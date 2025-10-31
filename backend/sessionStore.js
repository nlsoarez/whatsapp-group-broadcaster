// backend/sessionStore.js
import { useMultiFileAuthState, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys'
import path from 'node:path'
import fs from 'node:fs'


const SESSIONS_DIR = path.join(process.cwd(), 'sessions')
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR)


export async function getAuthState() {
const { state, saveCreds } = await useMultiFileAuthState(SESSIONS_DIR)
return { state, saveCreds }
}


export function getSignalKeyStore(state) {
return makeCacheableSignalKeyStore(state.keys)
}
