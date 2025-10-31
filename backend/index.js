// backend/index.js
app.get('/api/groups', async (req, res) => {
try {
if (!sock || !ready) return res.status(503).json({ error: 'WhatsApp não conectado' })
const participating = await sock.groupFetchAllParticipating()
const groups = Object.values(participating).map((g) => ({ id: g.id, subject: g.subject }))
// Opcional: buscar foto de perfil de forma preguiçosa no frontend
return res.json(groups)
} catch (e) {
console.error(e)
return res.status(500).json({ error: 'Falha ao listar grupos' })
}
})


// REST: foto do grupo (para não atrasar a listagem principal)
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


// REST: enviar mensagem para grupos
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


// Socket.IO: status de conexão sob demanda
io.on('connection', (socket) => {
socket.emit('status', { ready })
})


server.listen(PORT, async () => {
console.log('Server on :', PORT)
await startWA()
})
