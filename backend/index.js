// backend/index.js - VERSÃO MULTI-SESSÃO (5 usuários)
import express from 'express'
import http from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import SessionManager from './sessionManager.js'

const app = express()
app.use(express.json())
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'DELETE']
}))

const server = http.createServer(app)
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
})

// Configuração
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS) || 5
const sessionManager = new SessionManager(io, MAX_SESSIONS)

console.log(`🔧 Configurado para ${MAX_SESSIONS} sessões simultâneas`)

// ---------------------------
// Middleware de validação de sessão
// ---------------------------
function validateSession(req, res, next) {
  const sessionId = req.query.sessionId || req.body.sessionId || req.params.sessionId

  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId é obrigatório' })
  }

  const session = sessionManager.getSession(sessionId)
  if (!session) {
    return res.status(404).json({ error: 'Sessão não encontrada. Conecte primeiro.' })
  }

  req.sessionId = sessionId
  req.session = session
  next()
}

// Middleware para sessão opcional (cria se não existir)
function optionalSession(req, res, next) {
  const sessionId = req.query.sessionId || req.body.sessionId || req.params.sessionId

  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId é obrigatório' })
  }

  try {
    const session = sessionManager.getOrCreateSession(sessionId)
    req.sessionId = sessionId
    req.session = session
    next()
  } catch (error) {
    return res.status(429).json({ error: error.message })
  }
}

// ---------------------------
// REST: Gerenciamento de Sessões
// ---------------------------

// Status geral do servidor
app.get('/api/health', (req, res) => {
  const stats = sessionManager.getStats()
  res.json({
    status: 'online',
    uptime: process.uptime(),
    timestamp: Date.now(),
    sessions: stats
  })
})

// Lista todas as sessões (admin)
app.get('/api/sessions', (req, res) => {
  res.json({
    sessions: sessionManager.listSessions(),
    stats: sessionManager.getStats()
  })
})

// Inicia/conecta uma sessão
app.post('/api/session/start', optionalSession, async (req, res) => {
  try {
    const { sessionId } = req
    const forceNew = req.body.forceNew || false

    await sessionManager.startSession(sessionId, forceNew)

    res.json({
      success: true,
      sessionId,
      message: 'Sessão iniciada'
    })
  } catch (error) {
    console.error('Erro ao iniciar sessão:', error)
    res.status(500).json({ error: error.message })
  }
})

// Status de uma sessão específica
app.get('/api/session/status', optionalSession, (req, res) => {
  const { session, sessionId } = req

  res.json({
    sessionId,
    ready: session.ready,
    active: !!session.sock,
    lastActivity: session.lastActivity
  })
})

// ---------------------------
// REST: Envio de mensagens
// ---------------------------
app.post('/api/send', validateSession, async (req, res) => {
  try {
    const { sessionId } = req
    const { groupIds, message, replyTo } = req.body

    if (!req.session.ready) {
      return res.status(503).json({ error: 'WhatsApp não conectado' })
    }

    if (!groupIds?.length) {
      return res.status(400).json({ error: 'Nenhum grupo selecionado' })
    }

    if (!message?.trim()) {
      return res.status(400).json({ error: 'Mensagem vazia' })
    }

    console.log(`📤 [${sessionId}] Enviando para ${groupIds.length} grupo(s)`)

    const results = await sessionManager.sendMessage(sessionId, groupIds, message, replyTo)

    const successCount = results.filter(r => r.success).length
    const replyCount = results.filter(r => r.replyFound).length

    console.log(`📊 [${sessionId}] ${successCount}/${groupIds.length} enviados, ${replyCount} como reply`)

    res.json({
      ok: true,
      results,
      summary: {
        total: groupIds.length,
        success: successCount,
        replies: replyCount
      }
    })

  } catch (error) {
    console.error('Erro ao enviar:', error)
    res.status(500).json({ error: 'Falha ao enviar', details: error.message })
  }
})

// ---------------------------
// REST: Grupos
// ---------------------------
app.get('/api/groups', validateSession, async (req, res) => {
  try {
    if (!req.session.ready) {
      return res.status(503).json({ error: 'WhatsApp não conectado' })
    }

    const groups = await sessionManager.getGroups(req.sessionId)
    res.json(groups)

  } catch (error) {
    console.error('Erro ao listar grupos:', error)
    res.status(500).json({ error: 'Falha ao listar grupos' })
  }
})

// Foto do grupo
app.get('/api/group-picture/:jid', validateSession, async (req, res) => {
  try {
    if (!req.session.ready) {
      return res.status(204).end()
    }

    const url = await sessionManager.getGroupPicture(req.sessionId, req.params.jid)

    if (!url) {
      return res.status(204).end()
    }

    res.json({ url })
  } catch (error) {
    res.status(204).end()
  }
})

// ---------------------------
// REST: Logout e Reset
// ---------------------------
app.post('/api/logout', optionalSession, async (req, res) => {
  try {
    console.log(`🚪 [${req.sessionId}] Logout solicitado`)

    // Se a sessão não está conectada, apenas retorna sucesso
    if (!req.session.ready && !req.session.sock) {
      return res.json({ success: true, message: 'Sessão não estava conectada' })
    }

    const success = await sessionManager.logoutSession(req.sessionId)

    if (success) {
      res.json({ success: true, message: 'Logout realizado' })
    } else {
      res.json({ success: true, message: 'Sessão já estava desconectada' })
    }
  } catch (error) {
    console.error('Erro no logout:', error)
    res.status(500).json({ error: error.message })
  }
})

app.post('/api/reset-session', optionalSession, async (req, res) => {
  try {
    console.log(`🔄 [${req.sessionId}] Reset solicitado`)

    // Tenta fazer logout se existir conexão
    if (req.session.sock) {
      await sessionManager.logoutSession(req.sessionId)
    }

    // Reinicia a sessão
    await sessionManager.startSession(req.sessionId, true)

    res.json({ success: true, message: 'Sessão resetada' })
  } catch (error) {
    console.error('Erro no reset:', error)
    res.status(500).json({ error: error.message })
  }
})

// Deleta sessão completamente
app.delete('/api/session/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params

    const success = await sessionManager.deleteSession(sessionId)

    if (success) {
      res.json({ success: true, message: 'Sessão removida' })
    } else {
      res.status(404).json({ error: 'Sessão não encontrada' })
    }
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// ---------------------------
// REST: Debug/Cache
// ---------------------------
app.get('/api/debug/cache/:groupId', validateSession, (req, res) => {
  const messages = sessionManager.getMessageCache(req.sessionId, req.params.groupId)

  res.json({
    sessionId: req.sessionId,
    groupId: req.params.groupId,
    totalMessages: messages.length,
    messages
  })
})

// ---------------------------
// Socket.IO - Conexões por sessão
// ---------------------------
io.on('connection', (socket) => {
  const sessionId = socket.handshake.query.sessionId

  if (!sessionId) {
    console.log('⚠️ Conexão rejeitada: sem sessionId')
    socket.emit('error', { message: 'sessionId é obrigatório' })
    socket.disconnect()
    return
  }

  // Cada usuário entra na sua sala (room)
  socket.join(sessionId)
  console.log(`🔌 [${sessionId}] Cliente conectado: ${socket.id}`)

  // Tenta criar/obter sessão
  try {
    const session = sessionManager.getOrCreateSession(sessionId)

    // Envia status atual
    socket.emit('status', { ready: session.ready })

    if (session.ready) {
      socket.emit('ready')
    }

    // Se não está conectado, inicia conexão
    if (!session.sock) {
      sessionManager.startSession(sessionId)
    }

  } catch (error) {
    socket.emit('error', { message: error.message })
  }

  socket.on('disconnect', () => {
    console.log(`🔌 [${sessionId}] Cliente desconectado: ${socket.id}`)
  })

  socket.on('request-status', () => {
    const session = sessionManager.getSession(sessionId)
    socket.emit('status', { ready: session?.ready || false })
  })

  socket.on('start-session', async () => {
    try {
      await sessionManager.startSession(sessionId)
    } catch (error) {
      socket.emit('error', { message: error.message })
    }
  })
})

// ---------------------------
// Limpeza periódica
// ---------------------------
setInterval(() => {
  sessionManager.cleanupInactiveSessions(24 * 60 * 60 * 1000) // 24 horas
}, 60 * 60 * 1000) // Verifica a cada hora

// ---------------------------
// Tratamento de erros
// ---------------------------
process.on('uncaughtException', (err) => {
  console.error('❌ Erro não capturado:', err)
})

process.on('unhandledRejection', (err) => {
  console.error('❌ Promise rejeitada:', err)
})

process.on('SIGINT', async () => {
  console.log('🛑 Encerrando servidor...')

  server.close(() => {
    console.log('👋 Servidor encerrado')
    process.exit(0)
  })
})

process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM recebido, encerrando...')

  server.close(() => {
    console.log('👋 Servidor encerrado')
    process.exit(0)
  })
})

// ---------------------------
// Inicialização
// ---------------------------
const PORT = process.env.PORT || 3000

server.listen(PORT, '0.0.0.0', () => {
  console.log('═══════════════════════════════════════════')
  console.log('  🚀 WhatsApp Group Broadcaster - Multi-User')
  console.log('═══════════════════════════════════════════')
  console.log(`  📍 Porta: ${PORT}`)
  console.log(`  👥 Max Sessões: ${MAX_SESSIONS}`)
  console.log(`  📊 Health: http://localhost:${PORT}/api/health`)
  console.log(`  📋 Sessões: http://localhost:${PORT}/api/sessions`)
  console.log('═══════════════════════════════════════════')
})
