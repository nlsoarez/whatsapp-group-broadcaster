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
