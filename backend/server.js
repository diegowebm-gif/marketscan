require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const { register, login, getUserByToken, upgradeToPro, getLimits } = require('./auth');
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const { openLoginWindow, checkLogin, scrapeMarketplace, closeBrowser, analyzeListings, hasSavedCookies, hasSavedCookiesAsync, saveCookies, loginWithCredentials, submitTwoFactor, launchBrowser } = require('./scraper');
const { createSession, touchSession, saveSearch, saveListings, getListingsBySearch, getRecentSearches, savePriceSnapshot, getPriceHistory } = require('./database');
const { VAPID_PUBLIC_KEY, saveSubscription, saveMonitor, getMonitors, removeMonitor, sendPush, startMonitorCron } = require('./alerts');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

app.use(cors());

// ⚠️ WEBHOOK STRIPE: antes do express.json()
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    if (webhookSecret) {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } else {
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
      await upgradeToPro(token, 1);
      console.log(`[Stripe] Plano Pro ativado para token: ${token.slice(0, 8)}...`);
    }
  }
  if (event.type === 'customer.subscription.deleted') {
    console.log('[Stripe] Assinatura cancelada:', event.data.object.id);
  }
  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// ── Middleware de autenticação ─────────────────────────────
async function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'] || req.body?.authToken || req.query?.authToken;
  const user = await getUserByToken(token);
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
app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ ok: false, error: 'E-mail e senha obrigatórios.' });
  if (password.length < 6) return res.status(400).json({ ok: false, error: 'Senha mínima de 6 caracteres.' });
  const result = await register(email, password);
  res.json(result);
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ ok: false, error: 'E-mail e senha obrigatórios.' });
  const result = await login(email, password);
  res.json(result);
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ ok: true, email: req.user.email, plan: req.user.plan, limits: req.limits, planExpiresAt: req.user.planExpiresAt });
});

app.post('/api/auth/upgrade', requireAuth, async (req, res) => {
  const { months = 1 } = req.body;
  const result = await upgradeToPro(req.headers['x-auth-token'] || req.body?.authToken, months);
  res.json(result);
});

// ── Sessão Facebook ───────────────────────────────────────
app.post('/api/session/start', requireAuth, async (req, res) => {
  try {
    const sessionId = uuidv4();
    await createSession(sessionId);
    res.json({ ok: true, sessionId });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/session/login', requireAuth, async (req, res) => {
  const { sessionId, email, password } = req.body;
  if (!sessionId || !email || !password) {
    return res.status(400).json({ ok: false, error: 'Dados obrigatórios.' });
  }
  try {
    const result = await loginWithCredentials(sessionId, email, password);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/session/2fa', requireAuth, async (req, res) => {
  const { sessionId, code } = req.body;
  if (!sessionId || !code) {
    return res.status(400).json({ ok: false, error: 'Dados obrigatórios.' });
  }
  try {
    const result = await submitTwoFactor(sessionId, code);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/facebook-callback', (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.redirect('/');
  res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Conectar ao Facebook — MarketScan</title>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@800&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:#f4f5f7;color:#1a1a2e;gap:1.5rem;padding:2rem;text-align:center}
  .logo{font-size:1.3rem;font-weight:800;font-family:'Syne',sans-serif}
  .logo span{color:#6a0dad}
  .btn-fb{display:inline-flex;align-items:center;gap:8px;padding:14px 28px;background:#1877f2;color:#fff;border:none;border-radius:8px;font-weight:700;font-size:15px;cursor:pointer;text-decoration:none;font-family:'Inter',sans-serif;transition:opacity .2s}
  .btn-fb:hover{opacity:.9}
  .btn-confirm{padding:11px 24px;background:#6a0dad;color:#fff;border:none;border-radius:8px;font-weight:700;font-size:14px;cursor:pointer;font-family:'Inter',sans-serif;display:none}
  .info{max-width:360px;font-size:13px;color:#6b7280;line-height:1.6;background:#fff;border-radius:12px;padding:1rem 1.25rem;border:1px solid rgba(0,0,0,0.08)}
  .spinner{width:28px;height:28px;border:3px solid rgba(106,13,173,0.2);border-top-color:#6a0dad;border-radius:50%;animation:spin .8s linear infinite;display:none}
  @keyframes spin{to{transform:rotate(360deg)}}
  #status{font-size:13px;color:#6b7280;min-height:20px}
</style>
</head>
<body>
  <div class="logo">Market<span>Scan</span></div>
  <div class="info">
    <p style="font-weight:600;margin-bottom:.5rem">📘 Conectar ao Facebook</p>
    <p>Clique em <strong>Abrir Facebook</strong>, faça login normalmente e volte aqui para confirmar.</p>
  </div>
  <a href="https://www.facebook.com/marketplace" target="_blank" class="btn-fb" id="btn-fb" onclick="onFbOpen()">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="white"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
    Abrir Facebook
  </a>
  <button class="btn-confirm" id="btn-confirm" onclick="confirmLogin()">✅ Já fiz login — Continuar</button>
  <div class="spinner" id="spinner"></div>
  <p id="status">Clique no botão acima para abrir o Facebook.</p>
<script>
const SESSION_ID = '${sessionId}';
function onFbOpen() {
  setTimeout(() => {
    document.getElementById('btn-confirm').style.display = 'inline-block';
    document.getElementById('status').textContent = 'Após fazer login no Facebook, clique em Continuar.';
  }, 2000);
}
async function confirmLogin() {
  document.getElementById('spinner').style.display = 'block';
  document.getElementById('btn-confirm').style.display = 'none';
  document.getElementById('status').textContent = 'Verificando sessão...';
  try {
    const res = await fetch('/api/session/fb-cookies', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ sessionId: SESSION_ID })
    });
    const data = await res.json();
    if (data.ok) {
      document.getElementById('status').textContent = '✅ Conectado! Fechando...';
      setTimeout(() => window.close(), 1500);
    } else {
      document.getElementById('spinner').style.display = 'none';
      document.getElementById('btn-confirm').style.display = 'inline-block';
      document.getElementById('status').textContent = data.error || 'Não detectado. Tente novamente.';
    }
  } catch(e) {
    document.getElementById('spinner').style.display = 'none';
    document.getElementById('btn-confirm').style.display = 'inline-block';
    document.getElementById('status').textContent = 'Erro de conexão.';
  }
}
</script>
</body></html>`);
});

// Verifica se usuário está logado no Facebook via fetch do lado do cliente
app.post('/api/session/fb-cookies', async (req, res) => {
  const { sessionId, fbToken } = req.body;
  if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId obrigatório' });
  
  // Se veio um token de verificação do Facebook
  if (fbToken) {
    try {
      // Salva cookies mínimos para permitir scraping
      const minimalCookies = [
        { name: 'fb_token_verified', value: fbToken, domain: '.facebook.com', path: '/' }
      ];
      saveCookies(sessionId, minimalCookies);
      await touchSession(sessionId);
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
  
  res.json({ ok: false, error: 'Token não fornecido.' });
});

app.post('/api/session/cookies', async (req, res) => {
  const { sessionId, cookies, userAgent } = req.body;
  if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId obrigatório' });
  try {
    const cookieObj = {};
    (cookies || '').split(';').forEach(c => {
      const [k, ...rest] = c.trim().split('=');
      if (k) cookieObj[k.trim()] = rest.join('=') || '';
    });
    const hasSession = cookieObj['c_user'] || cookieObj['xs'];
    if (!hasSession) return res.json({ ok: false, error: 'Login no Facebook não detectado.' });
    const puppeteerCookies = Object.entries(cookieObj).map(([name, value]) => ({
      name, value, domain: '.facebook.com', path: '/', httpOnly: false, secure: true,
    }));
    saveCookies(sessionId, puppeteerCookies);
    await touchSession(sessionId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/session/:id/check', requireAuth, async (req, res) => {
  try {
    const sessionId = req.params.id;
    if (await hasSavedCookiesAsync(sessionId)) {
      await touchSession(sessionId);
      return res.json({ ok: true, loggedIn: true });
    }
    const { loggedIn } = await checkLogin(sessionId);
    if (loggedIn) await touchSession(sessionId);
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
    const hasSession = await hasSavedCookiesAsync(sessionId);
    const { loggedIn } = hasSession ? { loggedIn: true } : await checkLogin(sessionId);
    if (!loggedIn) return res.status(401).json({ ok: false, error: 'Sessão expirada. Faça login no Facebook.' });
    await touchSession(sessionId);
    const rawListings = await scrapeMarketplace(sessionId, keyword, location, maxItems, {
      removeNoPrice: req.body.removeNoPrice !== false,
      blockedWords: finalBlockedWords,
      city,
    });
    const searchId = await saveSearch(sessionId, keyword, location);
    if (rawListings.length > 0) await saveListings(searchId, rawListings);
    const { listings, stats } = analyzeListings(rawListings);
    if (stats && stats.with_price >= 3) await savePriceSnapshot(keyword, city || location, stats.avg, stats.median, stats.min, stats.max, stats.with_price);
    res.json({ ok: true, searchId, keyword, location, stats, listings, plan: req.user.plan, limits: req.limits });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Histórico (Pro) ───────────────────────────────────────
app.get('/api/price-history', requireAuth, requirePro, async (req, res) => {
  const { keyword, city, days } = req.query;
  if (!keyword || !city) return res.status(400).json({ ok: false, error: 'keyword e city obrigatórios.' });
  const history = await getPriceHistory(keyword, city, parseInt(days) || 30);
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

app.get('/success', async (req, res) => {
  const { session_id, token } = req.query;
  if (token) {
    try {
      const session = await stripe.checkout.sessions.retrieve(session_id);
      if (session.payment_status === 'paid') await upgradeToPro(token, 1);
    } catch (e) { console.error('[Stripe] Success page error:', e); }
  }
  res.redirect('/?upgraded=true');
});

// ── Admin ─────────────────────────────────────────────────
const ADMIN_EMAIL = 'diegowebm@gmail.com';

async function requireAdmin(req, res, next) {
  const token = req.headers['x-auth-token'];
  const user = await getUserByToken(token);
  if (!user || user.email !== ADMIN_EMAIL) {
    return res.status(403).json({ ok: false, error: 'Acesso negado.' });
  }
  req.user = user;
  next();
}

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    });
    const result = await pool.query('SELECT id, email, plan, token, created_at, plan_expires_at FROM users ORDER BY created_at DESC');
    await pool.end();
    res.json({ ok: true, users: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/admin/grant-pro', requireAdmin, async (req, res) => {
  const { token, months = 1 } = req.body;
  if (!token) return res.status(400).json({ ok: false, error: 'Token obrigatório.' });
  const result = await upgradeToPro(token, months);
  res.json(result);
});

app.post('/api/admin/revoke-pro', requireAdmin, async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ ok: false, error: 'Token obrigatório.' });
  try {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    });
    await pool.query('UPDATE users SET plan = $1, plan_expires_at = NULL WHERE token = $2', ['free', token]);
    await pool.end();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/admin.html'));
});

// Página de termos de uso
app.get('/terms.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/terms.html'));
});

// Landing page na raiz
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/landing.html'));
});

// App em /app
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')));

startMonitorCron(scrapeMarketplace, analyzeListings, hasSavedCookies);

app.listen(PORT, () => console.log(`\n🚀 MarketScan rodando em ${BASE_URL}\n`));
