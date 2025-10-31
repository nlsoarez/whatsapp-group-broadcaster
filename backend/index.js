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
const store = { messages: {} } // cache de mensagens

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
    if (qr) io.emit('qr', { dataUrl: awaitQRCode(qr) })
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

  // Armazena mensagens recebidas
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      const from = msg.key.remoteJid
      if (!store.messages[from]) store.messages[from] = []
      store.messages[from].push(msg)

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        '(mídia)'
      io.emit('message', {
        groupId: from,
        from: msg.pushName || msg.key.participant || 'Desconhecido',
        text,
        timestamp: msg.messageTimestamp * 1000
      })
    }
  })
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
        } else {
          // fallback se não encontrar a msg original
          message = `*${replyTo.from || 'Você'} respondeu:* ${replyTo.text}\n\n${message}`
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
// Socket.IO: status sob demanda
// ---------------------------
io.on('connection', socket => {
  socket.emit('status', { ready })
})

// ---------------------------
// Inicialização do servidor
// ---------------------------
const PORT = process.env.PORT || 3000
server.listen(PORT, async () => {
  console.log(`🚀 Servidor iniciado na porta ${PORT}`)
  await startWA()
})
