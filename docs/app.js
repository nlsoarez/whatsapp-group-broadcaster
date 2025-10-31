// docs/app.js
document.addEventListener('DOMContentLoaded', () => {
  const socket = io(window.BACKEND_URL, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000
  });

  const el = {
    qr: document.getElementById('qr'),
    status: document.getElementById('wa-status'),
    groups: document.getElementById('groups'),
    chats: document.getElementById('chats'),
    message: document.getElementById('message'),
    send: document.getElementById('send'),
    qrCard: document.getElementById('qr-card')
  };

  const state = {
    groups: [],
    selected: new Set(),
    chatByGroup: new Map(),
    messageIdMap: new Map(),
    replyingTo: null,
    connectionAttempts: 0
  };

  // --- Funções de UI ---
  function setQR(url) {
    if (url) {
      el.qr.innerHTML = `<img src="${url}" alt="QR Code" class="w-full h-full object-contain rounded-lg" />`;
      setStatus('Escaneie o QR Code com seu WhatsApp', false);
    } else {
      el.qr.innerHTML = '<span class="text-gray-500 text-sm">Aguardando QR...</span>';
    }
  }

  function setStatus(text, ok) {
    el.status.innerHTML = `
      <span class="${ok ? 'text-emerald-600' : 'text-amber-600'} flex items-center gap-2">
        ${ok ? 
          '<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"></path></svg>' : 
          '<svg class="w-4 h-4 animate-pulse" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd"></path></svg>'
        }
        ${text}
      </span>
    `;
  }

  function addResetButton() {
    // Remove botão existente se houver
    const existingBtn = document.getElementById('reset-session-btn');
    if (existingBtn) existingBtn.remove();
    
    // Adiciona botão de reset no card do QR
    const resetBtn = document.createElement('button');
    resetBtn.id = 'reset-session-btn';
    resetBtn.className = 'mt-3 px-4 py-2 bg-amber-500 hover:bg-amber-600 text-white rounded-lg text-sm font-medium transition-all w-full';
    resetBtn.innerHTML = '🔄 Gerar Novo QR Code';
    resetBtn.onclick = async () => {
      if (confirm('Isso desconectará a sessão atual. Continuar?')) {
        resetBtn.disabled = true;
        resetBtn.innerHTML = '<span class="animate-pulse">Resetando...</span>';
        
        try {
          const response = await fetch(`${window.BACKEND_URL}/api/reset-session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          });
          
          if (response.ok) {
            showToast('Sessão resetada! Aguarde novo QR...', 'success');
            el.qr.innerHTML = '<span class="text-gray-500 text-sm animate-pulse">Gerando novo QR...</span>';
            setStatus('Gerando novo QR Code...', false);
          } else {
            throw new Error('Falha ao resetar sessão');
          }
        } catch (error) {
          showToast('Erro ao resetar: ' + error.message, 'error');
          resetBtn.disabled = false;
          resetBtn.innerHTML = '🔄 Gerar Novo QR Code';
        }
      }
    };
    
    const qrCard = document.getElementById('qr-card');
    if (qrCard && !qrCard.classList.contains('hidden')) {
      qrCard.appendChild(resetBtn);
    }
  }

  function renderGroups() {
    el.groups.innerHTML = '';
    
    if (state.groups.length === 0) {
      el.groups.innerHTML = '<div class="text-gray-500 text-center py-8">Nenhum grupo disponível</div>';
      return;
    }
    
    for (const g of state.groups) {
      const div = document.createElement('div');
      div.className = 'flex items-center space-x-2 border rounded-lg p-2 hover:bg-slate-50 cursor-pointer transition-all';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'w-4 h-4 accent-red-600';
      checkbox.checked = state.selected.has(g.id);
      checkbox.onchange = (e) => {
        e.stopPropagation();
        if (checkbox.checked) state.selected.add(g.id);
        else state.selected.delete(g.id);
        updateSelectedCount();
      };

      const img = document.createElement('img');
      img.className = 'w-8 h-8 rounded-full object-cover bg-gray-200';
      img.onerror = () => { 
        img.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23999"%3E%3Cpath d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/%3E%3C/svg%3E'; 
      };
      
      fetch(`${window.BACKEND_URL}/api/group-picture/${g.id}`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d?.url) img.src = d.url; })
        .catch(() => {});

      const info = document.createElement('div');
      info.className = 'flex-1';
      info.innerHTML = `
        <div class="text-sm font-medium truncate">${g.subject}</div>
        ${g.participants ? `<div class="text-xs text-gray-500">${g.participants} participantes</div>` : ''}
      `;

      div.onclick = (e) => {
        if (e.target !== checkbox) {
          checkbox.checked = !checkbox.checked;
          checkbox.onchange(e);
        }
      };

      div.appendChild(checkbox);
      div.appendChild(img);
      div.appendChild(info);
      el.groups.appendChild(div);
    }
    updateSelectedCount();
  }

  function updateSelectedCount() {
    const count = state.selected.size;
    const sendBtn = document.getElementById('send');
    if (count > 0) {
      sendBtn.textContent = `Enviar para ${count} grupo${count > 1 ? 's' : ''}`;
      sendBtn.classList.remove('opacity-50');
    } else {
      sendBtn.textContent = 'Enviar para grupos selecionados';
      sendBtn.classList.add('opacity-50');
    }
  }

  async function fetchGroups() {
    try {
      const r = await fetch(`${window.BACKEND_URL}/api/groups`);
      const data = await r.json();
      if (r.ok) {
        state.groups = data;
        renderGroups();
        if (data.length > 0) {
          showToast(`${data.length} grupos carregados`, 'success');
        }
      } else {
        throw new Error(data.error || 'Falha ao buscar grupos');
      }
    } catch (e) {
      console.error('Erro ao buscar grupos:', e);
      el.groups.innerHTML = `
        <div class="text-red-500 text-center py-8">
          <p>Erro ao carregar grupos</p>
          <button onclick="location.reload()" class="mt-2 text-sm underline">Recarregar página</button>
        </div>
      `;
    }
  }

  // --- Chat visual ---
  function pushChat(groupId, who, text, ts, messageId, replyText) {
    if (!state.chatByGroup.has(groupId)) state.chatByGroup.set(groupId, []);
    const chatEntry = { who, text, ts, messageId, replyText };
    state.chatByGroup.get(groupId).push(chatEntry);
    
    if (messageId && groupId) {
      const key = `${groupId}:${text}`;
      state.messageIdMap.set(key, messageId);
    }
    
    renderChats();
  }

  function renderChats() {
    el.chats.innerHTML = '';
    
    if (state.chatByGroup.size === 0) {
      el.chats.innerHTML = '<div class="text-gray-500 text-center py-8">Nenhuma mensagem ainda...</div>';
      return;
    }
    
    for (const [gid, msgs] of state.chatByGroup.entries()) {
      const group = state.groups.find(g => g.id === gid);
      const card = document.createElement('div');
      card.className = 'border rounded-lg p-3 bg-white';
      
      const header = document.createElement('div');
      header.className = 'flex items-center justify-between mb-3 pb-2 border-b';
      header.innerHTML = `
        <div class="font-semibold text-gray-800">${group ? group.subject : 'Grupo'}</div>
        <div class="text-xs text-gray-500">${msgs.length} mensagens</div>
      `;
      card.appendChild(header);

      const messagesContainer = document.createElement('div');
      messagesContainer.className = 'space-y-1 max-h-60 overflow-y-auto scrollbar-thin';
      
      for (const m of msgs.slice(-50)) {
        const msgDiv = document.createElement('div');
        const isMe = m.who === 'Você';
        msgDiv.className = `text-sm p-2 rounded-lg cursor-pointer transition-all ${
          isMe ? 'bg-green-50 ml-auto max-w-[80%] hover:bg-green-100' : 'bg-gray-50 mr-auto max-w-[80%] hover:bg-gray-100'
        }`;
        
        const time = new Date(m.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

        let content = '';
        if (m.replyText) {
          content = `
            <div class="text-xs text-gray-500 bg-white/50 rounded p-1 mb-1 italic border-l-2 border-blue-400 pl-2">
              ↩️ ${m.replyText.substring(0, 50)}${m.replyText.length > 50 ? '...' : ''}
            </div>
          `;
        }
        
        content += `
          <div class="flex items-start gap-2">
            <div class="flex-1">
              ${!isMe ? `<div class="font-semibold text-xs text-gray-600 mb-1">${m.who}</div>` : ''}
              <div class="text-gray-800 break-words">${m.text}</div>
            </div>
            <div class="text-[10px] text-gray-400 mt-auto">${time}</div>
          </div>
        `;
        
        msgDiv.innerHTML = content;

        msgDiv.onclick = () => {
          if (state.replyingTo) {
            el.message.value = el.message.value.replace(/^↩️ Respondendo a: .+\n\n/, '');
          }
          
          state.replyingTo = { 
            groupId: gid, 
            text: m.text, 
            from: m.who,
            messageId: m.messageId || state.messageIdMap.get(`${gid}:${m.text}`)
          };
          
          document.querySelectorAll('.replying-to').forEach(el => el.classList.remove('replying-to', 'ring-2', 'ring-blue-400'));
          msgDiv.classList.add('replying-to', 'ring-2', 'ring-blue-400');
          
          const currentText = el.message.value;
          el.message.value = `↩️ Respondendo a: ${m.who} - "${m.text.substring(0, 50)}${m.text.length > 50 ? '...' : ''}"\n\n${currentText}`;
          el.message.focus();
          el.message.setSelectionRange(el.message.value.length, el.message.value.length);
          
          showReplyIndicator(m.who, m.text);
        };

        messagesContainer.appendChild(msgDiv);
      }
      
      card.appendChild(messagesContainer);
      el.chats.appendChild(card);
    }
    
    const lastContainer = el.chats.lastElementChild?.querySelector('.overflow-y-auto');
    if (lastContainer) {
      lastContainer.scrollTop = lastContainer.scrollHeight;
    }
  }

  function showReplyIndicator(from, text) {
    const existingIndicator = document.getElementById('reply-indicator');
    if (existingIndicator) existingIndicator.remove();
    
    const indicator = document.createElement('div');
    indicator.id = 'reply-indicator';
    indicator.className = 'fixed bottom-20 right-6 bg-white shadow-lg rounded-lg p-3 max-w-sm border-l-4 border-blue-500 z-50 animate-pulse';
    indicator.innerHTML = `
      <div class="flex items-center justify-between">
        <div class="flex-1">
          <div class="text-xs text-gray-500 mb-1">Respondendo a ${from}:</div>
          <div class="text-sm text-gray-700">"${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"</div>
        </div>
        <button onclick="cancelReply()" class="ml-3 text-gray-400 hover:text-gray-600">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    `;
    document.body.appendChild(indicator);
    
    setTimeout(() => {
      if (document.getElementById('reply-indicator')) {
        indicator.classList.remove('animate-pulse');
      }
    }, 2000);
  }

  window.cancelReply = function() {
    state.replyingTo = null;
    el.message.value = el.message.value.replace(/^↩️ Respondendo a: .+\n\n/, '');
    document.getElementById('reply-indicator')?.remove();
    document.querySelectorAll('.replying-to').forEach(el => {
      el.classList.remove('replying-to', 'ring-2', 'ring-blue-400');
    });
  };

  // --- Envio de mensagens ---
  el.send.addEventListener('click', async () => {
    let text = el.message.value.replace(/^↩️ Respondendo a: .+\n\n/, '').trim();
    
    if (!text) {
      showToast('Digite uma mensagem', 'error');
      return;
    }
    
    const ids = Array.from(state.selected);
    if (!ids.length) {
      showToast('Selecione pelo menos um grupo', 'error');
      return;
    }

    const payload = { groupIds: ids, message: text };
    if (state.replyingTo) {
      payload.replyTo = state.replyingTo;
    }

    el.send.disabled = true;
    el.send.innerHTML = '<span class="animate-pulse">Enviando...</span>';
    
    try {
      const r = await fetch(`${window.BACKEND_URL}/api/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await r.json();
      
      if (!r.ok || !data.ok) throw new Error(data.error || 'Falha no envio');

      const now = Date.now();
      
      if (data.results) {
        let successCount = 0;
        for (const result of data.results) {
          if (result.success) {
            successCount++;
            pushChat(
              result.groupId, 
              'Você', 
              text, 
              now,
              result.messageId,
              state.replyingTo ? state.replyingTo.text : null
            );
          }
        }
        showToast(`Enviado para ${successCount}/${ids.length} grupos`, successCount === ids.length ? 'success' : 'warning');
      } else {
        for (const gid of ids) {
          pushChat(gid, 'Você', text, now, null, state.replyingTo ? state.replyingTo.text : null);
        }
        showToast(`Mensagem enviada!`, 'success');
      }

      el.message.value = '';
      state.replyingTo = null;
      window.cancelReply();
      
    } catch (e) {
      showToast('Erro: ' + e.message, 'error');
    } finally {
      el.send.disabled = false;
      updateSelectedCount();
    }
  });

  // Toast notifications
  function showToast(message, type = 'info') {
    const existingToasts = document.querySelectorAll('.toast-notification');
    const offset = existingToasts.length * 60;
    
    const toast = document.createElement('div');
    toast.className = `toast-notification fixed right-4 px-4 py-2 rounded-lg shadow-lg z-50 transition-all ${
      type === 'success' ? 'bg-green-500 text-white' :
      type === 'error' ? 'bg-red-500 text-white' :
      type === 'warning' ? 'bg-amber-500 text-white' :
      'bg-blue-500 text-white'
    }`;
    toast.style.top = `${20 + offset}px`;
    toast.textContent = message;
    document.body.appendChild(toast);
    
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // --- Eventos Socket.IO ---
  socket.on('connect', () => {
    console.log('✅ Socket conectado ao backend');
    state.connectionAttempts = 0;
    showToast('Conectado ao servidor', 'success');
  });
  
  socket.on('disconnect', () => {
    console.log('❌ Socket desconectado');
    setStatus('Desconectado do servidor', false);
  });
  
  socket.on('reconnecting', (attemptNumber) => {
    state.connectionAttempts = attemptNumber;
    console.log(`🔄 Tentando reconectar... (tentativa ${attemptNumber})`);
    setStatus(`Reconectando... (tentativa ${attemptNumber})`, false);
  });
  
  socket.on('reconnect_failed', () => {
    console.log('❌ Falha ao reconectar');
    setStatus('Falha na conexão. Recarregue a página.', false);
    showToast('Conexão perdida. Recarregue a página.', 'error');
  });
  
  socket.on('qr', ({ dataUrl }) => {
    console.log('📱 QR Code recebido');
    setQR(dataUrl);
    addResetButton();
    if (el.qrCard?.classList.contains('hidden')) {
      el.qrCard.classList.remove('hidden');
    }
  });
  
  socket.on('ready', () => { 
    console.log('✅ WhatsApp conectado');
    setStatus('WhatsApp conectado ✅', true); 
    fetchGroups();
    showToast('WhatsApp conectado com sucesso!', 'success');
    if (el.qrCard && !el.qrCard.classList.contains('hidden')) {
      el.qrCard.classList.add('hidden');
    }
  });
  
  socket.on('disconnected', () => {
    setStatus('WhatsApp desconectado. Aguarde reconexão...', false);
    if (el.qrCard?.classList.contains('hidden')) {
      el.qrCard.classList.remove('hidden');
      setQR(null);
      addResetButton();
    }
  });
  
  socket.on('status', ({ ready }) => { 
    if (ready) { 
      setStatus('WhatsApp conectado ✅', true); 
      fetchGroups();
      if (el.qrCard && !el.qrCard.classList.contains('hidden')) {
        el.qrCard.classList.add('hidden');
      }
    } else {
      setStatus('Aguardando conexão...', false);
      addResetButton();
    }
  });
  
  socket.on('message', ({ groupId, from, text, timestamp, messageId }) => {
    pushChat(groupId, from, text, timestamp, messageId);
  });
  
  socket.on('message_sent', ({ groupId, text, timestamp, messageId, isReply }) => {
    console.log('Confirmação de envio:', { groupId, messageId, isReply });
  });

  // Atalhos de teclado
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Enter' && document.activeElement === el.message) {
      el.send.click();
    }
    if (e.key === 'Escape' && state.replyingTo) {
      window.cancelReply();
    }
  });

  // Solicita status inicial
  setTimeout(() => {
    socket.emit('request-status');
  }, 1000);
});
