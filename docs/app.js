// --- ADIÇÃO: permitir responder mensagens anteriores ---
let replyContext = null

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

    for (const m of msgs.slice(-50)) {
      const line = document.createElement('div')
      line.className = 'text-sm mb-1 cursor-pointer hover:bg-slate-100 p-1 rounded'
      const time = new Date(m.ts).toLocaleTimeString()
      line.textContent = `[${time}] ${m.who}: ${m.text}`

      // ➕ Clique numa mensagem preenche campo de resposta
      line.addEventListener('click', () => {
        replyContext = { gid, text: m.text }
        el.message.value = `↩️ Respondendo: "${m.text}"`
        el.message.focus()
      })

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
      body: JSON.stringify({ groupIds: ids, message: text, replyTo: replyContext })
    })
    const data = await r.json()
    if (!r.ok || !data.ok) throw new Error(data.error || 'Falha')
    const now = Date.now()
    for (const gid of ids) pushChat(gid, 'Você', text, now)
    replyContext = null
    el.message.value = ''
  } catch (e) {
    alert('Falha ao enviar: ' + e.message)
  } finally {
    el.send.disabled = false
  }
})
