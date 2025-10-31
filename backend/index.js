// backend/index.js
app.post('/api/send', async (req, res) => {
  try {
    const { groupIds, message, replyTo } = req.body;
    if (!groupIds?.length) throw new Error('Nenhum grupo selecionado.');
    if (!message) throw new Error('Mensagem vazia.');

    for (const gid of groupIds) {
      let options = {};

      // Caso seja resposta
      if (replyTo?.groupId && replyTo?.text) {
        const storeMsg = store.messages[replyTo.groupId]?.find(m => m.message?.conversation === replyTo.text);
        if (storeMsg) {
          options.quoted = storeMsg; // Envia como resposta real
        } else {
          // Se não achar a msg original, envia como texto simples
          message = `*${replyTo?.from || 'Você'} respondeu:* ${replyTo.text}\n\n${message}`;
        }
      }

      await sock.sendMessage(gid, { text: message }, options);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Erro ao enviar mensagem:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});
