// docs/app.js
// --- Configuração base ---
const BACKEND_URL = (window.BACKEND_URL || 'http://localhost:3000').replace(/\/$/, '')
const socket = io(BACKEND_URL, { transports: ['websocket'] })

// --- Elementos do DOM ---
const el = {
  qr: document.getElementById('qr'),
  waStatus: document.getElementById('wa-status'),
  groups: document.getElementById('groups'),
  chats: document.getElementById('chats'),
  send: document.getElementById('send'),
  message: document.getElementById('message')
}

// --- Estado ---
const state = {
  groups: [],
  selected: new Set(),
  chatByGroup: new Map()
}

// --- Exibe o QR ---
function setQR(dataUrl) {
  el.qr.innerHTML = ''
  const img = document.createElement('img')
  img.src = dataUrl
  img.className = 'w-full h-full object-contain rounded-lg'
  el.qr.appendChild(img)
}

// --- Atualiza status ---
function setStatus(text, good = false) {
  el.waStatus.textContent = text
  el.waStatus.className = `mt-2 text-sm ${good ? 'text-emerald-700' : 'text-slate-600'}`
}

// --- Buscar grupos ---
async function fetchGroups() {
  try {
    const r = await fetch(`${BACKEND_URL}/api/groups`)
    if (!r.ok) throw new Error('Falha ao carregar grupos')
    const groups = await r.json()
    state.groups = groups
    renderGroups()
  } catch (err) {
    console.error('Erro ao buscar grupos:', err)
  }
}

// --- Renderizar grupos ---
function renderGroups() {
  el.groups.innerHTML = ''
  for (const g of state.groups) {
    const row = document.createElement('div')
    row.className = 'flex items-center gap-3 p-2 rounded-lg border hover:bg-slate-50'

    const pic = document.createElement('img')
    pic.className = 'w-10 h-10 rounded-full object-cover bg-slate-100'
    pic.alt = 'foto do grupo'
    fetch(`${BACKEND_URL}/api/group-picture/${encodeURIComponent(g.id)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.url) pic.src = d.url })
    row.appendChild(pic)

    const label = document.createElement('label')
    label.className = 'flex-1 flex items-center gap-2 cursor-pointer'

    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.className = 'w-4 h-4'
    cb.addEventListener('change', () => {
      if (cb.checked) state.selected.add(g.id)
      else state.selected.delete(g.id)
    })

    const name = document.createElement('span')
    name.textContent = g.subject

    label.appendChild(cb)
    label.appendChild(name)
    row.appendChild(label)
    el.groups.appendChild(row)
  }
}

// --- Atualizar chat ---
function pushChat(groupId, who, text, ts) {
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

    for (const m of msgs.slice(-50)) {
      const line = document.createElement('div')
      line.className = 'text-sm mb-1'
      const time = new Date(m.ts).toLocaleTimeString()
      line.textContent = `[${time}] ${m.who}: ${m.text}`
      card.appendChild(line)
    }

    el.chats.appendChild(card)
  }
}

// --- Enviar mensagem ---
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

// --- Eventos do Socket.IO ---
socket.on('connect', () => console.log('✅ Socket conectado ao backend'))
socket.on('disconnect', () => console.warn('⚠️ Socket desconectado'))
socket.on('connect_error', err => console.error('Erro de conexão Socket.IO:', err))

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

// --- Inicialização ---
setStatus('Aguardando QR...')
