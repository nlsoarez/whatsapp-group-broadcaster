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
      // se houver contexto de resposta, inclui como "quoted"
      const msgOptions = replyTo && replyTo.text
        ? { text: message, quoted: { key: { remoteJid: gid }, message: { conversation: replyTo.text } } }
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
