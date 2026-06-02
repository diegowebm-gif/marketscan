const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const adapter = new FileSync(path.join(DATA_DIR, 'marketplace.json'));
const db = low(adapter);

// Schema padrão
db.defaults({ sessions: [], searches: [], listings: [] }).write();

function nextId(collection) {
  const items = db.get(collection).value();
  if (!items.length) return 1;
  return Math.max(...items.map(i => i.id || 0)) + 1;
}

function now() { return Math.floor(Date.now() / 1000); }

function createSession(id) {
  const exists = db.get('sessions').find({ id }).value();
  if (exists) {
    db.get('sessions').find({ id }).assign({ last_used: now() }).write();
  } else {
    db.get('sessions').push({ id, created_at: now(), last_used: now() }).write();
  }
}

function touchSession(id) {
  db.get('sessions').find({ id }).assign({ last_used: now() }).write();
}

function saveSearch(sessionId, keyword, location) {
  const id = nextId('searches');
  db.get('searches').push({ id, session_id: sessionId, keyword, location, created_at: now() }).write();
  return id;
}

function saveListings(searchId, listings) {
  const toInsert = listings.map(l => ({ id: nextId('listings'), search_id: searchId, ...l }));
  // Insere um por um atualizando o nextId
  for (const item of toInsert) {
    db.get('listings').push(item).write();
  }
}

function getListingsBySearch(searchId) {
  return db.get('listings')
    .filter({ search_id: searchId })
    .sortBy('price')
    .value();
}

function getRecentSearches(sessionId, limit = 10) {
  const searches = db.get('searches')
    .filter({ session_id: sessionId })
    .sortBy('created_at')
    .reverse()
    .take(limit)
    .value();

  return searches.map(s => ({
    ...s,
    total_listings: db.get('listings').filter({ search_id: s.id }).size().value(),
  }));
}

// Salva snapshot de preço médio por keyword+cidade
function savePriceSnapshot(keyword, city, avg, median, min, max, count) {
  try {
    const history = db.get('price_history').value() || [];
    db.get('price_history').push({
      id: history.length + 1,
      keyword: (keyword || '').toLowerCase(),
      city: (city || '').toLowerCase(),
      avg: avg || 0, median: median || 0, min: min || 0, max: max || 0, count: count || 0,
      date: new Date().toISOString().split('T')[0],
      ts: Date.now(),
    }).write();
  } catch(e) {
    console.warn('[DB] Erro ao salvar snapshot:', e.message);
  }
}

// Retorna histórico dos últimos 30 dias para keyword+cidade
function getPriceHistory(keyword, city, days = 30) {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  return db.get('price_history')
    .filter(h =>
      h.keyword === keyword.toLowerCase() &&
      h.city === city.toLowerCase() &&
      h.ts >= since
    )
    .sortBy('ts')
    .value();
}

module.exports = {
  createSession,
  touchSession,
  saveSearch,
  saveListings,
  getListingsBySearch,
  getRecentSearches,
  savePriceSnapshot,
  getPriceHistory,
};
