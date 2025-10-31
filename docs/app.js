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
    messageIdMap: new Map(), // Mapeia texto -> messageId
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
      div.className = 'flex items-center space-x-2 border rounded-lg p-2 hover:bg-slate-50 cursor-pointer';

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
      img.onerror = () => { img.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23999"%3E%3Cpath d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/%3E%3C/svg%3E'; };
      
      fetch(`${window.BACKEND_URL}/api/group-picture/${g.id}`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d?.url) img.src = d.url; })
        .catch(() => {});

      const span = document.createElement('span');
      span.textContent = g.subject;
      span.className = 'text-sm font-medium truncate flex-1';

      // Click no div seleciona/deseleciona
      div.onclick = (e) => {
        if (e.target !== checkbox) {
          checkbox.checked = !checkbox.checked;
          checkbox.onchange(e);
        }
      };

      div.appendChild(checkbox);
      div.appendChild(img);
      div.appendChild(span);
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
      }
    } catch (e) {
      console.error('Erro ao buscar grupos:', e);
    }
  }

  // --- Chat visual melhorado ---
  function pushChat(groupId, who, text, ts, messageId, replyText) {
    if (!state.chatByGroup.has(groupId)) state.chatByGroup.set(groupId, []);
    const chatEntry = { who, text, ts, messageId, replyText };
    state.chatByGroup.get(groupId).push(chatEntry);
    
    // Armazena messageId para poder referenciar depois
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
      
      // Header do grupo
      const header = document.createElement('div');
      header.className = 'flex items-center justify-between mb-3 pb-2 border-b';
      header.innerHTML = `
        <div class="font-semibold text-gray-800">${group ? group.subject : 'Grupo'}</div>
        <div class="text-xs text-gray-500">${msgs.length} mensagens</div>
      `;
      card.appendChild(header);

      // Container de mensagens com scroll
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
              <div class="text-gray-800">${m.text}</div>
            </div>
            <div class="text-[10px] text-gray-400 mt-auto">${time}</div>
          </div>
        `;
        
        msgDiv.innerHTML = content;

        // Clique para responder
        msgDiv.onclick = () => {
          // Limpa resposta anterior
          if (state.replyingTo) {
            el.message.value = el.message.value.replace(/^↩️ Respondendo a: .+\n\n/, '');
          }
          
          state.replyingTo = { 
            groupId: gid, 
            text: m.text, 
            from: m.who,
            messageId: m.messageId || state.messageIdMap.get(`${gid}:${m.text}`)
          };
          
          // Visual feedback
          document.querySelectorAll('.replying-to').forEach(el => el.classList.remove('replying-to', 'ring-2', 'ring-blue-400'));
          msgDiv.classList.add('replying-to', 'ring-2', 'ring-blue-400');
          
          // Atualiza textarea
          const currentText = el.message.value;
          el.message.value = `↩️ Respondendo a: ${m.who} - "${m.text.substring(0, 50)}${m.text.length > 50 ? '...' : ''}"\n\n${currentText}`;
          el.message.focus();
          el.message.setSelectionRange(el.message.value.length, el.message.value.length);
          
          // Mostra indicador visual
          showReplyIndicator(m.who, m.text);
        };

        messagesContainer.appendChild(msgDiv);
      }
      
      card.appendChild(messagesContainer);
      el.chats.appendChild(card);
    }
    
    // Auto-scroll para última mensagem
    const lastContainer = el.chats.lastElementChild?.querySelector('.overflow-y-auto');
    if (lastContainer) {
      lastContainer.scrollTop = lastContainer.scrollHeight;
    }
  }

  function showReplyIndicator(from, text) {
    // Remove indicador anterior se existir
    const existingIndicator = document.getElementById('reply-indicator');
    if (existingIndicator) existingIndicator.remove();
    
    // Cria novo indicador
    const indicator = document.createElement('div');
    indicator.id = 'reply-indicator';
    indicator.className = 'fixed bottom-20 right-6 bg-white shadow-lg rounded-lg p-3 max-w-sm border-l-4 border-blue-500 z-50';
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
    
    // Remove após 5 segundos
    setTimeout(() => {
      if (document.getElementById('reply-indicator')) {
        indicator.style.opacity = '0';
        setTimeout(() => indicator.remove(), 300);
      }
    }, 5000);
  }

  // Função global para cancelar resposta
  window.cancelReply = function() {
    state.replyingTo = null;
    el.message.value = el.message.value.replace(/^↩️ Respondendo a: .+\n\n/, '');
    document.getElementById('reply-indicator')?.remove();
    document.querySelectorAll('.replying-to').forEach(el => {
      el.classList.remove('replying-to', 'ring-2', 'ring-blue-400');
    });
  };

  // --- Envio de mensagens melhorado ---
  el.send.addEventListener('click', async () => {
    // Remove indicação de resposta do texto
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
      
      // Processa resultados por grupo
      if (data.results) {
        for (const result of data.results) {
          if (result.success) {
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
      } else {
        // Fallback para versão antiga
        for (const gid of ids) {
          pushChat(gid, 'Você', text, now, null, state.replyingTo ? state.replyingTo.text : null);
        }
      }

      el.message.value = '';
      state.replyingTo = null;
      window.cancelReply();
      showToast(`Mensagem enviada para ${ids.length} grupo(s)`, 'success');
      
    } catch (e) {
      showToast('Erro: ' + e.message, 'error');
    } finally {
      el.send.disabled = false;
      updateSelectedCount();
    }
  });

  // Sistema de Toast notifications
  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `fixed top-4 right-4 px-4 py-2 rounded-lg shadow-lg z-50 animate-pulse ${
      type === 'success' ? 'bg-green-500 text-white' :
      type === 'error' ? 'bg-red-500 text-white' :
      'bg-blue-500 text-white'
    }`;
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
    showToast('Conectado ao servidor', 'success');
  });
  
  socket.on('disconnect', () => {
    console.log('❌ Socket desconectado');
    showToast('Desconectado do servidor', 'error');
  });
  
  socket.on('qr', ({ dataUrl }) => setQR(dataUrl));
  
  socket.on('ready', () => { 
    setStatus('WhatsApp conectado ✅', true); 
    fetchGroups();
    showToast('WhatsApp conectado com sucesso!', 'success');
  });
  
  socket.on('disconnected', () => {
    setStatus('Desconectado. Aguarde novo QR ou reconexão.', false);
    showToast('WhatsApp desconectado', 'error');
  });
  
  socket.on('status', ({ ready }) => { 
    if (ready) { 
      setStatus('WhatsApp conectado ✅', true); 
      fetchGroups(); 
    } 
  });
  
  socket.on('message', ({ groupId, from, text, timestamp, messageId }) => {
    pushChat(groupId, from, text, timestamp, messageId);
  });
  
  socket.on('message_sent', ({ groupId, text, timestamp, messageId, isReply }) => {
    // Já adicionado no success do envio, mas mantém para redundância
    console.log('Confirmação de envio:', { groupId, messageId, isReply });
  });

  // Atalhos de teclado
  document.addEventListener('keydown', (e) => {
    // Ctrl+Enter para enviar
    if (e.ctrlKey && e.key === 'Enter' && document.activeElement === el.message) {
      el.send.click();
    }
    // ESC para cancelar resposta
    if (e.key === 'Escape' && state.replyingTo) {
      window.cancelReply();
    }
  });
});
