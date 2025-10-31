sock.ev.on('messages.upsert', async ({ messages, type }) => {
  if (type !== 'notify') return

  for (const m of messages) {
    const jid = m.key?.remoteJid
    if (!jid?.endsWith('@g.us')) continue

    const ts = (m.messageTimestamp || Date.now()) * 1000
    const lastTs = lastBroadcastByGroup.get(jid) || 0
    const body = extractMessageText(m)
    if (!body || ts < lastTs) continue

    const from = m.pushName || m.key?.participant || 'desconhecido'

    // Emite no painel
    io.emit('message', {
      groupId: jid,
      from,
      text: body,
      timestamp: ts
    })

    // --- 🔁 NOVO: replicar resposta em todos os grupos que receberam broadcast ---
    const now = Date.now()
    const broadcastedGroups = Array.from(lastBroadcastByGroup.keys())
    if (broadcastedGroups.includes(jid)) {
      // Envia essa mesma mensagem para todos os outros grupos do broadcast
      for (const targetId of broadcastedGroups) {
        if (targetId === jid) continue // evita loop infinito
        try {
          await sock.sendMessage(targetId, { text: body })
          io.emit('message_sent', { groupId: targetId, text: body, timestamp: now })
          console.log(`🔁 Mensagem replicada de ${jid} para ${targetId}`)
        } catch (err) {
          console.error('Erro ao replicar mensagem:', err)
        }
      }
    }
  }
})
