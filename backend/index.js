// backend/index.js - VERSÃO DEBUG PARA INVESTIGAR QUOTED
import express from 'express'
import http from 'http'
import { Server } from 'socket.io'
import makeWASocket, { 
  useMultiFileAuthState, 
  DisconnectReason,
  fetchLatestBaileysVersion,
  delay
} from '@whiskeysockets/baileys'
import pino from 'pino'
import cors from 'cors'
import qrcode from 'qrcode'
import path from 'path'

const app = express()
app.use(express.json())
app.use(cors())

const server = http.createServer(app)
const io = new Server(server, { 
  cors: { origin: '*' },
  transports: ['websocket', 'polling']
})

let sock
let ready = false
let qrDinamic = null
const store = { messages: {} } // cache de mensagens

// Diretório de sessão
const SESSIONS_DIR = path.join(process.cwd(), 'sessions')

// ---------------------------
// Gera QR como base64
// ---------------------------
async function generateQRCode(qr) {
  try {
    return await qrcode.toDataURL(qr)
  } catch (error) {
    console.error('❌ Erro ao gerar QR Code:', error)
    return null
  }
}

// ---------------------------
// Inicialização do WhatsApp
// ---------------------------
async function startWA() {
  try {
    console.log('🔄 Iniciando conexão com WhatsApp...')
    
    const { version } = await fetchLatestBaileysVersion()
    console.log(`📱 Usando versão do WA Web: ${version.join('.')}`)

    const { state, saveCreds } = await useMultiFileAuthState(SESSIONS_DIR)
    
    sock = makeWASocket({
      version,
      printQRInTerminal: true,
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: ['WhatsApp Broadcaster', 'Chrome', '120.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: true
    })

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        console.log('📱 QR Code gerado!')
        qrDinamic = qr
        const dataUrl = await generateQRCode(qr)
        if (dataUrl) {
          io.emit('qr', { dataUrl })
        }
      }

      if (connection === 'open') {
        ready = true
        qrDinamic = null
        io.emit('ready')
        console.log('✅ WhatsApp conectado com sucesso!')
        console.log(`📞 Número: ${sock.user?.id}`)
      }

      if (connection === 'close') {
        ready = false
        const shouldReconnect = 
          lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
        
        const statusCode = lastDisconnect?.error?.output?.statusCode
        const reason = getDisconnectReason(statusCode)
        
        console.log(`❌ Desconectado: ${reason}`)

        if (shouldReconnect) {
          console.log('🔄 Tentando reconectar em 5 segundos...')
          io.emit('disconnected')
          setTimeout(startWA, 5000)
        } else {
          console.log('🚪 Logout detectado. Aguardando novo login...')
          io.emit('logged_out')
        }
      }

      if (connection === 'connecting') {
        console.log('🔌 Conectando ao WhatsApp...')
      }
    })

    sock.ev.on('creds.update', saveCreds)

    // Armazena mensagens recebidas - COM ESTRUTURA COMPLETA
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return

      for (const msg of messages) {
        if (msg.key.remoteJid === 'status@broadcast') continue

        const from = msg.key.remoteJid
        
        if (!store.messages[from]) {
          store.messages[from] = []
        }
        
        // ✅ ARMAZENA MENSAGEM COMPLETA COM TODA ESTRUTURA
        store.messages[from].push(msg)
        if (store.messages[from].length > 100) {
          store.messages[from].shift()
        }

        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption ||
          '(mídia sem legenda)'

        const senderName = msg.pushName || 
          msg.key.participant?.split('@')[0] || 
          'Desconhecido'

        const messageId = msg.key.id

        // 🔍 DEBUG: Log completo da estrutura da mensagem
        console.log('📩 Mensagem recebida:', {
          from,
          senderName,
          text,
          messageId,
          hasKey: !!msg.key,
          hasMessage: !!msg.message,
          keyStructure: JSON.stringify(msg.key),
          messageType: Object.keys(msg.message || {})[0]
        })

        io.emit('message', {
          groupId: from,
          from: senderName,
          text,
          timestamp: (msg.messageTimestamp * 1000) || Date.now(),
          messageId
        })
      }
    })

    sock.ev.on('connection.error', (error) => {
      console.error('❌ Erro na conexão:', error)
    })

  } catch (error) {
    console.error('❌ Erro ao iniciar WhatsApp:', error)
    setTimeout(startWA, 10000)
  }
}

function getDisconnectReason(statusCode) {
  const reasons = {
    [DisconnectReason.badSession]: 'Sessão inválida',
    [DisconnectReason.connectionClosed]: 'Conexão fechada',
    [DisconnectReason.connectionLost]: 'Conexão perdida',
    [DisconnectReason.connectionReplaced]: 'Conexão substituída em outro dispositivo',
    [DisconnectReason.loggedOut]: 'Deslogado',
    [DisconnectReason.restartRequired]: 'Reinício necessário',
    [DisconnectReason.timedOut]: 'Tempo esgotado',
    [DisconnectReason.multideviceMismatch]: 'Incompatibilidade multidevice'
  }
  return reasons[statusCode] || `Desconhecido (${statusCode})`
}

app.get('/api/status', (req, res) => {
  res.json({ 
    ready, 
    hasQR: !!qrDinamic,
    connected: sock?.user?.id || null
  })
})

app.get('/api/groups', async (req, res) => {
  try {
    if (!sock || !ready) {
      return res.status(503).json({ error: 'WhatsApp não conectado' })
    }
    
    const groups = Object.values(await sock.groupFetchAllParticipating()).map(g => ({
      id: g.id,
      subject: g.subject,
      size: g.participants.length
    }))
    
    console.log(`📋 Listando ${groups.length} grupos`)
    res.json(groups)
  } catch (e) {
    console.error('❌ Erro ao listar grupos:', e)
    res.status(500).json({ error: 'Falha ao listar grupos' })
  }
})

app.get('/api/group-picture/:jid', async (req, res) => {
  try {
    if (!sock || !ready) return res.status(503).end()
    
    const url = await sock.profilePictureUrl(req.params.jid, 'image')
    if (!url) return res.status(204).end()
    
    res.json({ url })
  } catch {
    res.status(204).end()
  }
})

// ---------------------------
// REST: envio de mensagens COM DEBUG
// ---------------------------
app.post('/api/send', async (req, res) => {
  try {
    const { groupIds, message, replyTo } = req.body
    
    if (!sock || !ready) {
      return res.status(503).json({ error: 'WhatsApp não conectado' })
    }
    
    if (!groupIds?.length) {
      return res.status(400).json({ error: 'Nenhum grupo selecionado' })
    }
    
    if (!message?.trim()) {
      return res.status(400).json({ error: 'Mensagem vazia' })
    }

    console.log('\n🔍 DEBUG ENVIO:')
    console.log('Message:', message)
    console.log('ReplyTo:', JSON.stringify(replyTo, null, 2))

    const results = []
    
    for (const gid of groupIds) {
      try {
        // TENTATIVA COM QUOTED
        if (replyTo?.groupId && replyTo?.messageId) {
          const msgs = store.messages[replyTo.groupId] || []
          
          console.log(`\n🔍 Buscando mensagem para reply:`)
          console.log(`- Grupo: ${replyTo.groupId}`)
          console.log(`- MessageId: ${replyTo.messageId}`)
          console.log(`- Total msgs no cache: ${msgs.length}`)
          
          const original = msgs.find(m => m.key.id === replyTo.messageId)
          
          if (original) {
            console.log(`✅ Mensagem original encontrada!`)
            console.log(`- Estrutura key:`, JSON.stringify(original.key, null, 2))
            console.log(`- Tipo mensagem:`, Object.keys(original.message || {}))
            
            try {
              // MÉTODO 1: Quoted direto
              console.log('\n🧪 TESTE 1: Enviando com quoted no 3º parâmetro...')
              await sock.sendMessage(gid, { 
                text: message.trim() 
              }, { 
                quoted: original 
              })
              console.log('✅ TESTE 1: Sucesso!')
              
            } catch (error) {
              console.error('❌ TESTE 1 falhou:', error.message)
              
              // MÉTODO 2: Fallback - construir contextInfo manualmente
              try {
                console.log('\n🧪 TESTE 2: Enviando com contextInfo manual...')
                await sock.sendMessage(gid, {
                  text: message.trim(),
                  contextInfo: {
                    stanzaId: original.key.id,
                    participant: original.key.participant || original.key.remoteJid,
                    quotedMessage: original.message
                  }
                })
                console.log('✅ TESTE 2: Sucesso!')
              } catch (error2) {
                console.error('❌ TESTE 2 também falhou:', error2.message)
                throw error2
              }
            }
            
          } else {
            console.log(`⚠️ Mensagem original NÃO encontrada`)
            console.log(`IDs disponíveis no cache:`, msgs.map(m => m.key.id).slice(-5))
            
            // Envia sem reply
            await sock.sendMessage(gid, { text: message.trim() })
          }
        } else {
          // Mensagem normal sem reply
          console.log('📤 Enviando mensagem normal (sem reply)')
          await sock.sendMessage(gid, { text: message.trim() })
        }
        
        console.log(`✅ Mensagem enviada para ${gid}`)
        
        io.emit('message_sent', { 
          groupId: gid, 
          text: message, 
          timestamp: Date.now(),
          replyTo: replyTo || null
        })
        
        results.push({ groupId: gid, success: true })
        
        await delay(1000)
        
      } catch (error) {
        console.error(`❌ Erro ao enviar para ${gid}:`, error)
        results.push({ groupId: gid, success: false, error: error.message })
      }
    }

    res.json({ ok: true, results })
    
  } catch (e) {
    console.error('❌ Erro no envio:', e)
    res.status(500).json({ error: 'Falha ao enviar mensagem' })
  }
})

io.on('connection', (socket) => {
  console.log('🔌 Cliente conectado via Socket.IO')
  
  socket.emit('status', { ready })
  
  if (qrDinamic) {
    generateQRCode(qrDinamic).then(dataUrl => {
      if (dataUrl) socket.emit('qr', { dataUrl })
    })
  }

  socket.on('disconnect', () => {
    console.log('🔌 Cliente desconectado')
  })
})

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    whatsapp: ready ? 'connected' : 'disconnected',
    uptime: process.uptime()
  })
})

const PORT = process.env.PORT || 3000

server.listen(PORT, async () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('🚀 WhatsApp Group Broadcaster')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`📡 Servidor rodando na porta ${PORT}`)
  console.log(`🌍 Ambiente: ${process.env.NODE_ENV || 'development'}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  
  await startWA()
})

process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled Rejection:', error)
})

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error)
})
