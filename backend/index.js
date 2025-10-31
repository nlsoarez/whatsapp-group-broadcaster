// backend/index.js
import express from 'express'
import http from 'http'
import { Server } from 'socket.io'
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys'
import pino from 'pino'
import cors from 'cors'
import qrcode from 'qrcode'

const app = express()
app.use(express.json())
app.use(cors())

const server = http.createServer(app)
const io = new Server(server, { cors: { origin: '*' } })

let sock
let ready = false
const store = { 
  messages: {},      // cache de mensagens por grupo
  sentMessages: {}   // cache de mensagens enviadas
}

// ---------------------------
// Gera QR como base64
// ---------------------------
async function generateQRCode(qr) {
  try {
    return await qrcode.toDataURL(qr)
  } catch (error) {
    console.error('Erro ao gerar QR Code:', error)
    return null
  }
}

// ---------------------------
// Inicialização do WhatsApp
// ---------------------------
async function startWA() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState('auth')
    
    sock = makeWASocket({
      printQRInTerminal: false,
      auth: state,
      logger: pino({ level: 'silent' })
    })

    // Connection update - CORRIGIDO com async
    sock.ev.on('connection.update', async (update) => {
      const { qr, connection, lastDisconnect } = update
      
      if (qr) {
        console.log('📱 QR Code recebido, gerando imagem...')
        const qrDataUrl = await generateQRCode(qr)
        if (qrDataUrl) {
          io.emit('qr', { dataUrl: qrDataUrl })
        }
      }
      
      if (connection === 'open') {
        ready = true
        io.emit('ready')
        console.log('✅ WhatsApp conectado!')
      } else if (connection === 'close') {
        ready = false
        io.emit('disconnected')
        
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
        console.log('❌ Conexão fechada devido a', lastDisconnect?.error, 'Reconectando:', shouldReconnect)
        
        if (shouldReconnect) {
          setTimeout(() => startWA(), 5000)
        }
      }
    })

    // Salvar credenciais
    sock.ev.on('creds.update', saveCreds)

    // Processar mensagens - CORRIGIDO com async
    sock.ev.on('messages.upsert', async (upsert) => {
      try {
        const { messages, type } = upsert
        
        for (const msg of messages) {
          const from = msg.key.remoteJid
          
          // Ignora mensagens de status e broadcast
          if (!from || from === 'status@broadcast') continue
          
          // Inicializa array se não existir
          if (!store.messages[from]) store.messages[from] = []
          
          // Armazena a mensagem com sua key completa
          store.messages[from].push({
            key: msg.key,
            message: msg.message,
            messageTimestamp: msg.messageTimestamp,
            pushName: msg.pushName
          })
          
          // Limita o cache a 100 mensagens por grupo
          if (store.messages[from].length > 100) {
            store.messages[from] = store.messages[from].slice(-100)
          }

          // Só emite evento se for mensagem recebida (não enviada por nós) e não for de status
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
    
    // Monitora status de mensagens
    sock.ev.on('messages.update', (updates) => {
      for (const update of updates) {
        if (update.key && update.status === 2) {
          console.log('✉️ Mensagem enviada:', update.key.id)
        }
      }
    })
    
  } catch (error) {
    console.error('Erro ao iniciar WhatsApp:', error)
    setTimeout(() => startWA(), 10000)
  }
}

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
      subject: g.subject || 'Grupo sem nome'
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
    console.error('Erro ao buscar foto do grupo:', error)
    res.status(204).end()
  }
})

// ---------------------------
// REST: envio de mensagens com resposta melhorada
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
            // Envia como resposta real do WhatsApp
            sentMessage = await sock.sendMessage(gid, 
              { text: message },
              { quoted: originalMsg }
            )
            console.log(`✅ Resposta enviada para ${gid}`)
          } else {
            // Fallback com indicação visual
            console.log(`⚠️ Mensagem original não encontrada para ${gid}`)
            const fallbackText = `↩️ Em resposta a: "${replyTo.text?.substring(0, 100)}..."\n\n${message}`
            sentMessage = await sock.sendMessage(gid, { text: fallbackText })
          }
        } else {
          // Mensagem normal
          sentMessage = await sock.sendMessage(gid, { text: message })
        }
        
        // Armazena mensagem enviada no cache
        if (sentMessage) {
          const msgData = {
            key: sentMessage.key,
            message: { conversation: message },
            messageTimestamp: Date.now() / 1000
          }
          
          // Adiciona ao cache de mensagens enviadas
          if (!store.sentMessages[gid]) store.sentMessages[gid] = []
          store.sentMessages[gid].push(msgData)
          
          // Também adiciona ao cache principal
          if (!store.messages[gid]) store.messages[gid] = []
          store.messages[gid].push(msgData)
        }
        
        // Emite evento de mensagem enviada
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
        console.error(`Erro ao enviar para ${gid}:`, error.message)
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
// REST: debug - ver cache de mensagens
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
// REST: health check
// ---------------------------
app.get('/api/health', (req, res) => {
  res.json({
    status: ready ? 'connected' : 'disconnected',
    uptime: process.uptime(),
    timestamp: Date.now()
  })
})

// ---------------------------
// Socket.IO: gerenciamento de conexões
// ---------------------------
io.on('connection', (socket) => {
  console.log('🔌 Cliente conectado via Socket.IO')
  
  // Envia status atual ao conectar
  socket.emit('status', { ready })
  
  // Se já estiver conectado ao WhatsApp, notifica
  if (ready) {
    socket.emit('ready')
  }
  
  socket.on('disconnect', () => {
    console.log('🔌 Cliente desconectado')
  })
  
  // Permite que o cliente solicite status
  socket.on('request-status', () => {
    socket.emit('status', { ready })
  })
})

// ---------------------------
// Tratamento de erros não capturados
// ---------------------------
process.on('uncaughtException', (err) => {
  console.error('Erro não capturado:', err)
})

process.on('unhandledRejection', (err) => {
  console.error('Promise rejeitada não tratada:', err)
})

// ---------------------------
// Inicialização do servidor
// ---------------------------
const PORT = process.env.PORT || 3000

server.listen(PORT, async () => {
  console.log(`🚀 Servidor iniciado na porta ${PORT}`)
  console.log(`📊 Health check: http://localhost:${PORT}/api/health`)
  console.log(`📊 Debug: http://localhost:${PORT}/api/debug/cache/{groupId}`)
  console.log('⏳ Iniciando WhatsApp...')
  
  // Inicia o WhatsApp
  await startWA()
})
