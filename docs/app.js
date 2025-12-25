// app.js - Versão Multi-Sessão (5 usuários)
document.addEventListener('DOMContentLoaded', () => {

  // --- Gerenciamento de Sessão do Usuário ---
  function getOrCreateSessionId() {
    // Primeiro verifica se há um sessionId na URL (para links diretos)
    const urlParams = new URLSearchParams(window.location.search);
    let sessionId = urlParams.get('session');

    if (sessionId) {
      localStorage.setItem('whatsapp_session_id', sessionId);
      return sessionId;
    }

    // Depois verifica localStorage
    sessionId = localStorage.getItem('whatsapp_session_id');

    if (!sessionId) {
      // Gera novo ID único
      sessionId = 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      localStorage.setItem('whatsapp_session_id', sessionId);
    }

    return sessionId;
  }

  const SESSION_ID = getOrCreateSessionId();
  console.log('📱 Session ID:', SESSION_ID);

  // Conecta Socket.IO com sessionId
  const socket = io(window.BACKEND_URL, {
    query: { sessionId: SESSION_ID },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000
  });

  const el = {
    qr: document.getElementById('qr'),
    status: document.getElementById('status-text'),
    statusDot: document.getElementById('status-dot'),
    groups: document.getElementById('groups'),
    groupsCount: document.getElementById('groups-count'),
    selectedCount: document.getElementById('selected-count'),
    chats: document.getElementById('chats'),
    message: document.getElementById('message'),
    send: document.getElementById('send'),
    qrCard: document.getElementById('qr-card'),
    charCount: document.getElementById('char-count'),
    sentCount: document.getElementById('sent-count'),
    deliveredCount: document.getElementById('delivered-count'),
    readCount: document.getElementById('read-count'),
    groupSearch: document.getElementById('group-search'),
    replyBox: document.getElementById('reply-indicator-box'),
    replyPreview: document.getElementById('reply-preview'),
    resetBtn: document.getElementById('reset-session-btn'),
    logoutBtn: document.getElementById('logout-btn'),
    sessionInfo: document.getElementById('session-info'),
    sessionIdDisplay: document.getElementById('session-id-display')
  };

  const state = {
    groups: [],
    filteredGroups: [],
    selected: new Set(),
    chatByGroup: new Map(),
    messageIdMap: new Map(),
    replyingTo: null,
    stats: {
      sent: 0,
      delivered: 0,
      read: 0
    },
    isLoadingHistory: new Set()
  };

  // Exibe o Session ID na UI
  if (el.sessionIdDisplay) {
    el.sessionIdDisplay.textContent = SESSION_ID.substring(0, 15) + '...';
    el.sessionIdDisplay.title = SESSION_ID;
  }

  // --- Helper para adicionar sessionId nas URLs ---
  function apiUrl(endpoint) {
    const separator = endpoint.includes('?') ? '&' : '?';
    return `${window.BACKEND_URL}${endpoint}${separator}sessionId=${SESSION_ID}`;
  }

  // --- Inicialização ---
  initializeEventListeners();
  requestInitialData();

  // --- Funções de UI ---
  function setQR(url) {
    if (url) {
      el.qr.innerHTML = `
        <img src="${url}" alt="QR Code" class="w-full h-full object-contain rounded-lg" />
      `;
    } else {
      el.qr.innerHTML = '<div class="loading-skeleton w-full h-full rounded-lg"></div>';
    }
  }

  function setStatus(text, connected) {
    el.status.textContent = text;
    el.statusDot.className = connected
      ? 'w-2 h-2 rounded-full bg-green-500 pulse-dot'
      : 'w-2 h-2 rounded-full bg-red-500 pulse-dot';

    const badge = document.getElementById('connection-status');
    if (connected) {
      badge.classList.remove('glass-dark');
      badge.classList.add('bg-green-50', 'border-green-200');
    } else {
      badge.classList.remove('bg-green-50', 'border-green-200');
      badge.classList.add('glass-dark');
    }
  }

  function renderGroups() {
    el.groups.innerHTML = '';

    if (state.filteredGroups.length === 0) {
      el.groups.innerHTML = `
        <div class="text-center py-8 text-gray-500">
          ${state.groups.length === 0 ? 'Nenhum grupo disponível' : 'Nenhum grupo encontrado'}
        </div>
      `;
      return;
    }

    state.filteredGroups.forEach(g => {
      const div = document.createElement('div');
      const isSelected = state.selected.has(g.id);
      const messageCount = state.chatByGroup.get(g.id)?.length || 0;

      div.className = 'group-item flex items-center gap-3 p-3 bg-white/50 hover:bg-white/70 rounded-xl cursor-pointer transition-all';
      div.dataset.groupId = g.id;

      div.innerHTML = `
        <input type="checkbox"
          class="group-checkbox w-5 h-5 rounded border-2 accent-purple-600"
          data-group-id="${g.id}"
          ${isSelected ? 'checked' : ''}
        >

        <img
          src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23999'%3E%3Cpath d='M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z'/%3E%3C/svg%3E"
          class="w-10 h-10 rounded-full object-cover bg-gray-100 group-picture"
          data-group-id="${g.id}"
        >

        <div class="flex-1 min-w-0">
          <p class="font-medium text-gray-800 truncate">${escapeHtml(g.subject)}</p>
          <p class="text-xs text-gray-500">${g.participants || 0} participantes</p>
        </div>

        ${messageCount > 0 ? `
          <div class="px-2 py-1 bg-purple-100 text-purple-700 rounded-full text-xs font-medium">
            ${messageCount}
          </div>
        ` : ''}

        ${state.isLoadingHistory.has(g.id) ? `
          <div class="animate-spin h-4 w-4 border-2 border-purple-500 border-t-transparent rounded-full"></div>
        ` : ''}
      `;

      const checkbox = div.querySelector('.group-checkbox');
      checkbox.addEventListener('click', (e) => {
        e.stopPropagation();
        handleGroupSelection(g.id, checkbox.checked);
      });

      div.addEventListener('click', (e) => {
        if (e.target === checkbox) return;
        checkbox.checked = !checkbox.checked;
        handleGroupSelection(g.id, checkbox.checked);
      });

      el.groups.appendChild(div);
      loadGroupPicture(g.id);
    });

    updateUI();
  }

  function handleGroupSelection(groupId, isSelected) {
    if (isSelected) {
      state.selected.add(groupId);
      loadGroupHistory(groupId);
    } else {
      state.selected.delete(groupId);
      if (state.chatByGroup.has(groupId)) {
        renderChats();
      }
    }
    updateUI();
  }

  async function loadGroupPicture(groupId) {
    try {
      const response = await fetch(apiUrl(`/api/group-picture/${groupId}`));
      if (response.ok) {
        const data = await response.json();
        if (data.url) {
          const img = document.querySelector(`.group-picture[data-group-id="${groupId}"]`);
          if (img) img.src = data.url;
        }
      }
    } catch (error) {
      // Silently fail
    }
  }

  async function loadGroupHistory(groupId) {
    if (state.isLoadingHistory.has(groupId)) return;

    console.log(`🔄 Carregando histórico para ${groupId}`);
    state.isLoadingHistory.add(groupId);

    const groupEl = document.querySelector(`.group-item[data-group-id="${groupId}"]`);
    if (groupEl && !groupEl.querySelector('.animate-spin')) {
      const loader = document.createElement('div');
      loader.className = 'animate-spin h-4 w-4 border-2 border-purple-500 border-t-transparent rounded-full';
      groupEl.appendChild(loader);
    }

    try {
      const url = apiUrl(`/api/debug/cache/${encodeURIComponent(groupId)}`);
      const response = await fetch(url);

      if (response.ok) {
        const data = await response.json();

        if (data.messages && data.messages.length > 0) {
          state.chatByGroup.set(groupId, []);

          let addedCount = 0;
          data.messages.forEach(msg => {
            if (msg.text && msg.text.trim()) {
              const timestamp = msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now();
              pushChat(
                groupId,
                msg.fromMe ? 'Você' : (msg.from || 'Desconhecido'),
                msg.text,
                timestamp,
                msg.id || `hist-${Date.now()}-${Math.random()}`,
                null,
                true
              );
              addedCount++;
            }
          });

          console.log(`✅ ${addedCount} mensagens carregadas para ${groupId}`);
          showToast(`Histórico: ${addedCount} mensagens`, 'success');
        } else {
          showToast('Sem histórico disponível', 'info');
        }
      }
    } catch (error) {
      console.error(`Erro ao carregar histórico:`, error);
      showToast(`Erro: ${error.message}`, 'error');
    } finally {
      state.isLoadingHistory.delete(groupId);
      const loader = document.querySelector(`.group-item[data-group-id="${groupId}"] .animate-spin`);
      if (loader) loader.remove();
      renderChats();
    }
  }

  function updateUI() {
    el.groupsCount.textContent = `${state.groups.length} grupos disponíveis`;
    el.selectedCount.textContent = state.selected.size;

    const count = state.selected.size;
    if (count > 0) {
      el.send.innerHTML = `
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/>
        </svg>
        <span>Enviar para ${count} grupo${count > 1 ? 's' : ''}</span>
      `;
      el.send.classList.remove('opacity-50', 'cursor-not-allowed');
      el.send.disabled = false;
    } else {
      el.send.innerHTML = `
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/>
        </svg>
        <span>Selecione grupos primeiro</span>
      `;
      el.send.classList.add('opacity-50', 'cursor-not-allowed');
      el.send.disabled = true;
    }

    el.sentCount.textContent = state.stats.sent;
    el.deliveredCount.textContent = state.stats.delivered;
    el.readCount.textContent = state.stats.read;
  }

  // --- Sistema de Chat ---
  function pushChat(groupId, who, text, ts, messageId, replyText, isHistory = false) {
    if (!state.chatByGroup.has(groupId)) {
      state.chatByGroup.set(groupId, []);
    }

    const chat = state.chatByGroup.get(groupId);

    if (messageId) {
      const exists = chat.some(m => m.messageId === messageId);
      if (exists) return;
    }

    chat.push({
      who,
      text,
      ts: ts || Date.now(),
      messageId: messageId || `${Date.now()}-${Math.random()}`,
      replyText
    });

    chat.sort((a, b) => a.ts - b.ts);

    if (chat.length > 100) {
      state.chatByGroup.set(groupId, chat.slice(-100));
    }

    if (messageId && groupId) {
      state.messageIdMap.set(`${groupId}:${text}`, messageId);
    }

    if (!isHistory) {
      renderChats();
    }
  }

  function renderChats() {
    el.chats.innerHTML = '';

    const selectedGroups = Array.from(state.selected);

    if (selectedGroups.length === 0) {
      el.chats.innerHTML = `
        <div class="glass-dark rounded-xl p-6 flex flex-col items-center justify-center min-h-[300px]">
          <svg class="w-16 h-16 text-gray-400 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
          </svg>
          <p class="text-gray-500 text-center">
            Selecione grupos para monitorar<br>
            <span class="text-xs">As mensagens aparecerão aqui</span>
          </p>
        </div>
      `;
      return;
    }

    selectedGroups.forEach(groupId => {
      const messages = state.chatByGroup.get(groupId) || [];
      const group = state.groups.find(g => g.id === groupId);

      if (!group) return;

      const chatCard = document.createElement('div');
      chatCard.className = 'glass-dark rounded-xl p-4';

      const header = `
        <div class="flex items-center justify-between mb-3 pb-2 border-b border-gray-200">
          <div class="flex items-center gap-2">
            <div class="w-2 h-2 bg-green-500 rounded-full"></div>
            <h3 class="font-semibold text-gray-800">${escapeHtml(group.subject)}</h3>
          </div>
          <span class="text-xs text-gray-500">${messages.length} mensagens</span>
        </div>
      `;

      let messagesHtml = '';

      if (messages.length === 0) {
        messagesHtml = `
          <div class="text-center py-4 text-gray-400 text-sm">
            Sem mensagens recentes
          </div>
        `;
      } else {
        messagesHtml = messages.slice(-20).map(m => {
          const isMe = m.who === 'Você';
          const time = new Date(m.ts).toLocaleTimeString('pt-BR', {
            hour: '2-digit',
            minute: '2-digit'
          });

          return `
            <div class="message-bubble mb-2 ${isMe ? 'text-right' : ''}"
                 data-message-id="${m.messageId}"
                 data-message-text="${escapeHtml(m.text)}"
                 data-message-from="${escapeHtml(m.who)}"
                 data-group-id="${groupId}">
              <div class="inline-block max-w-[80%] ${
                isMe
                  ? 'bg-gradient-to-r from-purple-500 to-indigo-500 text-white'
                  : 'bg-white text-gray-800'
              } rounded-2xl px-4 py-2 shadow-md cursor-pointer hover:shadow-lg transition-all">
                ${m.replyText ? `
                  <div class="text-xs ${isMe ? 'text-purple-100' : 'text-gray-500'} mb-1 italic border-l-2 ${isMe ? 'border-purple-300' : 'border-gray-300'} pl-2">
                    ↩️ ${escapeHtml(m.replyText.substring(0, 50))}${m.replyText.length > 50 ? '...' : ''}
                  </div>
                ` : ''}
                ${!isMe ? `<p class="text-xs font-semibold text-purple-600 mb-1">${escapeHtml(m.who)}</p>` : ''}
                <p class="text-sm break-words">${escapeHtml(m.text)}</p>
                <p class="text-xs ${isMe ? 'text-purple-100' : 'text-gray-400'} mt-1">${time}</p>
              </div>
            </div>
          `;
        }).join('');
      }

      chatCard.innerHTML = header + `
        <div class="max-h-[400px] overflow-y-auto scrollbar-thin pr-2">
          ${messagesHtml}
        </div>
      `;

      chatCard.querySelectorAll('.message-bubble').forEach(bubble => {
        bubble.addEventListener('click', function() {
          const messageText = this.dataset.messageText;
          const sender = this.dataset.messageFrom;
          const messageId = this.dataset.messageId;
          const groupId = this.dataset.groupId;

          setReply({
            groupId: groupId,
            text: messageText,
            from: sender,
            messageId: messageId
          });

          document.querySelectorAll('.message-bubble > div').forEach(el => {
            el.classList.remove('ring-2', 'ring-purple-400');
          });
          this.querySelector('div').classList.add('ring-2', 'ring-purple-400');
        });
      });

      el.chats.appendChild(chatCard);

      const scrollContainer = chatCard.querySelector('.overflow-y-auto');
      if (scrollContainer) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
      }
    });
  }

  function setReply(replyInfo) {
    state.replyingTo = replyInfo;

    el.replyBox.classList.remove('hidden');
    el.replyPreview.innerHTML = `
      <span class="font-medium">${escapeHtml(replyInfo.from)}</span>:
      "${escapeHtml(replyInfo.text.substring(0, 100))}${replyInfo.text.length > 100 ? '...' : ''}"
    `;

    el.message.focus();
  }

  // --- Event Listeners ---
  function initializeEventListeners() {
    let searchTimeout;
    el.groupSearch.addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        const search = e.target.value.toLowerCase();
        state.filteredGroups = state.groups.filter(g =>
          g.subject.toLowerCase().includes(search)
        );
        renderGroups();
      }, 300);
    });

    el.message.addEventListener('input', () => {
      el.charCount.textContent = el.message.value.length;
    });

    el.send.addEventListener('click', sendMessage);

    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 'Enter' && !el.send.disabled) {
        sendMessage();
      }
      if (e.key === 'Escape') {
        window.cancelReplyFunction();
      }
    });

    el.resetBtn.addEventListener('click', resetSession);

    if (el.logoutBtn) {
      el.logoutBtn.addEventListener('click', performLogout);
    }

    // Botão para criar nova sessão
    const newSessionBtn = document.getElementById('new-session-btn');
    if (newSessionBtn) {
      newSessionBtn.addEventListener('click', createNewSession);
    }

    // Botão para copiar link da sessão
    const copySessionBtn = document.getElementById('copy-session-btn');
    if (copySessionBtn) {
      copySessionBtn.addEventListener('click', copySessionLink);
    }
  }

  async function sendMessage() {
    if (el.send.disabled) return;

    const text = el.message.value.trim();

    if (!text) {
      showToast('Digite uma mensagem', 'error');
      return;
    }

    const ids = Array.from(state.selected);
    if (!ids.length) {
      showToast('Selecione pelo menos um grupo', 'warning');
      return;
    }

    const payload = {
      groupIds: ids,
      message: text,
      sessionId: SESSION_ID
    };

    if (state.replyingTo) {
      payload.replyTo = state.replyingTo;
    }

    el.send.disabled = true;
    el.send.innerHTML = '<span class="animate-pulse">Enviando...</span>';

    try {
      const response = await fetch(apiUrl('/api/send'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Falha no envio');
      }

      state.stats.sent += ids.length;

      const now = Date.now();
      ids.forEach(groupId => {
        pushChat(groupId, 'Você', text, now, null, state.replyingTo?.text);
      });

      el.message.value = '';
      el.charCount.textContent = '0';
      window.cancelReplyFunction();

      if (data.summary) {
        showToast(
          `✅ ${data.summary.success}/${data.summary.total} enviados, ${data.summary.replies} como reply`,
          'success'
        );
      } else {
        showToast('Mensagem enviada!', 'success');
      }

    } catch (error) {
      showToast(`Erro: ${error.message}`, 'error');
    } finally {
      el.send.disabled = false;
      updateUI();
    }
  }

  async function performLogout() {
    if (!confirm('Deseja realmente fazer logout? Você precisará escanear o QR Code novamente.')) {
      return;
    }

    el.logoutBtn.disabled = true;
    el.logoutBtn.innerHTML = '<span class="animate-pulse">Desconectando...</span>';

    try {
      const response = await fetch(apiUrl('/api/logout'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: SESSION_ID })
      });

      if (response.ok) {
        state.groups = [];
        state.filteredGroups = [];
        state.selected.clear();
        state.chatByGroup.clear();
        state.messageIdMap.clear();

        setStatus('Desconectado', false);
        el.qrCard.classList.remove('hidden');
        el.groups.innerHTML = '';
        el.chats.innerHTML = '';

        showToast('Logout realizado! Aguarde novo QR Code...', 'success');
      } else {
        throw new Error('Falha ao fazer logout');
      }
    } catch (error) {
      showToast(`Erro: ${error.message}`, 'error');
    } finally {
      el.logoutBtn.disabled = false;
      el.logoutBtn.innerHTML = `
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>
        </svg>
        <span>Logout</span>
      `;
    }
  }

  async function resetSession() {
    if (!confirm('Isso desconectará a sessão atual. Continuar?')) return;

    el.resetBtn.disabled = true;
    el.resetBtn.innerHTML = '<span class="animate-pulse">Resetando...</span>';

    try {
      const response = await fetch(apiUrl('/api/reset-session'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: SESSION_ID })
      });

      if (response.ok) {
        showToast('Sessão resetada! Aguarde novo QR...', 'success');
        el.qr.innerHTML = '<div class="loading-skeleton w-full h-full rounded-lg"></div>';
      } else {
        throw new Error('Falha ao resetar');
      }
    } catch (error) {
      showToast(`Erro: ${error.message}`, 'error');
    } finally {
      el.resetBtn.disabled = false;
      el.resetBtn.innerHTML = `
        <svg class="w-5 h-5 inline mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
        </svg>
        Gerar Novo QR Code
      `;
    }
  }

  function createNewSession() {
    if (!confirm('Criar uma nova sessão? Você será desconectado da sessão atual.')) return;

    localStorage.removeItem('whatsapp_session_id');
    window.location.reload();
  }

  function copySessionLink() {
    const url = `${window.location.origin}${window.location.pathname}?session=${SESSION_ID}`;
    navigator.clipboard.writeText(url).then(() => {
      showToast('Link da sessão copiado!', 'success');
    }).catch(() => {
      showToast('Erro ao copiar', 'error');
    });
  }

  async function requestInitialData() {
    socket.emit('request-status');

    try {
      const response = await fetch(apiUrl('/api/groups'));
      if (response.ok) {
        const groups = await response.json();
        state.groups = groups;
        state.filteredGroups = groups;
        renderGroups();
      }
    } catch (error) {
      console.error('Erro ao buscar grupos:', error);
    }
  }

  // --- Socket.IO Events ---
  socket.on('connect', () => {
    console.log('✅ Conectado ao servidor');
    showToast('Conectado ao servidor', 'success');
  });

  socket.on('disconnect', () => {
    console.log('❌ Desconectado');
    setStatus('Desconectado', false);
  });

  socket.on('error', ({ message }) => {
    console.error('❌ Erro:', message);
    showToast(`Erro: ${message}`, 'error');
  });

  socket.on('qr', ({ dataUrl }) => {
    console.log('📱 QR Code recebido');
    setQR(dataUrl);
    setStatus('Aguardando escaneamento', false);
    if (el.qrCard.classList.contains('hidden')) {
      el.qrCard.classList.remove('hidden');
    }
  });

  socket.on('ready', async () => {
    console.log('✅ WhatsApp conectado');
    setStatus('Conectado', true);
    el.qrCard.classList.add('hidden');

    try {
      const response = await fetch(apiUrl('/api/groups'));
      if (response.ok) {
        const groups = await response.json();
        state.groups = groups;
        state.filteredGroups = groups;
        renderGroups();
        showToast('WhatsApp conectado!', 'success');
      }
    } catch (error) {
      console.error('Erro ao buscar grupos:', error);
    }
  });

  socket.on('disconnected', () => {
    setStatus('Desconectado', false);
    el.qrCard.classList.remove('hidden');
    showToast('WhatsApp desconectado', 'warning');
  });

  socket.on('message', ({ groupId, from, text, timestamp, messageId }) => {
    if (state.selected.has(groupId)) {
      pushChat(groupId, from, text, timestamp, messageId);
    }
  });

  socket.on('message_sent', ({ groupId, text, timestamp, messageId, isReply }) => {
    console.log('Mensagem enviada:', { groupId, isReply });
    state.stats.delivered++;
    updateUI();
  });

  socket.on('status', ({ ready }) => {
    if (ready) {
      setStatus('Conectado', true);
      el.qrCard.classList.add('hidden');
    } else {
      setStatus('Aguardando conexão', false);
    }
  });

  // --- Funções Globais ---
  window.selectAllGroups = () => {
    state.filteredGroups.forEach(g => {
      state.selected.add(g.id);
      const checkbox = document.querySelector(`.group-checkbox[data-group-id="${g.id}"]`);
      if (checkbox) checkbox.checked = true;
      loadGroupHistory(g.id);
    });
    updateUI();
    renderChats();
  };

  window.deselectAllGroups = () => {
    state.selected.clear();
    document.querySelectorAll('.group-checkbox').forEach(cb => {
      cb.checked = false;
    });
    updateUI();
    renderChats();
  };

  window.cancelReplyFunction = () => {
    state.replyingTo = null;
    el.replyBox.classList.add('hidden');
    document.querySelectorAll('.message-bubble > div').forEach(el => {
      el.classList.remove('ring-2', 'ring-purple-400');
    });
  };

  window.refreshChatsFunction = () => {
    state.selected.forEach(groupId => {
      loadGroupHistory(groupId);
    });
    showToast('Atualizando chats...', 'info');
  };

  window.clearChatsFunction = () => {
    state.chatByGroup.clear();
    renderChats();
    showToast('Chats limpos', 'success');
  };

  window.resetSessionFunction = resetSession;

  window.getSessionId = () => SESSION_ID;

  // --- Utilities ---
  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `
      px-6 py-3 rounded-xl shadow-lg mb-3 transform translate-x-0 transition-all duration-300
      ${type === 'success' ? 'bg-gradient-to-r from-green-500 to-emerald-600 text-white' :
        type === 'error' ? 'bg-gradient-to-r from-red-500 to-pink-600 text-white' :
        type === 'warning' ? 'bg-gradient-to-r from-amber-500 to-orange-600 text-white' :
        'bg-gradient-to-r from-blue-500 to-indigo-600 text-white'}
    `;

    toast.innerHTML = `
      <div class="flex items-center gap-3">
        ${type === 'success' ? '<svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"></path></svg>' :
          type === 'error' ? '<svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"></path></svg>' :
          type === 'warning' ? '<svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"></path></svg>' :
          '<svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd"></path></svg>'}
        <span class="font-medium">${message}</span>
      </div>
    `;

    const container = document.getElementById('toast-container');
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.transform = 'translateX(0)';
    }, 10);

    setTimeout(() => {
      toast.style.transform = 'translateX(400px)';
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }
});
