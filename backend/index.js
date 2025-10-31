// backend/index.js
import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import Pino from 'pino'
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys'

const PORT = process.env.PORT || 10000
const app = express()
const server = createServer(app)
const io = new Server(server, { cors: { origin: '*' } })

app.use(cors())
app.use(express.json())

// ===============================
// 🔧 CONFIGURAÇÕES GERAIS
// ===============================
const logger = Pino({ level: 'silent' })
let sock
let ready = false
const lastBroadcastByGroup = new Map()
const contactedGroups = new Set()

// ===============================
// 🧠 INICIALIZAÇÃO DO WHATSAPP
// ===============================
async function startWA() {
  const { state, saveCreds } = await useMultiFileAuthState('./session')
  const { version } = await fetchLatestBaileysVersion()
  sock = makeWASocket({
    version,
    printQRInTerminal: false,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    browser: ['Nelson Bot', 'Chrome', '1.0.0']
  })

  // 🟢 Atualização do QR Code em tempo real
  sock.ev.on('connection.update', ({ qr, connection }) => {
    if (qr) io.emit('qr', { dataUrl: `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qr)}` })
    if (connection === 'open') {
      ready = true
      io.emit('ready')
    }
    if (connection === 'close') {
      ready = false
      io.emit('disconnected')
      setTimeout(startWA, 5000)
    }
  })

  // 💾 Salva credenciais
  sock.ev.on('creds.update', saveCreds)

  // 📥 Recebe mensagens e replica se for resposta
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    const msg = messages[0]
    if (!msg.message || !msg.key.remoteJid.endsWith('@g.us')) return

    const from = msg.pushName || msg.key.participant?.split('@')[0] || 'Usuário'
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || ''
    const groupId = msg.key.remoteJid
    const timestamp = msg.messageTimestamp * 1000

    io.emit('message', { groupId, from, text, timestamp })

    // 📣 Se for resposta a uma mensagem enviada pelo bot → replica
    if (msg.message.extendedTextMessage?.contextInfo?.quotedMessage) {
      const quoted = msg.message.extendedTextMessage.contextInfo.quotedMessage.conversation || ''
      const replyText = `${from} respondeu: ${text}`
      for (const gid of contactedGroups) {
        try {
          await sock.sendMessage(gid, { text: replyText })
        } catch (err) {
          console.error('Falha ao replicar resposta:', err)
        }
      }
    }
  })
}

// ===============================
// 📡 ROTAS EXPRESS
// ===============================

// Lista de grupos
app.get('/api/groups', async (req, res) => {
  try {
    if (!sock || !ready) return res.status(503).json({ error: 'WhatsApp não conectado' })
    const participating = await sock.groupFetchAllParticipating()
    const groups = Object.values(participating).map((g) => ({ id: g.id, subject: g.subject }))
    return res.json(groups)
  } catch (e) {
    console.error(e)
    return res.status(500).json({ error: 'Falha ao listar grupos' })
  }
})

// Foto do grupo
app.get('/api/group-picture/:jid', async (req, res) => {
  try {
    if (!sock || !ready) return res.status(503).end()
    const url = await sock.profilePictureUrl(req.params.jid, 'image')
    if (!url) return res.status(204).end()
    return res.json({ url })
  } catch {
    return res.status(204).end()
  }
})

// Enviar mensagem (com suporte a reply)
app.post('/api/send', async (req, res) => {
  try {
    const { groupIds, message, replyTo } = req.body
    if (!sock || !ready) return res.status(503).json({ error: 'WhatsApp não conectado' })
    if (!Array.isArray(groupIds) || !groupIds.length || !message) {
      return res.status(400).json({ error: 'Parâmetros inválidos' })
    }

    const now = Date.now()
    const results = []
    for (const gid of groupIds) {
      const msgOptions = replyTo && replyTo.text
        ? {
            text: message,
            quoted: {
              key: { remoteJid: gid },
              message: { conversation: replyTo.text }
            }
          }
        : { text: message }

      await sock.sendMessage(gid, msgOptions)
      contactedGroups.add(gid)
      lastBroadcastByGroup.set(gid, now)
      io.emit('message_sent', { groupId: gid, text: message, timestamp: now })
      results.push({ groupId: gid, ok: true })
    }

    return res.json({ ok: true, results })
  } catch (e) {
    console.error(e)
    return res.status(500).json({ error: 'Falha no envio' })
  }
})

// Socket.IO status
io.on('connection', (socket) => {
  socket.emit('status', { ready })
})

// Inicia servidor e WhatsApp
server.listen(PORT, async () => {
  console.log(`🚀 Server on port ${PORT}`)
  await startWA()
})
