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
        connectTimeoutMs: 30000,
        keepAliveIntervalMs: 25000,
        emitOwnEvents: true,
        generateHighQualityLinkPreview: false,
        syncFullHistory: true, // Reabilitado para carregar histórico
        markOnlineOnConnect: true,
        defaultQueryTimeoutMs: 30000,
        qrTimeout: 40000,
        retryRequestDelayMs: 250,
        getMessage: async (key) => {
          const jid = key.remoteJid
          const messageList = session.store.messages[jid] || []
          return messageList.find(m => m.key.id === key.id)?.message || undefined
        }
      })

      session.sock = sock

      // Handler de conexão
      sock.ev.on('connection.update', async (update) => {
        const { qr, connection, lastDisconnect, isNewLogin } = update

        // Só mostra QR se realmente precisar (não está conectado)
        if (qr && !session.ready) {
          // Throttle: evita gerar QR muito rápido (mínimo 3 segundos entre cada)
          const now = Date.now()
          if (session.lastQrTime && (now - session.lastQrTime) < 3000) {
            console.log(`⏳ QR Code ignorado (throttle) para ${sessionId}`)
            return
          }

          // Evita QR duplicado
          if (session.lastQr === qr) {
            console.log(`⏳ QR Code duplicado ignorado para ${sessionId}`)
            return
          }

          session.lastQr = qr
          session.lastQrTime = now
          session.qrRetries++

          console.log(`📱 QR Code para ${sessionId} (${session.qrRetries}/5)`)

          // Emite evento de loading imediatamente
          this.io.to(sessionId).emit('qr_loading')

          try {
            // Gera QR code com configurações otimizadas
            const dataUrl = await qrcode.toDataURL(qr, {
              width: 256,
              margin: 1,
              errorCorrectionLevel: 'M',
              color: {
                dark: '#000000',
                light: '#FFFFFF'
              }
            })
            this.io.to(sessionId).emit('qr', { dataUrl })
            console.log(`✅ QR Code enviado para ${sessionId}`)
          } catch (err) {
            console.error('Erro ao gerar QR:', err)
            try {
              const simpleQr = await qrcode.toDataURL(qr)
              this.io.to(sessionId).emit('qr', { dataUrl: simpleQr })
            } catch (e) {
              this.io.to(sessionId).emit('qr_error', { message: 'Erro ao gerar QR Code' })
            }
          }

          if (session.qrRetries > 5) {
            console.log(`⚠️ Muitas tentativas para ${sessionId}, reiniciando...`)
            session.lastQr = null
            session.lastQrTime = null
            setTimeout(() => this.startSession(sessionId, true), 5000)
          }
        }

        if (connection === 'open') {
          // Só emite se não estava pronto antes
          if (!session.ready) {
            session.ready = true
            session.qrRetries = 0
            session.lastQr = null
            session.lastQrTime = null
            this.io.to(sessionId).emit('ready')
            console.log(`✅ Sessão ${sessionId} conectada!`)
          }
        } else if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut

          // Só emite disconnected se realmente desconectou (não temporário)
          if (session.ready) {
            session.ready = false

            // Só notifica o frontend se for logout ou erro grave
            if (!shouldReconnect || statusCode === 401 || statusCode === 403 || statusCode === 405) {
              this.io.to(sessionId).emit('disconnected')
              console.log(`❌ Sessão ${sessionId} desconectada (código: ${statusCode})`)
            } else {
              console.log(`🔄 Reconexão temporária para ${sessionId} (código: ${statusCode})`)
            }
          }

          if (statusCode === 405 || statusCode === DisconnectReason.badSession) {
            await this.clearSessionAuth(sessionId)
          }

          if (shouldReconnect) {
            console.log(`🔄 Reconectando ${sessionId} em 5s...`)
            setTimeout(() => this.startSession(sessionId, statusCode === 405), 5000)
          } else {
            console.log(`🚪 Logout realizado para ${sessionId}`)
            this.io.to(sessionId).emit('disconnected')
          }
        }
      })

      sock.ev.on('creds.update', saveCreds)

      // Inicializa mapa de contatos
      if (!session.store.contacts) session.store.contacts = {}

      // Handler de contatos - contacts.set (sincronização inicial)
      sock.ev.on('contacts.set', ({ contacts }) => {
        console.log(`📇 [${sessionId}] Contatos recebidos: ${contacts?.length || 0}`)
        if (contacts && contacts.length > 0) {
          contacts.forEach(c => {
            if (c.id) {
              const name = c.name || c.notify || c.verifiedName
              if (name) {
                // Armazena com ID completo e apenas número para facilitar matching
                session.store.contacts[c.id] = name
                const number = c.id.split('@')[0]
                if (number) session.store.contacts[number] = name
              }
            }
          })
          console.log(`📇 [${sessionId}] Total de contatos armazenados: ${Object.keys(session.store.contacts).length}`)
        }
      })

      // Handler de contatos - contacts.upsert (atualizações)
      sock.ev.on('contacts.upsert', (contacts) => {
        if (contacts && contacts.length > 0) {
          contacts.forEach(c => {
            if (c.id) {
              const name = c.name || c.notify || c.verifiedName
              if (name) {
                session.store.contacts[c.id] = name
                const number = c.id.split('@')[0]
                if (number) session.store.contacts[number] = name
              }
            }
          })
        }
      })

      // Helper para formatar ID de usuário quando não tem nome
      const formatUserId = (participantId) => {
        if (!participantId) return 'Desconhecido'

        const number = participantId.split('@')[0]
        if (!number) return 'Desconhecido'

        // Mostra formato amigável: "Usuário ~XXXX" (últimos 4 dígitos)
        const lastDigits = number.slice(-4)
        return `Usuário ~${lastDigits}`
      }

      // Helper para resolver nome de contato
      const resolveContactName = (participantId, pushName) => {
        // Primeiro tenta o pushName se não for um número puro (ID)
        if (pushName && !pushName.match(/^\d{8,}$/)) {
          return pushName
        }

        if (!participantId) return pushName || 'Desconhecido'

        // Tenta do mapa de contatos
        if (session.store.contacts) {
          // ID completo
          let name = session.store.contacts[participantId]
          if (name && !name.match(/^\d{8,}$/)) return name

          // Apenas número
          const number = participantId.split('@')[0]
          name = session.store.contacts[number]
          if (name && !name.match(/^\d{8,}$/)) return name

          // Com sufixo @s.whatsapp.net
          name = session.store.contacts[`${number}@s.whatsapp.net`]
          if (name && !name.match(/^\d{8,}$/)) return name
        }

        // Se não encontrou nome, mostra formato amigável do ID
        return formatUserId(participantId)
      }

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

            // Resolve nome do remetente usando helper
            const participant = msg.key.participant || msg.participant
            const senderName = resolveContactName(participant, msg.pushName || msg.verifiedBizName)

            const msgData = {
              key: msg.key,
              message: msg.message,
              messageTimestamp: msg.messageTimestamp,
              pushName: senderName,
              participant: participant // Armazena participant para busca posterior
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

      // Handler para histórico sincronizado
      sock.ev.on('messaging-history.set', async ({ chats, contacts, messages, isLatest }) => {
        try {
          console.log(`📜 [${sessionId}] Histórico recebido: ${messages?.length || 0} mensagens, ${chats?.length || 0} chats, ${contacts?.length || 0} contatos`)

          // Armazena contatos para buscar nomes
          if (contacts && contacts.length > 0) {
            if (!session.store.contacts) session.store.contacts = {}
            contacts.forEach(c => {
              if (c.id) {
                const name = c.name || c.notify || c.verifiedName
                if (name) {
                  session.store.contacts[c.id] = name
                  const number = c.id.split('@')[0]
                  if (number) session.store.contacts[number] = name
                }
              }
            })
            console.log(`📇 [${sessionId}] Contatos do histórico: ${Object.keys(session.store.contacts).length}`)
          }

          if (messages && messages.length > 0) {
            let processedCount = 0
            for (const msg of messages) {
              const from = msg.key?.remoteJid
              if (!from || from === 'status@broadcast') continue

              // Apenas grupos
              if (!from.includes('@g.us')) continue

              if (!session.store.messages[from]) {
                session.store.messages[from] = []
              }

              // Resolve nome do remetente usando helper
              const participant = msg.key?.participant || msg.participant
              const senderName = resolveContactName(participant, msg.pushName || msg.verifiedBizName)

              const msgData = {
                key: msg.key,
                message: msg.message,
                messageTimestamp: msg.messageTimestamp,
                pushName: senderName,
                participant: participant
              }

              // Evita duplicatas
              const exists = session.store.messages[from].some(m => m.key?.id === msg.key?.id)
              if (!exists) {
                session.store.messages[from].push(msgData)
                processedCount++
              }
            }

            // Ordena e limita
            for (const groupId of Object.keys(session.store.messages)) {
              session.store.messages[groupId].sort((a, b) =>
                (a.messageTimestamp || 0) - (b.messageTimestamp || 0)
              )
              if (session.store.messages[groupId].length > 200) {
                session.store.messages[groupId] = session.store.messages[groupId].slice(-200)
              }
            }

            console.log(`✅ [${sessionId}] Histórico: ${processedCount} msgs processadas em ${Object.keys(session.store.messages).length} grupos`)
          }
        } catch (error) {
          console.error(`❌ [${sessionId}] Erro ao processar histórico:`, error)
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

  // Busca grupos de uma sessão e armazena participantes
  async getGroups(sessionId) {
    const session = this.sessions.get(sessionId)
    if (!session?.sock || !session.ready) {
      throw new Error('Sessão não conectada')
    }

    const groups = await session.sock.groupFetchAllParticipating()

    // Armazena participantes dos grupos para resolver nomes
    if (!session.store.contacts) session.store.contacts = {}

    for (const group of Object.values(groups)) {
      if (group.participants) {
        for (const participant of group.participants) {
          // Só sobrescreve se ainda não tem nome ou se é só número
          const existing = session.store.contacts[participant.id]
          const name = participant.name || participant.notify || participant.verifiedName
          if (name && (!existing || existing.match(/^\d+$/))) {
            session.store.contacts[participant.id] = name
          }
        }
      }
    }

    console.log(`📇 [${sessionId}] Contatos após grupos: ${Object.keys(session.store.contacts).length}`)

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
        if (replyInfo?.text || replyInfo?.messageId) {
          const groupMessages = session.store.messages[gid] || []
          console.log(`🔍 [${sessionId}] Buscando mensagem para reply em ${gid} (${groupMessages.length} mensagens no cache)`)
          console.log(`🔍 Procurando: ID="${replyInfo.messageId}" texto="${replyInfo.text?.substring(0, 50)}" de="${replyInfo.from}"`)

          let originalMessage = null

          // 1. PRIORIDADE: Busca direta por messageId (mais confiável)
          if (replyInfo.messageId) {
            originalMessage = groupMessages.find(m => m.key?.id === replyInfo.messageId)
            if (originalMessage) {
              console.log(`✅ Match exato por messageId: ${replyInfo.messageId}`)
            }
          }

          // 2. Busca exata por texto
          if (!originalMessage && replyInfo.text) {
            originalMessage = groupMessages.find(m => {
              const msgText = m.message?.conversation || m.message?.extendedTextMessage?.text || ''
              return msgText === replyInfo.text
            })
            if (originalMessage) {
              console.log(`✅ Match exato por texto`)
            }
          }

          // 3. Busca por similaridade se não encontrar exata (texto começa igual)
          if (!originalMessage && replyInfo.text) {
            const normalized = replyInfo.text.toLowerCase().trim()
            const searchLen = Math.min(normalized.length, 50)

            for (const msg of groupMessages) {
              const msgText = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').toLowerCase().trim()
              // Verifica se o texto começa igual ou contém o início do texto buscado
              if (msgText && (msgText.startsWith(normalized.substring(0, searchLen)) || msgText.includes(normalized.substring(0, 30)))) {
                originalMessage = msg
                console.log(`✅ Match por similaridade de texto`)
                break
              }
            }
          }

          // 4. Busca pelo remetente + texto parcial (mais flexível)
          if (!originalMessage && replyInfo.from && replyInfo.text) {
            const senderName = replyInfo.from.toLowerCase()
            const textStart = replyInfo.text.toLowerCase().substring(0, 20)

            for (const msg of groupMessages) {
              const msgSender = (msg.pushName || '').toLowerCase()
              const msgText = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').toLowerCase()

              // Match se o remetente é similar e o texto contém o início
              if ((msgSender && senderName && (msgSender.includes(senderName.substring(0, 8)) || senderName.includes(msgSender.substring(0, 8))))) {
                if (msgText && textStart && msgText.includes(textStart)) {
                  originalMessage = msg
                  console.log(`✅ Match por remetente + texto parcial`)
                  break
                }
              }
            }
          }

          // 5. Busca nos messagePatterns (índice de texto normalizado)
          if (!originalMessage && session.store.messagePatterns && replyInfo.text) {
            const normalizedSearch = replyInfo.text.toLowerCase().trim().replace(/\s+/g, ' ')
            const patternMatch = session.store.messagePatterns[normalizedSearch]

            if (patternMatch) {
              const matchInGroup = patternMatch.find(p => p.groupId === gid)
              if (matchInGroup) {
                originalMessage = groupMessages.find(m => m.key?.id === matchInGroup.messageId)
                if (originalMessage) {
                  console.log(`✅ Match por messagePatterns`)
                }
              }
            }
          }

          // 6. Última tentativa: busca por qualquer texto que contenha a string
          if (!originalMessage && replyInfo.text && replyInfo.text.length >= 10) {
            const searchText = replyInfo.text.toLowerCase().trim().substring(0, 40)
            for (const msg of groupMessages) {
              const msgText = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').toLowerCase().trim()
              if (msgText && msgText.includes(searchText)) {
                originalMessage = msg
                console.log(`✅ Match por busca parcial de texto`)
                break
              }
            }
          }

          if (originalMessage) {
            try {
              sentMessage = await session.sock.sendMessage(gid,
                { text: message },
                { quoted: originalMessage }
              )
              replyFound = true
              console.log(`✅ Reply nativo enviado com sucesso para ${gid}`)
            } catch (quoteError) {
              console.log(`⚠️ Erro ao enviar reply nativo, usando fallback: ${quoteError.message}`)
            }
          } else {
            console.log(`⚠️ Mensagem original não encontrada para reply em ${gid}`)
          }
        }

        // Envia normal se não conseguiu reply nativo
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

    // Helper para formatar ID de usuário quando não tem nome
    const formatUserId = (participantId) => {
      if (!participantId) return 'Desconhecido'
      const number = participantId.split('@')[0]
      if (!number) return 'Desconhecido'
      const lastDigits = number.slice(-4)
      return `Usuário ~${lastDigits}`
    }

    // Helper para buscar nome do contato
    const getContactName = (participantId, pushName) => {
      // Primeiro tenta o pushName se não for um ID numérico
      if (pushName && !pushName.match(/^\d{8,}$/)) {
        return pushName
      }

      if (!participantId) return pushName || null

      // Tenta do mapa de contatos
      if (session.store.contacts) {
        let name = session.store.contacts[participantId]
        if (name && !name.match(/^\d{8,}$/)) return name

        const number = participantId.split('@')[0]
        name = session.store.contacts[number]
        if (name && !name.match(/^\d{8,}$/)) return name

        name = session.store.contacts[`${number}@s.whatsapp.net`]
        if (name && !name.match(/^\d{8,}$/)) return name
      }

      // Se não encontrou nome, mostra formato amigável do ID
      return formatUserId(participantId)
    }

    return messages.map(m => {
      const participant = m.key?.participant || m.participant
      const senderName = getContactName(participant, m.pushName)

      return {
        id: m.key?.id,
        text: m.message?.conversation || m.message?.extendedTextMessage?.text,
        from: senderName || 'Desconhecido',
        fromMe: m.key?.fromMe,
        timestamp: new Date(m.messageTimestamp * 1000).toISOString(),
        participant: participant
      }
    })
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
