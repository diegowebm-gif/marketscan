const path = require('path');
const fs = require('fs');

const AUTH_DIR = path.join(__dirname, '../data/baileys_auth');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

let sock = null;
let isConnected = false;
let connectionRetries = 0;

async function connectWhatsApp() {
  try {
    console.log('[WhatsApp] Importando Baileys...');
    const baileysModule = await import('@whiskeysockets/baileys');
    const makeWASocket = baileysModule.default;
    const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileysModule;
    console.log('[WhatsApp] Baileys importado!');

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    console.log('[WhatsApp] Auth carregado, buscando versão...');
    const { version } = await fetchLatestBaileysVersion();
    console.log(`[WhatsApp] Versão: ${version}. Criando socket...`);

    const { default: pino } = await import('pino');

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: true,
      logger: pino({ level: 'silent' }),
      browser: ['MarketScan', 'Chrome', '1.0.0'],
    });

    console.log('[WhatsApp] Socket criado, aguardando conexão...');

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        console.log('\n[WhatsApp] ⬇️  ESCANEIE O QR CODE ABAIXO COM SEU WHATSAPP  ⬇️\n');
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
          console.log('[WhatsApp] Deslogado. Limpando auth...');
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
  } catch (err) {
    console.error('[WhatsApp] Erro fatal:', err.message);
    console.error(err.stack);
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

module.exports = { connectWhatsApp, sendWhatsAppBaileys, isConnected: () => isConnected };
