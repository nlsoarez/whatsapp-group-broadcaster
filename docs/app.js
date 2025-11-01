// docs/app.js
document.addEventListener('DOMContentLoaded', () => {
  const socket = io(window.BACKEND_URL, {
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: Infinity
  });

  const el = {
    qr: document.getElementById('qr'),
    qrCard: document.getElementById('qr-card'),
    status: document.getElementById('wa-status'),
    groups: document.getElementById('groups'),
    chatsPreview: document.getElementById('chats-preview'),
    chatsFull: document.getElementById('chats-full'),
    message: document.getElementById('message'),
    send: document.getElementById('send'),
    logoutBtn: document.getElementById('logout-btn'),
    expandMonitor: document.getElementById('expand-monitor'),
    modal: document.getElementById('monitor-modal'),
    closeModal: document.getElementById('close-modal')
  };

  const state = {
    groups: [],
    selected: new Set(),
    chatByGroup: new Map(),
    replyingTo: null,
    isModalOpen: false
  };

  // --- Funções de UI ---
  function setQR(url) {
    el.qr.innerHTML = `<img src="${url}" alt="QR Code" class="w-full h-full object-contain rounded-lg" />`;
  }

  function setStatus(text, ok) {
    el.status.innerHTML = `<span class="${ok ? 'text-emerald-600' : 'text-red-600'}">${text}</span>`;
  }

  function showLogoutButton(show) {
    el.logoutBtn.classList.toggle('hidden', !show);
  }

  function renderGroups() {
    el.groups.innerHTML = '';
    for (const g of state.groups) {
      const div = document.createElement('div');
      div.className = 'flex items-center space-x-2 border rounded-lg p-2 hover:bg-slate-50 cursor-pointer transition-all';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'w-4 h-4 cursor-pointer';
      checkbox.onchange = () => {
        if (checkbox.checked) {
          state.selected.add(g.id);
          // Requisita histórico ao selecionar
          socket.emit('request_history', { groupId: g.id });
        } else {
          state.selected.delete(g.id);
        }
      };

      const img = document.createElement('img');
      img.className = 'w-8 h-8 rounded-full object-cover bg-gray-200';
      img.alt = g.subject;
      fetch(`${window.BACKEND_URL}/api/group-picture/${g.id}`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d?.url) img.src = d.url; })
        .catch(() => {});

      const span = document.createElement('span');
      span.textContent = g.subject;
      span.className = 'text-sm font-medium truncate flex-1';

      div.appendChild(checkbox);
      div.appendChild(img);
      div.appendChild(span);
      el.groups.appendChild(div);
    }
  }

  async function fetchGroups() {
    try {
      const r = await fetch(`${window.BACKEND_URL}/api/groups`);
      const data = await r.json();
      if (r.ok) {
        state.groups = data;
        renderGroups();
      }
    } catch (e) {
      console.error('Erro ao buscar grupos:', e);
    }
  }

  // --- Chat visual ---
  function pushChat(groupId, who, text, ts, replyText) {
    if (!state.chatByGroup.has(groupId)) state.chatByGroup.set(groupId, []);
    
    const messages = state.chatByGroup.get(groupId);
    
    // Evita duplicatas
    const exists = messages.find(m => m.who === who && m.text === text && Math.abs(m.ts - ts) < 1000);
    if (!exists) {
      messages.push({ who, text, ts, replyText });
    }
    
    renderChats();
  }

  function pushHistory(groupId, messages) {
    if (!state.chatByGroup.has(groupId)) state.chatByGroup.set(groupId, []);
    
    const existingMessages = state.chatByGroup.get(groupId);
    
    // Adiciona mensagens antigas sem duplicar
    for (const msg of messages) {
      const exists = existingMessages.find(m => 
        m.who === msg.from && 
        m.text === msg.text && 
        Math.abs(m.ts - msg.timestamp) < 1000
      );
      
      if (!exists) {
        existingMessages.unshift({ 
          who: msg.from, 
          text: msg.text, 
          ts: msg.timestamp 
        });
      }
    }
    
    // Ordena por timestamp
    existingMessages.sort((a, b) => a.ts - b.ts);
    
    renderChats();
  }

  function renderChats() {
    renderChatContainer(el.chatsPreview, false);
    if (state.isModalOpen) {
      renderChatContainer(el.chatsFull, true);
    }
  }

  function renderChatContainer(container, isFull) {
    container.innerHTML = '';
    
    if (state.chatByGroup.size === 0) {
      container.innerHTML = '<p class="text-gray-500 text-sm text-center py-4">Nenhuma mensagem ainda. Selecione grupos para monitorar.</p>';
      return;
    }
    
    for (const [gid, msgs] of state.chatByGroup.entries()) {
      const group = state.groups.find(g => g.id === gid);
      const card = document.createElement('div');
      card.className = 'border rounded-lg p-4 bg-white';
      
      const header = document.createElement('div');
      header.className = 'flex items-center gap-2 mb-3 pb-2 border-b';
      
      const avatar = document.createElement('div');
      avatar.className = 'w-10 h-10 rounded-full bg-[#E60000] flex items-center justify-center text-white font-bold';
      avatar.textContent = (group?.subject || 'Grupo')[0].toUpperCase();
      
      const title = document.createElement('div');
      title.className = 'font-semibold text-gray-800';
      title.textContent = group ? group.subject : gid;
      
      const badge = document.createElement('span');
      badge.className = 'ml-auto text-xs bg-[#E60000] text-white px-2 py-1 rounded-full';
      badge.textContent = `${msgs.length} msgs`;
      
      header.appendChild(avatar);
      header.appendChild(title);
      header.appendChild(badge);
      card.appendChild(header);

      const messagesDiv = document.createElement('div');
      messagesDiv.className = 'space-y-2';
      
      const displayMessages = isFull ? msgs.slice(-100) : msgs.slice(-10);
      
      for (const m of displayMessages) {
        const line = document.createElement('div');
        line.className = 'text-sm p-2 hover:bg-slate-50 rounded-md cursor-pointer transition-all border-l-2 border-transparent hover:border-[#E60000]';
        const time = new Date(m.ts).toLocaleTimeString('pt-BR');

        if (m.replyText) {
          line.innerHTML = `
            <div class="text-xs text-slate-500 border-l-4 border-emerald-500 pl-2 italic mb-1 bg-emerald-50 rounded p-1">
              ${escapeHtml(m.replyText)}
            </div>
            <div class="font-semibold text-gray-700">${escapeHtml(m.who)}:</div>
            <div class="text-gray-600">${escapeHtml(m.text)}</div>
            <div class="text-[10px] text-slate-400 mt-1">${time}</div>
          `;
        } else {
          line.innerHTML = `
            <div class="font-semibold text-gray-700">${escapeHtml(m.who)}:</div>
            <div class="text-gray-600">${escapeHtml(m.text)}</div>
            <div class="text-[10px] text-slate-400 mt-1">${time}</div>
          `;
        }

        // Clique para responder
        line.onclick = () => {
          state.replyingTo = { groupId: gid, text: m.text, from: m.who };
          el.message.value = `↩️ Respondendo: ${m.text}\n\n`;
          el.message.focus();
          
          // Fecha modal se aberto
          if (state.isModalOpen) {
            closeMonitorModal();
          }
        };

        messagesDiv.appendChild(line);
      }
      
      card.appendChild(messagesDiv);
      container.appendChild(card);
    }
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // --- Modal ---
  function openMonitorModal() {
    state.isModalOpen = true;
    el.modal.classList.add('active');
    renderChats();
  }

  function closeMonitorModal() {
    state.isModalOpen = false;
    el.modal.classList.remove('active');
  }

  el.expandMonitor.addEventListener('click', openMonitorModal);
  el.closeModal.addEventListener('click', closeMonitorModal);
  el.modal.addEventListener('click', (e) => {
    if (e.target === el.modal) closeMonitorModal();
  });

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
      for (const gid of ids) {
        pushChat(gid, 'Você', text, now, state.replyingTo ? state.replyingTo.text : null);
      }

      el.message.value = '';
      state.replyingTo = null;
    } catch (e) {
      alert('Erro ao enviar: ' + e.message);
    } finally {
      el.send.disabled = false;
    }
  });

  // --- Logout ---
  el.logoutBtn.addEventListener('click', async () => {
    if (!confirm('Tem certeza que deseja desconectar?')) return;
    
    try {
      const r = await fetch(`${window.BACKEND_URL}/api/logout`, {
        method: 'POST'
      });
      
      if (r.ok) {
        state.groups = [];
        state.selected.clear();
        state.chatByGroup.clear();
        state.replyingTo = null;
        
        el.groups.innerHTML = '';
        el.chatsPreview.innerHTML = '';
        el.chatsFull.innerHTML = '';
        el.message.value = '';
        
        setStatus('Desconectado. Aguarde novo QR...', false);
        showLogoutButton(false);
        el.qrCard.classList.remove('hidden');
      }
    } catch (e) {
      alert('Erro ao fazer logout: ' + e.message);
    }
  });

  // --- Eventos Socket.IO ---
  socket.on('connect', () => {
    console.log('✅ Socket conectado ao backend');
  });

  socket.on('qr', ({ dataUrl }) => {
    setQR(dataUrl);
    el.qrCard.classList.remove('hidden');
    showLogoutButton(false);
  });

  socket.on('ready', () => {
    setStatus('WhatsApp conectado ✅', true);
    el.qrCard.classList.add('hidden');
    showLogoutButton(true);
    fetchGroups();
  });

  socket.on('disconnected', () => {
    setStatus('Desconectado. Aguarde reconexão...', false);
  });

  socket.on('logged_out', () => {
    setStatus('Você foi desconectado. Escaneie o QR novamente.', false);
    el.qrCard.classList.remove('hidden');
    showLogoutButton(false);
  });

  socket.on('status', ({ ready }) => {
    if (ready) {
      setStatus('WhatsApp conectado ✅', true);
      el.qrCard.classList.add('hidden');
      showLogoutButton(true);
      fetchGroups();
    }
  });

  socket.on('message', ({ groupId, from, text, timestamp }) => {
    pushChat(groupId, from, text, timestamp);
  });

  socket.on('message_sent', ({ groupId, text, timestamp }) => {
    pushChat(groupId, 'Você', text, timestamp);
  });

  socket.on('history', ({ groupId, messages }) => {
    if (messages && messages.length > 0) {
      pushHistory(groupId, messages);
    }
  });

  // Atalho: Enter + Ctrl para enviar
  el.message.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault();
      el.send.click();
    }
  });
});
