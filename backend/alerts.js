const webpush = require('web-push');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');

const DATA_DIR = path.join(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const adapter = new FileSync(path.join(DATA_DIR, 'alerts.json'));
const db = low(adapter);
db.defaults({ subscriptions: [], monitors: [], fired: [] }).write();

// Configura VAPID — lê do .env ou usa padrão de desenvolvimento
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || 'BBeJlscCtAwLv75_YcbJHus8lySB7T8ONp9GAG4KDztm5SebE8ixNIyJ3Xtvx9a2nsuFjc7Ny8uZs7q07NRX_c4';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '5SebE8ixNIyJ3Xtvx9a2nsuFjc7Ny8uZs7q07NRX_c4';

webpush.setVapidDetails('mailto:marketscan@app.com', VAPID_PUBLIC, VAPID_PRIVATE);

// Salva subscription do browser
function saveSubscription(sessionId, subscription) {
  const existing = db.get('subscriptions').find({ sessionId }).value();
  if (existing) {
    db.get('subscriptions').find({ sessionId }).assign({ subscription, updatedAt: Date.now() }).write();
  } else {
    db.get('subscriptions').push({ sessionId, subscription, createdAt: Date.now() }).write();
  }
}

// Salva um monitor de preço
function saveMonitor(sessionId, keyword, location, city, maxPrice, intervalHours = 2) {
  const id = `${sessionId}_${Date.now()}`;
  db.get('monitors').push({
    id,
    sessionId,
    keyword,
    location,
    city,
    maxPrice,
    intervalHours,
    active: true,
    createdAt: Date.now(),
    lastChecked: null,
    nextCheck: Date.now(), // roda imediatamente na primeira vez
  }).write();
  return id;
}

// Lista monitores de uma sessão
function getMonitors(sessionId) {
  return db.get('monitors').filter({ sessionId }).value();
}

// Remove um monitor
function removeMonitor(id) {
  db.get('monitors').remove({ id }).write();
}

// Envia push notification para uma sessão
async function sendPush(sessionId, payload) {
  const sub = db.get('subscriptions').find({ sessionId }).value();
  if (!sub) return false;

  try {
    await webpush.sendNotification(sub.subscription, JSON.stringify(payload));
    return true;
  } catch (err) {
    console.error('Erro ao enviar push:', err.statusCode, err.message);
    // Se subscription inválida (410), remove
    if (err.statusCode === 410) {
      db.get('subscriptions').remove({ sessionId }).write();
    }
    return false;
  }
}

// Chave única para evitar notificar o mesmo anúncio duas vezes
function firedKey(monitorId, listingId) {
  return `${monitorId}_${listingId}`;
}

function alreadyFired(monitorId, listingId) {
  return db.get('fired').includes(firedKey(monitorId, listingId)).value();
}

function markFired(monitorId, listingId) {
  db.get('fired').push(firedKey(monitorId, listingId)).write();
  // Limpa registros antigos (mantém só os últimos 500)
  const fired = db.get('fired').value();
  if (fired.length > 500) {
    db.set('fired', fired.slice(-500)).write();
  }
}

// Inicia o cron que verifica os monitores a cada 30 minutos
function startMonitorCron(scrapeMarketplace, analyzeListings, hasSavedCookies) {
  cron.schedule('*/30 * * * *', async () => {
    const now = Date.now();
    const monitors = db.get('monitors').filter({ active: true }).value();

    for (const monitor of monitors) {
      if (monitor.nextCheck > now) continue;
      if (!hasSavedCookies(monitor.sessionId)) continue;

      console.log(`[Monitor] Verificando: "${monitor.keyword}" para sessão ${monitor.sessionId}`);

      try {
        const listings = await scrapeMarketplace(
          monitor.sessionId,
          monitor.keyword,
          monitor.location,
          60,
          { removeAccessories: true, removeDefects: true, removeNoPrice: true, city: monitor.city }
        );

        const { listings: analyzed } = analyzeListings(listings);

        // Filtra apenas os que estão abaixo do preço alvo
        const hits = analyzed.filter(l =>
          l.price !== null &&
          l.price <= monitor.maxPrice &&
          l.external_id &&
          !alreadyFired(monitor.id, l.external_id)
        );

        for (const hit of hits) {
          const pct = Math.abs(hit.pct_below_avg || 0);
          const sent = await sendPush(monitor.sessionId, {
            title: '🔥 Oportunidade no MarketScan!',
            body: `${hit.title} por R$ ${hit.price.toLocaleString('pt-BR')} em ${hit.location || monitor.city}`,
            url: hit.listing_url,
            tag: `alert_${hit.external_id}`,
          });

          if (sent) {
            markFired(monitor.id, hit.external_id);
            console.log(`[Monitor] Alerta enviado: ${hit.title} — R$ ${hit.price}`);
          }
        }

        // Agenda próxima verificação
        db.get('monitors').find({ id: monitor.id }).assign({
          lastChecked: now,
          nextCheck: now + monitor.intervalHours * 60 * 60 * 1000,
        }).write();

      } catch (err) {
        console.error(`[Monitor] Erro ao verificar "${monitor.keyword}":`, err.message);
      }
    }
  });

  console.log('✅ Monitor de alertas iniciado (verifica a cada 30 min)');
}

module.exports = {
  VAPID_PUBLIC_KEY: VAPID_PUBLIC,
  saveSubscription,
  saveMonitor,
  getMonitors,
  removeMonitor,
  sendPush,
  startMonitorCron,
};
