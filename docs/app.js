// docs/app.js
document.addEventListener('DOMContentLoaded', () => {
  const socket = io(window.BACKEND_URL);

  const el = {
    qr: document.getElementById('qr'),
    status: document.getElementById('wa-status'),
    groups: document.getElementById('groups'),
    chats: document.getElementById('chats'),
    message: document.getElementById('message'),
    send: document.getElementById('send')
  };

  const state = {
    groups: [],
    selected: new Set(),
    chatByGroup: new Map(),
    replyingTo: null
  };

  // --- Funções de UI ---
  function setQR(url) {
    el.qr.innerHTML = `<img src="${url}" alt="QR Code" class="w-full h-full object-contain rounded-lg" />`;
  }

  function setStatus(text, ok) {
    el.status.innerHTML = `<span class="${ok ? 'text-emerald-600' : 'text-red-600'}">${text}</span>`;
  }

  function renderGroups() {
    el.groups.innerHTML = '';
    for (const g of state.groups) {
      const div = document.createElement('div');
      div.className = 'flex items-center space-x-2 border rounded-lg p-2 hover:bg-slate-50';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'w-4 h-4';
      checkbox.onchange = () => {
        if (checkbox.checked) state.selected.add(g.id);
        else state.selected.delete(g.id);
      };

      const img = document.createElement('img');
      img.className = 'w-8 h-8 rounded-full object-cover';
      fetch(`${window.BACKEND_URL}/api/group-picture/${g.id}`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d?.url) img.src = d.url; })
        .catch(() => {});

      const span = document.createElement('span');
      span.textContent = g.subject;
      span.className = 'text-sm font-medium truncate max-w-[200px]';

      div.appendChild(checkbox);
      div.appendChild(img);
      div.appendChild(span);
      el.groups.appendChild(div);
    }
  }

  async function fetchGroups() {
    const r = await fetch(`${window.BACKEND_URL}/api/groups`);
    const data = await r.json();
    if (r.ok) {
      state.groups = data;
      renderGroups();
    }
  }

  // --- Chat visual ---
  function pushChat(groupId, who, text, ts, replyText) {
    if (!state.chatByGroup.has(groupId)) state.chatByGroup.set(groupId, []);
    state.chatByGroup.get(groupId).push({ who, text, ts, replyText });
    renderChats();
  }

  function renderChats() {
    el.chats.innerHTML = '';
    for (const [gid, msgs] of state.chatByGroup.entries()) {
      const group = state.groups.find(g => g.id === gid);
      const card = document.createElement('div');
      card.className = 'border rounded-lg p-3';
      const title = document.createElement('div');
      title.className = 'font-semibold mb-2';
      title.textContent = group ? group.subject : gid;
      card.appendChild(title);

      for (const m of msgs.slice(-50)) {
        const line = document.createElement('div');
        line.className = 'text-sm mb-2 border-b border-slate-100 pb-1 cursor-pointer hover:bg-slate-50 rounded-md px-1';
        const time = new Date(m.ts).toLocaleTimeString();

        if (m.replyText) {
          line.innerHTML = `
            <div class="text-xs text-slate-500 border-l-4 border-emerald-500 pl-2 italic mb-1">
              ${m.replyText}
            </div>
            <div><b>${m.who}:</b> ${m.text}</div>
            <div class="text-[10px] text-slate-400">${time}</div>
          `;
        } else {
          line.innerHTML = `<b>${m.who}:</b> ${m.text}<div class="text-[10px] text-slate-400">${time}</div>`;
        }

        // Clique para responder
        line.onclick = () => {
          state.replyingTo = { groupId: gid, text: m.text, from: m.who };
          el.message.value = `↩️ Respondendo: ${m.text}\n\n`;
          el.message.focus();
        };

        card.appendChild(line);
      }

      el.chats.appendChild(card);
    }
  }

  // --- Envio de mensagens ---
  el.send.addEventListener('click', async () => {
    const text = el.message.value.trim();
    if (!text) return alert('Escreva uma mensagem.');
    const ids = Array.from(state.selected);
    if (!ids.length) return alert('Selecione ao menos um grupo.');

    const payload = { groupIds: ids, message: text };
    if (state.replyingTo) payload.replyTo = state.replyingTo;

    el.send.disabled = true;
    try {
      const r = await fetch(`${window.BACKEND_URL}/api/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || 'Falha no envio.');

      const now = Date.now();
      for (const gid of ids)
        pushChat(gid, 'Você', text, now, state.replyingTo ? state.replyingTo.text : null);

      el.message.value = '';
      state.replyingTo = null;
    } catch (e) {
      alert('Erro ao enviar: ' + e.message);
    } finally {
      el.send.disabled = false;
    }
  });

  // --- Eventos Socket.IO ---
  socket.on('connect', () => console.log('✅ Socket conectado ao backend'));
  socket.on('qr', ({ dataUrl }) => setQR(dataUrl));
  socket.on('ready', () => { setStatus('WhatsApp conectado ✅', true); fetchGroups(); });
  socket.on('disconnected', () => setStatus('Desconectado. Aguarde novo QR ou reconexão.', false));
  socket.on('status', ({ ready }) => { if (ready) { setStatus('WhatsApp conectado ✅', true); fetchGroups(); } });
  socket.on('message', ({ groupId, from, text, timestamp }) => pushChat(groupId, from, text, timestamp));
  socket.on('message_sent', ({ groupId, text, timestamp }) => pushChat(groupId, 'Você', text, timestamp));
});
