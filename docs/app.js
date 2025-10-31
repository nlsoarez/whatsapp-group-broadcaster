// frontend/app.js
if (!state.chatByGroup.has(groupId)) state.chatByGroup.set(groupId, [])
state.chatByGroup.get(groupId).push({ who, text, ts })
renderChats()
}


function renderChats() {
el.chats.innerHTML = ''
for (const [gid, msgs] of state.chatByGroup.entries()) {
const group = state.groups.find(g => g.id === gid)
const card = document.createElement('div')
card.className = 'border rounded-lg p-3'
const title = document.createElement('div')
title.className = 'font-semibold mb-2'
title.textContent = group ? group.subject : gid
card.appendChild(title)


for (const m of msgs.slice(-50)) { // limita exibição
const line = document.createElement('div')
line.className = 'text-sm mb-1'
const time = new Date(m.ts).toLocaleTimeString()
line.textContent = `[${time}] ${m.who}: ${m.text}`
card.appendChild(line)
}


el.chats.appendChild(card)
}
}


el.send.addEventListener('click', async () => {
const text = el.message.value.trim()
if (!text) return alert('Escreva uma mensagem')
const ids = Array.from(state.selected)
if (!ids.length) return alert('Selecione ao menos um grupo')


el.send.disabled = true
try {
const r = await fetch(`${BACKEND_URL}/api/send`, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ groupIds: ids, message: text })
})
const data = await r.json()
if (!r.ok || !data.ok) throw new Error(data.error || 'Falha')
const now = Date.now()
for (const gid of ids) pushChat(gid, 'Você', text, now)
} catch (e) {
alert('Falha ao enviar: ' + e.message)
} finally {
el.send.disabled = false
}
})


// Socket events
socket.on('qr', ({ dataUrl }) => setQR(dataUrl))
socket.on('ready', () => { setStatus('WhatsApp conectado ✅', true); fetchGroups() })
socket.on('disconnected', () => setStatus('Desconectado. Aguarde novo QR ou reconexão.'))
socket.on('status', ({ ready }) => {
if (ready) { setStatus('WhatsApp conectado ✅', true); fetchGroups() }
})
socket.on('message', ({ groupId, from, text, timestamp }) => {
pushChat(groupId, from, text || '(mídia sem legenda)', timestamp)
})
socket.on('message_sent', ({ groupId, text, timestamp }) => {
pushChat(groupId, 'Você', text, timestamp)
})
