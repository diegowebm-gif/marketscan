const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Criar tabela de sessão no banco
async function initWhatsAppTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_session (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at BIGINT
    )
  `).catch(err => console.warn('[WhatsApp] Erro ao criar tabela:', err.message));
  console.log('[WhatsApp] Tabela de sessão pronta');
}

// Auth state usando PostgreSQL
async function usePostgresAuthState() {
  await initWhatsAppTable();

  async function readData(key) {
    try {
      const res = await pool.query('SELECT value FROM whatsapp_session WHERE key = $1', [key]);
      if (res.rows.length === 0) return null;
      return JSON.parse(res.rows[0].value);
    } catch { return null; }
  }

  async function writeData(key, value) {
    try {
      await pool.query(
        `INSERT INTO whatsapp_session (key, value, updated_at) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = $3`,
        [key, JSON.stringify(value), Date.now()]
      );
    } catch (err) {
      console.warn('[WhatsApp] Erro ao salvar sessão:', err.message);
    }
  }

  async function removeData(key) {
    await pool.query('DELETE FROM whatsapp_session WHERE key = $1', [key]).catch(() => {});
  }

  // Carregar creds do banco
  const creds = await readData('creds');

  const state = {
    creds: creds || undefined,
    keys: {
      get: async (type, ids) => {
        const data = {};
        for (const id of ids) {
          const val = await readData(`${type}-${id}`);
          if (val) data[id] = val;
        }
        return data;
      },
      set: async (data) => {
        for (const [type, typeData] of Object.entries(data)) {
          for (const [id, value] of Object.entries(typeData)) {
            if (value) {
              await writeData(`${type}-${id}`, value);
            } else {
              await removeData(`${type}-${id}`);
            }
          }
        }
      }
    }
  };

  async function saveCreds() {
    await writeData('creds', state.creds);
  }

  return { state, saveCreds };
}

let sock = null;
let isConnected = false;
let connectionRetries = 0;
let lastQR = null;

async function connectWhatsApp() {
  try {
    console.log('[WhatsApp] Importando Baileys...');
    const baileysModule = await import('@whiskeysockets/baileys');
    const makeWASocket = baileysModule.default;
    const { DisconnectReason, fetchLatestBaileysVersion, initAuthCreds, BufferJSON } = baileysModule;
    console.log('[WhatsApp] Baileys importado!');

    const { state, saveCreds } = await usePostgresAuthState();
    
    // Se não tem creds, inicializar
    if (!state.creds) {
      const { default: pino } = await import('pino');
      const { version } = await fetchLatestBaileysVersion();
      state.creds = initAuthCreds();
      
      sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['MarketScan', 'Chrome', '1.0.0'],
      });
    } else {
      const { default: pino } = await import('pino');
      const { version } = await fetchLatestBaileysVersion();
      
      sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['MarketScan', 'Chrome', '1.0.0'],
      });
    }

    console.log('[WhatsApp] Socket criado, aguardando conexão...');

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        lastQR = qr;
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`;
        console.log('\n[WhatsApp] ============================================');
        console.log('[WhatsApp] ESCANEIE O QR CODE:');
        console.log(`[WhatsApp] ${qrUrl}`);
        console.log(`[WhatsApp] Ou acesse: https://marketscan.site/whatsapp-qr`);
        console.log('[WhatsApp] ============================================\n');
      }
      if (connection === 'close') {
        isConnected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`[WhatsApp] Conexão encerrada. Código: ${statusCode}`);

        // Código undefined = sessão inválida, limpar e gerar novo QR
        if (!statusCode || statusCode === 401 || statusCode === 440) {
          console.log('[WhatsApp] Sessão inválida. Limpando banco e gerando novo QR...');
          await pool.query('DELETE FROM whatsapp_session').catch(() => {});
          connectionRetries = 0;
          setTimeout(connectWhatsApp, 3000);
          return;
        }

        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        if (!shouldReconnect) {
          console.log('[WhatsApp] Deslogado. Limpando sessão...');
          await pool.query('DELETE FROM whatsapp_session').catch(() => {});
          connectionRetries = 0;
          setTimeout(connectWhatsApp, 3000);
          return;
        }
        if (connectionRetries < 5) {
          connectionRetries++;
          console.log(`[WhatsApp] Reconectando... tentativa ${connectionRetries}`);
          setTimeout(connectWhatsApp, 5000);
        }
      }
      if (connection === 'open') {
        isConnected = true;
        lastQR = null;
        connectionRetries = 0;
        console.log('[WhatsApp] ✅ Conectado com sucesso! Sessão salva no banco.');
      }
    });
  } catch (err) {
    console.error('[WhatsApp] Erro fatal:', err.message, err.stack);
    setTimeout(connectWhatsApp, 10000);
  }
}

async function sendWhatsAppBaileys(phone, message) {
  if (!isConnected || !sock) {
    console.warn('[WhatsApp] Não conectado.');
    return false;
  }
  try {
    let number = phone.replace(/\D/g, '');
    if (!number.startsWith('55')) number = '55' + number;
    const jid = `${number}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    console.log(`[WhatsApp] ✅ Mensagem enviada para ${number}`);
    return true;
  } catch (err) {
    console.error(`[WhatsApp] Erro ao enviar:`, err.message);
    return false;
  }
}

function getLastQR() { return lastQR; }
function getIsConnected() { return isConnected; }

module.exports = { connectWhatsApp, sendWhatsAppBaileys, getLastQR, getIsConnected };
