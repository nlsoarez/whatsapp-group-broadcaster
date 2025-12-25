FROM node:22-slim

# Instala git (necessário para algumas dependências npm)
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copia package.json primeiro para cache de dependências
COPY backend/package*.json ./backend/

# Instala dependências
WORKDIR /app/backend
RUN npm install

# Copia o resto do código
WORKDIR /app
COPY backend/ ./backend/

# Expõe a porta
EXPOSE 3000

# Comando de inicialização
WORKDIR /app/backend
CMD ["node", "index.js"]
