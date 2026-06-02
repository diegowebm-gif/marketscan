const crypto = require('crypto');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const adapter = new FileSync(path.join(DATA_DIR, 'users.json'));
const db = low(adapter);
db.defaults({ users: [] }).write();

function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'marketscan_salt').digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function register(email, password) {
  email = email.toLowerCase().trim();
  if (db.get('users').find({ email }).value()) {
    return { ok: false, error: 'E-mail já cadastrado.' };
  }
  const user = {
    id: crypto.randomUUID(),
    email,
    password: hashPassword(password),
    plan: 'free',
    token: generateToken(),
    createdAt: Date.now(),
    planExpiresAt: null,
  };
  db.get('users').push(user).write();
  return { ok: true, token: user.token, plan: user.plan, email: user.email };
}

function login(email, password) {
  email = email.toLowerCase().trim();
  const user = db.get('users').find({ email }).value();
  if (!user || user.password !== hashPassword(password)) {
    return { ok: false, error: 'E-mail ou senha incorretos.' };
  }
  // Renova token
  const token = generateToken();
  db.get('users').find({ email }).assign({ token }).write();
  return { ok: true, token, plan: user.plan, email: user.email };
}

function getUserByToken(token) {
  if (!token) return null;
  const user = db.get('users').find({ token }).value();
  if (!user) return null;
  // Verifica se plano pro expirou
  if (user.plan === 'pro' && user.planExpiresAt && Date.now() > user.planExpiresAt) {
    db.get('users').find({ token }).assign({ plan: 'free', planExpiresAt: null }).write();
    return { ...user, plan: 'free' };
  }
  return user;
}

function upgradeToPro(token, months = 1) {
  const user = getUserByToken(token);
  if (!user) return { ok: false, error: 'Sessão inválida.' };
  const expiresAt = Date.now() + months * 30 * 24 * 60 * 60 * 1000;
  db.get('users').find({ token }).assign({ plan: 'pro', planExpiresAt: expiresAt }).write();
  return { ok: true, plan: 'pro', expiresAt };
}

// Limites por plano
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

module.exports = { register, login, getUserByToken, upgradeToPro, getLimits };
