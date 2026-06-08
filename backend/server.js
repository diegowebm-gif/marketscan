require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const { register, login, getUserByToken, upgradeToPro, getLimits, createPasswordResetToken, resetPassword, updateWhatsappPhone } = require('./auth');
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const { openLoginWindow, checkLogin, scrapeMarketplace, closeBrowser, analyzeListings, hasSavedCookies, hasSavedCookiesAsync, saveCookies, loginWithCredentials, submitTwoFactor, launchBrowser } = require('./scraper');
const { createSession, touchSession, saveSearch, saveListings, getListingsBySearch, getRecentSearches, savePriceSnapshot, getPriceHistory } = require('./database');
const { VAPID_PUBLIC_KEY, saveSubscription, saveMonitor, getMonitors, removeMonitor, sendPush, sendWhatsApp, startMonitorCron } = require('./alerts');
const { connectWhatsApp, getLastQR, getIsConnected } = require('./whatsapp');

// ── Email (Resend) ────────────────────────────────────────────
async function sendEmail(to, subject, html) {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'MarketScan <noreply@marketscan.site>',
        to,
        subject,
        html,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Erro ao enviar email');
    console.log(`[Email] Enviado para ${to}: ${subject}`);
    return true;
  } catch (err) {
    console.error(`[Email] Erro ao enviar para ${to}:`, err.message);
    return false;
  }
}

function emailBoasVindas(email) {
  return sendEmail(email, '🎁 Seu presente: 7 dias de MarketScan Pro grátis!', `
    <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;padding:2rem;background:#f4f5f7">
      <div style="background:#fff;border-radius:12px;padding:2rem;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
        <h1 style="font-size:1.4rem;color:#1a1a2e;margin-bottom:.5rem">Bem-vindo ao MarketScan! 🎉</h1>
        <p style="color:#6b7280;font-size:14px;margin-bottom:1.5rem">Você ganhou <strong>7 dias grátis do plano Pro</strong>. Aproveite tudo sem pagar nada.</p>
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:1rem;margin-bottom:1.5rem">
          <p style="color:#15803d;font-size:13px;margin:0;font-weight:600">✅ O que você pode fazer agora:</p>
          <ul style="color:#166534;font-size:13px;margin:.75rem 0 0;padding-left:1.25rem;line-height:1.8">
            <li>Buscar anúncios em qualquer cidade do Brasil</li>
            <li>Ver score de oportunidade em cada anúncio</li>
            <li>Configurar alertas de preço</li>
            <li>Ver histórico de preços do mercado</li>
            <li>Usar a calculadora de lucro</li>
          </ul>
        </div>
        <a href="${process.env.BASE_URL}/app" style="display:inline-block;background:#6a0dad;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">Começar a usar →</a>
        <p style="color:#9ca3af;font-size:11px;margin-top:1.5rem">Se tiver dúvidas, responda este email ou acesse <a href="${process.env.BASE_URL}/contact" style="color:#6a0dad">nossa página de contato</a>.</p>
      </div>
    </div>
  `);
}

function emailTrialExpirando(email, diasRestantes) {
  return sendEmail(email, `⏳ Seu Pro grátis expira ${diasRestantes === 1 ? 'amanhã' : `em ${diasRestantes} dias`}!`, `
    <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;padding:2rem;background:#f4f5f7">
      <div style="background:#fff;border-radius:12px;padding:2rem;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
        <h1 style="font-size:1.4rem;color:#1a1a2e;margin-bottom:.5rem">⏳ Seu trial está acabando</h1>
        <p style="color:#6b7280;font-size:14px;margin-bottom:1rem">Seu período gratuito do <strong>MarketScan Pro</strong> expira ${diasRestantes === 1 ? 'amanhã' : `em ${diasRestantes} dias`}. Não perca o acesso às ferramentas que você já usa.</p>
        <div style="background:#fefce8;border:1px solid #fde047;border-radius:8px;padding:1rem;margin-bottom:1.5rem">
          <p style="color:#854d0e;font-size:13px;margin:0">🔒 Sem o Pro você perde: alertas de preço, histórico, calculadora de lucro e buscas ilimitadas.</p>
        </div>
        <a href="${process.env.BASE_URL}/app" style="display:inline-block;background:#6a0dad;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">Assinar Pro — R$ 29,90/mês →</a>
        <p style="color:#9ca3af;font-size:11px;margin-top:1.5rem">Cancele quando quiser. Sem fidelidade.</p>
      </div>
    </div>
  `);
}

function emailTrialExpirado(email) {
  return sendEmail(email, '🔓 Seu trial expirou — continue com o Pro', `
    <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;padding:2rem;background:#f4f5f7">
      <div style="background:#fff;border-radius:12px;padding:2rem;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
        <h1 style="font-size:1.4rem;color:#1a1a2e;margin-bottom:.5rem">Seu trial gratuito expirou</h1>
        <p style="color:#6b7280;font-size:14px;margin-bottom:1rem">Esperamos que você tenha encontrado boas oportunidades durante esses 7 dias! Para continuar usando todos os recursos, assine o Pro.</p>
        <div style="background:#f5f3ff;border:1px solid #ddd6fe;border-radius:8px;padding:1rem;margin-bottom:1.5rem">
          <p style="color:#5b21b6;font-size:13px;margin:0;font-weight:600">Por apenas R$ 29,90/mês você tem:</p>
          <ul style="color:#6d28d9;font-size:13px;margin:.75rem 0 0;padding-left:1.25rem;line-height:1.8">
            <li>Buscas ilimitadas</li>
            <li>Alertas de preço em tempo real</li>
            <li>Histórico de preços do mercado</li>
            <li>Calculadora de lucro</li>
          </ul>
        </div>
        <a href="${process.env.BASE_URL}/app" style="display:inline-block;background:#6a0dad;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">Assinar agora →</a>
        <p style="color:#9ca3af;font-size:11px;margin-top:1.5rem">Cancele quando quiser. Sem fidelidade mínima.</p>
      </div>
    </div>
  `);
}

const app = express();
app.set('trust proxy', 1); // Railway usa proxy reverso

// ── Segurança HTTP headers ─────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // desabilitado para não quebrar o frontend
  crossOriginEmbedderPolicy: false,
}));
app.disable('x-powered-by');

// ── Rate limiting ──────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 20, // máx 20 tentativas de login/cadastro por IP
  message: { ok: false, error: 'Muitas tentativas. Aguarde 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const searchLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 10, // máx 10 buscas por minuto por IP
  message: { ok: false, error: 'Muitas requisições. Aguarde um momento.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60, // máx 60 req/min por IP para outras rotas
  message: { ok: false, error: 'Muitas requisições. Aguarde um momento.' },
  standardHeaders: true,
  legacyHeaders: false,
});
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

app.use(cors());

// ⚠️ WEBHOOK STRIPE: antes do express.json()
// Aceita ambas as rotas para compatibilidade
async function handleStripeWebhook(req, res) {
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

  // Checkout concluído — ativa Pro
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const token = session.metadata?.userToken;
    const promoCode = session.metadata?.promoCode;

    if (token) {
      // Checkout normal com usuário logado
      await upgradeToPro(token, 1);
      if (session.customer) {
        const { Pool } = require('pg');
        const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
        await p.query('UPDATE users SET stripe_customer_id = $1 WHERE token = $2', [session.customer, token]).catch(() => {});
        await p.end();
      }
      console.log(`[Stripe] Pro ativado via checkout para token: ${token.slice(0, 8)}...`);
      // Verificar se o usuário é um indicado e creditar 7 dias ao indicador
      try {
        const { Pool } = require('pg');
        const pRef = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
        const userRes = await pRef.query('SELECT email FROM users WHERE token = $1', [token]);
        if (userRes.rows.length > 0) {
          const email = userRes.rows[0].email;
          const refRes = await pRef.query('SELECT referrer_id FROM referrals WHERE referred_email = $1 AND status != $2', [email, 'converted']);
          if (refRes.rows.length > 0) {
            const referrerId = refRes.rows[0].referrer_id;
            // Creditar 7 dias ao indicador
            await pRef.query('UPDATE users SET plan_expires_at = plan_expires_at + $1 WHERE id = $2', [7 * 24 * 60 * 60 * 1000, referrerId]);
            await pRef.query('UPDATE referrals SET status = $1, converted_at = $2 WHERE referred_email = $3', ['converted', Date.now(), email]);
            console.log(`[Referral] 7 dias creditados para indicador ${referrerId}`);
          }
        }
        await pRef.end();
      } catch(e) { console.warn('[Referral] Erro ao processar indicação:', e.message); }
    } else if (promoCode && session.customer_email) {
      // Checkout via página de promo — cria conta com senha já definida
      const email = session.customer_email;
      const passwordHash = session.metadata?.userPassword;

      // Cria usuário diretamente com o hash de senha já calculado
      const crypto = require('crypto');
      const { Pool } = require('pg');
      const p2 = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
      const token = crypto.randomBytes(32).toString('hex');
      const userId = crypto.randomUUID();
      const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;

      await p2.query(
        'INSERT INTO users (id, email, password, plan, token, plan_expires_at, stripe_customer_id) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (email) DO NOTHING',
        [userId, email.toLowerCase().trim(), passwordHash || crypto.createHash('sha256').update(crypto.randomBytes(8).toString('hex') + 'marketscan_salt').digest('hex'), 'pro', token, expiresAt, session.customer || null]
      ).catch(() => {});
      await p2.end();

      await sendEmail(email, '🎉 Bem-vindo ao MarketScan Pro!', `
        <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;padding:2rem;background:#f4f5f7">
          <div style="background:#fff;border-radius:12px;padding:2rem;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
            <h1 style="font-size:1.3rem;color:#1a1a2e;margin-bottom:.5rem">🎉 Sua conta Pro está ativa!</h1>
            <p style="color:#6b7280;font-size:14px;margin-bottom:1.5rem">Assinatura confirmada! Acesse com seu e-mail e a senha que você criou.</p>
            <a href="${BASE_URL}" style="display:inline-block;background:#6a0dad;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">Acessar MarketScan →</a>
          </div>
        </div>
      `).catch(() => {});
      console.log(`[Stripe] Conta Pro criada via promo para: ${email}`);
    }
  }

  // Renovação mensal — renova Pro por mais 1 mês
  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;
    const token = invoice.metadata?.userToken || invoice.subscription_details?.metadata?.userToken;
    if (token) {
      await upgradeToPro(token, 1);
      console.log(`[Stripe] Pro renovado via invoice para token: ${token.slice(0, 8)}...`);
    }
  }

  // Cancelamento — rebaixa para Free
  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    const token = sub.metadata?.userToken;
    if (token) {
      const { Pool } = require('pg');
      const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
      await pool.query('UPDATE users SET plan = $1, plan_expires_at = NULL WHERE token = $2', ['free', token]);
      await pool.end();
      console.log(`[Stripe] Assinatura cancelada — rebaixado para Free: ${token.slice(0, 8)}...`);
    }
  }

  res.json({ received: true });
}

app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);
app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), handleStripeWebhook);

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use('/api', apiLimiter);
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
app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { email, password, refCode } = req.body;
  if (!email || !password) return res.status(400).json({ ok: false, error: 'E-mail e senha obrigatórios.' });
  if (password.length < 6) return res.status(400).json({ ok: false, error: 'Senha mínima de 6 caracteres.' });
  const { whatsappPhone } = req.body;
  const result = await register(email, password, whatsappPhone || null);
  if (result.ok) {
    emailBoasVindas(email).catch(() => {});
    // Salvar referral se veio com código de indicação
    if (refCode) {
      try {
        const { Pool } = require('pg');
        const pRef = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
        const refRes = await pRef.query('SELECT user_id FROM referral_codes WHERE code = $1', [refCode.toUpperCase()]);
        if (refRes.rows.length > 0) {
          const referrerId = refRes.rows[0].user_id;
          await pRef.query(
            'INSERT INTO referrals (referrer_id, referred_email, referred_id, status) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
            [referrerId, email.toLowerCase(), result.userId || null, 'registered']
          );
          console.log(`[Referral] ${email} indicado por ${referrerId}`);
        }
        await pRef.end();
      } catch(e) { console.warn('[Referral] Erro ao salvar referral:', e.message); }
    }
  }
  res.json(result);
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ ok: false, error: 'E-mail e senha obrigatórios.' });
  const result = await login(email, password);
  res.json(result);
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ ok: true, email: req.user.email, plan: req.user.plan, limits: req.limits, planExpiresAt: req.user.planExpiresAt, whatsappPhone: req.user.whatsappPhone || null });
});

app.post('/api/auth/upgrade', requireAuth, async (req, res) => {
  const { months = 1 } = req.body;
  const result = await upgradeToPro(req.headers['x-auth-token'] || req.body?.authToken, months);
  res.json(result);
});

app.post('/api/auth/update-whatsapp', requireAuth, async (req, res) => {
  const { phone } = req.body;
  const result = await updateWhatsappPhone(req.headers['x-auth-token'], phone || '');
  res.json(result);
});


app.post('/api/auth/update-email', requireAuth, async (req, res) => {
  const { newEmail, password } = req.body;
  if (!newEmail || !password) return res.status(400).json({ ok: false, error: 'Dados obrigatórios.' });
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
  try {
    // Verifica senha atual
    const { hashPassword } = require('./auth');
    const result = await pool.query('SELECT * FROM users WHERE token = $1', [req.headers['x-auth-token']]);
    const user = result.rows[0];
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(password + 'marketscan_salt').digest('hex');
    if (!user || user.password !== hash) { await pool.end(); return res.json({ ok: false, error: 'Senha incorreta.' }); }
    // Verifica se novo email já existe
    const existing = await pool.query('SELECT id FROM users WHERE email = $1 AND token != $2', [newEmail.toLowerCase().trim(), req.headers['x-auth-token']]);
    if (existing.rows.length) { await pool.end(); return res.json({ ok: false, error: 'E-mail já cadastrado por outro usuário.' }); }
    await pool.query('UPDATE users SET email = $1 WHERE token = $2', [newEmail.toLowerCase().trim(), req.headers['x-auth-token']]);
    await pool.end();
    res.json({ ok: true });
  } catch (err) { await pool.end(); res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/auth/update-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ ok: false, error: 'Dados obrigatórios.' });
  if (newPassword.length < 6) return res.status(400).json({ ok: false, error: 'Senha mínima de 6 caracteres.' });
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
  try {
    const crypto = require('crypto');
    const hashFn = (p) => crypto.createHash('sha256').update(p + 'marketscan_salt').digest('hex');
    const result = await pool.query('SELECT * FROM users WHERE token = $1', [req.headers['x-auth-token']]);
    const user = result.rows[0];
    if (!user || user.password !== hashFn(currentPassword)) { await pool.end(); return res.json({ ok: false, error: 'Senha atual incorreta.' }); }
    await pool.query('UPDATE users SET password = $1 WHERE token = $2', [hashFn(newPassword), req.headers['x-auth-token']]);
    await pool.end();
    res.json({ ok: true });
  } catch (err) { await pool.end(); res.status(500).json({ ok: false, error: err.message }); }
});


// ── Reports de anúncios ──────────────────────────────────────
async function initReportsTable() {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
  await pool.query(`CREATE TABLE IF NOT EXISTS reports (
    id SERIAL PRIMARY KEY,
    url TEXT NOT NULL,
    title TEXT,
    user_email TEXT,
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000,
    reviewed BOOLEAN DEFAULT FALSE
  )`);
  await pool.end();
}
initReportsTable().catch(() => {});

app.post('/api/report', requireAuth, async (req, res) => {
  const { url, title, userEmail } = req.body;
  if (!url) return res.status(400).json({ ok: false });
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
  await pool.query('INSERT INTO reports (url, title, user_email) VALUES ($1, $2, $3)', [url, title || '', userEmail || '']);
  await pool.end();
  res.json({ ok: true });
});

app.get('/api/admin/reports', requireAdmin, async (req, res) => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
  const result = await pool.query('SELECT * FROM reports ORDER BY created_at DESC LIMIT 100');
  await pool.end();
  res.json({ ok: true, reports: result.rows });
});

app.post('/api/admin/reports/:id/review', requireAdmin, async (req, res) => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
  await pool.query('UPDATE reports SET reviewed = TRUE WHERE id = $1', [req.params.id]);
  await pool.end();
  res.json({ ok: true });
});

app.delete('/api/admin/reports/:id', requireAdmin, async (req, res) => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
  await pool.query('DELETE FROM reports WHERE id = $1', [req.params.id]);
  await pool.end();
  res.json({ ok: true });
});

app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ ok: false, error: 'E-mail obrigatório.' });
  const result = await createPasswordResetToken(email);
  if (result.ok && result.resetToken) {
    const resetUrl = `${BASE_URL}/?reset_token=${result.resetToken}`;
    await sendEmail(result.email, '🔑 Redefinir senha — MarketScan', `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;padding:2rem;background:#f4f5f7">
        <div style="background:#fff;border-radius:12px;padding:2rem;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
          <h1 style="font-size:1.3rem;color:#1a1a2e;margin-bottom:.5rem">🔑 Redefinir sua senha</h1>
          <p style="color:#6b7280;font-size:14px;margin-bottom:1.5rem">Recebemos uma solicitação para redefinir a senha da sua conta MarketScan. Clique no botão abaixo para criar uma nova senha.</p>
          <a href="${resetUrl}" style="display:inline-block;background:#6a0dad;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">Redefinir minha senha →</a>
          <p style="color:#9ca3af;font-size:11px;margin-top:1.5rem">Este link expira em 1 hora. Se você não solicitou isso, ignore este e-mail.</p>
        </div>
      </div>
    `).catch(() => {});
  }
  res.json({ ok: true }); // Sempre retorna ok para não revelar se email existe
});

app.post('/api/auth/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ ok: false, error: 'Dados obrigatórios.' });
  if (password.length < 6) return res.status(400).json({ ok: false, error: 'Senha mínima de 6 caracteres.' });
  const result = await resetPassword(token, password);
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
// ── Cache de buscas ──────────────────────────────────────────
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutos

async function getCachedSearch(keyword, city, maxItems = 40) {
  try {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
    await pool.query(`CREATE TABLE IF NOT EXISTS search_cache (
      cache_key TEXT PRIMARY KEY,
      result JSONB,
      created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
    )`);
    const key = `${keyword.toLowerCase().trim()}|${city.toLowerCase().trim()}|${maxItems}`;
    const result = await pool.query('SELECT result, created_at FROM search_cache WHERE cache_key = $1', [key]);
    await pool.end();
    if (!result.rows.length) return null;
    const age = Date.now() - parseInt(result.rows[0].created_at);
    if (age > CACHE_TTL_MS) return null;
    console.log(`[Cache] Hit para "${keyword}" em "${city}" (${Math.round(age/1000/60)}min atrás)`);
    return result.rows[0].result;
  } catch (err) {
    console.error('[Cache] Erro ao ler:', err.message);
    return null;
  }
}

async function setCachedSearch(keyword, city, result, maxItems = 40) {
  try {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
    const key = `${keyword.toLowerCase().trim()}|${city.toLowerCase().trim()}|${maxItems}`;
    await pool.query(`INSERT INTO search_cache (cache_key, result, created_at) VALUES ($1, $2, $3)
      ON CONFLICT (cache_key) DO UPDATE SET result = $2, created_at = $3`,
      [key, JSON.stringify(result), Date.now()]);
    await pool.end();
    console.log(`[Cache] Salvo para "${keyword}" em "${city}"`);
  } catch (err) {
    console.error('[Cache] Erro ao salvar:', err.message);
  }
}

// ── Limite de buscas diárias ─────────────────────────────────
const FREE_DAILY_LIMIT = 5;

async function checkSearchLimit(userId, isPro) {
  if (isPro) return { allowed: true };
  try {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
    await pool.query(`CREATE TABLE IF NOT EXISTS search_limits (user_id TEXT PRIMARY KEY, count INT DEFAULT 0, reset_at BIGINT DEFAULT 0)`);
    const now = Date.now();
    const midnight = new Date(); midnight.setHours(24,0,0,0);
    const resetAt = midnight.getTime();
    const result = await pool.query('SELECT count, reset_at FROM search_limits WHERE user_id = $1', [userId]);
    let count = 0;
    if (result.rows.length > 0) {
      const row = result.rows[0];
      if (now > parseInt(row.reset_at)) {
        await pool.query('UPDATE search_limits SET count = 1, reset_at = $1 WHERE user_id = $2', [resetAt, userId]);
        await pool.end();
        return { allowed: true, count: 1, limit: FREE_DAILY_LIMIT };
      }
      count = parseInt(row.count);
      if (count >= FREE_DAILY_LIMIT) {
        await pool.end();
        return { allowed: false, count, limit: FREE_DAILY_LIMIT };
      }
      await pool.query('UPDATE search_limits SET count = count + 1 WHERE user_id = $1', [userId]);
    } else {
      await pool.query('INSERT INTO search_limits (user_id, count, reset_at) VALUES ($1, 1, $2)', [userId, resetAt]);
    }
    await pool.end();
    return { allowed: true, count: count + 1, limit: FREE_DAILY_LIMIT };
  } catch (err) {
    console.error('[Limit] Erro:', err.message);
    return { allowed: true };
  }
}

// ── Busca com streaming (SSE) ────────────────────────────────
app.get('/api/search/stream', searchLimiter, requireAuth, async (req, res) => {
  const { keyword, city = '', state = '', maxItems = 40, removeNoPrice = 'false', blockedWords = '' } = req.query;
  if (!keyword) return res.status(400).json({ ok: false, error: 'keyword obrigatório.' });

  const sessionId = req.headers['x-session-id'] || 'shared';
  const location = state || 'Brasil';
  const requestedMax = parseInt(maxItems) || 40;
  const max = Math.min(requestedMax, req.limits.maxItems);
  console.log(`[Search] maxItems solicitado: ${requestedMax}, limite do plano: ${req.limits.maxItems}, aplicado: ${max}`);
  const blocked = blockedWords ? blockedWords.split(',').map(w => w.trim()).filter(Boolean) : [];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.socket?.setTimeout(0);
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}
data: ${JSON.stringify(data)}

`);

  // Verifica limite diário para Free antes de iniciar
  const limitCheck = await checkSearchLimit(req.user.id, req.user.plan === 'pro');
  if (!limitCheck.allowed) {
    send('error', { message: 'limit_reached', count: limitCheck.count, limit: limitCheck.limit });
    res.end();
    return;
  }
  if (limitCheck.count !== undefined) {
    send('limit', { count: limitCheck.count, limit: limitCheck.limit });
  }

  // Verifica cache primeiro
  const cached = await getCachedSearch(keyword, city, max);
  if (cached) {
    send('status', { message: 'Carregando resultados...' });
    send('done', { ...cached, fromCache: true, plan: req.user.plan, limits: req.limits });
    res.end();
    return;
  }

  send('status', { message: 'Conectando ao Marketplace...' });

  try {
    await touchSession(sessionId);
    let batchCount = 0;

    const rawListings = await scrapeMarketplace(
      sessionId, keyword, location, max,
      { removeNoPrice: removeNoPrice === 'true', blockedWords: blocked, city },
      (partialRaw, scrollNum, totalScrolls) => {
        send('status', { message: `Carregando anúncios... (${scrollNum}/${totalScrolls})` });
      }
    );

    const { listings, stats } = analyzeListings(rawListings);
    if (stats && stats.with_price >= 3) {
      await savePriceSnapshot(keyword, city || location, stats.avg, stats.median, stats.min, stats.max, stats.with_price);
    }
    const cityMismatch = rawListings.length > 0 && rawListings[0]?._cityMismatch === true;
    // Salva no cache se tiver resultados
    if (listings.length > 0) {
      setCachedSearch(keyword, city, { listings, stats, cityMismatch }).catch(() => {});
    }
    send('done', { listings, stats, cityMismatch, plan: req.user.plan, limits: req.limits });
  } catch (err) {
    send('error', { message: err.message });
  } finally {
    res.end();
  }
});

app.post('/api/search', requireAuth, async (req, res) => {
  const { sessionId, keyword, location = 'Brasil', city = '', blockedWords = [] } = req.body;
  const { maxItems: limitMax, canBlockWords } = req.limits;
  if (!sessionId || !keyword) return res.status(400).json({ ok: false, error: 'Dados obrigatórios.' });
  const requestedMax2 = parseInt(req.body.maxItems) || 40;
  const maxItems = Math.min(requestedMax2, limitMax);
  const finalBlockedWords = canBlockWords ? blockedWords : [];
  try {
    await touchSession(sessionId);
    const rawListings = await scrapeMarketplace(sessionId, keyword, location, maxItems, {
      removeNoPrice: req.body.removeNoPrice !== false,
      blockedWords: finalBlockedWords,
      city,
    }) || [];
    const searchId = await saveSearch(sessionId, keyword, location);
    if (rawListings.length > 0) await saveListings(searchId, rawListings);
    const { listings, stats } = analyzeListings(rawListings);
    if (stats && stats.with_price >= 3) await savePriceSnapshot(keyword, city || location, stats.avg, stats.median, stats.min, stats.max, stats.with_price);
    const cityMismatch = rawListings.length > 0 && rawListings[0]?._cityMismatch === true;
    res.json({ ok: true, searchId, keyword, location, city, stats, listings, plan: req.user.plan, limits: req.limits, cityMismatch });
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

app.post('/api/push/subscribe', requireAuth, requirePro, async (req, res) => {
  const { sessionId, subscription } = req.body;
  if (!sessionId || !subscription) return res.status(400).json({ ok: false, error: 'Dados obrigatórios.' });
  await saveSubscription(sessionId, subscription);
  res.json({ ok: true });
});

app.post('/api/monitor', requireAuth, requirePro, async (req, res) => {
  const { keyword, location, city, maxPrice, intervalHours = 2, whatsappPhone } = req.body;
  if (!keyword || !maxPrice) return res.status(400).json({ ok: false, error: 'Dados incompletos.' });
  // Usar user.id como sessionId — fixo por usuário, não muda com login/logout
  const sessionId = req.user.id;
  const existing = await getMonitors(sessionId);
  if (existing.length >= req.limits.maxAlerts) return res.status(403).json({ ok: false, error: `Limite de ${req.limits.maxAlerts} alertas atingido.` });
  const id = await saveMonitor(sessionId, keyword, location, city, maxPrice, intervalHours, whatsappPhone || null);
  res.json({ ok: true, id });
});

// Testa envio de WhatsApp
app.post('/api/push/test-whatsapp', requireAuth, requirePro, async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ ok: false, error: 'Número obrigatório.' });
  const sent = await sendWhatsApp(phone, '✅ *MarketScan*\n\nSeu WhatsApp está conectado! Você receberá alertas de oportunidades aqui. 🔥');
  res.json({ ok: sent, error: sent ? null : 'Falha ao enviar. Verifique se o número está correto.' });
});

app.get('/api/monitor/:sessionId', requireAuth, requirePro, async (req, res) => {
  // Buscar pelo user.id (fixo) e também pelo sessionId passado (compatibilidade)
  const monitors = await getMonitors(req.user.id);
  res.json({ ok: true, monitors });
});

// Rota alternativa
app.get('/api/monitors', requireAuth, async (req, res) => {
  const monitors = await getMonitors(req.user.id);
  res.json({ ok: true, monitors });
});

app.delete('/api/monitor/:id', requireAuth, requirePro, async (req, res) => {
  await removeMonitor(req.params.id);
  res.json({ ok: true });
});

// Migrar monitores antigos para usar user.id (roda uma vez)
app.post('/api/monitor/migrate', requireAuth, requirePro, async (req, res) => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
  // Atualiza monitores que estavam com o token como session_id
  const token = req.headers['x-auth-token'];
  await pool.query('UPDATE monitors SET session_id = $1 WHERE session_id = $2', [req.user.id, token]).catch(() => {});
  await pool.end();
  res.json({ ok: true });
});

app.post('/api/push/test', requireAuth, requirePro, async (req, res) => {
  const sent = await sendPush(req.body.sessionId, { title: '✅ MarketScan', body: 'Notificações funcionando!', url: '/', tag: 'test' });
  res.json({ ok: sent });
});

// ── Stripe Checkout ───────────────────────────────────────

// Portal de gerenciamento do Stripe
app.post('/api/stripe/portal', requireAuth, async (req, res) => {
  try {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
    const result = await pool.query('SELECT stripe_customer_id FROM users WHERE token = $1', [req.headers['x-auth-token']]);
    await pool.end();
    let customerId = result.rows[0]?.stripe_customer_id;

    // Fallback: busca pelo email no Stripe se não tiver ID salvo
    if (!customerId) {
      const customers = await stripe.customers.list({ email: req.user.email, limit: 1 });
      if (customers.data.length > 0) {
        customerId = customers.data[0].id;
        // Salva para próximas vezes
        const pool2 = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
        await pool2.query('UPDATE users SET stripe_customer_id = $1 WHERE token = $2', [customerId, req.headers['x-auth-token']]).catch(() => {});
        await pool2.end();
      }
    }

    if (!customerId) return res.json({ ok: false, error: 'Assinatura Stripe não encontrada para este e-mail.' });

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${BASE_URL}/`,
    });
    res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error('[Stripe] Portal error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Info da assinatura
app.get('/api/stripe/subscription', requireAuth, async (req, res) => {
  try {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
    const result = await pool.query('SELECT stripe_customer_id, plan, plan_expires_at FROM users WHERE token = $1', [req.headers['x-auth-token']]);
    await pool.end();
    const user = result.rows[0];
    if (!user) return res.json({ ok: false });
    let renewal = null;
    let cancelAtPeriodEnd = false;
    let customerId = user.stripe_customer_id;

    // Fallback: busca pelo email
    if (!customerId) {
      const customers = await stripe.customers.list({ email: req.user.email, limit: 1 });
      if (customers.data.length > 0) customerId = customers.data[0].id;
    }

    if (customerId) {
      const subs = await stripe.subscriptions.list({ customer: customerId, limit: 1, status: 'active' });
      if (subs.data.length > 0) {
        const sub = subs.data[0];
        renewal = new Date(sub.current_period_end * 1000).toLocaleDateString('pt-BR');
        cancelAtPeriodEnd = sub.cancel_at_period_end;
      }
    }
    res.json({ ok: true, plan: user.plan, planExpiresAt: user.plan_expires_at, renewal, cancelAtPeriodEnd, hasStripe: !!customerId });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});


// ── Checkout de promo sem login (para links de influenciadores) ──
app.post('/api/stripe/checkout-promo', async (req, res) => {
  try {
    const { promoCode, email, password } = req.body;
    if (!promoCode) return res.status(400).json({ ok: false, error: 'Código obrigatório.' });
    if (!email) return res.status(400).json({ ok: false, error: 'E-mail obrigatório.' });
    if (!password || password.length < 6) return res.status(400).json({ ok: false, error: 'Senha mínima de 6 caracteres.' });

    // Verificar se email já cadastrado
    const { Pool } = require('pg');
    const poolCheck = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
    const existing = await poolCheck.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    await poolCheck.end();
    if (existing.rows.length > 0) return res.json({ ok: false, error: 'E-mail já cadastrado. Faça login e use o cupom na tela de upgrade.' });

    // Valida o promoCode no Stripe
    const promoCodes = await stripe.promotionCodes.list({ code: promoCode.toUpperCase(), active: true, limit: 1 });
    if (!promoCodes.data.length) return res.json({ ok: false, error: 'Cupom inválido ou expirado.' });
    const promo = promoCodes.data[0];

    const sessionParams = {
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}&promo=1`,
      cancel_url: `${BASE_URL}/promo/${promoCode}`,
      locale: 'pt-BR',
      discounts: [{ promotion_code: promo.id }],
      metadata: { promoCode: promoCode.toUpperCase(), userEmail: email, userPassword: require('crypto').createHash('sha256').update(password + 'marketscan_salt').digest('hex') },
    };

    // Se vier email, pré-preenche no checkout
    if (email) sessionParams.customer_email = email;

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error('[Stripe] Promo checkout error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});


// Contar monitores (admin)
app.get('/api/admin/monitors-count', requireAdmin, async (req, res) => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
  const result = await pool.query('SELECT COUNT(*) as total FROM monitors').catch(() => ({ rows: [{ total: 0 }] }));
  await pool.end();
  res.json({ ok: true, total: parseInt(result.rows[0].total) });
});

// Limpar todos os monitores (admin)
app.delete('/api/admin/monitors/clear-all', requireAdmin, async (req, res) => {
  try {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
    const result = await pool.query('DELETE FROM monitors');
    await pool.query('DELETE FROM fired_alerts').catch(() => {});
    await pool.end();
    console.log(`[Admin] ${result.rowCount} monitores removidos`);
    res.json({ ok: true, deleted: result.rowCount || 0 });
  } catch (err) {
    console.error('[Admin] Erro ao limpar monitores:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});


// Rota para ver QR Code do WhatsApp (protegida com senha)
app.get('/whatsapp-qr', async (req, res) => {
  if (req.query.key !== process.env.ADMIN_KEY) return res.status(403).send('<h2 style="font-family:sans-serif;text-align:center;margin-top:100px">🔒 Acesso negado</h2>');
  const qr = getLastQR();
  const connected = getIsConnected();
  if (connected) {
    return res.send('<h2 style="font-family:sans-serif;color:green;text-align:center;margin-top:100px">✅ WhatsApp Conectado!</h2>');
  }
  if (!qr) {
    return res.send('<h2 style="font-family:sans-serif;text-align:center;margin-top:100px">⏳ Aguardando QR Code... Recarregue a página em alguns segundos.</h2><script>setTimeout(()=>location.reload(),2000)</script>');
  }
  try {
    const QRCode = require('qrcode');
    const qrImage = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#f0f0f0">
        <h2>📱 Escaneie o QR Code com seu WhatsApp</h2>
        <p style="color:#666">Abra o WhatsApp → Menu → Aparelhos conectados → Conectar um aparelho</p>
        <img src="${qrImage}" style="margin:20px auto;display:block;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.15);width:300px;height:300px">
        <p style="color:#999;font-size:12px">Esta página atualiza automaticamente a cada 3 segundos</p>
        <script>setTimeout(()=>location.reload(),3000)</script>
      </body></html>
    `);
  } catch(e) {
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`;
    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>📱 Escaneie o QR Code</h2><img src="${qrUrl}" style="width:300px"><script>setTimeout(()=>location.reload(),3000)</script></body></html>`);
  }
});


// ── Saúde das contas Facebook ─────────────────────────────
app.get('/api/admin/fb-health', requireAdmin, async (req, res) => {
  try {
    const { Pool } = require('pg');
    const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
    
    // Pegar todas as contas configuradas
    const accounts = [];
    for (let i = 1; i <= 9; i++) {
      const val = process.env[`FB_ACCOUNT_${i}`];
      if (val && val.includes(':')) {
        const idx = val.indexOf(':');
        accounts.push({ email: val.slice(0, idx), sessionId: `pool-account-${i}`, index: i });
      }
    }
    if (process.env.FB_EMAIL) {
      accounts.push({ email: process.env.FB_EMAIL, sessionId: 'shared-pool-account', index: 0 });
    }

    // Verificar status de cada conta
    const results = await Promise.all(accounts.map(async (acc) => {
      const cookieRes = await p.query(
        'SELECT cookies, updated_at FROM session_cookies WHERE session_id = $1',
        [acc.sessionId]
      ).catch(() => ({ rows: [] }));
      
      if (!cookieRes.rows.length) {
        return { ...acc, status: 'sem_cookie', lastLogin: null };
      }
      
      let cookies = cookieRes.rows[0].cookies;
      const updatedAt = cookieRes.rows[0].updated_at;
      // Cookies podem estar como string JSON
      if (typeof cookies === 'string') {
        try { cookies = JSON.parse(cookies); } catch { cookies = []; }
      }
      const hasCUser = Array.isArray(cookies) && cookies.some(c => c.name === 'c_user');
      const ageHours = updatedAt ? Math.floor((Date.now() - parseInt(updatedAt)) / (1000 * 60 * 60)) : null;
      
      return {
        ...acc,
        status: hasCUser ? 'ativo' : 'cookie_invalido',
        lastLogin: updatedAt ? new Date(parseInt(updatedAt)).toLocaleString('pt-BR') : null,
        ageHours,
      };
    }));

    await p.end();
    res.json({ ok: true, accounts: results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Forçar reconexão de uma conta específica
app.post('/api/admin/fb-reconnect/:index', requireAdmin, async (req, res) => {
  try {
    const idx = parseInt(req.params.index);
    let email, password, sessionId;
    
    if (idx === 0) {
      email = process.env.FB_EMAIL;
      password = process.env.FB_PASSWORD;
      sessionId = 'shared-pool-account';
    } else {
      const val = process.env[`FB_ACCOUNT_${idx}`];
      if (!val) return res.json({ ok: false, error: 'Conta não encontrada' });
      const sepIdx = val.indexOf(':');
      email = val.slice(0, sepIdx);
      password = val.slice(sepIdx + 1);
      sessionId = `pool-account-${idx}`;
    }

    const result = await loginWithCredentials(sessionId, email, password);
    res.json({ ok: result.ok, status: result.status, error: result.error });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Limpar cookies de uma conta (forçar novo login)
app.delete('/api/admin/fb-cookies/:index', requireAdmin, async (req, res) => {
  try {
    const idx = parseInt(req.params.index);
    const sessionId = idx === 0 ? 'shared-pool-account' : `pool-account-${idx}`;
    const { Pool } = require('pg');
    const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
    await p.query('DELETE FROM session_cookies WHERE session_id = $1', [sessionId]);
    await p.end();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});


// Limpar sessão WhatsApp (forçar novo QR)
app.delete('/whatsapp-session', (req, res) => {
  if (req.query.key !== process.env.ADMIN_KEY) return res.status(403).send('Acesso negado');
  const { Pool } = require('pg');
  const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
  p.query('DELETE FROM whatsapp_session').then(() => {
    p.end();
    res.send('<h2 style="font-family:sans-serif;text-align:center;margin-top:100px">✅ Sessão limpa! Reinicie o servidor e acesse /whatsapp-qr para escanear o QR Code.</h2>');
  }).catch(err => res.status(500).send('Erro: ' + err.message));
});


// ── Sistema de Indicação ──────────────────────────────────────
async function initReferralTable() {
  const { Pool } = require('pg');
  const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
  await p.query(`
    CREATE TABLE IF NOT EXISTS referrals (
      id SERIAL PRIMARY KEY,
      referrer_id TEXT NOT NULL,
      referred_email TEXT NOT NULL,
      referred_id TEXT,
      status TEXT DEFAULT 'registered',
      created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000,
      converted_at BIGINT
    );
    CREATE TABLE IF NOT EXISTS referral_codes (
      user_id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
    );
  `).catch(err => console.warn('[Referral] Erro ao criar tabelas:', err.message));
  await p.end();
}
initReferralTable();

// Gerar código único de indicação
function generateRefCode(email) {
  const base = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 8);
  const rand = Math.random().toString(36).slice(2, 5).toUpperCase();
  return `${base}${rand}`;
}

// Buscar ou criar código de indicação do usuário
async function getOrCreateRefCode(userId, email) {
  const { Pool } = require('pg');
  const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
  const existing = await p.query('SELECT code FROM referral_codes WHERE user_id = $1', [userId]);
  if (existing.rows.length > 0) { await p.end(); return existing.rows[0].code; }
  const code = generateRefCode(email);
  await p.query('INSERT INTO referral_codes (user_id, code) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, code]);
  await p.end();
  return code;
}

// Rota: pegar link de indicação
app.get('/api/referral/my-link', requireAuth, async (req, res) => {
  const code = await getOrCreateRefCode(req.user.id, req.user.email);
  res.json({ ok: true, code, url: `${BASE_URL}/ref/${code}` });
});

// Rota: listar indicados
app.get('/api/referral/my-referrals', requireAuth, async (req, res) => {
  const { Pool } = require('pg');
  const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
  const result = await p.query(
    'SELECT referred_email, status, created_at, converted_at FROM referrals WHERE referrer_id = $1 ORDER BY created_at DESC',
    [req.user.id]
  );
  const stats = await p.query(
    'SELECT COUNT(*) as total, SUM(CASE WHEN status = $1 THEN 1 ELSE 0 END) as converted FROM referrals WHERE referrer_id = $2',
    ['converted', req.user.id]
  );
  await p.end();
  const converted = parseInt(stats.rows[0].converted) || 0;
  res.json({ ok: true, referrals: result.rows, totalDaysEarned: converted * 7 });
});

// Rota: página de cadastro via referral
app.get('/ref/:code', (req, res) => {
  res.redirect(`/?ref=${req.params.code}`);
});

// Rota da página de promo
app.get('/promo/:code', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/promo.html'));
});

app.post('/api/stripe/checkout', requireAuth, async (req, res) => {
  try {
    const { promoCode } = req.body;
    const sessionParams = {
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}&token=${req.headers['x-auth-token']}`,
      cancel_url: `${BASE_URL}/?canceled=true`,
      customer_email: req.user.email,
      metadata: { userToken: req.headers['x-auth-token'] },
      locale: 'pt-BR',
    };
    // Se vier um promoCode válido do Stripe, aplica direto
    if (promoCode) {
      sessionParams.discounts = [{ promotion_code: promoCode }];
    } else {
      sessionParams.allow_promotion_codes = true;
    }
    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error('[Stripe] Checkout error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Valida cupom — verifica se é cupom interno (dias Pro) ou Stripe (desconto)
app.post('/api/coupon/validate', requireAuth, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ ok: false, error: 'Código obrigatório.' });

  // 1. Verifica cupom interno primeiro (dias Pro grátis)
  const pool2 = new (require('pg').Pool)({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
  try {
    const result = await pool2.query('SELECT * FROM coupons WHERE code = $1', [code.toUpperCase()]);
    await pool2.end();
    if (result.rows.length && result.rows[0].uses_remaining > 0) {
      return res.json({ ok: true, type: 'internal', days: result.rows[0].days_pro, message: `🎉 Cupom válido! ${result.rows[0].days_pro} dias de Pro grátis.` });
    }
  } catch (e) { await pool2.end(); }

  // 2. Verifica cupom Stripe (desconto no pagamento)
  try {
    const promoCodes = await stripe.promotionCodes.list({ code: code.toUpperCase(), active: true, limit: 1 });
    if (promoCodes.data.length > 0) {
      const promo = promoCodes.data[0];
      const coupon = promo.coupon;
      const discountText = coupon.percent_off ? `${coupon.percent_off}% de desconto` : `R$${(coupon.amount_off/100).toFixed(2)} de desconto`;
      const durationText = coupon.duration === 'once' ? 'no primeiro mês' : coupon.duration === 'forever' ? 'em todas as cobranças' : `por ${coupon.duration_in_months} meses`;
      return res.json({ ok: true, type: 'stripe', promoId: promo.id, message: `🎉 Cupom válido! ${discountText} ${durationText}.` });
    }
  } catch (e) { console.error('[Coupon] Stripe error:', e.message); }

  res.json({ ok: false, error: 'Cupom inválido ou expirado.' });
});

app.get('/success', async (req, res) => {
  const { session_id, token } = req.query;
  if (token) {
    try {
      const session = await stripe.checkout.sessions.retrieve(session_id);
      if (session.payment_status === 'paid') await upgradeToPro(token, 1);
    } catch (e) { console.error('[Stripe] Success page error:', e); }
  }
  res.sendFile(path.join(__dirname, '../frontend/success.html'));
});

// ── Feedback de cidade incorreta ─────────────────────────────
app.post('/api/feedback/city', requireAuth, async (req, res) => {
  const { city, state, keyword, description } = req.body;
  if (!city) return res.status(400).json({ ok: false, error: 'Cidade obrigatória.' });
  try {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS city_feedback (
        id SERIAL PRIMARY KEY,
        email TEXT,
        city TEXT NOT NULL,
        state TEXT,
        keyword TEXT,
        description TEXT,
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
      )
    `);
    await pool.query(
      'INSERT INTO city_feedback (email, city, state, keyword, description) VALUES ($1, $2, $3, $4, $5)',
      [req.user.email, city, state || '', keyword || '', description || '']
    );
    await pool.end();
    console.log(`[Feedback] Cidade incorreta reportada: ${city}/${state} por ${req.user.email}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/admin/reconnect-shared', requireAdmin, async (req, res) => {
  try {
    const { ensureSharedSession } = require('./scraper');
    // Apaga cookies da sessão compartilhada para forçar novo login
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    });
    await pool.query("DELETE FROM session_cookies WHERE session_id = 'shared-pool-account'");
    await pool.end();
    const fs = require('fs'), path = require('path');
    const cookieFile = path.join(__dirname, '../data/cookies/shared-pool-account.json');
    if (fs.existsSync(cookieFile)) fs.unlinkSync(cookieFile);
    // Reconecta
    const result = await ensureSharedSession();
    res.json({ ok: !!result, message: result ? 'Reconectado com sucesso!' : 'Falhou — verifique FB_EMAIL e FB_PASSWORD' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/admin/city-feedback'
, requireAdmin, async (req, res) => {
  try {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    });
    const result = await pool.query('SELECT * FROM city_feedback ORDER BY created_at DESC LIMIT 100');
    await pool.end();
    res.json({ ok: true, feedback: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Contato ──────────────────────────────────────────────────
app.get('/contact', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/contact.html'));
});

app.post('/api/contact', async (req, res) => {
  const { name, email, subject, message } = req.body;
  if (!name || !email || !message) return res.status(400).json({ ok: false, error: 'Campos obrigatórios faltando.' });
  try {
    // Salva no banco e notifica por email (via log por enquanto)
    console.log(`[Contato] De: ${name} <${email}> | Assunto: ${subject} | Msg: ${message.slice(0, 100)}`);
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
    await pool.query(`CREATE TABLE IF NOT EXISTS contact_messages (id SERIAL PRIMARY KEY, name TEXT, email TEXT, subject TEXT, message TEXT, created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000)`);
    await pool.query('INSERT INTO contact_messages (name, email, subject, message) VALUES ($1,$2,$3,$4)', [name, email, subject, message]);
    await pool.end();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Cupons ──────────────────────────────────────────────────
async function getCouponPool() {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
  await pool.query(`CREATE TABLE IF NOT EXISTS coupons (
    code TEXT PRIMARY KEY, days_pro INT DEFAULT 30,
    max_uses INT DEFAULT 100, uses_remaining INT DEFAULT 100,
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
  )`);
  return pool;
}

app.get('/api/admin/coupons', requireAdmin, async (req, res) => {
  try {
    const pool = await getCouponPool();
    const result = await pool.query('SELECT * FROM coupons ORDER BY created_at DESC');
    await pool.end();
    res.json({ ok: true, coupons: result.rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/admin/coupons', requireAdmin, async (req, res) => {
  const { code, days_pro = 30, max_uses = 100 } = req.body;
  if (!code) return res.status(400).json({ ok: false, error: 'Código obrigatório.' });
  try {
    const pool = await getCouponPool();
    await pool.query('INSERT INTO coupons (code, days_pro, max_uses, uses_remaining) VALUES ($1,$2,$3,$3) ON CONFLICT (code) DO NOTHING', [code.toUpperCase(), days_pro, max_uses]);
    await pool.end();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.delete('/api/admin/coupons/:code', requireAdmin, async (req, res) => {
  try {
    const pool = await getCouponPool();
    await pool.query('DELETE FROM coupons WHERE code = $1', [req.params.code.toUpperCase()]);
    await pool.end();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Aplicar cupom
app.post('/api/coupon/apply', requireAuth, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ ok: false, error: 'Código obrigatório.' });
  try {
    const pool = await getCouponPool();
    const result = await pool.query('SELECT * FROM coupons WHERE code = $1', [code.toUpperCase()]);
    if (!result.rows.length) { await pool.end(); return res.json({ ok: false, error: 'Cupom inválido ou inexistente.' }); }
    const coupon = result.rows[0];
    if (coupon.uses_remaining <= 0) { await pool.end(); return res.json({ ok: false, error: 'Este cupom já esgotou os usos.' }); }
    await pool.query('UPDATE coupons SET uses_remaining = uses_remaining - 1 WHERE code = $1', [code.toUpperCase()]);
    await pool.end();
    const months = Math.ceil(coupon.days_pro / 30);
    await upgradeToPro(req.headers['x-auth-token'], months);
    console.log(`[Cupom] ${code} aplicado por ${req.user.email} — ${coupon.days_pro} dias Pro`);
    res.json({ ok: true, days: coupon.days_pro, message: `✅ Cupom aplicado! Você ganhou ${coupon.days_pro} dias de Pro.` });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── Alertas do pool ──────────────────────────────────────────
app.get('/api/admin/pool-alerts', requireAdmin, async (req, res) => {
  try {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
    await pool.query(`CREATE TABLE IF NOT EXISTS pool_alerts (id SERIAL PRIMARY KEY, email TEXT, status TEXT, created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000)`);
    const result = await pool.query('SELECT * FROM pool_alerts ORDER BY created_at DESC LIMIT 50');
    await pool.end();
    res.json({ ok: true, alerts: result.rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.delete('/api/admin/pool-alerts/:id', requireAdmin, async (req, res) => {
  try {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
    await pool.query('DELETE FROM pool_alerts WHERE id = $1', [req.params.id]);
    await pool.end();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
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

app.delete('/api/admin/users/:token', requireAdmin, async (req, res) => {
  const { token } = req.params;
  if (!token) return res.status(400).json({ ok: false, error: 'Token obrigatório.' });
  try {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    });
    await pool.query('DELETE FROM users WHERE token = $1', [token]);
    await pool.end();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
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

// Landing page
app.get('/landing', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/landing.html'));
});

// Raiz redireciona para landing
app.get('/', (req, res) => {
  res.redirect('/landing');
});

// App em /app
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')));

startMonitorCron(scrapeMarketplace, analyzeListings, hasSavedCookies);

// Iniciar WhatsApp Baileys
console.log('[WhatsApp] Iniciando Baileys...');
connectWhatsApp().catch(err => console.error('[WhatsApp] Erro ao iniciar:', err.message, err.stack));

// ── Cron de emails do trial ───────────────────────────────────
const cron = require('node-cron');
cron.schedule('0 10 * * *', async () => {
  console.log('[Cron] Verificando trials expirando...');
  try {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    const twoDaysMs = 2 * oneDayMs;

    const expiring1 = await pool.query(`SELECT email FROM users WHERE plan = 'pro' AND plan_expires_at > $1 AND plan_expires_at <= $2`, [now, now + oneDayMs]);
    for (const u of expiring1.rows) await emailTrialExpirando(u.email, 1).catch(() => {});

    const expiring2 = await pool.query(`SELECT email FROM users WHERE plan = 'pro' AND plan_expires_at > $1 AND plan_expires_at <= $2`, [now + oneDayMs, now + twoDaysMs]);
    for (const u of expiring2.rows) await emailTrialExpirando(u.email, 2).catch(() => {});

    const expired = await pool.query(`SELECT email, token FROM users WHERE plan = 'pro' AND plan_expires_at < $1 AND plan_expires_at > $2`, [now, now - oneDayMs]);
    for (const u of expired.rows) {
      await pool.query("UPDATE users SET plan = 'free' WHERE token = $1", [u.token]);
      await emailTrialExpirado(u.email).catch(() => {});
    }

    await pool.end();
    console.log(`[Cron] ${expiring1.rows.length} expirando em 1d, ${expiring2.rows.length} em 2d, ${expired.rows.length} expirados`);
  } catch (err) { console.error('[Cron] Erro:', err.message); }
}, { timezone: 'America/Sao_Paulo' });

app.listen(PORT, () => console.log(`\n🚀 MarketScan rodando em ${BASE_URL}\n`));
