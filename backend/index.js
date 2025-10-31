// backend/index.js
import express from 'express'
import http from 'http'
import { Server } from 'socket.io'
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys'
import pino from 'pino'
import cors from 'cors'

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
// Inicialização do WhatsApp
// ---------------------------
async function startWA() {
  const { state, saveCreds } = await useMultiFileAuthState('auth')
  sock = makeWASocket({
    printQRInTerminal: false,
    auth: state,
    logger: pino({ level: 'silent' })
  })

  sock.ev.on('connection.update', ({ qr, connection }) => {
    if (qr) io.emit('qr', { dataUrl: await generateQRCode(qr) })
    if (connection === 'open') {
      ready = true
      io.emit('ready')
      console.log('✅ WhatsApp conectado!')
    } else if (connection === 'close') {
      ready = false
      io.emit('disconnected')
      console.log('❌ Desconectado, tentando reconectar...')
      setTimeout(startWA, 5000)
    }
  })

  sock.ev.on('creds.update', saveCreds)

  // Armazena TODAS as mensagens (recebidas e enviadas)
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      const from = msg.key.remoteJid
      
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

      // Só emite evento se for mensagem recebida (não enviada por nós)
      if (!msg.key.fromMe) {
        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          '(mídia)'
          
        io.emit('message', {
          groupId: from,
          from: msg.pushName || msg.key.participant || 'Desconhecido',
          text,
          timestamp: msg.messageTimestamp * 1000,
          messageId: msg.key.id  // Adiciona ID da mensagem
        })
      }
    }
  })
  
  // Monitora mensagens enviadas por nós
  sock.ev.on('messages.update', (updates) => {
    for (const update of updates) {
      if (update.key && update.status === 2) { // 2 = enviada
        console.log('Mensagem enviada confirmada:', update.key.id)
      }
    }
  })
}

// ---------------------------
// Gera QR como base64
// ---------------------------
async function generateQRCode(qr) {
  const qrcode = await import('qrcode')
  return await qrcode.toDataURL(qr)
}

// ---------------------------
// REST: lista grupos
// ---------------------------
app.get('/api/groups', async (req, res) => {
  try {
    if (!sock || !ready) return res.status(503).json({ error: 'WhatsApp não conectado' })
    const groups = Object.values(await sock.groupFetchAllParticipating()).map(g => ({
      id: g.id,
      subject: g.subject
    }))
    res.json(groups)
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Falha ao listar grupos' })
  }
})

// ---------------------------
// REST: foto do grupo
// ---------------------------
app.get('/api/group-picture/:jid', async (req, res) => {
  try {
    if (!sock || !ready) return res.status(503).json({ error: 'WhatsApp não conectado' })
    const url = await sock.profilePictureUrl(req.params.jid, 'image')
    if (!url) return res.status(204).end()
    res.json({ url })
  } catch {
    res.status(204).end()
  }
})

// ---------------------------
// REST: envio de mensagens com resposta melhorada
// ---------------------------
app.post('/api/send', async (req, res) => {
  try {
    const { groupIds, message, replyTo } = req.body
    if (!sock || !ready) return res.status(503).json({ error: 'WhatsApp não conectado' })
    if (!groupIds?.length) return res.status(400).json({ error: 'Nenhum grupo selecionado' })
    if (!message) return res.status(400).json({ error: 'Mensagem vazia' })

    const results = []
    
    for (const gid of groupIds) {
      let sentMessage = null
      
      try {
        // Se for uma resposta
        if (replyTo?.groupId === gid && replyTo?.messageId) {
          // Busca a mensagem original pelo ID
          const groupMessages = store.messages[gid] || []
          const originalMsg = groupMessages.find(m => m.key.id === replyTo.messageId)
          
          if (originalMsg) {
            // Envia como resposta real do WhatsApp
            sentMessage = await sock.sendMessage(gid, 
              { text: message },
              { quoted: originalMsg }
            )
            console.log(`✅ Resposta enviada para ${gid} referenciando mensagem ${replyTo.messageId}`)
          } else {
            // Se não encontrar a mensagem original, envia normal mas com contexto
            console.log(`⚠️ Mensagem original não encontrada no cache para ${gid}`)
            sentMessage = await sock.sendMessage(gid, { 
              text: `↩️ Em resposta a: "${replyTo.text}"\n\n${message}` 
            })
          }
        } else if (replyTo?.text && !replyTo?.messageId) {
          // Busca por texto (backward compatibility)
          const groupMessages = store.messages[gid] || []
          const originalMsg = groupMessages.find(m => {
            const msgText = m.message?.conversation || 
                          m.message?.extendedTextMessage?.text
            return msgText === replyTo.text
          })
          
          if (originalMsg) {
            sentMessage = await sock.sendMessage(gid, 
              { text: message },
              { quoted: originalMsg }
            )
            console.log(`✅ Resposta enviada por match de texto para ${gid}`)
          } else {
            // Fallback com indicação visual
            sentMessage = await sock.sendMessage(gid, { 
              text: `↩️ Em resposta a: "${replyTo.text}"\n\n${message}` 
            })
          }
        } else {
          // Mensagem normal (não é resposta)
          sentMessage = await sock.sendMessage(gid, { text: message })
        }
        
        // Armazena mensagem enviada no cache
        if (sentMessage) {
          if (!store.sentMessages[gid]) store.sentMessages[gid] = []
          store.sentMessages[gid].push({
            key: sentMessage.key,
            message: { conversation: message },
            messageTimestamp: Date.now() / 1000
          })
          
          // Também adiciona ao cache principal
          if (!store.messages[gid]) store.messages[gid] = []
          store.messages[gid].push({
            key: sentMessage.key,
            message: { conversation: message },
            messageTimestamp: Date.now() / 1000
          })
        }
        
        // Emite evento de mensagem enviada
        io.emit('message_sent', { 
          groupId: gid, 
          text: message, 
          timestamp: Date.now(),
          messageId: sentMessage?.key?.id,
          isReply: !!replyTo
        })
        
        results.push({ groupId: gid, success: true, messageId: sentMessage?.key?.id })
        
      } catch (error) {
        console.error(`Erro ao enviar para ${gid}:`, error)
        results.push({ groupId: gid, success: false, error: error.message })
      }
    }

    res.json({ ok: true, results })
  } catch (e) {
    console.error('Erro geral no envio:', e)
    res.status(500).json({ error: 'Falha ao enviar mensagem', details: e.message })
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
// Socket.IO: status sob demanda
// ---------------------------
io.on('connection', socket => {
  socket.emit('status', { ready })
  console.log('🔌 Cliente conectado via Socket.IO')
  
  socket.on('disconnect', () => {
    console.log('🔌 Cliente desconectado')
  })
})

// ---------------------------
// Inicialização do servidor
// ---------------------------
const PORT = process.env.PORT || 3000
server.listen(PORT, async () => {
  console.log(`🚀 Servidor iniciado na porta ${PORT}`)
  console.log(`📊 Debug disponível em http://localhost:${PORT}/api/debug/cache/{groupId}`)
  await startWA()
})
