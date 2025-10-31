// docs/app.js
document.addEventListener('DOMContentLoaded', () => {
  const socket = io(window.BACKEND_URL)

  const el = {
    qr: document.getElementById('qr'),
    status: document.getElementById('wa-status'),
    groups: document.getElementById('groups'),
    chats: document.getElementById('chats'),
    message: document.getElementById('message'),
    send: document.getElementById('send')
  }

  const state = {
    groups: [],
    selected: new Set(),
    chatByGroup: new Map(),
    replyingTo: null
  }

  // ---- Helpers ----
  function setQR(url) {
    el.qr.innerHTML = `<img src="${url}" alt="QR Code" class="w-full h-full object-contain rounded-lg" />`
  }

  function setStatus(text, ok) {
    el.status.innerHTML = `<span class="${ok ? 'text-emerald-600' : 'text-red-600'}">${text}</span>`
  }

  function pushChat(groupId, who, text, ts, replyTo = null) {
    if (!state.chatByGroup.has(groupId)) state.chatByGroup.set(groupId, [])
    state.chatByGroup.get(groupId).push({ who, text, ts, replyTo })
    renderChats()
  }

  // ---- Render Chats ----
  function renderChats() {
    el.chats.innerHTML = ''
    for (const [gid, msgs] of state.chatByGroup.entries()) {
      const group = state.groups.find(g => g.id === gid)
      const card = document.createElement('div')
      card.className = 'border rounded-lg p-3 bg-white shadow-sm mb-3'

      const title = document.createElement('div')
      title.className = 'font-semibold mb-2 text-slate-800'
      title.textContent = group ? group.subject : gid
      card.appendChild(title)

      for (const m of msgs.slice(-50)) {
        const wrapper = document.createElement('div')
        wrapper.className = 'text-sm mb-2 border-l-2 border-slate-200 pl-2 hover:bg-slate-50 rounded cursor-pointer'

        // Caso seja uma resposta
        if (m.replyTo) {
          const quoted = document.createElement('div')
          quoted.className = 'text-xs text-slate-500 bg-slate-100 rounded px-2 py-1 mb-1'
          quoted.textContent = `${m.replyTo.who}: ${m.replyTo.text}`
          wrapper.appendChild(quoted)
        }

        const time = new Date(m.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
        wrapper.innerHTML += `<b>${m.who}</b> <span class="text-xs text-slate-500">[${time}]</span><br>${m.text}`

        wrapper.onclick = () => {
          state.replyingTo = { groupId: gid, text: m.text, who: m.who }
          el.message.value = `↩️ Respondendo a ${m.who}: ${m.text}\n\n`
          el.message.focus()
        }

        card.appendChild(wrapper)
      }
      el.chats.appendChild(card)
    }
  }

  // ---- Render Grupos ----
  function renderGroups() {
    el.groups.innerHTML = ''
    for (const g of state.groups) {
      const div = document.createElement('div')
      div.className = 'flex items-center space-x-2 border rounded-lg p-2 hover:bg-slate-50'

      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.className = 'w-4 h-4'
      checkbox.onchange = () => {
        if (checkbox.checked) state.selected.add(g.id)
        else state.selected.delete(g.id)
      }

      const img = document.createElement('img')
      img.className = 'w-8 h-8 rounded-full object-cover'
      fetch(`${window.BACKEND_URL}/api/group-picture/${g.id}`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d?.url) img.src = d.url })
        .catch(() => {})

      const span = document.createElement('span')
      span.textContent = g.subject
      span.className = 'text-sm font-medium'

      div.appendChild(checkbox)
      div.appendChild(img)
      div.appendChild(span)
      el.groups.appendChild(div)
    }
  }

  async function fetchGroups() {
    const r = await fetch(`${window.BACKEND_URL}/api/groups`)
    const data = await r.json()
    if (r.ok) {
      state.groups = data
      renderGroups()
    }
  }

  // ---- Envio ----
  el.send.addEventListener('click', async () => {
    const text = el.message.value.trim()
    if (!text) return alert('Escreva uma mensagem.')
    const ids = Array.from(state.selected)
    if (!ids.length) return alert('Selecione ao menos um grupo.')

    const payload = { groupIds: ids, message: text }
    if (state.replyingTo) payload.replyTo = state.replyingTo

    el.send.disabled = true
    try {
      const r = await fetch(`${window.BACKEND_URL}/api/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      const data = await r.json()
      if (!r.ok || !data.ok) throw new Error(data.error || 'Falha no envio.')

      const now = Date.now()
      for (const gid of ids)
        pushChat(gid, 'Você', text, now, state.replyingTo || null)

      el.message.value = ''
      state.replyingTo = null
    } catch (e) {
      alert('Erro ao enviar: ' + e.message)
    } finally {
      el.send.disabled = false
    }
  })

  // ---- Socket.IO ----
  socket.on('connect', () => console.log('✅ Socket conectado ao backend'))
  socket.on('qr', ({ dataUrl }) => setQR(dataUrl))
  socket.on('ready', () => { setStatus('WhatsApp conectado ✅', true); fetchGroups() })
  socket.on('disconnected', () => setStatus('Desconectado. Aguarde novo QR ou reconexão.', false))
  socket.on('status', ({ ready }) => { if (ready) { setStatus('WhatsApp conectado ✅', true); fetchGroups() } })
  socket.on('message', ({ groupId, from, text, timestamp }) => {
    pushChat(groupId, from, text || '(mídia)', timestamp)
  })
  socket.on('message_sent', ({ groupId, text, timestamp }) => {
    pushChat(groupId, 'Você', text, timestamp)
  })
})
