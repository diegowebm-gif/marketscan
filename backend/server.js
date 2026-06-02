require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const { register, login, getUserByToken, upgradeToPro, getLimits } = require('./auth');
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const { openLoginWindow, checkLogin, scrapeMarketplace, closeBrowser, analyzeListings, hasSavedCookies, saveCookies } = require('./scraper');
const { createSession, touchSession, saveSearch, saveListings, getListingsBySearch, getRecentSearches, savePriceSnapshot, getPriceHistory } = require('./database');
const { VAPID_PUBLIC_KEY, saveSubscription, saveMonitor, getMonitors, removeMonitor, sendPush, startMonitorCron } = require('./alerts');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

app.use(cors());

// ⚠️  WEBHOOK STRIPE: registrado ANTES do express.json()
// O Stripe precisa do body raw para validar a assinatura
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    if (webhookSecret) {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } else {
      // Sem secret configurado (dev local), aceita sem validar
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    console.error('[Stripe] Webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('[Stripe] Evento recebido:', event.type);

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const token = session.metadata?.userToken;
    if (token) {
      upgradeToPro(token, 1);
      console.log(`[Stripe] Plano Pro ativado para token: ${token.slice(0, 8)}...`);
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    console.log('[Stripe] Assinatura cancelada:', event.data.object.id);
    // TODO: revogar plano Pro do usuário correspondente
  }

  res.json({ received: true });
});

// Agora sim: JSON parser para o resto das rotas
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// ── Middleware de autenticação ─────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'] || req.body?.authToken || req.query?.authToken;
  const user = getUserByToken(token);
  if (!user) return res.status(401).json({ ok: false, error: 'Não autenticado. Faça login.' });
  req.user = user;
  req.limits = getLimits(user.plan);
  next();
}

function requirePro(req, res, next) {
  if (req.user.plan !== 'pro') {
    return res.status(403).json({ ok: false, error: 'Recurso exclusivo do plano Pro.', upgrade: true });
  }
  next();
}

// ── Auth ──────────────────────────────────────────────────
app.post('/api/auth/register', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ ok: false, error: 'E-mail e senha obrigatórios.' });
  if (password.length < 6) return res.status(400).json({ ok: false, error: 'Senha mínima de 6 caracteres.' });
  const result = register(email, password);
  res.json(result);
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ ok: false, error: 'E-mail e senha obrigatórios.' });
  const result = login(email, password);
  res.json(result);
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ ok: true, email: req.user.email, plan: req.user.plan, limits: req.limits, planExpiresAt: req.user.planExpiresAt });
});

app.post('/api/auth/upgrade', requireAuth, (req, res) => {
  const { months = 1 } = req.body;
  const result = upgradeToPro(req.headers['x-auth-token'] || req.body?.authToken, months);
  res.json(result);
});

// ── Sessão Facebook ───────────────────────────────────────
// FIX: não chama mais Puppeteer aqui — só monta a URL e devolve pro frontend
app.post('/api/session/start', requireAuth, async (req, res) => {
  try {
    const sessionId = uuidv4();
    createSession(sessionId);

    // O frontend vai abrir esta URL numa nova aba/popup
    // Após o login, o Facebook redireciona para /facebook-callback?sessionId=...
    const loginUrl = `https://www.facebook.com/login?next=${encodeURIComponent('https://www.facebook.com/marketplace')}`;

    res.json({ ok: true, sessionId, loginUrl });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Página de callback — o usuário chega aqui após fazer login no Facebook
// O JS desta página lê os cookies do browser e envia para o servidor
app.get('/facebook-callback', (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.redirect('/');
  res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Conectando...</title>
<style>
  body{font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:#020408;color:#e2e8f0;gap:1rem}
  .spinner{width:40px;height:40px;border:3px solid rgba(56,189,248,0.2);border-top-color:#38bdf8;border-radius:50%;animation:spin .7s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  p{color:#94a3b8;font-size:14px}
</style></head>
<body>
  <div class="spinner"></div>
  <p id="msg">Verificando login no Facebook...</p>
  <script>
    async function sendCookies() {
      const res = await fetch('/api/session/cookies', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          sessionId: '${sessionId}',
          cookies: document.cookie,
          userAgent: navigator.userAgent
        })
      });
      const data = await res.json();
      if (data.ok) {
        document.getElementById('msg').textContent = 'Conectado! Pode fechar esta janela.';
        setTimeout(() => window.close(), 1500);
      } else {
        document.getElementById('msg').textContent = 'Erro: ' + (data.error || 'tente novamente');
      }
    }
    sendCookies();
  </script>
</body></html>`);
});

// Recebe cookies do browser do usuário e salva para uso no Puppeteer
app.post('/api/session/cookies', async (req, res) => {
  const { sessionId, cookies, userAgent } = req.body;
  if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId obrigatório' });

  try {
    const cookieObj = {};
    (cookies || '').split(';').forEach(c => {
      const [k, ...rest] = c.trim().split('=');
      if (k) cookieObj[k.trim()] = rest.join('=') || '';
    });

    // Verifica se tem cookie de sessão ativa do Facebook
    const hasSession = cookieObj['c_user'] || cookieObj['xs'];
    if (!hasSession) {
      return res.json({ ok: false, error: 'Login no Facebook não detectado. Faça login no Facebook primeiro e tente novamente.' });
    }

    const puppeteerCookies = Object.entries(cookieObj).map(([name, value]) => ({
      name, value,
      domain: '.facebook.com',
      path: '/',
      httpOnly: false,
      secure: true,
    }));

    saveCookies(sessionId, puppeteerCookies);
    touchSession(sessionId);
    console.log('[Auth] Cookies salvos para sessão ' + sessionId.slice(0, 8) + '...');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/session/:id/check', requireAuth, async (req, res) => {
  try {
    const sessionId = req.params.id;
    if (hasSavedCookies(sessionId)) {
      touchSession(sessionId);
      return res.json({ ok: true, loggedIn: true });
    }
    const { loggedIn } = await checkLogin(sessionId);
    if (loggedIn) touchSession(sessionId);
    res.json({ ok: true, loggedIn });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/session/:id', requireAuth, async (req, res) => {
  try {
    await closeBrowser(req.params.id);
    const cookiePath = path.join(__dirname, `../data/cookies/${req.params.id}.json`);
    const fs = require('fs');
    if (fs.existsSync(cookiePath)) fs.unlinkSync(cookiePath);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Busca ─────────────────────────────────────────────────
app.post('/api/search', requireAuth, async (req, res) => {
  const { sessionId, keyword, location = 'Brasil', city = '', blockedWords = [] } = req.body;
  const { maxItems: limitMax, canBlockWords } = req.limits;

  if (!sessionId || !keyword) return res.status(400).json({ ok: false, error: 'Dados obrigatórios.' });

  const maxItems = Math.min(parseInt(req.body.maxItems) || 40, limitMax);
  const finalBlockedWords = canBlockWords ? blockedWords : [];

  try {
    const hasSession = hasSavedCookies(sessionId);
    const { loggedIn } = hasSession ? { loggedIn: true } : await checkLogin(sessionId);
    if (!loggedIn) return res.status(401).json({ ok: false, error: 'Sessão expirada. Faça login no Facebook.' });

    touchSession(sessionId);
    const rawListings = await scrapeMarketplace(sessionId, keyword, location, maxItems, {
      removeNoPrice: req.body.removeNoPrice !== false,
      blockedWords: finalBlockedWords,
      city,
    });

    const searchId = saveSearch(sessionId, keyword, location);
    if (rawListings.length > 0) saveListings(searchId, rawListings);
    const { listings, stats } = analyzeListings(rawListings);
    if (stats && stats.with_price >= 3) savePriceSnapshot(keyword, city || location, stats.avg, stats.median, stats.min, stats.max, stats.with_price);

    res.json({ ok: true, searchId, keyword, location, stats, listings, plan: req.user.plan, limits: req.limits });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Histórico (Pro) ───────────────────────────────────────
app.get('/api/price-history', requireAuth, requirePro, (req, res) => {
  const { keyword, city, days } = req.query;
  if (!keyword || !city) return res.status(400).json({ ok: false, error: 'keyword e city obrigatórios.' });
  const history = getPriceHistory(keyword, city, parseInt(days) || 30);
  res.json({ ok: true, history });
});

// ── Alertas (Pro) ─────────────────────────────────────────
app.get('/api/push/vapid-key', (req, res) => res.json({ ok: true, publicKey: VAPID_PUBLIC_KEY }));

app.post('/api/push/subscribe', requireAuth, requirePro, (req, res) => {
  const { sessionId, subscription } = req.body;
  if (!sessionId || !subscription) return res.status(400).json({ ok: false, error: 'Dados obrigatórios.' });
  saveSubscription(sessionId, subscription);
  res.json({ ok: true });
});

app.post('/api/monitor', requireAuth, requirePro, (req, res) => {
  const { sessionId, keyword, location, city, maxPrice, intervalHours = 2 } = req.body;
  if (!sessionId || !keyword || !maxPrice) return res.status(400).json({ ok: false, error: 'Dados incompletos.' });
  const existing = getMonitors(sessionId);
  if (existing.length >= req.limits.maxAlerts) return res.status(403).json({ ok: false, error: `Limite de ${req.limits.maxAlerts} alertas atingido.` });
  const id = saveMonitor(sessionId, keyword, location, city, maxPrice, intervalHours);
  res.json({ ok: true, id });
});

app.get('/api/monitor/:sessionId', requireAuth, requirePro, (req, res) => {
  res.json({ ok: true, monitors: getMonitors(req.params.sessionId) });
});

app.delete('/api/monitor/:id', requireAuth, requirePro, (req, res) => {
  removeMonitor(req.params.id);
  res.json({ ok: true });
});

app.post('/api/push/test', requireAuth, requirePro, async (req, res) => {
  const sent = await sendPush(req.body.sessionId, { title: '✅ MarketScan', body: 'Notificações funcionando!', url: '/', tag: 'test' });
  res.json({ ok: sent });
});

// ── Stripe Checkout ───────────────────────────────────────
app.post('/api/stripe/checkout', requireAuth, async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      // FIX: usa BASE_URL em vez de localhost hardcoded
      success_url: `${BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}&token=${req.headers['x-auth-token']}`,
      cancel_url: `${BASE_URL}/?canceled=true`,
      customer_email: req.user.email,
      metadata: { userToken: req.headers['x-auth-token'] },
      locale: 'pt-BR',
    });
    res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error('[Stripe] Checkout error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Página de sucesso após pagamento
app.get('/success', async (req, res) => {
  const { session_id, token } = req.query;
  if (token) {
    try {
      const session = await stripe.checkout.sessions.retrieve(session_id);
      if (session.payment_status === 'paid') {
        upgradeToPro(token, 1);
      }
    } catch (e) { console.error('[Stripe] Success page error:', e); }
  }
  res.redirect('/?upgraded=true');
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')));

startMonitorCron(scrapeMarketplace, analyzeListings, hasSavedCookies);

app.listen(PORT, () => console.log(`\n🚀 MarketScan rodando em ${BASE_URL}\n`));
