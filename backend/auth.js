const crypto = require('crypto');
const { Pool } = require('pg');

// Conexão com PostgreSQL via DATABASE_URL do Railway
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Cria tabela de usuários se não existir
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      plan TEXT DEFAULT 'free',
      token TEXT UNIQUE,
      created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000,
      plan_expires_at BIGINT DEFAULT NULL,
      whatsapp_phone TEXT DEFAULT NULL
    )
  `);
  console.log('[DB] Tabela users pronta');
}
initDB().catch(err => console.error('[DB] Erro ao criar tabela:', err.message));

function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'marketscan_salt').digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function register(email, password, whatsappPhone = null) {
  email = email.toLowerCase().trim();
  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    return { ok: false, error: 'E-mail já cadastrado.' };
  }
  const trialDays = 7;
  const planExpiresAt = Date.now() + trialDays * 24 * 60 * 60 * 1000;
  const phone = whatsappPhone ? whatsappPhone.replace(/\D/g, '') : null;
  const user = {
    id: crypto.randomUUID(),
    email,
    password: hashPassword(password),
    plan: 'pro',
    token: generateToken(),
    plan_expires_at: planExpiresAt,
    whatsapp_phone: phone,
  };
  await pool.query(
    'INSERT INTO users (id, email, password, plan, token, plan_expires_at, whatsapp_phone) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [user.id, user.email, user.password, user.plan, user.token, user.plan_expires_at, user.whatsapp_phone]
  );
  return { ok: true, token: user.token, plan: user.plan, email: user.email, trial: true, trialDays };
}

async function login(email, password) {
  email = email.toLowerCase().trim();
  const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  const user = result.rows[0];
  if (!user || user.password !== hashPassword(password)) {
    return { ok: false, error: 'E-mail ou senha incorretos.' };
  }
  const token = generateToken();
  await pool.query('UPDATE users SET token = $1 WHERE email = $2', [token, email]);
  return { ok: true, token, plan: user.plan, email: user.email };
}

async function getUserByToken(token) {
  if (!token) return null;
  const result = await pool.query('SELECT * FROM users WHERE token = $1', [token]);
  const user = result.rows[0];
  if (!user) return null;
  // Verifica se plano pro expirou
  if (user.plan === 'pro' && user.plan_expires_at && Date.now() > parseInt(user.plan_expires_at)) {
    await pool.query('UPDATE users SET plan = $1, plan_expires_at = NULL WHERE token = $2', ['free', token]);
    return { ...user, plan: 'free', planExpiresAt: null };
  }
  return {
    id: user.id,
    email: user.email,
    plan: user.plan,
    token: user.token,
    planExpiresAt: user.plan_expires_at ? parseInt(user.plan_expires_at) : null,
    whatsappPhone: user.whatsapp_phone || null,
  };
}

async function upgradeToPro(token, months = 1) {
  const user = await getUserByToken(token);
  if (!user) return { ok: false, error: 'Sessão inválida.' };
  const expiresAt = Date.now() + months * 30 * 24 * 60 * 60 * 1000;
  await pool.query(
    'UPDATE users SET plan = $1, plan_expires_at = $2 WHERE token = $3',
    ['pro', expiresAt, token]
  );
  return { ok: true, plan: 'pro', expiresAt };
}

const PLAN_LIMITS = {
  free: {
    maxItems: 20,
    canAlert: false,
    maxAlerts: 0,
    canCompare: false,
    canCalc: false,
    canHistory: false,
    canBlockWords: false,
  },
  pro: {
    maxItems: 100,
    canAlert: true,
    maxAlerts: 5,
    canCompare: true,
    canCalc: true,
    canHistory: true,
    canBlockWords: true,
  },
};

function getLimits(plan) {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.free;
}

async function createPasswordResetToken(email) {
  email = email.toLowerCase().trim();
  const result = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (!result.rows.length) {
    // Não revela se o email existe ou não
    return { ok: true };
  }
  const resetToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 60 * 60 * 1000; // 1 hora
  await pool.query(
    'UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE email = $3',
    [resetToken, expiresAt, email]
  );
  return { ok: true, resetToken, email };
}

async function resetPassword(resetToken, newPassword) {
  if (!resetToken) return { ok: false, error: 'Token inválido.' };
  const result = await pool.query(
    'SELECT * FROM users WHERE reset_token = $1',
    [resetToken]
  );
  const user = result.rows[0];
  if (!user) return { ok: false, error: 'Link inválido ou expirado.' };
  if (Date.now() > parseInt(user.reset_token_expires)) {
    return { ok: false, error: 'Link expirado. Solicite um novo.' };
  }
  await pool.query(
    'UPDATE users SET password = $1, reset_token = NULL, reset_token_expires = NULL WHERE reset_token = $2',
    [hashPassword(newPassword), resetToken]
  );
  return { ok: true };
}

async function updateWhatsappPhone(token, phone) {
  const clean = phone ? phone.replace(/\D/g, '') : null;
  await pool.query('UPDATE users SET whatsapp_phone = $1 WHERE token = $2', [clean, token]);
  return { ok: true };
}

// Garante que colunas de reset existam na tabela
pool.query(`
  ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires BIGINT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_phone TEXT;
`).catch(() => {});

module.exports = { register, login, getUserByToken, upgradeToPro, getLimits, createPasswordResetToken, resetPassword, updateWhatsappPhone };
