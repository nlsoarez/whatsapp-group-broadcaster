# 🚀 WhatsApp Broadcaster - Versão 3.0 (Multi-Sessão)

Sistema profissional de broadcasting para WhatsApp com suporte a **5 usuários simultâneos**, cada um com sua própria sessão/login WhatsApp.

## ✨ Novidades da Versão 3.0

### 🔥 Multi-Sessão (5 Usuários)
- Cada usuário tem sua própria sessão WhatsApp
- QR Codes independentes por usuário
- Isolamento completo de dados e mensagens
- Logout de um usuário não afeta os outros

### 🏗️ Arquitetura
- **SessionManager**: Gerencia múltiplas conexões WhatsApp
- **Socket.IO Rooms**: Eventos isolados por sessão
- **APIs com contexto**: Todas rotas validam sessionId
- **Persistência**: Cada sessão salva em diretório próprio

---

## 📁 Estrutura do Projeto

```
whatsapp-group-broadcaster/
├── backend/
│   ├── index.js           # Servidor principal (multi-sessão)
│   ├── sessionManager.js  # Gerenciador de sessões
│   ├── package.json       # Dependências
│   ├── .env.example       # Variáveis de ambiente
│   └── auth/              # Credenciais por usuário
│       ├── user_123abc/   # Sessão usuário 1
│       ├── user_456def/   # Sessão usuário 2
│       └── ...
├── docs/
│   ├── index.html         # Frontend principal
│   ├── app.js             # JavaScript (com sessionId)
│   └── monitoring.html    # Janela de monitoramento
├── railway.json           # Config Railway
├── nixpacks.toml          # Config build
└── Procfile               # Comando de inicialização
```

---

## 🚀 Deploy no Railway

### 1. Criar Projeto no Railway

```bash
# Via CLI
railway login
railway init
railway up
```

### 2. Ou via GitHub
1. Conecte seu repositório ao Railway
2. O Railway detectará automaticamente as configurações
3. Deploy automático a cada push

### 3. Variáveis de Ambiente (opcional)
```
PORT=3000              # Railway define automaticamente
MAX_SESSIONS=5         # Máximo de usuários
CORS_ORIGIN=*          # Origens permitidas
```

### 4. Após Deploy
1. Copie a URL gerada pelo Railway
2. Atualize `window.BACKEND_URL` no `docs/index.html`
3. Hospede o frontend (GitHub Pages, Vercel, Netlify)

---

## 💻 Desenvolvimento Local

```bash
# Backend
cd backend
npm install
npm run dev

# Frontend
# Abra docs/index.html no navegador
# Ou use um servidor local:
npx serve docs -p 8080
```

---

## 🔌 API Endpoints

### Sessões
| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/api/health` | Status do servidor |
| GET | `/api/sessions` | Lista todas sessões |
| POST | `/api/session/start?sessionId=xxx` | Inicia sessão |
| GET | `/api/session/status?sessionId=xxx` | Status da sessão |

### Mensagens
| Método | Endpoint | Descrição |
|--------|----------|-----------|
| POST | `/api/send?sessionId=xxx` | Envia mensagens |
| GET | `/api/groups?sessionId=xxx` | Lista grupos |
| GET | `/api/group-picture/:jid?sessionId=xxx` | Foto do grupo |

### Controle
| Método | Endpoint | Descrição |
|--------|----------|-----------|
| POST | `/api/logout?sessionId=xxx` | Logout |
| POST | `/api/reset-session?sessionId=xxx` | Reset |
| DELETE | `/api/session/:sessionId` | Remove sessão |

---

## 🎯 Funcionalidades

### Core
- ✅ Login via QR Code (por usuário)
- ✅ Seleção múltipla de grupos
- ✅ Envio broadcast inteligente
- ✅ Sistema de reply automático
- ✅ Monitoramento em tempo real

### Multi-Sessão
- ✅ 5 usuários simultâneos
- ✅ Sessões isoladas
- ✅ Persistência de credenciais
- ✅ Limpeza automática de inativas

### Interface
- 🎨 Design moderno (Tailwind CSS)
- 📱 Responsivo
- 🔔 Notificações toast
- 📊 Estatísticas em tempo real
- 🔍 Busca de grupos
- 📋 Copiar link da sessão

---

## 📊 Recursos do Servidor

| Recurso | Por Sessão | 5 Sessões |
|---------|-----------|-----------|
| RAM | ~5 MB | ~25 MB |
| Cache | ~1-5 MB | ~5-25 MB |
| CPU (idle) | 1-2% | 5-10% |

**Recomendação:** Mínimo 512 MB RAM

---

## 🔒 Segurança

- Cada usuário tem credenciais isoladas
- Socket.IO rooms para eventos privados
- Validação de sessionId em todas as rotas
- Limpeza automática de sessões inativas (24h)

---

## 🐛 Troubleshooting

### QR Code não aparece
1. Verifique se o backend está rodando
2. Confira a URL do backend no frontend
3. Verifique os logs do servidor

### Limite de sessões atingido
- Máximo de 5 sessões por padrão
- Configure `MAX_SESSIONS` para alterar
- Use `/api/sessions` para ver sessões ativas

### Sessão não persiste
- Verifique permissões do diretório `auth/`
- No Railway, use volumes persistentes

---

## 📝 Notas

1. **Sessão por navegador**: Cada aba/navegador gera um sessionId único
2. **Compartilhar sessão**: Use `?session=xxx` na URL
3. **Nova sessão**: Clique em "Nova" no header

---

## 🚀 Versões

- **v3.0.0** - Multi-sessão (5 usuários), Railway
- **v2.0.0** - Logout, histórico completo, expansão
- **v1.0.0** - Versão inicial

---

**Desenvolvido por:** Nelson Leandro
**Versão:** 3.0.0
**Data:** Dezembro 2025

💜 Obrigado pela confiança!
