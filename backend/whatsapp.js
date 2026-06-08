const path = require('path');
const fs = require('fs');

// Usar arquivo local para sessão (mais confiável que banco para Baileys)
const AUTH_DIR = '/tmp/baileys_auth';
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

let sock = null;
let isConnected = false;
let connectionRetries = 0;
let lastQR = null;

async function connectWhatsApp() {
  try {
    console.log('[WhatsApp] Importando Baileys...');
    const baileysModule = await import('@whiskeysockets/baileys');
    const makeWASocket = baileysModule.makeWASocket || baileysModule.default;
    const { DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } = baileysModule;
    const { default: pino } = await import('pino');
    console.log('[WhatsApp] Baileys importado!');

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    
    const hasAuth = fs.existsSync(path.join(AUTH_DIR, 'creds.json'));
    console.log('[WhatsApp] Auth local:', hasAuth ? 'SIM' : 'NÃO');

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
          console.log('[WhatsApp] Restart required — reconectando...');
          connectionRetries = 0;
          setTimeout(connectWhatsApp, 1500);
          return;
        }

        if (statusCode === 401) {
          console.log('[WhatsApp] Deslogado. Limpando auth...');
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          fs.mkdirSync(AUTH_DIR, { recursive: true });
          connectionRetries = 0;
          setTimeout(connectWhatsApp, 3000);
          return;
        }

        if (!statusCode && connectionRetries >= 4) {
          console.log('[WhatsApp] Muitas falhas. Limpando auth...');
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          fs.mkdirSync(AUTH_DIR, { recursive: true });
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
