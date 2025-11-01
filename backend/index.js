// backend/index.js - VERSÃO COM REPLY INTELIGENTE MULTI-GRUPO
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

// Store expandido para melhor busca de mensagens
const store = { 
  messages: {},        // mensagens por grupo
  sentMessages: {},    // mensagens enviadas
  messagePatterns: {}  // padrões de mensagem para matching
}

// Garante que o diretório auth existe
const AUTH_DIR = path.join(__dirname, 'auth')
if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true })
  console.log('📁 Diretório auth criado')
}

// ---------------------------
// Funções auxiliares
// ---------------------------

// Normaliza texto para comparação
function normalizeText(text) {
  if (!text) return ''
  return text.toLowerCase().trim().replace(/\s+/g, ' ')
}

// Calcula similaridade entre dois textos (0 a 1)
function textSimilarity(text1, text2) {
  const norm1 = normalizeText(text1)
  const norm2 = normalizeText(text2)
  
  if (norm1 === norm2) return 1
  
  // Similaridade simples baseada em palavras comuns
  const words1 = new Set(norm1.split(' '))
  const words2 = new Set(norm2.split(' '))
  
  const intersection = new Set([...words1].filter(x => words2.has(x)))
  const union = new Set([...words1, ...words2])
  
  return intersection.size / union.size
}

// Busca mensagem similar em um grupo
function findSimilarMessage(groupId, targetText, senderName = null, threshold = 0.7) {
  const groupMessages = store.messages[groupId] || []
  
  // Primeiro tenta busca exata
  let bestMatch = groupMessages.find(m => {
    const msgText = m.message?.conversation || m.message?.extendedTextMessage?.text
    return msgText === targetText
  })
  
  if (bestMatch) return bestMatch
  
  // Se não encontrar exata, busca por similaridade
  let bestSimilarity = 0
  
  for (const msg of groupMessages) {
    const msgText = msg.message?.conversation || m.message?.extendedTextMessage?.text
    if (!msgText) continue
    
    const similarity = textSimilarity(msgText, targetText)
    
    // Se tiver nome do remetente, dá preferência a mensagens da mesma pessoa
    const senderBonus = senderName && msg.pushName === senderName ? 0.1 : 0
    const finalScore = similarity + senderBonus
    
    if (finalScore > bestSimilarity && finalScore >= threshold) {
      bestSimilarity = finalScore
      bestMatch = msg
    }
  }
  
  return bestMatch
}

// Limpa sessão
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

// Gera QR Code
async function generateQRCode(qr) {
  try {
    const dataUrl = await qrcode.toDataURL(qr, {
      width: 300,
      margin: 2
    })
    return dataUrl
  } catch (error) {
    console.error('Erro ao gerar QR Code:', error)
    return null
  }
}

// ---------------------------
// Inicialização do WhatsApp
// ---------------------------
async function startWA(forceNewSession = false) {
  try {
    if (forceNewSession || qrRetries > MAX_QR_RETRIES) {
      clearAuthState()
      qrRetries = 0
    }

    console.log('📱 Iniciando conexão WhatsApp...')
    
    const { version, isLatest } = await fetchLatestBaileysVersion()
    console.log(`📦 Baileys v${version.join('.')} ${isLatest ? '(última)' : ''}`)
    
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
    
    sock = makeWASocket({
      version,
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
      },
      logger: pino({ level: 'error' }),
      browser: Browsers.ubuntu('Chrome'),
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 10000,
      emitOwnEvents: true,
      generateHighQualityLinkPreview: true,
      syncFullHistory: false,
      markOnlineOnConnect: true,
      getMessage: async (key) => {
        const jid = key.remoteJid
        const messageList = store.messages[jid] || []
        return messageList.find(m => m.key.id === key.id)?.message || undefined
      }
    })

    // Connection handler
    sock.ev.on('connection.update', async (update) => {
      const { qr, connection, lastDisconnect } = update
      
      if (qr) {
        qrRetries++
        console.log(`📱 QR Code (tentativa ${qrRetries}/${MAX_QR_RETRIES})`)
        
        const qrDataUrl = await generateQRCode(qr)
        if (qrDataUrl) {
          io.emit('qr', { dataUrl: qrDataUrl })
        }
        
        if (qrRetries > MAX_QR_RETRIES) {
          console.log('⚠️ Muitas tentativas, reiniciando...')
          setTimeout(() => startWA(true), 3000)
        }
      }
      
      if (connection === 'open') {
        ready = true
        qrRetries = 0
        io.emit('ready')
        console.log('✅ WhatsApp conectado!')
      } else if (connection === 'close') {
        ready = false
        io.emit('disconnected')
        
        const statusCode = lastDisconnect?.error?.output?.statusCode
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut
        
        if (statusCode === 405 || statusCode === DisconnectReason.badSession) {
          clearAuthState()
        }
        
        if (shouldReconnect) {
          const delay = 10000
          console.log(`🔄 Reconectando em ${delay/1000}s...`)
          setTimeout(() => startWA(statusCode === 405), delay)
        }
      }
    })

    sock.ev.on('creds.update', saveCreds)

    // Processar mensagens com armazenamento inteligente
    sock.ev.on('messages.upsert', async (upsert) => {
      try {
        const { messages } = upsert
        
        for (const msg of messages) {
          const from = msg.key.remoteJid
          if (!from || from === 'status@broadcast') continue
          
          // Armazena mensagem
          if (!store.messages[from]) store.messages[from] = []
          
          const msgData = {
            key: msg.key,
            message: msg.message,
            messageTimestamp: msg.messageTimestamp,
            pushName: msg.pushName || msg.key.participant?.split('@')[0] || 'Usuário'
          }
          
          store.messages[from].push(msgData)
          
          // Armazena padrão de mensagem para busca posterior
          const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text
          if (text) {
            const normalizedText = normalizeText(text)
            if (!store.messagePatterns[normalizedText]) {
              store.messagePatterns[normalizedText] = []
            }
            store.messagePatterns[normalizedText].push({
              groupId: from,
              messageId: msg.key.id,
              sender: msgData.pushName
            })
          }
          
          // Limita cache
          if (store.messages[from].length > 150) {
            store.messages[from] = store.messages[from].slice(-150)
          }

          // Emite para frontend
          if (!msg.key.fromMe && from.includes('@g.us')) {
            io.emit('message', {
              groupId: from,
              from: msgData.pushName,
              text: text || '(mídia)',
              timestamp: msg.messageTimestamp * 1000,
              messageId: msg.key.id
            })
          }
        }
      } catch (error) {
        console.error('Erro ao processar mensagens:', error)
      }
    })
    
  } catch (error) {
    console.error('Erro ao iniciar WhatsApp:', error)
    setTimeout(() => startWA(), 10000)
  }
}

// ---------------------------
// REST: Envio com Reply Inteligente
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
    console.log(`📤 Enviando para ${groupIds.length} grupos...`)
    
    // Se tem replyTo, prepara informações de busca
    const replyInfo = replyTo ? {
      text: replyTo.text,
      from: replyTo.from,
      messageId: replyTo.messageId,
      originalGroupId: replyTo.groupId
    } : null
    
    for (const gid of groupIds) {
      try {
        let sentMessage = null
        let replyFound = false
        
        // Tenta fazer reply se foi solicitado
        if (replyInfo) {
          console.log(`🔍 Buscando mensagem similar em ${gid.split('@')[0]}...`)
          
          // Estratégia 1: Se é o grupo original, usa o messageId direto
          if (gid === replyInfo.originalGroupId && replyInfo.messageId) {
            const groupMessages = store.messages[gid] || []
            const originalMsg = groupMessages.find(m => m.key.id === replyInfo.messageId)
            
            if (originalMsg) {
              sentMessage = await sock.sendMessage(gid, 
                { text: message },
                { quoted: originalMsg }
              )
              replyFound = true
              console.log(`✅ Reply direto em ${gid.split('@')[0]}`)
            }
          }
          
          // Estratégia 2: Busca mensagem similar no grupo atual
          if (!replyFound && replyInfo.text) {
            const similarMsg = findSimilarMessage(
              gid, 
              replyInfo.text, 
              replyInfo.from,
              0.6 // threshold de 60% de similaridade
            )
            
            if (similarMsg) {
              sentMessage = await sock.sendMessage(gid, 
                { text: message },
                { quoted: similarMsg }
              )
              replyFound = true
              console.log(`✅ Reply por similaridade em ${gid.split('@')[0]}`)
            }
          }
          
          // Estratégia 3: Se não achou similar, tenta buscar última mensagem do mesmo remetente
          if (!replyFound && replyInfo.from) {
            const groupMessages = store.messages[gid] || []
            const lastFromSender = [...groupMessages].reverse().find(m => 
              m.pushName === replyInfo.from && 
              (m.message?.conversation || m.message?.extendedTextMessage?.text)
            )
            
            if (lastFromSender) {
              sentMessage = await sock.sendMessage(gid, 
                { text: message },
                { quoted: lastFromSender }
              )
              replyFound = true
              console.log(`✅ Reply para última msg de ${replyInfo.from} em ${gid.split('@')[0]}`)
            }
          }
        }
        
        // Se não conseguiu fazer reply ou não era pra fazer, envia normal
        if (!sentMessage) {
          // Se era pra ser reply mas não achou, adiciona contexto
          const finalMessage = replyInfo && !replyFound
            ? `↩️ @${replyInfo.from || 'usuário'}: "${replyInfo.text?.substring(0, 50)}..."\n\n${message}`
            : message
            
          sentMessage = await sock.sendMessage(gid, { text: finalMessage })
          console.log(`📨 Mensagem ${replyInfo && !replyFound ? 'com contexto' : 'normal'} em ${gid.split('@')[0]}`)
        }
        
        // Armazena mensagem enviada
        if (sentMessage) {
          const msgData = {
            key: sentMessage.key,
            message: { conversation: message },
            messageTimestamp: Date.now() / 1000,
            pushName: 'Você'
          }
          
          if (!store.messages[gid]) store.messages[gid] = []
          store.messages[gid].push(msgData)
        }
        
        // Emite confirmação
        io.emit('message_sent', { 
          groupId: gid, 
          text: message, 
          timestamp: Date.now(),
          messageId: sentMessage?.key?.id,
          isReply: replyFound
        })
        
        results.push({ 
          groupId: gid, 
          success: true, 
          messageId: sentMessage?.key?.id,
          replyFound: replyFound
        })
        
      } catch (error) {
        console.error(`❌ Erro em ${gid}:`, error.message)
        results.push({ 
          groupId: gid, 
          success: false, 
          error: error.message 
        })
      }
      
      // Pequeno delay entre envios para evitar rate limit
      if (groupIds.length > 1) {
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    }
    
    // Resumo do envio
    const successCount = results.filter(r => r.success).length
    const replyCount = results.filter(r => r.replyFound).length
    
    console.log(`📊 Resultado: ${successCount}/${groupIds.length} enviados, ${replyCount} como reply`)
    
    res.json({ 
      ok: true, 
      results,
      summary: {
        total: groupIds.length,
        success: successCount,
        replies: replyCount
      }
    })
    
  } catch (e) {
    console.error('Erro geral:', e)
    res.status(500).json({ 
      error: 'Falha ao enviar', 
      details: e.message 
    })
  }
})

// ---------------------------
// REST: Listar grupos
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
// REST: Foto do grupo
// ---------------------------
app.get('/api/group-picture/:jid', async (req, res) => {
  try {
    if (!sock || !ready) {
      return res.status(503).end()
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
// REST: Reset sessão
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
    
    res.json({ success: true, message: 'Sessão resetada' })
  } catch (error) {
    console.error('Erro ao resetar:', error)
    res.status(500).json({ error: 'Falha ao resetar' })
  }
})

// ---------------------------
// REST: Health & Debug
// ---------------------------
app.get('/api/health', (req, res) => {
  res.json({
    status: ready ? 'connected' : 'disconnected',
    uptime: process.uptime(),
    timestamp: Date.now(),
    cacheSize: {
      groups: Object.keys(store.messages).length,
      patterns: Object.keys(store.messagePatterns).length
    }
  })
})

app.get('/api/debug/cache/:groupId', async (req, res) => {
  const { groupId } = req.params
  const messages = store.messages[groupId] || []
  
  res.json({
    groupId,
    totalMessages: messages.length,
    lastMessages: messages.slice(-10).map(m => ({
      id: m.key?.id,
      text: m.message?.conversation || m.message?.extendedTextMessage?.text,
      from: m.pushName,
      fromMe: m.key?.fromMe,
      timestamp: new Date(m.messageTimestamp * 1000).toLocaleString('pt-BR')
    }))
  })
})

// ---------------------------
// Socket.IO
// ---------------------------
io.on('connection', (socket) => {
  console.log('🔌 Cliente conectado')
  
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
})

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
  console.log('🛑 Encerrando...')
  
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
  console.log(`🚀 Servidor na porta ${PORT}`)
  console.log(`📊 Health: http://localhost:${PORT}/api/health`)
  console.log('⏳ Iniciando WhatsApp...')
  
  setTimeout(() => {
    startWA()
  }, 2000)
})
