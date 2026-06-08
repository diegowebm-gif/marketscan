const path = require('path');
const fs = require('fs');

const AUTH_DIR = path.join(__dirname, '../data/baileys_auth');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

let sock = null;
let isConnected = false;
let connectionRetries = 0;
let lastQR = null;

async function connectWhatsApp() {
  try {
    console.log('[WhatsApp] Importando Baileys...');
    const baileysModule = await import('@whiskeysockets/baileys');
    const makeWASocket = baileysModule.default;
    const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileysModule;

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    const { default: pino } = await import('pino');

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false, // desabilitar print automático
      logger: pino({ level: 'silent' }),
      browser: ['MarketScan', 'Chrome', '1.0.0'],
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        lastQR = qr;
        // Gerar URL do QR Code para escanear no browser
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`;
        console.log('\n[WhatsApp] ============================================');
        console.log('[WhatsApp] ESCANEIE O QR CODE PELO LINK ABAIXO:');
        console.log(`[WhatsApp] ${qrUrl}`);
        console.log('[WhatsApp] ============================================\n');
        console.log('[WhatsApp] Ou acesse: https://marketscan.site/whatsapp-qr para escanear');
      }
      if (connection === 'close') {
        isConnected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log(`[WhatsApp] Conexão encerrada. Código: ${statusCode}`);
        if (shouldReconnect && connectionRetries < 5) {
          connectionRetries++;
          setTimeout(connectWhatsApp, 5000);
        } else if (!shouldReconnect) {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          fs.mkdirSync(AUTH_DIR, { recursive: true });
          setTimeout(connectWhatsApp, 3000);
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
