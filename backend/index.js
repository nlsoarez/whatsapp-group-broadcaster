// backend/index.js
import express from 'express'
import http from 'http'
import { Server } from 'socket.io'
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import pino from 'pino'
import cors from 'cors'
import fs from 'fs'
import path from 'path'

const app = express()
app.use(express.json())
app.use(cors())

const server = http.createServer(app)
const io = new Server(server, { 
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000
})

let sock
let ready = false
const store = { messages: {}, lastSync: {} }

// ---------------------------
// Inicialização do WhatsApp
// ---------------------------
async function startWA() {
  const { state, saveCreds } = await useMultiFileAuthState('auth')
  const { version } = await fetchLatestBaileysVersion()
  
  sock = makeWASocket({
    printQRInTerminal: false,
    auth: state,
    logger: pino({ level: 'silent' }),
    version,
    keepAliveIntervalMs: 50000,
    markOnlineOnConnect: true
  })

  sock.ev.on('connection.update', async ({ qr, connection, lastDisconnect }) => {
    if (qr) {
      const dataUrl = await awaitQRCode(qr)
      io.emit('qr', { dataUrl })
    }
    
    if (connection === 'open') {
      ready = true
      io.emit('ready')
      console.log('✅ WhatsApp conectado!')
      
      // Sincroniza histórico após conexão
      setTimeout(() => syncAllGroupsHistory(), 2000)
    } else if (connection === 'close') {
      ready = false
      io.emit('disconnected')
      
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      console.log('❌ Desconectado:', lastDisconnect?.error?.message)
      
      if (shouldReconnect) {
        console.log('🔄 Tentando reconectar em 5s...')
        setTimeout(startWA, 5000)
      } else {
        console.log('🚪 Logout detectado - aguardando novo login')
        io.emit('logged_out')
      }
    }
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      const from = msg.key.remoteJid
      if (!from?.endsWith('@g.us')) continue // Só grupos
      
      if (!store.messages[from]) store.messages[from] = []
      
      // Evita duplicatas
      const exists = store.messages[from].find(m => m.key.id === msg.key.id)
      if (!exists) store.messages[from].push(msg)

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        '(mídia)'
      
      const participant = msg.key.participant || msg.key.remoteJid
      const name = msg.pushName || participant?.split('@')[0] || 'Desconhecido'
      
      io.emit('message', {
        groupId: from,
        from: name,
        text,
        timestamp: (msg.messageTimestamp || Date.now() / 1000) * 1000
      })
    }
  })
}

// ---------------------------
// Sincroniza histórico de todos os grupos
// ---------------------------
async function syncAllGroupsHistory() {
  try {
    const groups = Object.values(await sock.groupFetchAllParticipating())
    console.log(`📥 Sincronizando histórico de ${groups.length} grupos...`)
    
    for (const group of groups) {
      const history = await syncGroupHistory(group.id)
      
      // Envia histórico para o frontend
      if (history.length > 0) {
        io.emit('history', {
          groupId: group.id,
          messages: history.map(msg => ({
            from: msg.pushName || msg.key.participant?.split('@')[0] || 'Desconhecido',
            text: msg.message?.conversation || msg.message?.extendedTextMessage?.text || '(mídia)',
            timestamp: (msg.messageTimestamp || Date.now() / 1000) * 1000
          }))
        })
      }
    }
    
    console.log('✅ Histórico sincronizado!')
  } catch (e) {
    console.error('Erro ao sincronizar histórico:', e)
  }
}

// ---------------------------
// Busca histórico de um grupo
// ---------------------------
async function syncGroupHistory(groupId, limit = 30) {
  try {
    if (!sock || !ready) return []
    
    const lastSync = store.lastSync[groupId]
    if (lastSync && Date.now() - lastSync < 30000) {
      return store.messages[groupId] || []
    }
    
    store.lastSync[groupId] = Date.now()
    
    // Busca mensagens do Baileys
    const messages = await sock.fetchMessagesFromWA(groupId, limit)
    
    if (!store.messages[groupId]) store.messages[groupId] = []
    
    for (const msg of messages) {
      const exists = store.messages[groupId].find(m => m.key.id === msg.key.id)
      if (!exists) {
        store.messages[groupId].unshift(msg)
      }
    }
    
    // Limita cache
    if (store.messages[groupId].length > 100) {
      store.messages[groupId] = store.messages[groupId].slice(-100)
    }
    
    return messages
  } catch (e) {
    console.error(`Erro ao buscar histórico do grupo ${groupId}:`, e.message)
    return []
  }
}

// ---------------------------
// Gera QR como base64
// ---------------------------
async function awaitQRCode(qr) {
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
    if (!sock || !ready) return res.status(503).end()
    const url = await sock.profilePictureUrl(req.params.jid, 'image')
    if (!url) return res.status(204).end()
    res.json({ url })
  } catch {
    res.status(204).end()
  }
})

// ---------------------------
// REST: histórico de um grupo
// ---------------------------
app.get('/api/history/:groupId', async (req, res) => {
  try {
    if (!sock || !ready) return res.status(503).json({ error: 'WhatsApp não conectado' })
    
    const messages = await syncGroupHistory(req.params.groupId, 50)
    
    const formatted = messages.map(msg => ({
      from: msg.pushName || msg.key.participant?.split('@')[0] || 'Desconhecido',
      text: msg.message?.conversation || msg.message?.extendedTextMessage?.text || '(mídia)',
      timestamp: (msg.messageTimestamp || Date.now() / 1000) * 1000
    }))
    
    res.json(formatted)
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Falha ao buscar histórico' })
  }
})

// ---------------------------
// REST: envio de mensagens
// ---------------------------
app.post('/api/send', async (req, res) => {
  try {
    const { groupIds, message, replyTo } = req.body
    if (!sock || !ready) return res.status(503).json({ error: 'WhatsApp não conectado' })
    if (!groupIds?.length) return res.status(400).json({ error: 'Nenhum grupo selecionado' })
    if (!message) return res.status(400).json({ error: 'Mensagem vazia' })

    for (const gid of groupIds) {
      let options = {}

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

      await sock.sendMessage(gid, { text: message }, options)
      io.emit('message_sent', { groupId: gid, text: message, timestamp: Date.now() })
    }

    res.json({ ok: true })
  } catch (e) {
    console.error('Erro no envio:', e)
    res.status(500).json({ error: 'Falha ao enviar mensagem' })
  }
})

// ---------------------------
// REST: logout
// ---------------------------
app.post('/api/logout', async (req, res) => {
  try {
    if (!sock) return res.status(400).json({ error: 'Não conectado' })
    
    await sock.logout()
    ready = false
    store.messages = {}
    store.lastSync = {}
    
    // Remove sessão
    const authPath = path.join(process.cwd(), 'auth')
    if (fs.existsSync(authPath)) {
      fs.rmSync(authPath, { recursive: true, force: true })
    }
    
    io.emit('logged_out')
    console.log('🚪 Logout realizado')
    
    // Reinicia para gerar novo QR
    setTimeout(startWA, 2000)
    
    res.json({ ok: true })
  } catch (e) {
    console.error('Erro no logout:', e)
    res.status(500).json({ error: 'Falha ao fazer logout' })
  }
})

// ---------------------------
// Socket.IO
// ---------------------------
io.on('connection', socket => {
  socket.emit('status', { ready })
  
  socket.on('request_history', async ({ groupId }) => {
    const messages = await syncGroupHistory(groupId, 50)
    socket.emit('history', {
      groupId,
      messages: messages.map(msg => ({
        from: msg.pushName || msg.key.participant?.split('@')[0] || 'Desconhecido',
        text: msg.message?.conversation || msg.message?.extendedTextMessage?.text || '(mídia)',
        timestamp: (msg.messageTimestamp || Date.now() / 1000) * 1000
      }))
    })
  })
})

// ---------------------------
// Inicialização
// ---------------------------
const PORT = process.env.PORT || 3000
server.listen(PORT, async () => {
  console.log(`🚀 Servidor iniciado na porta ${PORT}`)
  await startWA()
})
