// backend/index.js
import express from 'express'
import http from 'http'
import { Server } from 'socket.io'
import makeWASocket, { 
  useMultiFileAuthState, 
  DisconnectReason,
  fetchLatestBaileysVersion
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
    
    // Buscar versão mais recente do Baileys
    const { version } = await fetchLatestBaileysVersion()
    console.log(`📱 Usando versão do WA Web: ${version.join('.')}`)

    // Carregar estado de autenticação
    const { state, saveCreds } = await useMultiFileAuthState(SESSIONS_DIR)
    
    sock = makeWASocket({
      version,
      printQRInTerminal: true, // Também mostra no terminal para debug
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: ['WhatsApp Broadcaster', 'Chrome', '120.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: true
    })

    // Evento de atualização de conexão
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update

      // QR Code disponível
      if (qr) {
        console.log('📱 QR Code gerado!')
        qrDinamic = qr
        const dataUrl = await generateQRCode(qr)
        if (dataUrl) {
          io.emit('qr', { dataUrl })
        }
      }

      // Conexão aberta
      if (connection === 'open') {
        ready = true
        qrDinamic = null
        io.emit('ready')
        console.log('✅ WhatsApp conectado com sucesso!')
        console.log(`📞 Número: ${sock.user?.id}`)
      }

      // Conexão fechada
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

      // Conectando
      if (connection === 'connecting') {
        console.log('🔌 Conectando ao WhatsApp...')
      }
    })

    // Salvar credenciais quando atualizadas
    sock.ev.on('creds.update', saveCreds)

    // Armazena mensagens recebidas
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return

      for (const msg of messages) {
        // Ignora mensagens de status
        if (msg.key.remoteJid === 'status@broadcast') continue

        const from = msg.key.remoteJid
        
        // Inicializa array se não existir
        if (!store.messages[from]) {
          store.messages[from] = []
        }
        
        // Armazena apenas últimas 100 mensagens por grupo
        store.messages[from].push(msg)
        if (store.messages[from].length > 100) {
          store.messages[from].shift()
        }

        // Extrai texto da mensagem
        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption ||
          '(mídia sem legenda)'

        // Nome do remetente
        const senderName = msg.pushName || 
          msg.key.participant?.split('@')[0] || 
          'Desconhecido'

        console.log(`📩 Mensagem recebida em ${from}: ${senderName}: ${text}`)

        // Emite para frontend
        io.emit('message', {
          groupId: from,
          from: senderName,
          text,
          timestamp: (msg.messageTimestamp * 1000) || Date.now()
        })
      }
    })

    // Tratamento de erros
    sock.ev.on('connection.error', (error) => {
      console.error('❌ Erro na conexão:', error)
    })

  } catch (error) {
    console.error('❌ Erro ao iniciar WhatsApp:', error)
    setTimeout(startWA, 10000)
  }
}

// ---------------------------
// Função auxiliar para identificar motivo da desconexão
// ---------------------------
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

// ---------------------------
// REST: Status da conexão
// ---------------------------
app.get('/api/status', (req, res) => {
  res.json({ 
    ready, 
    hasQR: !!qrDinamic,
    connected: sock?.user?.id || null
  })
})

// ---------------------------
// REST: lista grupos
// ---------------------------
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

// ---------------------------
// REST: foto do grupo
// ---------------------------
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
// REST: envio de mensagens
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

    const results = []
    
    for (const gid of groupIds) {
      try {
        let options = {}

        // Se for resposta
        if (replyTo?.groupId && replyTo?.text) {
          const msgs = store.messages[replyTo.groupId] || []
          const original = msgs.find(
            m =>
              m.message?.conversation === replyTo.text ||
              m.message?.extendedTextMessage?.text === replyTo.text
          )
          
          if (original) {
            options.quoted = original
          }
        }

        await sock.sendMessage(gid, { text: message.trim() }, options)
        
        console.log(`✅ Mensagem enviada para ${gid}`)
        
        io.emit('message_sent', { 
          groupId: gid, 
          text: message, 
          timestamp: Date.now() 
        })
        
        results.push({ groupId: gid, success: true })
        
        // Pequeno delay entre envios para evitar ban
        await new Promise(resolve => setTimeout(resolve, 1000))
        
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

// ---------------------------
// Socket.IO: status sob demanda
// ---------------------------
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

// ---------------------------
// Health check
// ---------------------------
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    whatsapp: ready ? 'connected' : 'disconnected',
    uptime: process.uptime()
  })
})

// ---------------------------
// Inicialização do servidor
// ---------------------------
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

// Tratamento de erros não capturados
process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled Rejection:', error)
})

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error)
})
