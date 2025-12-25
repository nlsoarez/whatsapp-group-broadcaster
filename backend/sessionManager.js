// backend/sessionManager.js - Gerenciador de Múltiplas Sessões WhatsApp
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers
} from '@whiskeysockets/baileys'
import pino from 'pino'
import qrcode from 'qrcode'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

class SessionManager {
  constructor(io, maxSessions = 5) {
    this.io = io
    this.maxSessions = maxSessions
    this.sessions = new Map()
    this.baseAuthDir = path.join(__dirname, 'auth')

    // Garante que o diretório base existe
    if (!fs.existsSync(this.baseAuthDir)) {
      fs.mkdirSync(this.baseAuthDir, { recursive: true })
      console.log('📁 Diretório base auth criado')
    }

    // Carrega sessões existentes
    this.loadExistingSessions()
  }

  // Carrega sessões que já existem no disco
  loadExistingSessions() {
    try {
      const dirs = fs.readdirSync(this.baseAuthDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)

      console.log(`📂 Encontradas ${dirs.length} sessões salvas`)

      dirs.forEach(sessionId => {
        // Apenas registra, não conecta automaticamente
        this.sessions.set(sessionId, {
          sock: null,
          ready: false,
          qrRetries: 0,
          store: { messages: {}, sentMessages: {}, messagePatterns: {} },
          authDir: path.join(this.baseAuthDir, sessionId),
          lastActivity: Date.now()
        })
      })
    } catch (error) {
      console.error('Erro ao carregar sessões:', error)
    }
  }

  // Retorna estatísticas das sessões
  getStats() {
    const stats = {
      total: this.sessions.size,
      active: 0,
      connected: 0,
      disconnected: 0,
      maxSessions: this.maxSessions
    }

    this.sessions.forEach(session => {
      if (session.sock) stats.active++
      if (session.ready) stats.connected++
      else stats.disconnected++
    })

    return stats
  }

  // Lista todas as sessões
  listSessions() {
    const list = []
    this.sessions.forEach((session, sessionId) => {
      list.push({
        sessionId,
        ready: session.ready,
        active: !!session.sock,
        lastActivity: session.lastActivity
      })
    })
    return list
  }

  // Cria ou obtém uma sessão
  getOrCreateSession(sessionId) {
    if (this.sessions.has(sessionId)) {
      const session = this.sessions.get(sessionId)
      session.lastActivity = Date.now()
      return session
    }

    // Verifica limite de sessões
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(`Limite de ${this.maxSessions} sessões atingido`)
    }

    const authDir = path.join(this.baseAuthDir, sessionId)
    if (!fs.existsSync(authDir)) {
      fs.mkdirSync(authDir, { recursive: true })
    }

    const session = {
      sock: null,
      ready: false,
      qrRetries: 0,
      store: { messages: {}, sentMessages: {}, messagePatterns: {} },
      authDir,
      lastActivity: Date.now()
    }

    this.sessions.set(sessionId, session)
    console.log(`📱 Nova sessão criada: ${sessionId}`)

    return session
  }

  // Obtém uma sessão existente
  getSession(sessionId) {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.lastActivity = Date.now()
    }
    return session
  }

  // Inicia conexão WhatsApp para uma sessão
  async startSession(sessionId, forceNew = false) {
    const session = this.getOrCreateSession(sessionId)

    if (forceNew || session.qrRetries > 5) {
      await this.clearSessionAuth(sessionId)
      session.qrRetries = 0
    }

    // Se já tem conexão ativa, não reconecta
    if (session.sock && session.ready) {
      console.log(`✅ Sessão ${sessionId} já conectada`)
      this.io.to(sessionId).emit('ready')
      return session
    }

    try {
      console.log(`📱 Iniciando sessão ${sessionId}...`)

      const { version } = await fetchLatestBaileysVersion()
      const { state, saveCreds } = await useMultiFileAuthState(session.authDir)

      const sock = makeWASocket({
        version,
        printQRInTerminal: false,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        logger: pino({ level: 'error' }),
        browser: Browsers.ubuntu('Chrome'),
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        emitOwnEvents: true,
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        markOnlineOnConnect: true,
        defaultQueryTimeoutMs: undefined,
        getMessage: async (key) => {
          const jid = key.remoteJid
          const messageList = session.store.messages[jid] || []
          return messageList.find(m => m.key.id === key.id)?.message || undefined
        }
      })

      session.sock = sock

      // Handler de conexão
      sock.ev.on('connection.update', async (update) => {
        const { qr, connection, lastDisconnect } = update

        if (qr) {
          session.qrRetries++
          console.log(`📱 QR Code para ${sessionId} (${session.qrRetries}/5)`)

          try {
            const dataUrl = await qrcode.toDataURL(qr, { width: 300, margin: 2 })
            this.io.to(sessionId).emit('qr', { dataUrl })
          } catch (err) {
            console.error('Erro ao gerar QR:', err)
          }

          if (session.qrRetries > 5) {
            console.log(`⚠️ Muitas tentativas para ${sessionId}, reiniciando...`)
            setTimeout(() => this.startSession(sessionId, true), 3000)
          }
        }

        if (connection === 'open') {
          session.ready = true
          session.qrRetries = 0
          this.io.to(sessionId).emit('ready')
          console.log(`✅ Sessão ${sessionId} conectada!`)
        } else if (connection === 'close') {
          session.ready = false
          this.io.to(sessionId).emit('disconnected')

          const statusCode = lastDisconnect?.error?.output?.statusCode
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut

          if (statusCode === 405 || statusCode === DisconnectReason.badSession) {
            await this.clearSessionAuth(sessionId)
          }

          if (shouldReconnect) {
            console.log(`🔄 Reconectando ${sessionId} em 10s...`)
            setTimeout(() => this.startSession(sessionId, statusCode === 405), 10000)
          } else {
            console.log(`🚪 Logout realizado para ${sessionId}`)
          }
        }
      })

      sock.ev.on('creds.update', saveCreds)

      // Handler de mensagens
      sock.ev.on('messages.upsert', async (upsert) => {
        try {
          const { messages } = upsert

          for (const msg of messages) {
            const from = msg.key.remoteJid
            if (!from || from === 'status@broadcast') continue

            if (!session.store.messages[from]) {
              session.store.messages[from] = []
            }

            const msgData = {
              key: msg.key,
              message: msg.message,
              messageTimestamp: msg.messageTimestamp,
              pushName: msg.pushName || msg.key.participant?.split('@')[0] || 'Usuário'
            }

            session.store.messages[from].push(msgData)

            // Armazena padrão
            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text
            if (text) {
              const normalized = text.toLowerCase().trim().replace(/\s+/g, ' ')
              if (!session.store.messagePatterns[normalized]) {
                session.store.messagePatterns[normalized] = []
              }
              session.store.messagePatterns[normalized].push({
                groupId: from,
                messageId: msg.key.id,
                sender: msgData.pushName
              })
            }

            // Limita cache
            if (session.store.messages[from].length > 200) {
              session.store.messages[from] = session.store.messages[from].slice(-200)
            }

            // Emite para o usuário específico
            if (!msg.key.fromMe && from.includes('@g.us')) {
              this.io.to(sessionId).emit('message', {
                groupId: from,
                from: msgData.pushName,
                text: text || '(mídia)',
                timestamp: msg.messageTimestamp * 1000,
                messageId: msg.key.id
              })
            }
          }
        } catch (error) {
          console.error(`Erro ao processar mensagens para ${sessionId}:`, error)
        }
      })

      return session

    } catch (error) {
      console.error(`❌ Erro ao iniciar sessão ${sessionId}:`, error)
      setTimeout(() => this.startSession(sessionId, true), 15000)
      throw error
    }
  }

  // Limpa autenticação de uma sessão
  async clearSessionAuth(sessionId) {
    const session = this.sessions.get(sessionId)
    if (!session) return

    try {
      if (fs.existsSync(session.authDir)) {
        fs.rmSync(session.authDir, { recursive: true, force: true })
        fs.mkdirSync(session.authDir, { recursive: true })
        console.log(`🧹 Auth limpo para ${sessionId}`)
      }
    } catch (error) {
      console.error(`Erro ao limpar auth de ${sessionId}:`, error)
    }
  }

  // Faz logout de uma sessão
  async logoutSession(sessionId) {
    const session = this.sessions.get(sessionId)
    if (!session) return false

    try {
      console.log(`🚪 Logout da sessão ${sessionId}...`)

      if (session.sock && session.ready) {
        await session.sock.logout()
      }

      await this.clearSessionAuth(sessionId)

      session.ready = false
      session.sock = null
      session.store = { messages: {}, sentMessages: {}, messagePatterns: {} }

      this.io.to(sessionId).emit('disconnected')

      // Reinicia sessão para mostrar novo QR
      setTimeout(() => this.startSession(sessionId, true), 2000)

      return true
    } catch (error) {
      console.error(`Erro no logout de ${sessionId}:`, error)
      return false
    }
  }

  // Remove uma sessão completamente
  async deleteSession(sessionId) {
    const session = this.sessions.get(sessionId)
    if (!session) return false

    try {
      if (session.sock) {
        await session.sock.logout().catch(() => {})
        session.sock.end()
      }

      if (fs.existsSync(session.authDir)) {
        fs.rmSync(session.authDir, { recursive: true, force: true })
      }

      this.sessions.delete(sessionId)
      console.log(`🗑️ Sessão ${sessionId} removida`)

      return true
    } catch (error) {
      console.error(`Erro ao deletar ${sessionId}:`, error)
      return false
    }
  }

  // Busca grupos de uma sessão
  async getGroups(sessionId) {
    const session = this.sessions.get(sessionId)
    if (!session?.sock || !session.ready) {
      throw new Error('Sessão não conectada')
    }

    const groups = await session.sock.groupFetchAllParticipating()
    return Object.values(groups).map(g => ({
      id: g.id,
      subject: g.subject || 'Grupo sem nome',
      participants: g.participants?.length || 0
    }))
  }

  // Obtém foto de um grupo
  async getGroupPicture(sessionId, jid) {
    const session = this.sessions.get(sessionId)
    if (!session?.sock || !session.ready) return null

    try {
      return await session.sock.profilePictureUrl(jid, 'image')
    } catch {
      return null
    }
  }

  // Envia mensagem
  async sendMessage(sessionId, groupIds, message, replyInfo = null) {
    const session = this.sessions.get(sessionId)
    if (!session?.sock || !session.ready) {
      throw new Error('Sessão não conectada')
    }

    const results = []

    for (const gid of groupIds) {
      try {
        let sentMessage = null
        let replyFound = false

        // Lógica de reply inteligente
        if (replyInfo?.text) {
          const groupMessages = session.store.messages[gid] || []

          // Busca exata
          let originalMessage = groupMessages.find(m => {
            const msgText = m.message?.conversation || m.message?.extendedTextMessage?.text
            return msgText === replyInfo.text
          })

          // Busca por similaridade se não encontrar exata
          if (!originalMessage && replyInfo.text) {
            const normalized = replyInfo.text.toLowerCase().trim()
            for (const msg of groupMessages) {
              const msgText = msg.message?.conversation || msg.message?.extendedTextMessage?.text
              if (msgText && msgText.toLowerCase().includes(normalized.substring(0, 30))) {
                originalMessage = msg
                break
              }
            }
          }

          if (originalMessage) {
            sentMessage = await session.sock.sendMessage(gid,
              { text: message },
              { quoted: originalMessage }
            )
            replyFound = true
          }
        }

        // Envia normal se não conseguiu reply
        if (!sentMessage) {
          const finalMessage = replyInfo && !replyFound
            ? `↩️ @${replyInfo.from || 'usuário'}: "${replyInfo.text?.substring(0, 50)}..."\n\n${message}`
            : message

          sentMessage = await session.sock.sendMessage(gid, { text: finalMessage })
        }

        // Armazena mensagem enviada
        if (sentMessage) {
          if (!session.store.messages[gid]) session.store.messages[gid] = []
          session.store.messages[gid].push({
            key: sentMessage.key,
            message: { conversation: message },
            messageTimestamp: Date.now() / 1000,
            pushName: 'Você'
          })
        }

        // Emite confirmação
        this.io.to(sessionId).emit('message_sent', {
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
          replyFound
        })

      } catch (error) {
        console.error(`❌ Erro ao enviar para ${gid}:`, error.message)
        results.push({
          groupId: gid,
          success: false,
          error: error.message
        })
      }

      // Delay entre envios
      if (groupIds.length > 1) {
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    }

    return results
  }

  // Obtém cache de mensagens
  getMessageCache(sessionId, groupId) {
    const session = this.sessions.get(sessionId)
    if (!session) return []

    const messages = session.store.messages[groupId] || []
    return messages.map(m => ({
      id: m.key?.id,
      text: m.message?.conversation || m.message?.extendedTextMessage?.text,
      from: m.pushName,
      fromMe: m.key?.fromMe,
      timestamp: new Date(m.messageTimestamp * 1000).toISOString()
    }))
  }

  // Limpeza de sessões inativas
  cleanupInactiveSessions(maxInactiveMs = 24 * 60 * 60 * 1000) {
    const now = Date.now()
    let cleaned = 0

    this.sessions.forEach((session, sessionId) => {
      if (now - session.lastActivity > maxInactiveMs && !session.ready) {
        this.deleteSession(sessionId)
        cleaned++
      }
    })

    if (cleaned > 0) {
      console.log(`🧹 ${cleaned} sessões inativas removidas`)
    }

    return cleaned
  }
}

export default SessionManager
