// backend/index.js
import express from 'express'
import http from 'http'
import { Server } from 'socket.io'
import makeWASocket, { 
  useMultiFileAuthState, 
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers
} from '@whiskeysockets/baileys'
import pino from 'pino'
import cors from 'cors'
import qrcode from 'qrcode'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
app.use(express.json())
app.use(cors())

const server = http.createServer(app)
const io = new Server(server, { 
  cors: { 
    origin: '*',
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling']
})

let sock = null
let ready = false
let qrRetries = 0
const MAX_QR_RETRIES = 5

// Store para mensagens
const store = { 
  messages: {},
  sentMessages: {}
}

// Garante que o diretório auth existe
const AUTH_DIR = path.join(__dirname, 'auth')
if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true })
  console.log('📁 Diretório auth criado')
}

// ---------------------------
// Limpa sessão antiga se necessário
// ---------------------------
function clearAuthState() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true })
      fs.mkdirSync(AUTH_DIR, { recursive: true })
      console.log('🧹 Sessão antiga removida')
    }
  } catch (error) {
    console.error('Erro ao limpar sessão:', error)
  }
}

// ---------------------------
// Gera QR como base64
// ---------------------------
async function generateQRCode(qr) {
  try {
    const dataUrl = await qrcode.toDataURL(qr, {
      width: 300,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    })
    return dataUrl
  } catch (error) {
    console.error('Erro ao gerar QR Code:', error)
    return null
  }
}

// ---------------------------
// Inicialização do WhatsApp com melhorias
// ---------------------------
async function startWA(forceNewSession = false) {
  try {
    // Se forçar nova sessão ou muitas tentativas falhadas, limpa auth
    if (forceNewSession || qrRetries > MAX_QR_RETRIES) {
      clearAuthState()
      qrRetries = 0
    }

    console.log('📱 Iniciando conexão WhatsApp...')
    
    // Obtém a versão mais recente do Baileys
    const { version, isLatest } = await fetchLatestBaileysVersion()
    console.log(`📦 Usando Baileys versão: ${version.join('.')} ${isLatest ? '(última)' : '(atualização disponível)'}`)
    
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
    
    // Configurações melhoradas para evitar bloqueios
    sock = makeWASocket({
      version,
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
      },
      logger: pino({ level: 'error' }),
      browser: Browsers.ubuntu('Chrome'), // Simula Chrome no Ubuntu ao invés do padrão
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: undefined,
      keepAliveIntervalMs: 10000,
      emitOwnEvents: true,
      fireInitQueries: true,
      generateHighQualityLinkPreview: true,
      syncFullHistory: false,
      markOnlineOnConnect: true,
      getMessage: async (key) => {
        // Retorna mensagem do cache se existir
        const jid = key.remoteJid
        const messageList = store.messages[jid] || []
        return messageList.find(m => m.key.id === key.id)?.message || undefined
      }
    })

    // Connection update handler
    sock.ev.on('connection.update', async (update) => {
      const { qr, connection, lastDisconnect } = update
      
      if (qr) {
        qrRetries++
        console.log(`📱 QR Code recebido (tentativa ${qrRetries}/${MAX_QR_RETRIES})`)
        
        const qrDataUrl = await generateQRCode(qr)
        if (qrDataUrl) {
          io.emit('qr', { dataUrl: qrDataUrl })
          console.log('📤 QR Code enviado para o frontend')
        }
        
        // Se exceder tentativas, reinicia com nova sessão
        if (qrRetries > MAX_QR_RETRIES) {
          console.log('⚠️ Muitas tentativas de QR, reiniciando com nova sessão...')
          setTimeout(() => startWA(true), 3000)
        }
      }
      
      if (connection === 'open') {
        ready = true
        qrRetries = 0
        io.emit('ready')
        console.log('✅ WhatsApp conectado com sucesso!')
      } else if (connection === 'close') {
        ready = false
        io.emit('disconnected')
        
        // Análise detalhada do erro de desconexão
        const statusCode = lastDisconnect?.error?.output?.statusCode
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut
        
        console.log(`❌ Conexão fechada - Código: ${statusCode}`)
        
        if (statusCode === DisconnectReason.badSession) {
          console.log('💔 Sessão corrompida, limpando...')
          clearAuthState()
        }
        
        if (statusCode === 405 || statusCode === DisconnectReason.multideviceMismatch) {
          console.log('⚠️ Erro 405 ou incompatibilidade multi-device detectada')
          clearAuthState()
          shouldReconnect = true
        }
        
        if (shouldReconnect) {
          const delay = statusCode === DisconnectReason.timedOut ? 5000 : 10000
          console.log(`🔄 Reconectando em ${delay/1000} segundos...`)
          setTimeout(() => startWA(statusCode === 405), delay)
        } else {
          console.log('🛑 Não reconectando - usuário fez logout')
          clearAuthState()
        }
      }
      
      if (connection === 'connecting') {
        console.log('🔄 Conectando ao WhatsApp...')
      }
    })

    // Salvar credenciais
    sock.ev.on('creds.update', saveCreds)

    // Processar mensagens
    sock.ev.on('messages.upsert', async (upsert) => {
      try {
        const { messages, type } = upsert
        
        for (const msg of messages) {
          const from = msg.key.remoteJid
          
          // Ignora mensagens de status e broadcast
          if (!from || from === 'status@broadcast') continue
          
          // Armazena no cache
          if (!store.messages[from]) store.messages[from] = []
          
          store.messages[from].push({
            key: msg.key,
            message: msg.message,
            messageTimestamp: msg.messageTimestamp,
            pushName: msg.pushName
          })
          
          // Limita cache
          if (store.messages[from].length > 100) {
            store.messages[from] = store.messages[from].slice(-100)
          }

          // Emite evento apenas para mensagens de grupo recebidas
          if (!msg.key.fromMe && from.includes('@g.us')) {
            const text =
              msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              '(mídia)'
              
            io.emit('message', {
              groupId: from,
              from: msg.pushName || msg.key.participant || 'Desconhecido',
              text,
              timestamp: msg.messageTimestamp * 1000,
              messageId: msg.key.id
            })
          }
        }
      } catch (error) {
        console.error('Erro ao processar mensagens:', error)
      }
    })
    
    // Monitora atualizações de mensagens
    sock.ev.on('messages.update', (updates) => {
      for (const update of updates) {
        if (update.key && update.status === 2) {
          console.log('✉️ Mensagem enviada confirmada')
        }
      }
    })
    
    // Tratamento de erros do socket
    sock.ev.on('error', (error) => {
      console.error('Erro no socket:', error)
    })
    
  } catch (error) {
    console.error('Erro fatal ao iniciar WhatsApp:', error)
    
    // Se erro crítico, limpa sessão e tenta novamente
    if (error.message?.includes('405') || error.message?.includes('Connection Failure')) {
      console.log('🧹 Limpando sessão devido a erro crítico...')
      clearAuthState()
      setTimeout(() => startWA(true), 5000)
    } else {
      setTimeout(() => startWA(), 10000)
    }
  }
}

// ---------------------------
// REST: força nova sessão
// ---------------------------
app.post('/api/reset-session', async (req, res) => {
  try {
    console.log('🔄 Resetando sessão...')
    
    if (sock) {
      await sock.logout().catch(() => {})
      sock.end()
    }
    
    clearAuthState()
    ready = false
    
    setTimeout(() => startWA(true), 1000)
    
    res.json({ success: true, message: 'Sessão resetada, aguarde novo QR' })
  } catch (error) {
    console.error('Erro ao resetar sessão:', error)
    res.status(500).json({ error: 'Falha ao resetar sessão' })
  }
})

// ---------------------------
// REST: lista grupos
// ---------------------------
app.get('/api/groups', async (req, res) => {
  try {
    if (!sock || !ready) {
      return res.status(503).json({ error: 'WhatsApp não conectado' })
    }
    
    const groups = await sock.groupFetchAllParticipating()
    const groupList = Object.values(groups).map(g => ({
      id: g.id,
      subject: g.subject || 'Grupo sem nome',
      participants: g.participants?.length || 0
    }))
    
    res.json(groupList)
  } catch (e) {
    console.error('Erro ao listar grupos:', e)
    res.status(500).json({ error: 'Falha ao listar grupos' })
  }
})

// ---------------------------
// REST: foto do grupo
// ---------------------------
app.get('/api/group-picture/:jid', async (req, res) => {
  try {
    if (!sock || !ready) {
      return res.status(503).json({ error: 'WhatsApp não conectado' })
    }
    
    const url = await sock.profilePictureUrl(req.params.jid, 'image').catch(() => null)
    
    if (!url) {
      return res.status(204).end()
    }
    
    res.json({ url })
  } catch (error) {
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
      let sentMessage = null
      
      try {
        // Verifica se é uma resposta
        if (replyTo?.groupId === gid && (replyTo?.messageId || replyTo?.text)) {
          const groupMessages = store.messages[gid] || []
          let originalMsg = null
          
          // Busca por messageId primeiro
          if (replyTo.messageId) {
            originalMsg = groupMessages.find(m => m.key.id === replyTo.messageId)
          }
          
          // Se não encontrou por ID, busca por texto
          if (!originalMsg && replyTo.text) {
            originalMsg = groupMessages.find(m => {
              const msgText = m.message?.conversation || 
                            m.message?.extendedTextMessage?.text
              return msgText === replyTo.text
            })
          }
          
          if (originalMsg) {
            sentMessage = await sock.sendMessage(gid, 
              { text: message },
              { quoted: originalMsg }
            )
            console.log(`✅ Resposta enviada para grupo`)
          } else {
            // Fallback
            const fallbackText = `↩️ ${replyTo.text ? `Em resposta a: "${replyTo.text.substring(0, 100)}..."\n\n` : ''}${message}`
            sentMessage = await sock.sendMessage(gid, { text: fallbackText })
          }
        } else {
          // Mensagem normal
          sentMessage = await sock.sendMessage(gid, { text: message })
        }
        
        // Armazena no cache
        if (sentMessage) {
          const msgData = {
            key: sentMessage.key,
            message: { conversation: message },
            messageTimestamp: Date.now() / 1000
          }
          
          if (!store.messages[gid]) store.messages[gid] = []
          store.messages[gid].push(msgData)
        }
        
        // Emite evento
        io.emit('message_sent', { 
          groupId: gid, 
          text: message, 
          timestamp: Date.now(),
          messageId: sentMessage?.key?.id,
          isReply: !!replyTo
        })
        
        results.push({ 
          groupId: gid, 
          success: true, 
          messageId: sentMessage?.key?.id 
        })
        
      } catch (error) {
        console.error(`Erro ao enviar para grupo:`, error.message)
        results.push({ 
          groupId: gid, 
          success: false, 
          error: error.message 
        })
      }
    }

    res.json({ ok: true, results })
    
  } catch (e) {
    console.error('Erro geral no envio:', e)
    res.status(500).json({ 
      error: 'Falha ao enviar mensagem', 
      details: e.message 
    })
  }
})

// ---------------------------
// REST: health check
// ---------------------------
app.get('/api/health', (req, res) => {
  res.json({
    status: ready ? 'connected' : 'disconnected',
    uptime: process.uptime(),
    timestamp: Date.now(),
    qrRetries: qrRetries
  })
})

// ---------------------------
// REST: debug cache
// ---------------------------
app.get('/api/debug/cache/:groupId', async (req, res) => {
  const { groupId } = req.params
  const messages = store.messages[groupId] || []
  
  res.json({
    groupId,
    totalMessages: messages.length,
    messages: messages.slice(-10).map(m => ({
      id: m.key?.id,
      text: m.message?.conversation || m.message?.extendedTextMessage?.text,
      fromMe: m.key?.fromMe,
      timestamp: m.messageTimestamp
    }))
  })
})

// ---------------------------
// Socket.IO
// ---------------------------
io.on('connection', (socket) => {
  console.log('🔌 Cliente conectado via Socket.IO')
  
  // Envia status atual
  socket.emit('status', { ready })
  
  if (ready) {
    socket.emit('ready')
  }
  
  socket.on('disconnect', () => {
    console.log('🔌 Cliente desconectado')
  })
  
  socket.on('request-status', () => {
    socket.emit('status', { ready })
  })
  
  socket.on('request-qr', () => {
    if (!ready && !sock) {
      console.log('📱 QR solicitado, reiniciando conexão...')
      startWA(true)
    }
  })
})

// ---------------------------
// Tratamento de erros
// ---------------------------
process.on('uncaughtException', (err) => {
  console.error('❌ Erro não capturado:', err)
  // Não fecha o processo, tenta recuperar
})

process.on('unhandledRejection', (err) => {
  console.error('❌ Promise rejeitada:', err)
})

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('🛑 Encerrando servidor...')
  
  if (sock) {
    await sock.end()
  }
  
  server.close(() => {
    console.log('👋 Servidor encerrado')
    process.exit(0)
  })
})

// ---------------------------
// Inicialização
// ---------------------------
const PORT = process.env.PORT || 3000

server.listen(PORT, async () => {
  console.log(`🚀 Servidor iniciado na porta ${PORT}`)
  console.log(`📊 Health: http://localhost:${PORT}/api/health`)
  console.log(`🔄 Reset: POST http://localhost:${PORT}/api/reset-session`)
  console.log('⏳ Iniciando WhatsApp...')
  
  // Aguarda um pouco antes de iniciar para garantir que tudo está pronto
  setTimeout(() => {
    startWA()
  }, 2000)
})
