const webpush = require('web-push');
const { Pool } = require('pg');
const cron = require('node-cron');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Criar tabelas se não existirem
async function initAlertsTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS monitors (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      keyword TEXT,
      location TEXT,
      city TEXT,
      max_price NUMERIC,
      interval_hours INTEGER DEFAULT 2,
      whatsapp_phone TEXT,
      active BOOLEAN DEFAULT TRUE,
      created_at BIGINT,
      last_checked BIGINT,
      next_check BIGINT
    );
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      session_id TEXT PRIMARY KEY,
      subscription JSONB,
      updated_at BIGINT
    );
    CREATE TABLE IF NOT EXISTS fired_alerts (
      id TEXT PRIMARY KEY,
      monitor_id TEXT,
      listing_url TEXT,
      fired_at BIGINT
    );
  `).catch(err => console.warn('[Alerts] Erro ao criar tabelas:', err.message));
}
initAlertsTables();

// Configura VAPID — lê do .env ou usa padrão de desenvolvimento
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || 'BBeJlscCtAwLv75_YcbJHus8lySB7T8ONp9GAG4KDztm5SebE8ixNIyJ3Xtvx9a2nsuFjc7Ny8uZs7q07NRX_c4';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '5SebE8ixNIyJ3Xtvx9a2nsuFjc7Ny8uZs7q07NRX_c4';

webpush.setVapidDetails('mailto:marketscan@app.com', VAPID_PUBLIC, VAPID_PRIVATE);

// Salva subscription do browser
async function saveSubscription(sessionId, subscription) {
  await pool.query(
    `INSERT INTO push_subscriptions (session_id, subscription, updated_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (session_id) DO UPDATE SET subscription = $2, updated_at = $3`,
    [sessionId, JSON.stringify(subscription), Date.now()]
  ).catch(err => console.warn('[Alerts] saveSubscription error:', err.message));
}

// Salva um monitor de preço
async function saveMonitor(sessionId, keyword, location, city, maxPrice, intervalHours = 2, whatsappPhone = null) {
  const id = `${sessionId}_${Date.now()}`;
  await pool.query(
    `INSERT INTO monitors (id, session_id, keyword, location, city, max_price, interval_hours, whatsapp_phone, active, created_at, last_checked, next_check)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,$9,NULL,$9)`,
    [id, sessionId, keyword, location, city, maxPrice, intervalHours, whatsappPhone, Date.now()]
  ).catch(err => console.warn('[Alerts] saveMonitor error:', err.message));
  return id;
}

// Lista monitores de uma sessão
async function getMonitors(sessionId) {
  const res = await pool.query(
    'SELECT * FROM monitors WHERE session_id = $1 ORDER BY created_at DESC',
    [sessionId]
  ).catch(() => ({ rows: [] }));
  return res.rows.map(r => ({
    id: r.id,
    sessionId: r.session_id,
    keyword: r.keyword,
    location: r.location,
    city: r.city,
    maxPrice: r.max_price,
    intervalHours: r.interval_hours,
    whatsappPhone: r.whatsapp_phone,
    active: r.active,
    createdAt: r.created_at,
    lastChecked: r.last_checked,
    nextCheck: r.next_check,
  }));
}

// Remove um monitor
async function removeMonitor(id) {
  await pool.query('DELETE FROM monitors WHERE id = $1', [id])
    .catch(err => console.warn('[Alerts] removeMonitor error:', err.message));
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

// ─── Z-API WhatsApp ───────────────────────────────────────
const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE_ID;
const ZAPI_TOKEN    = process.env.ZAPI_TOKEN;

async function sendWhatsApp(phone, message) {
  if (!ZAPI_INSTANCE || !ZAPI_TOKEN) {
    console.warn('[WhatsApp] ZAPI_INSTANCE_ID ou ZAPI_TOKEN não configurados.');
    return false;
  }
  let number = phone.replace(/\D/g, '');
  if (!number.startsWith('55')) number = '55' + number;
  try {
    const res = await fetch(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: number, message }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || JSON.stringify(data));
    console.log(`[WhatsApp] Mensagem enviada para ${number}`);
    return true;
  } catch (err) {
    console.error(`[WhatsApp] Erro ao enviar para ${number}:`, err.message);
    return false;
  }
}

// Inicia o cron que verifica os monitores a cada 30 minutos
function startMonitorCron(scrapeMarketplace, analyzeListings, hasSavedCookies) {
  cron.schedule('*/30 * * * *', async () => {
    const now = Date.now();
    const monitorsRes = await pool.query('SELECT * FROM monitors WHERE active = TRUE').catch(() => ({ rows: [] }));
    const monitors = monitorsRes.rows.map(r => ({ id: r.id, sessionId: r.session_id, keyword: r.keyword, location: r.location, city: r.city, maxPrice: r.max_price, intervalHours: r.interval_hours, whatsappPhone: r.whatsapp_phone, nextCheck: r.next_check }));

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
          const priceFormatted = hit.price.toLocaleString('pt-BR', { minimumFractionDigits: 0 });
          const pctText = hit.pct_below_avg > 0 ? ` (${hit.pct_below_avg}% abaixo da média)` : '';

          // Push notification
          const pushSent = await sendPush(monitor.sessionId, {
            title: '🔥 Oportunidade no MarketScan!',
            body: `${hit.title} por R$ ${priceFormatted} em ${hit.location || monitor.city}`,
            url: hit.listing_url,
            tag: `alert_${hit.external_id}`,
          });

          // WhatsApp via Z-API
          let waSent = false;
          if (monitor.whatsappPhone) {
            const waMessage = `🔔 *Alerta MarketScan!*

📦 *${hit.title}*
💰 R$ ${priceFormatted}${pctText}
📍 ${hit.location || monitor.city}

👉 ${hit.listing_url}

_Alerta configurado para: ${monitor.keyword} abaixo de R$ ${monitor.maxPrice}_`;
            waSent = await sendWhatsApp(monitor.whatsappPhone, waMessage);
          }

          if (pushSent || waSent) {
            markFired(monitor.id, hit.external_id);
            console.log(`[Monitor] Alerta enviado: ${hit.title} — R$ ${hit.price} | push:${pushSent} wa:${waSent}`);
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
  sendWhatsApp,
  VAPID_PUBLIC_KEY: VAPID_PUBLIC,
  saveSubscription,
  saveMonitor,
  getMonitors,
  removeMonitor,
  sendPush,
  startMonitorCron,
};
