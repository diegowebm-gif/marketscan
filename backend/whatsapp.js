const path = require('path');
const fs = require('fs');

const AUTH_DIR = path.join(__dirname, '../data/baileys_auth');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

let sock = null;
let isConnected = false;
let connectionRetries = 0;

async function connectWhatsApp() {
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = await import('@whiskeysockets/baileys');
  const { Boom } = await import('@hapi/boom');
  const pino = (await import('pino')).default;

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' }),
    browser: ['MarketScan', 'Chrome', '1.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n[WhatsApp] Escaneie o QR Code acima com seu WhatsApp!\n');
    }
    if (connection === 'close') {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`[WhatsApp] Conexão encerrada. Código: ${statusCode}`);
      if (shouldReconnect && connectionRetries < 5) {
        connectionRetries++;
        console.log(`[WhatsApp] Reconectando... tentativa ${connectionRetries}`);
        setTimeout(connectWhatsApp, 5000);
      } else if (!shouldReconnect) {
        console.log('[WhatsApp] Deslogado. Limpando auth e reconectando...');
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        fs.mkdirSync(AUTH_DIR, { recursive: true });
        setTimeout(connectWhatsApp, 3000);
      }
    }
    if (connection === 'open') {
      isConnected = true;
      connectionRetries = 0;
      console.log('[WhatsApp] ✅ Conectado com sucesso!');
    }
  });
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

module.exports = { connectWhatsApp, sendWhatsAppBaileys, isConnected: () => isConnected };
