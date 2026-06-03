const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()),
      last_used BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
    );

    CREATE TABLE IF NOT EXISTS searches (
      id SERIAL PRIMARY KEY,
      session_id TEXT,
      keyword TEXT,
      location TEXT,
      created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
    );

    CREATE TABLE IF NOT EXISTS listings (
      id SERIAL PRIMARY KEY,
      search_id INTEGER,
      external_id TEXT,
      title TEXT,
      price NUMERIC,
      price_raw TEXT,
      location TEXT,
      image_url TEXT,
      listing_url TEXT,
      condition TEXT,
      created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
    );

    CREATE TABLE IF NOT EXISTS price_history (
      id SERIAL PRIMARY KEY,
      keyword TEXT,
      city TEXT,
      avg NUMERIC,
      median NUMERIC,
      min NUMERIC,
      max NUMERIC,
      count INTEGER,
      date TEXT,
      ts BIGINT
    );
  `);
  console.log('[DB] Tabelas marketplace prontas');
}
initDB().catch(err => console.error('[DB] Erro ao criar tabelas:', err.message));

function now() { return Math.floor(Date.now() / 1000); }

async function createSession(id) {
  await pool.query(`
    INSERT INTO sessions (id, created_at, last_used)
    VALUES ($1, $2, $2)
    ON CONFLICT (id) DO UPDATE SET last_used = $2
  `, [id, now()]);
}

async function touchSession(id) {
  await pool.query('UPDATE sessions SET last_used = $1 WHERE id = $2', [now(), id]);
}

async function saveSearch(sessionId, keyword, location) {
  const result = await pool.query(
    'INSERT INTO searches (session_id, keyword, location, created_at) VALUES ($1, $2, $3, $4) RETURNING id',
    [sessionId, keyword, location, now()]
  );
  return result.rows[0].id;
}

async function saveListings(searchId, listings) {
  for (const l of listings) {
    await pool.query(
      `INSERT INTO listings (search_id, external_id, title, price, price_raw, location, image_url, listing_url, condition)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [searchId, l.external_id || null, l.title || '', l.price || null, l.price_raw || '',
       l.location || '', l.image_url || '', l.listing_url || '', l.condition || '']
    );
  }
}

async function getListingsBySearch(searchId) {
  const result = await pool.query(
    'SELECT * FROM listings WHERE search_id = $1 ORDER BY price ASC',
    [searchId]
  );
  return result.rows;
}

async function getRecentSearches(sessionId, limit = 10) {
  const result = await pool.query(
    'SELECT * FROM searches WHERE session_id = $1 ORDER BY created_at DESC LIMIT $2',
    [sessionId, limit]
  );
  const searches = result.rows;
  for (const s of searches) {
    const count = await pool.query('SELECT COUNT(*) FROM listings WHERE search_id = $1', [s.id]);
    s.total_listings = parseInt(count.rows[0].count);
  }
  return searches;
}

async function savePriceSnapshot(keyword, city, avg, median, min, max, count) {
  try {
    await pool.query(
      `INSERT INTO price_history (keyword, city, avg, median, min, max, count, date, ts)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        (keyword || '').toLowerCase(),
        (city || '').toLowerCase(),
        avg || 0, median || 0, min || 0, max || 0, count || 0,
        new Date().toISOString().split('T')[0],
        Date.now(),
      ]
    );
  } catch (e) {
    console.warn('[DB] Erro ao salvar snapshot:', e.message);
  }
}

async function getPriceHistory(keyword, city, days = 30) {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const result = await pool.query(
    `SELECT * FROM price_history
     WHERE keyword = $1 AND city = $2 AND ts >= $3
     ORDER BY ts ASC`,
    [(keyword || '').toLowerCase(), (city || '').toLowerCase(), since]
  );
  return result.rows;
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
