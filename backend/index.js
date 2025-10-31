// backend/index.js
import express from 'express'
import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys'
import { createServer } from 'http'
import { Server } from 'socket.io'
import Pino from 'pino'
import cors from 'cors'

const PORT = process.env.PORT || 10000
const app = express()
const server = createServer(app)
const io = new Server(server, { cors: { origin: '*' } })

app.use(cors())
app.use(express.json())

let sock
let ready = false
const contactedGroups = new Set() // mantém todos os grupos que já receberam mensagens
const lastBroadcastByGroup = new Map()

// 🧠 Extrair texto de mensagem
function extractMessageText(m) {
  try {
    if (m.message?.conversation) return m.message.conversation
    if (m.message?.extendedTextMessage?.text) return m.message.extendedTextMessage.text
    if (m.message?.imageMessage?.caption) return m.message.imageMessage.caption
    if (m.message?.videoMessage?.caption) return m.message.videoMessage.caption
    return ''
  } catch {
    return ''
  }
}

// 🚀 Inicializar WhatsApp
async function startWA() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    printQRInTerminal: false,
    logger: Pino({ level: 'silent' }),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, Pino({ level: 'silent' })),
    },
    syncFullHistory: false
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, qr } = update

    if (qr) {
      io.emit('qr', { dataUrl: await import('qrcode').then(qrPkg => qrPkg.toDataURL(qr)) })
    }

    if (connection === 'open') {
      ready = true
      io.emit('ready')
      console.log('✅ WhatsApp conectado!')
    }

    if (connection === 'close') {
      ready = false
      io.emit('disconnected')
      console.log('❌ Conexão perdida. Tentando reconectar...')
      setTimeout(() => startWA(), 5000)
    }
  })

  // 📩 Captura e replicação total
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    for (const m of messages) {
      const jid = m.key?.remoteJid
      if (!jid?.endsWith('@g.us')) continue

      const ts = (m.messageTimestamp || Date.now()) * 1000
      const body = extractMessageText(m)
      if (!body) continue

      const fromMe = m.key.fromMe
      const from = fromMe ? 'Você' : (m.pushName || m.key?.participant || 'desconhecido')

      // Envia para o frontend
      io.emit('message', { groupId: jid, from, text: body, timestamp: ts })

      // 🔁 Se a mensagem foi enviada por você → replica em todos os grupos já contatados
      if (fromMe) {
        const now = Date.now()
        for (const targetId of contactedGroups) {
          if (targetId === jid) continue
          try {
            await sock.sendMessage(targetId, { text: body })
            io.emit('message_sent', { groupId: targetId, text: body, timestamp: now })
            console.log(`🔁 Replicada sua resposta de ${jid} → ${targetId}`)
          } catch (err) {
            console.error('Erro ao replicar resposta:', err)
          }
        }
      }
    }
  })
}

// 🌐 REST APIs
app.get('/api/groups', async (req, res) => {
  try {
    if (!sock || !ready) return res.status(503).json({ error: 'WhatsApp não conectado' })
    const participating = await sock.groupFetchAllParticipating()
    const groups = Object.values(participating).map(g => ({ id: g.id, subject: g.subject }))
    return res.json(groups)
  } catch (e) {
    console.error(e)
    return res.status(500).json({ error: 'Falha ao listar grupos' })
  }
})

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

app.post('/api/send', async (req, res) => {
  try {
    const { groupIds, message } = req.body
    if (!sock || !ready) return res.status(503).json({ error: 'WhatsApp não conectado' })
    if (!Array.isArray(groupIds) || !groupIds.length || !message) {
      return res.status(400).json({ error: 'Parâmetros inválidos' })
    }

    const now = Date.now()
    const results = []
    for (const gid of groupIds) {
      await sock.sendMessage(gid, { text: message })
      contactedGroups.add(gid) // adiciona ao histórico global
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

// ⚡ WebSocket
io.on('connection', (socket) => {
  console.log('Cliente conectado ao socket')
  socket.emit('status', { ready })
})

// 🚀 Inicia servidor
server.listen(PORT, async () => {
  console.log(`🚀 Server on port ${PORT}`)
  await startWA()
})
