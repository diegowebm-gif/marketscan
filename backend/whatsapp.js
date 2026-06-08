const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function initWhatsAppTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_session (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at BIGINT
    )
  `).catch(err => console.warn('[WhatsApp] Erro ao criar tabela:', err.message));
}

async function readData(key) {
  try {
    const res = await pool.query('SELECT value FROM whatsapp_session WHERE key = $1', [key]);
    if (res.rows.length === 0) return null;
    return JSON.parse(res.rows[0].value);
  } catch { return null; }
}

async function writeData(key, value) {
  try {
    const str = JSON.stringify(value, (k, v) => {
      if (v instanceof Uint8Array) return { __type: 'Buffer', data: Array.from(v) };
      return v;
    });
    await pool.query(
      `INSERT INTO whatsapp_session (key, value, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = $3`,
      [key, str, Date.now()]
    );
  } catch (err) {
    console.warn('[WhatsApp] Erro ao salvar:', key, err.message);
  }
}

function reviver(k, v) {
  if (v && typeof v === 'object' && v.__type === 'Buffer') {
    return Buffer.from(v.data);
  }
  return v;
}

async function removeData(key) {
  await pool.query('DELETE FROM whatsapp_session WHERE key = $1', [key]).catch(() => {});
}

let sock = null;
let isConnected = false;
let connectionRetries = 0;
let lastQR = null;

async function connectWhatsApp() {
  try {
    await initWhatsAppTable();
    
    console.log('[WhatsApp] Importando Baileys...');
    const baileysModule = await import('@whiskeysockets/baileys');
    const makeWASocket = baileysModule.makeWASocket || baileysModule.default;
    const { DisconnectReason, fetchLatestBaileysVersion, initAuthCreds } = baileysModule;
    const { default: pino } = await import('pino');
    console.log('[WhatsApp] Baileys importado!');

    // Carregar creds
    const rawCreds = await readData('creds');
    const creds = rawCreds ? JSON.parse(JSON.stringify(rawCreds), reviver) : initAuthCreds();
    console.log('[WhatsApp] Creds no banco:', rawCreds ? 'SIM' : 'NÃO');

    const state = {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async id => {
            const raw = await readData(`key-${type}-${id}`);
            if (raw) data[id] = JSON.parse(JSON.stringify(raw), reviver);
          }));
          return data;
        },
        set: async (data) => {
          await Promise.all(
            Object.entries(data).flatMap(([type, typeData]) =>
              Object.entries(typeData).map(async ([id, value]) => {
                if (value != null) {
                  await writeData(`key-${type}-${id}`, value);
                } else {
                  await removeData(`key-${type}-${id}`);
                }
              })
            )
          );
        }
      }
    };

    async function saveCreds() {
      await writeData('creds', state.creds);
    }

    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['MarketScan', 'Chrome', '1.0.0'],
    });

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
        const err = lastDisconnect?.error;
        const statusCode = err?.output?.statusCode || err?.data?.statusCode;
        console.log(`[WhatsApp] Conexão encerrada. Código: ${statusCode}`);

        if (statusCode === 515) {
          console.log('[WhatsApp] Restart required — salvando creds e reconectando...');
          await saveCreds();
          connectionRetries = 0;
          setTimeout(connectWhatsApp, 1500);
          return;
        }

        if (statusCode === 401) {
          console.log('[WhatsApp] Deslogado. Limpando sessão...');
          await pool.query('DELETE FROM whatsapp_session').catch(() => {});
          connectionRetries = 0;
          setTimeout(connectWhatsApp, 3000);
          return;
        }

        if (!statusCode && connectionRetries >= 4) {
          console.log('[WhatsApp] Muitas falhas. Limpando sessão...');
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
        await saveCreds();
        console.log('[WhatsApp] ✅ Conectado com sucesso!');
      }
    });
  } catch (err) {
    console.error('[WhatsApp] Erro fatal:', err.message);
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
