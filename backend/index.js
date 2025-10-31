// backend/index.js
import 'dotenv/config'
import express from 'express'
import http from 'http'
import cors from 'cors'
import { Server as SocketIOServer } from 'socket.io'
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import Pino from 'pino'
import QRCode from 'qrcode'
import { getAuthState, getSignalKeyStore } from './sessionStore.js'

const PORT = process.env.PORT || 3000
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*'

// --- Configuração do servidor Express + Socket.IO ---
const app = express()
const server = http.createServer(app)
const io = new SocketIOServer(server, {
  cors: { origin: FRONTEND_ORIGIN, methods: ['GET', 'POST'] }
})

app.use(cors({ origin: FRONTEND_ORIGIN }))
app.use(express.json({ limit: '1mb' }))

// --- Variáveis globais ---
let sock
let ready = false
let lastBroadcastByGroup = new Map()

// --- Inicialização do WhatsApp (Baileys) ---
async function startWA() {
  const { state, saveCreds } = await getAuthState()
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    printQRInTerminal: false,
    logger: Pino({ level: 'silent' }),
    auth: { creds: state.creds, keys: getSignalKeyStore(state) },
    syncFullHistory: false
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u

    if (qr) {
      const dataUrl = await QRCode.toDataURL(qr)
      io.emit('qr', { dataUrl })
    }

    if (connection === 'open') {
      ready = true
      io.emit('ready')
      console.log('✅ WhatsApp conectado!')
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      ready = false
      io.emit('disconnected', { code })
      console.log('⚠️ Conexão encerrada, tentando reconectar...')
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(startWA, 1000)
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const m of messages) {
      const jid = m.key?.remoteJid
      if (!jid?.endsWith('@g.us')) continue
      const ts = (m.messageTimestamp || Date.now()) * 1000
      const lastTs = lastBroadcastByGroup.get(jid) || 0
      if (ts < lastTs) continue

      const body = extractMessageText(m)
      const from = m.pushName || m.key?.participant || 'desconhecido'

      io.emit('message', {
        groupId: jid,
        from,
        text: body,
        timestamp: ts
      })
    }
  })
}

function extractMessageText(m) {
  const msg = m.message || {}
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    ''
  )
}

// --- Rotas REST ---
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

app.get('/api/group-picture/:jid', async (req, res) => {
  try {
    if (!sock || !ready) return res.status(503).end()
    const url = await sock.profilePictureUrl(req.params.jid, 'image')
    if (!url) return res.status(204).end()
    return res.json({ url })
  } catch (e) {
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

// --- Socket.IO: status ---
io.on('connection', (socket) => {
  socket.emit('status', { ready })
})

// --- Inicializa servidor ---
server.listen(PORT, async () => {
  console.log('🚀 Server on port', PORT)
  await startWA()
})
