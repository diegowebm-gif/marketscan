const puppeteer = require('puppeteer');
const os = require('os');
const fs = require('fs');
const path = require('path');

const activeBrowsers = {};
const COOKIES_DIR = path.join(__dirname, '../data/cookies');

if (!fs.existsSync(COOKIES_DIR)) fs.mkdirSync(COOKIES_DIR, { recursive: true });

// Pool PostgreSQL para persistir cookies entre deploys
const { Pool } = require('pg');
const cookiePool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});
cookiePool.query(`
  CREATE TABLE IF NOT EXISTS session_cookies (
    session_id TEXT PRIMARY KEY,
    cookies TEXT NOT NULL,
    updated_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
  )
`).catch(err => console.warn('[Cookies] Erro ao criar tabela:', err.message));

// ─── Filtros de qualidade ─────────────────────────────────

const ACCESSORY_KEYWORDS = [
  'capinha','capa protetora','película','pelicula','carregador','cabo usb',
  'cabo lightning','cabo type-c','fone de ouvido','fones de ouvido',
  'earphone','earphones','headphone','headset','airpod','airpods',
  'case para','suporte para','protetor de tela','carcaça','carcaca',
  'bumper','skin adesiva','adaptador usb','hub usb','dock',
  'tripé','tripe','anel magnético','pop socket','popsocket',
  'bateria externa','powerbank','power bank','fonte carregador',
  'película vidro','película gel','caneta stylus','stylus',
  'suporte veicular','suporte celular','película fosca',
  'smartwatch','smart watch','relogio inteligente','relógio inteligente',
  'fone bluetooth','fone sem fio','cabo original','carregador original',
  'fonte original','adaptador original','kit cabo','kit carregador',
  'para iphone','compatível com iphone','compativel com iphone',
];

const DEFECT_KEYWORDS = [
  'com defeito','defeituoso','quebrado','trincado','rachado',
  'não liga','nao liga','não funciona','nao funciona',
  'para peças','para peça','pra peça','pra peças',
  'retirada de peças','display quebrado','tela quebrada',
  'tela trincada','vidro quebrado','vidro trincado',
  'sem touch','touch ruim','em manutenção','em manutencao',
  'bateria viciada','bateria ruim','bateria inchada','sem bateria',
  'câmera com defeito','camera com defeito','placa queimada',
  'não carrega','nao carrega','chassi dobrado','amassado',
  'danificado','avariado','tela manchada','burn-in',
];

const PACKAGE_KEYWORDS = [
  'caixa','embalagem','box','apenas caixa','só caixa','somente caixa',
  'caixa vazia','manual','acessório','acessorios',
];

function normalize(str) {
  return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function isAccessory(title) {
  const t = normalize(title);
  if (ACCESSORY_KEYWORDS.some(kw => t.includes(normalize(kw)))) return true;
  if (/^(cabo|carregador|fonte|adaptador|suporte|pelicula|capinha|capa|fone|kit)/.test(t)) return true;
  return false;
}

function hasDefect(title) {
  const t = normalize(title);
  return DEFECT_KEYWORDS.some(kw => t.includes(normalize(kw)));
}

function isRelevant(title, keyword) {
  if (!keyword) return true;
  const t = normalize(title);
  const kw = normalize(keyword);

  // Título genérico — deixa passar
  if (t === 'acabou de ser anunciado' || t.length < 5) return true;

  // Se contém a keyword inteira, é relevante
  if (t.includes(kw)) return true;

  const stopwords = ['de','do','da','os','as','um','uma','para','com','sem','pro','pra','e'];
  const words = kw.split(/\s+/).filter(w => w.length > 1 && !stopwords.includes(w));
  if (words.length === 0) return true;

  // Separa palavras textuais e números da keyword
  const textWords = words.filter(w => !/^\d+$/.test(w));
  const numWords = words.filter(w => /^\d+$/.test(w));

  // Verifica se palavras textuais principais estão no título
  const textMatched = textWords.filter(w => t.includes(w));
  if (textMatched.length < Math.ceil(textWords.length / 2)) return false;

  // Se a keyword tem número (ex: "11" em "iphone 11"), exige que o título também tenha
  if (numWords.length > 0) {
    const hasNumber = numWords.some(n => {
      // Boundary estrito: o número deve estar isolado (não ser parte de outro número)
      // ex: "11" bate em "iphone 11" mas não em "iphone 111" ou "iphone 12"
      const regex = new RegExp(`(?<![\\d])${n}(?![\\d])`);
      return regex.test(t);
    });
    if (!hasNumber) return false;
  }

  return true;
}

function isPackage(title) {
  const t = normalize(title);
  return PACKAGE_KEYWORDS.some(kw => t.startsWith(normalize(kw)) || t.includes(' ' + normalize(kw) + ' '));
}

function filterListings(listings, options = {}) {
  const { removeAccessories = false, removeDefects = false, removeNoPrice = true, keyword = '', city = '', blockedWords = [] } = options;
  return listings.filter(item => {
    const title = item.title || '';
    const loc = normalize(item.location || '');
    if (removeNoPrice && (item.price === null || item.price <= 0)) return false;
    if (removeDefects && hasDefect(title)) return false;
    if (removeAccessories && isAccessory(title)) return false;
    if (removeAccessories && isPackage(title)) return false;
    if (keyword && !isRelevant(title, keyword)) return false;
    if (city && loc && !loc.includes(normalize(city))) return false;
    if (blockedWords && blockedWords.length > 0) {
      const t = normalize(title);
      if (blockedWords.some(w => w && t.includes(normalize(w)))) return false;
    }
    return true;
  });
}

// ─── Cookies ──────────────────────────────────────────────
function cookiePath(sessionId) {
  return path.join(COOKIES_DIR, `${sessionId}.json`);
}

function saveCookies(sessionId, cookies) {
  // Salva no arquivo local
  try { fs.writeFileSync(cookiePath(sessionId), JSON.stringify(cookies, null, 2)); } catch {}
  // Salva no PostgreSQL para persistir entre deploys
  cookiePool.query(
    `INSERT INTO session_cookies (session_id, cookies, updated_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (session_id) DO UPDATE SET cookies = $2, updated_at = $3`,
    [sessionId, JSON.stringify(cookies), Date.now()]
  ).catch(err => console.warn('[Cookies] Erro ao salvar no DB:', err.message));
}

function loadCookies(sessionId) {
  // Tenta arquivo local primeiro (síncrono)
  const p = cookiePath(sessionId);
  if (fs.existsSync(p)) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
  }
  return null;
}

async function loadCookiesFromDB(sessionId) {
  // Carrega do PostgreSQL (para uso após redeploy)
  try {
    const result = await cookiePool.query('SELECT cookies FROM session_cookies WHERE session_id = $1', [sessionId]);
    if (result.rows.length > 0) {
      const cookies = JSON.parse(result.rows[0].cookies);
      // Salva localmente para próximas chamadas síncronas
      try { fs.writeFileSync(cookiePath(sessionId), JSON.stringify(cookies, null, 2)); } catch {}
      return cookies;
    }
  } catch (err) {
    console.warn('[Cookies] Erro ao carregar do DB:', err.message);
  }
  return null;
}

function hasSavedCookies(sessionId) {
  const cookies = loadCookies(sessionId);
  if (!cookies) return false;
  return cookies.some(c => c.name === 'c_user');
}

async function hasSavedCookiesAsync(sessionId) {
  // Verifica arquivo local primeiro
  if (hasSavedCookies(sessionId)) return true;
  // Busca no PostgreSQL
  const cookies = await loadCookiesFromDB(sessionId);
  if (!cookies) return false;
  return cookies.some(c => c.name === 'c_user');
}

// ─── Chrome ───────────────────────────────────────────────
function findChromePath() {
  const candidates = [
    // Variável de ambiente tem prioridade máxima
    process.env.PUPPETEER_EXECUTABLE_PATH,
    // Caminhos do Nix (Railway)
    '/root/.nix-profile/bin/chromium',
    '/run/current-system/sw/bin/chromium',
    // Caminhos padrão Linux
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    // Cache do Puppeteer
    path.join(os.homedir(), '.cache', 'puppeteer', 'chrome', 'linux-131.0.6778.204', 'chrome-linux64', 'chrome'),
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      console.log('[Browser] Chrome encontrado em:', c);
      return c;
    }
  }
  console.warn('[Browser] Chrome não encontrado nos candidatos — Puppeteer vai tentar o padrão');
  return undefined;
}

// ─── Proxy residencial Brasil (proxy-seller.com) via proxy-chain ──
const ProxyChain = require('proxy-chain');

// Proxy-seller residencial BR (país BR configurado no painel do proxy-seller)
const PROXY_USER = '9418de876b2eeb75';
const PROXY_PASS = 'L7cyB6AnifHUxKeZ';
const PROXY_HOST = 'res.proxy-seller.com';
const PROXY_PORT = 10000;

function getNextProxyUrl() {
  return `http://${PROXY_USER}:${PROXY_PASS}@${PROXY_HOST}:${PROXY_PORT}`;
}

// proxy-chain anonimiza o proxy — cria um tunnel local sem auth
// que o Chromium aceita sem ERR_NO_SUPPORTED_PROXIES
async function launchBrowser(proxyUrl = null) {
  const executablePath = findChromePath();
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--single-process',
    '--no-zygote',
    '--disable-blink-features=AutomationControlled',
    '--ignore-certificate-errors',         // Bright Data usa cert próprio
    '--ignore-ssl-errors',
    '--allow-insecure-localhost',
  ];

  let anonProxyUrl = null;
  if (proxyUrl) {
    try {
      anonProxyUrl = await ProxyChain.anonymizeProxy(proxyUrl);
      args.push(`--proxy-server=${anonProxyUrl}`);
      console.log('[Proxy] Tunnel anônimo criado:', anonProxyUrl);
    } catch (e) {
      console.warn('[Proxy] Falha ao criar tunnel anônimo:', e.message);
    }
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    defaultViewport: { width: 1280, height: 900 },
    executablePath,
    args,
    ignoreDefaultArgs: ['--enable-automation'],
  });

  // Associa o proxy anônimo ao browser para fechar depois
  if (anonProxyUrl) browser._anonProxyUrl = anonProxyUrl;
  return browser;
}

// ─── Pool de contas compartilhadas ────────────────────────────
// Contas configuradas via variáveis de ambiente:
// FB_ACCOUNT_1=email:senha
// FB_ACCOUNT_2=email:senha
// ... até FB_ACCOUNT_9
// Fallback: FB_EMAIL + FB_PASSWORD (conta única)

const SHARED_SESSION_ID = 'shared-pool-account';

function getPoolAccounts() {
  const accounts = [];
  // Tenta FB_ACCOUNT_1 até FB_ACCOUNT_9
  for (let i = 1; i <= 9; i++) {
    const val = process.env[`FB_ACCOUNT_${i}`];
    if (val && val.includes(':')) {
      const idx = val.indexOf(':');
      accounts.push({
        email: val.slice(0, idx),
        password: val.slice(idx + 1),
        sessionId: `pool-account-${i}`,
      });
    }
  }
  // Fallback: FB_EMAIL + FB_PASSWORD
  if (accounts.length === 0 && process.env.FB_EMAIL && process.env.FB_PASSWORD) {
    accounts.push({
      email: process.env.FB_EMAIL,
      password: process.env.FB_PASSWORD,
      sessionId: 'shared-pool-account',
    });
  }
  return accounts;
}

// Retorna o sessionId de uma conta ativa do pool (rotação round-robin)
let _poolIndex = 0;
async function ensureSharedSession() {
  const accounts = getPoolAccounts();
  if (accounts.length === 0) {
    console.warn('[Pool] Nenhuma conta configurada — sem sessão compartilhada');
    return null;
  }

  // Tenta cada conta em ordem rotativa
  for (let attempt = 0; attempt < accounts.length; attempt++) {
    const idx = (_poolIndex + attempt) % accounts.length;
    const account = accounts[idx];
    const { email, password, sessionId } = account;

    // Verifica cookies existentes
    if (hasSavedCookies(sessionId)) {
      console.log(`[Pool] Conta ${idx + 1} ativa (arquivo): ${email}`);
      _poolIndex = (idx + 1) % accounts.length;
      return sessionId;
    }
    const dbCookies = await loadCookiesFromDB(sessionId);
    if (dbCookies && dbCookies.some(c => c.name === 'c_user')) {
      console.log(`[Pool] Conta ${idx + 1} ativa (banco): ${email}`);
      _poolIndex = (idx + 1) % accounts.length;
      return sessionId;
    }

    // Sem cookies — tenta login automático
    console.log(`[Pool] Fazendo login automático conta ${idx + 1}: ${email}`);
    const result = await loginWithCredentials(sessionId, email, password);
    if (result.ok && result.status === 'logged_in') {
      console.log(`[Pool] Login bem-sucedido conta ${idx + 1}: ${email}`);
      _poolIndex = (idx + 1) % accounts.length;
      return sessionId;
    }
    console.warn(`[Pool] Conta ${idx + 1} falhou (${result.status}) — tentando próxima`);
    // Salva alerta se foi 2FA
    if (result.status === 'needs_2fa' || result.status === 'blocked') {
      try {
        const { Pool: PgPool } = require('pg');
        const pg = new PgPool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
        await pg.query(`CREATE TABLE IF NOT EXISTS pool_alerts (id SERIAL PRIMARY KEY, email TEXT, status TEXT, created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000)`);
        await pg.query(`INSERT INTO pool_alerts (email, status) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [email, result.status]);
        await pg.end();
      } catch {}
    }
  }

  console.warn('[Pool] Todas as contas falharam — sem sessão compartilhada');
  return null;
}

// ─── Login ────────────────────────────────────────────────

// Sessões aguardando 2FA: { sessionId: { browser, page } }
const pendingTwoFactor = {};

async function openLoginWindow(sessionId) {
  return { ok: true, loginUrl: 'https://www.facebook.com/login' };
}

// Login com email e senha do Facebook via Puppeteer headless + proxy residencial
async function loginWithCredentials(sessionId, email, password) {
  if (hasSavedCookies(sessionId)) {
    return { ok: true, status: 'already_logged' };
  }

  // Sem fallback direto — garante que o login sempre usa proxy BR
  const proxyUrl = getNextProxyUrl();
  console.log('[Login] Tentando via proxy-seller BR...');
  const result = await tryLoginWithProxy(sessionId, email, password, proxyUrl);
  if (result.ok || result.status === 'needs_2fa') return result;
  console.log('[Login] Proxy falhou:', result.error);
  return { ok: false, status: 'error', error: 'Falha no proxy BR. Tente novamente em alguns segundos.' };
}

async function tryLoginWithProxy(sessionId, email, password, proxyUrl) {
  const browser = await launchBrowser(proxyUrl);
  const page = await browser.newPage();

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  // Proxy auth já nas credenciais do --proxy-server

  try {
    await page.goto('https://www.facebook.com/login', { waitUntil: 'domcontentloaded', timeout: 40000 });

    // Aguarda a página de login carregar completamente
    await page.waitForFunction(
      () => {
        const input = document.querySelector(
          '#email, input[name="email"], input[type="email"], input[name="phone"], input[type="tel"], input[type="text"]'
        );
        if (!input) return false;
        const rect = input.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      },
      { timeout: 30000 }
    );

    // Digita usando clipboard injection — mais confiável para senhas com caracteres especiais (@, #, etc)
    const emailSel = await page.$('#email, input[name="email"], input[type="email"], input[name="phone"], input[type="tel"]').catch(() => null);
    if (!emailSel) throw new Error('Campo de email/telefone não encontrado.');

    await emailSel.click({ clickCount: 3 });
    // Usa keyboard.type na página diretamente — preserva caracteres especiais
    await page.keyboard.type(email, { delay: 60 });
    await delay(300);

    const passSel = await page.$('#pass, input[name="pass"], input[type="password"]').catch(() => null);
    if (!passSel) throw new Error('Campo de senha não encontrado.');

    await passSel.click({ clickCount: 3 });
    await page.keyboard.type(password, { delay: 80 });
    await delay(300);

    // Pressiona Enter para submeter
    await passSel.press('Enter');

    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);

    const url = page.url();
    const cookies = await page.cookies();
    const hasSession = cookies.some(c => c.name === 'c_user');

    if (hasSession) {
      saveCookies(sessionId, cookies);
      if (browser._anonProxyUrl) await ProxyChain.closeAnonymizedProxy(browser._anonProxyUrl, true).catch(() => {});
      await browser.close();
      console.log('[Login] Sucesso para sessão', sessionId.slice(0, 8));
      return { ok: true, status: 'logged_in' };
    }

    // Detecta bloqueio real (sem código — Facebook pedindo identidade/foto/doc)
    const isHardBlock =
      url.includes('/checkpoint') && (
        url.includes('?next') === false ||
        await page.evaluate(() => {
          const txt = document.body.innerText || '';
          return (
            txt.includes('identidade') ||
            txt.includes('identity') ||
            txt.includes('documento') ||
            txt.includes('foto') ||
            txt.includes('selfie') ||
            txt.includes('bloqueada') ||
            txt.includes('suspended') ||
            txt.includes('disabled') ||
            txt.includes('desativada') ||
            txt.includes('não conseguimos') ||
            txt.includes('unusual activity') ||
            txt.includes('atividade incomum')
          );
        }).catch(() => false)
      );

    if (isHardBlock) {
      if (browser._anonProxyUrl) await ProxyChain.closeAnonymizedProxy(browser._anonProxyUrl, true).catch(() => {});
      await browser.close();
      console.log('[Login] Conta bloqueada pelo Facebook:', sessionId.slice(0, 8));
      return { ok: false, status: 'blocked', error: 'O Facebook bloqueou o acesso a esta conta. Isso acontece quando a conta detecta um login de local desconhecido. Acesse o facebook.com normalmente pelo seu celular, confirme sua identidade lá e tente novamente aqui.' };
    }

    // Verifica se precisa de 2FA com código (código foi enviado por email/SMS)
    const needs2FA =
      url.includes('/two_step_verification') ||
      url.includes('/login/device-based') ||
      url.includes('approvals') ||
      (url.includes('/checkpoint') && !isHardBlock) ||
      await page.$('input[name="approvals_code"]').catch(() => null) ||
      await page.$('#approvals_code').catch(() => null) ||
      await page.$('input[autocomplete="one-time-code"]').catch(() => null);

    if (needs2FA) {
      pendingTwoFactor[sessionId] = { browser, page };
      console.log('[Login] 2FA necessário para sessão', sessionId.slice(0, 8));
      return { ok: true, status: 'needs_2fa' };
    }

    // Tenta pegar mensagem de erro do Facebook
    const errorText = await page.evaluate(() => {
      const sel = document.querySelector('[data-testid="royal_login_error"], #error_box, ._9ay7, [role="alert"]');
      return sel ? sel.textContent.trim() : '';
    }).catch(() => '');

    await browser.close();
    return { ok: false, status: 'error', error: errorText || 'Credenciais inválidas. Verifique e tente novamente.' };

  } catch (err) {
    if (browser._anonProxyUrl) await ProxyChain.closeAnonymizedProxy(browser._anonProxyUrl, true).catch(() => {});
    await browser.close().catch(() => null);
    return { ok: false, status: 'error', error: err.message };
  }
}

// Recebe o código 2FA e conclui o login
async function submitTwoFactor(sessionId, code) {
  const pending = pendingTwoFactor[sessionId];
  if (!pending) return { ok: false, error: 'Sessão expirada. Reinicie o login.' };

  const { browser, page } = pending;

  try {
    // Tenta encontrar o campo de código
    const codeInput = await page.$(
      'input[name="approvals_code"], #approvals_code, input[autocomplete="one-time-code"], input[type="text"]'
    ).catch(() => null);

    if (!codeInput) {
      await browser.close();
      delete pendingTwoFactor[sessionId];
      return { ok: false, error: 'Campo de código não encontrado. Tente novamente.' };
    }

    await codeInput.click({ clickCount: 3 });
    await codeInput.type(code, { delay: 80 });

    // Clica no botão de confirmar
    const submitBtn = await page.$(
      '[name="submit[Continue]"], [name="submit[This was me]"], button[type="submit"], input[type="submit"]'
    ).catch(() => null);
    if (submitBtn) await submitBtn.click();

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null);

    // Navega por checkpoints adicionais (ex: "Não reconheço este dispositivo")
    for (let i = 0; i < 4; i++) {
      const continueBtn = await page.$('[name="submit[Continue]"], [name="submit[This was me]"]').catch(() => null);
      if (!continueBtn) break;
      await continueBtn.click();
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }).catch(() => null);
    }

    const cookies = await page.cookies();
    const hasSession = cookies.some(c => c.name === 'c_user');

    if (hasSession) {
      saveCookies(sessionId, cookies);
      await browser.close();
      delete pendingTwoFactor[sessionId];
      console.log('[2FA] Login concluído para sessão', sessionId.slice(0, 8));
      return { ok: true, status: 'logged_in' };
    }

    await browser.close();
    delete pendingTwoFactor[sessionId];
    return { ok: false, error: 'Código inválido ou verificação adicional necessária.' };

  } catch (err) {
    await browser.close().catch(() => null);
    delete pendingTwoFactor[sessionId];
    return { ok: false, error: err.message };
  }
}

async function checkLogin(sessionId) {
  if (hasSavedCookies(sessionId)) return { loggedIn: true, fromCookies: true };
  return { loggedIn: false };
}

// ─── Scraping ─────────────────────────────────────────────

async function scrapeMarketplaceAttempt(sessionId, keyword, location, maxItems = 40, options = {}, onBatch = null) {
  // Usa sessão compartilhada se disponível, senão usa a do próprio usuário
  const sharedSessionId = await ensureSharedSession();
  const effectiveSessionId = sharedSessionId || sessionId;

  if (sharedSessionId) {
    console.log(`[Scraper] Usando sessão compartilhada para busca: "${keyword}"`);
  } else {
    console.log(`[Scraper] Sessão compartilhada indisponível — usando sessão do usuário`);
  }

  let cookies = loadCookies(effectiveSessionId);
  if (!cookies) {
    cookies = await loadCookiesFromDB(effectiveSessionId);
  }
  console.log(`[Scraper] Iniciando busca${cookies ? ` (${cookies.length} cookies)` : ' (sem cookies)'}: "${keyword}"`);

  // Scraping com proxy BR para garantir resultados do Facebook
  const browser = await launchBrowser(getNextProxyUrl());
  const page = await browser.newPage();

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  // Bloqueia recursos desnecessários para economizar banda
  await page.setRequestInterception(true);
  page.on('request', req => {
    const type = req.resourceType();
    const url = req.url();
    // Bloqueia vídeos, fontes externas e rastreadores
    if (type === 'media') { req.abort(); return; }
    if (type === 'font' && !url.includes('facebook.com') && !url.includes('fbcdn.net')) { req.abort(); return; }
    if (type === 'other' && (url.includes('google-analytics') || url.includes('doubleclick') || url.includes('googlesyndication') || url.includes('facebook.net/signals'))) { req.abort(); return; }
    // Bloqueia imagens grandes (perfil, banners) mas mantém thumbnails dos anúncios
    if (type === 'image') {
      // Mantém imagens do fbcdn (thumbnails dos anúncios) e bloqueia o resto
      if (!url.includes('fbcdn.net') && !url.includes('facebook.com')) { req.abort(); return; }
      // Bloqueia imagens de alta resolução (scontent com dimensões grandes)
      if (url.includes('_n.jpg') || url.includes('_o.jpg') || url.includes('p720x720') || url.includes('p960x960')) { req.abort(); return; }
    }
    req.continue().catch(() => {});
  });

  await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded' });
  if (cookies && cookies.length > 0) {
    await page.setCookie(...cookies);
  }

  const testCookies = await page.cookies();
  const hasSession = testCookies.some(c => c.name === 'c_user');
  console.log(`[Scraper] Sessão Facebook ativa: ${hasSession}`);

  const encodedKeyword = encodeURIComponent(keyword);

  const CITY_COORDS = {
    'sao paulo':[-23.5505,-46.6333],'rio de janeiro':[-22.9068,-43.1729],
    'belo horizonte':[-19.9167,-43.9345],'salvador':[-12.9714,-38.5014],
    'fortaleza':[-3.7172,-38.5433],'curitiba':[-25.4284,-49.2733],
    'manaus':[-3.1190,-60.0217],'recife':[-8.0476,-34.8770],
    'porto alegre':[-30.0346,-51.2177],'belem':[-1.4558,-48.5044],
    'goiania':[-16.6869,-49.2648],'guarulhos':[-23.4543,-46.5333],
    'campinas':[-22.9056,-47.0608],'sao luis':[-2.5297,-44.3028],
    'maceio':[-9.6658,-35.7350],'natal':[-5.7945,-35.2110],
    'teresina':[-5.0892,-42.8019],'campo grande':[-20.4428,-54.6460],
    'joao pessoa':[-7.1195,-34.8450],'osasco':[-23.5329,-46.7916],
    'santo andre':[-23.6639,-46.5383],'sao bernardo do campo':[-23.6939,-46.5650],
    'ribeirao preto':[-21.1704,-47.8103],'uberlandia':[-18.9186,-48.2772],
    'sorocaba':[-23.5015,-47.4526],'contagem':[-19.9317,-44.0536],
    'aracaju':[-10.9167,-37.0500],'feira de santana':[-12.2664,-38.9663],
    'cuiaba':[-15.5961,-56.0970],'joinville':[-26.3045,-48.8487],
    'florianopolis':[-27.5954,-48.5480],'londrina':[-23.3045,-51.1696],
    'juiz de fora':[-21.7642,-43.3503],'niteroi':[-22.8833,-43.1036],
    'porto velho':[-8.7612,-63.9004],'serra':[-20.1286,-40.3097],
    'caxias do sul':[-29.1678,-51.1794],'macapa':[0.0349,-51.0694],
    'duque de caxias':[-22.7856,-43.3117],'nova iguacu':[-22.7592,-43.4511],
    'sao joao de meriti':[-22.8011,-43.3706],'sao goncalo':[-22.8269,-43.0539],
    'marica':[-22.9194,-42.8186],'petropolis':[-22.5050,-43.1786],
    'volta redonda':[-22.5231,-44.1036],'cabo frio':[-22.8786,-42.0189],
    'santos':[-23.9608,-46.3336],'taubate':[-23.0267,-45.5553],
    'praia grande':[-24.0056,-46.4028],'bauru':[-22.3147,-49.0619],
    'marilia':[-22.2136,-49.9456],'americana':[-22.7375,-47.3319],
    'limeira':[-22.5639,-47.4017],'piracicaba':[-22.7253,-47.6492],
    'jundiai':[-23.1864,-46.8964],'sao jose dos campos':[-23.1794,-45.8869],
    'franca':[-20.5386,-47.4008],'guaruja':[-23.9928,-46.2564],
    'itaborai':[-22.7122,-42.8594],'mage':[-22.6550,-43.0403],
    'belford roxo':[-22.7642,-43.3967],'mesquita':[-22.7814,-43.4375],
    'queimados':[-22.7172,-43.5572],'teresopolis':[-22.4122,-42.9781],
    'araruama':[-22.8722,-42.3442],'resende':[-22.4681,-44.4508],
    'saquarema':[-22.9203,-42.5100],'angra dos reis':[-23.0067,-44.3183],
    'nova friburgo':[-22.2817,-42.5319],'campos dos goytacazes':[-21.7542,-41.3244],
    'macae':[-22.3711,-41.7869],'barra mansa':[-22.5442,-44.1717],
    'itaguai':[-22.8594,-43.7769],'palhoca':[-27.6447,-48.6697],
    'sao jose':[-27.5953,-48.6349],
  };

  const CITY_SLUGS = {
    'sao paulo':'saopaulo','rio de janeiro':'rio-de-janeiro','belo horizonte':'belo-horizonte',
    'salvador':'salvador','fortaleza':'fortaleza','curitiba':'curitiba','manaus':'manaus',
    'recife':'recife','porto alegre':'porto-alegre','belem':'belem','goiania':'goiania',
    'guarulhos':'guarulhos','campinas':'campinas','sao luis':'sao-luis','maceio':'maceio',
    'natal':'natal','teresina':'teresina','campo grande':'campo-grande',
    'joao pessoa':'joao-pessoa','osasco':'osasco','santo andre':'santo-andre',
    'sao bernardo do campo':'sao-bernardo-do-campo','ribeirao preto':'ribeirao-preto',
    'uberlandia':'uberlandia','sorocaba':'sorocaba','contagem':'contagem','aracaju':'aracaju',
    'feira de santana':'feira-de-santana','cuiaba':'cuiaba','joinville':'joinville',
    'florianopolis':'florianopolis','londrina':'londrina','juiz de fora':'juiz-de-fora',
    'niteroi':'niteroi','porto velho':'porto-velho','serra':'serra',
    'caxias do sul':'caxias-do-sul','macapa':'macapa','mogi das cruzes':'mogi-das-cruzes',
    'duque de caxias':'duquedecaxias','nova iguacu':'novaiguacu',
    'sao joao de meriti':'113653795311814','sao goncalo':'saogoncalo',
    'marica':'1034155596989724','petropolis':'109764205717440','volta redonda':'103110489728817',
    'cabo frio':'105619249471656','santos':'107844482581802','taubate':'108032269225848',
    'praia grande':'841455575937924','bauru':'109494869076117','marilia':'112693518746096',
    'americana':'110272192335221','limeira':'102199689822308','piracicaba':'105811186126463',
    'jundiai':'108154842546372','indaiatuba':'110591845628367','sao jose dos campos':'sao-jose-dos-campos',
    'franca':'114275645256058','guaruja':'115251048487079','suzano':'112107065473546',
    'niteroi':'111957382157401','mage':'103773956327575','nilopolis':'104019982966421',
    'itaborai':'106183312746333','teresopolis':'110552232306432','nova friburgo':'104036572965161',
    'barra mansa':'112392472105889','resende':'108365852531562','angra dos reis':'108220479211345',
    'campos dos goytacazes':'105581756141190','macae':'107694759253918',
    'araruama':'108028815884164','saquarema':'107362312627011','belford roxo':'104010079634163',
    'mogi das cruzes':'103427389698118','blumenau':'106081109431806','chapeco':'113399188670230',
    'itajai':'107825789240416','criciuma':'113418455335427','caxias do sul':'111708808846317',
    'pelotas':'111195672237858','santa maria':'113399188670230','canoas':'104074329627892',
    'novo hamburgo':'109764205717440','sao leopoldo':'109830025710831','passo fundo':'103165613056684',
    'contagem':'113109768703358','juiz de fora':'104091379628476','betim':'108393699180845',
    'montes claros':'103996099635518','governador valadares':'104058689631639',
    'ipatinga':'108365445854706','sete lagoas':'106278162735914','divinopolis':'108722999152877',
    'vitoria da conquista':'106102156088345','camacari':'109177215766743',
    'itabuna':'107665125929392','ilheus':'108238589197693','lauro de freitas':'178844495462261',
    'caruaru':'105521749481580','olinda':'106352142733188','paulista':'103106599729513',
    'jaboatao dos guararapes':'108089349211829','caucaia':'109524805739434',
    'maracanau':'106548656045346','juazeiro do norte':'112565985421900',
    'sobral':'108076769226284','mossoro':'106099089421918','imperatriz':'112332045445595',
    'timon':'111974835495167','ananindeua':'103108599729643','santarem':'105991899431377',
    'maraba':'110294718996521','castanhal':'112333922112988',
    'aparecida de goiania':'135851093139473','anapolis':'105995526097735',
    'rio verde':'105493786150505','rondonopolis':'114485828563373',
    'varzea grande':'109663205727561','sinop':'163857153653920',
    'vitoria':'102864356451860','vila velha':'104064876297545','cariacica':'103075926400033',
    'cachoeiro de itapemirim':'114301671919784','arapiraca':'105600829474777',
    'campina grande':'103137026393957','serra':'103108113062617',
    'rio de janeiro — centro':'rio-de-janeiro',
    'rio de janeiro — zona sul (copacabana, ipanema)':'copacabana',
    'rio de janeiro — barra da tijuca':'barra-da-tijuca',
    'rio de janeiro — zona norte (tijuca, vila isabel)':'tijuca-rio-de-janeiro',
    'rio de janeiro — campo grande':'campo-grande-rio-de-janeiro',
    'rio de janeiro — recreio dos bandeirantes':'recreio-dos-bandeirantes',
    'rio de janeiro — jacarepagua':'jacarepagua',
    'rio de janeiro — santa cruz':'santa-cruz-rio-de-janeiro',
    'rio de janeiro — bangu':'bangu',
    'rio de janeiro — realengo':'realengo',
    'rio de janeiro — madureira':'madureira-rio-de-janeiro',
    'rio de janeiro — penha':'penha-rio-de-janeiro',
    'rio de janeiro — meier':'meier',
    'rio de janeiro — ilha do governador':'ilha-do-governador',
    'itaguai':'itaguai','seropedica':'seropedica','japeri':'japeri',
    'guapimirim':'guapimirim','tangua':'tangua','rio bonito':'rio-bonito',
    'sao paulo — centro':'sao-paulo','sao paulo — zona sul':'sao-paulo',
    'sao paulo — zona norte':'sao-paulo','sao paulo — zona leste':'sao-paulo',
    'sao paulo — zona oeste':'sao-paulo','sao paulo — pinheiros':'pinheiros-sao-paulo',
    'sao paulo — vila mariana':'vila-mariana-sao-paulo','sao paulo — santana':'santana-sao-paulo',
    'sao paulo — santo andre':'santo-andre','sao paulo — mooca':'mooca-sao-paulo',
    'sao paulo — tatuape':'tatuape','sao paulo — itaquera':'itaquera',
    'sao paulo — campo limpo':'campo-limpo-sao-paulo','sao paulo — lapa':'lapa-sao-paulo',
    'sao paulo — penha':'penha-sao-paulo',
    'salvador — barra':'barra-salvador','salvador — itapua':'itapua-salvador',
    'salvador — pituba':'pituba','salvador — boca do rio':'boca-do-rio',
    'salvador — cajazeiras':'cajazeiras-salvador','salvador — liberdade':'liberdade-salvador',
    'salvador — brotas':'brotas-salvador',
    'fortaleza — aldeota':'aldeota','fortaleza — meireles':'meireles',
    'fortaleza — benfica':'benfica-fortaleza','fortaleza — messejana':'messejana',
    'fortaleza — barra do ceara':'barra-do-ceara','fortaleza — parangaba':'parangaba',
    'brasilia — asa norte':'asa-norte','brasilia — asa sul':'asa-sul',
    'brasilia — lago norte':'lago-norte','brasilia — lago sul':'lago-sul',
    'belo horizonte — savassi':'savassi','belo horizonte — lourdes':'lourdes-belo-horizonte',
    'belo horizonte — pampulha':'pampulha','belo horizonte — barreiro':'barreiro-belo-horizonte',
    'belo horizonte — venda nova':'venda-nova','belo horizonte — norte':'belo-horizonte',
    'recife — boa viagem':'boa-viagem','recife — casa forte':'casa-forte',
    'recife — afogados':'afogados','recife — imbiribeira':'imbiribeira',
    'curitiba — batel':'batel','curitiba — agua verde':'agua-verde-curitiba',
    'curitiba — boa vista':'boa-vista-curitiba','curitiba — cic':'cidade-industrial-curitiba',
    'curitiba — portao':'portao-curitiba','curitiba — cajuru':'cajuru-curitiba',
    'porto alegre — moinhos de vento':'moinhos-de-vento',
    'porto alegre — bela vista':'bela-vista-porto-alegre',
    'porto alegre — zona norte':'porto-alegre','porto alegre — zona sul':'porto-alegre',
    'florianopolis — centro':'florianopolis','florianopolis — norte da ilha':'norte-da-ilha-florianopolis',
    'florianopolis — sul da ilha':'sul-da-ilha-florianopolis',
    'manaus — centro':'manaus','manaus — zona sul':'manaus','manaus — zona norte':'manaus',
    'manaus — zona leste':'manaus','manaus — zona oeste':'manaus',
    'sao luis — centro':'sao-luis','goiania — setor bueno':'setor-bueno',
    'goiania — setor oeste':'setor-oeste-goiania','goiania — jardim goias':'jardim-goias',
    'goiania — campinas':'campinas-goiania',
    'vitoria — centro':'vitoria','vitoria — praia do canto':'praia-do-canto',
    'vitoria — jardim da penha':'jardim-da-penha',
    'vila velha — itapua':'itapua-vila-velha','vila velha — praia da costa':'praia-da-costa',
    'joao pessoa — tambau':'tambau','campo grande — centro':'campo-grande',
    'cuiaba — centro':'cuiaba',
    'belem — nazare':'nazare-belem','belem — umarizal':'umarizal',
    'belem — marco':'marco-belem','belem — pedreira':'pedreira-belem',
    'paty do alferes':'175812682443534',
    'miguel pereira':'108232345864033',
    'mendes':'108313579189484',
    'piraí':'107618299267639',
    'araçatuba':'103121836395318',
    'jaú':'108387972514980',
    'fernandopolis':'109493952401635',
    'votuporanga':'104040092965853',
    'dracena':'112336908778693',
    'tupã':'105558712810089',
    'birigui':'111808582172409',
    'penapolis':'107959479224270',
    'lins':'111748935511493',
    'pirassununga':'109308775762582',
    'rio claro':'108105659222437',
    'araraquara':'108259652527599',
    'sao carlos':'112077055478039',
    'jaboticabal':'107977462563610',
    'mirassol':'111283858895818',
    'tanabi':'110150832341665',
    'olimpia':'116817128328386',
    'sertaozinho':'104755609563629',
    'pontal':'105604599474296',
    'brodowski':'115372511810763',
    'cravinhos':'107958925898529',
    'mogi guacu':'177692522248459',
    'amparo':'113310682017264',
    'lindoia':'104216712947605',
    'pedreira':'109375992422632',
    'bragança paulista':'107830759246440',
    'atibaia':'111108838914089',
    'itatiba':'104136262955890',
    'valinhos':'111713975512458',
    'vinhedo':'105614539471753',
    'louveira':'105981376099075',
    'campo limpo paulista':'175848982426792',
    'jarinu':'103770316328472',
    'morungaba':'113642911983957',
    'tietê':'109659935727217',
    'capivari':'108130222547762',
    'rafard':'112776698736628',
    'mombuca':'103115166395453',
    'sao manuel':'112168952129139',
    'itapetininga':'112323638779218',
    'tatuí':'112866355394783',
    'cerquilho':'108161639204701',
    'laranjal paulista':'104035012966841',
    'registro':'104038469633699',
    'iguape':'104064876297545',
    'cananeia':'104097596294329',
    'ilha comprida':'1127876040572116',
    'miracatu':'104095792961148',
    'peruibe':'112019012147264',
    'mongagua':'106456742725072',
    'bertioga':'115121888503532',
    'cubatao':'111750952175364',
    'pocos de caldas':'108182879201893',
    'varginha':'115800968430393',
    'uberaba':'111939948825320',
    'patos de minas':'104159176287701',
    'ituiutaba':'103743419664068',
    'araguari':'108653189159915',
    'araxa':'112506905430043',
    'frutal':'112942778716868',
    'iturama':'104926502876159',
    'unai':'105708079462521',
    'paracatu':'114752231870318',
    'joao monlevade':'110481818978767',
    'coronel fabriciano':'106065959425485',
    'timoteo':'112786675401879',
    'caratinga':'105995526097735',
    'muriae':'107793705916959',
    'leopoldina':'104121269623246',
    'cataguases':'111501098867508',
    'uba':'106278306076939',
    'vicosa':'108506229173580',
    'barbacena':'108119922549873',
    'sao joao del rei':'112577395421470',
    'congonhas':'108527505838840',
    'conselheiro lafaiete':'106111339419954',
    'ouro preto':'114456011899884',
    'mariana':'109671235725766',
    'itabirito':'111931355497405',
    'nova lima':'115602175121479',
    'ribeirao das neves':'112639612080640',
    'vespasiano':'102819016421238',
    'lagoa santa':'108370799188255',
    'pedro leopoldo':'104090482959785',
    'matozinhos':'105558042811425',
    'esmeraldas':'105698479463894',
    'brumadinho':'107898525904985',
    'ibirite':'112856812058682',
    'sarzedo':'105610852806528',
    'gravataí':'109289649089579',
    'viamao':'103784476326467',
    'erechim':'109571869069371',
    'santa cruz do sul':'111951238821548',
    'lajeado':'107397062629205',
    'estrela':'111973172161046',
    'teutonia':'485432571612614',
    'carazinho':'107018325995260',
    'ijui':'112745438740490',
    'tres passos':'107931262568942',
    'santa rosa':'105811186126463',
    'alegrete':'106530792714438',
    'santana do livramento':'106454862723033',
    'bag':'110579472303567',
    'dom pedrito':'106061392757550',
    'bage':'110579472303567',
    'camaqua':'109438402408740',
    'rio grande':'113412225339351',
    'sao jose do norte':'104083952960573',
    'sao jose':'109342319085733',
    'palhoca':'104099219626468',
    'biguacu':'103127443060754',
    'tijucas':'112292485450576',
    'balneario camboriu':'108416972513126',
    'itapema':'101884336520624',
    'porto belo':'112195532130087',
    'bombinhas':'109303769088586',
    'navegantes':'112414045436402',
    'camboriu':'108416972513126',
    'brusque':'109458192405408',
    'gaspar':'109389479079850',
    'ilhota':'109352732416249',
    'luiz alves':'109289499089349',
    'lages':'105590669475875',
    'sao joaquim':'108344259193049',
    'curitibanos':'113226902024196',
    'campos novos':'108339329190739',
    'videira':'108085732553038',
    'caçador':'108580659166601',
    'fraiburgo':'132759726777713',
    'timbo':'184128774934281',
    'apiuna':'106250592740089',
    'aurora':'185090504838850',
    'tubarao':'108212005867000',
    'laguna':'109614629057602',
    'imbituba':'112601968751141',
    'araranguá':'111941265488819',
    'ponta grossa':'106275636069985',
    'cascavel':'1595221914094128',
    'foz do iguacu':'107845332577217',
    'sao jose dos pinhais':'113048332042619',
    'colombo':'108110605890492',
    'guarapuava':'111775985505817',
    'paranagua':'111101128914166',
    'araucaria':'108050219216728',
    'fazenda rio grande':'174365399260367',
    'almirante tamandare':'108030519218760',
    'pinhais':'109743579045077',
    'campo largo':'103794712992471',
    'balsa nova':'109570505735843',
    'contenda':'112394712109103',
    'toledo':'798908626873690',
    'umuarama':'108424242515911',
    'campo mourao':'111722322185417',
    'apucarana':'107664652596260',
    'arapongas':'106505452716653',
    'cornelio procopio':'108449725845788',
    'bandeirantes':'103121836395318',
    'ivaipora':'108190595868839',
    'pitanga':'107151975982677',
    'guaraniacu':'104096126293753',
    'goioere':'171405649554447',
    'jequie':'109522185733552',
    'alagoinhas':'105575622808651',
    'porto seguro':'103114646394765',
    'luis eduardo magalhaes':'170562112963167',
    'irece':'108089349211829',
    'jacobina':'106142619417143',
    'santo antonio de jesus':'116192215057877',
    'cruz das almas':'109216022439773',
    'cachoeira':'104693599569469',
    'maragogipe':'108328065862111',
    'simoes filho':'125354274193275',
    'candeias':'106102156088345',
    'madre de deus':'108336839190035',
    'pojuca':'112418538770933',
    'cabo de santo agostinho':'150108461701384',
    'camaragibe':'112970645384637',
    'garanhuns':'106036499436414',
    'petrolina':'112503348760834',
    'santa cruz do capibaribe':'113197418696506',
    'caetes':'112249115454035',
    'belo jardim':'113388775341291',
    'arcoverde':'104941129541687',
    'pesqueira':'109491432415350',
    'bezerros':'103116713062530',
    'timbauba':'109045975790967',
    'limoeiro':'103811112990589',
    'vertentes':'113520751998486',
    'surubim':'111736142176345',
    'toritama':'113249585357064',
    'crato':'114964508518222',
    'itapipoca':'112332045445595',
    'maranguape':'108072382554499',
    'horizonte':'100308371472701',
    'pacajus':'113062128707004',
    'chorozinho':'109062239115223',
    'iguatu':'105592592808735',
    'quixada':'103132436394293',
    'quixeramobim':'110296678989518',
    'caninde':'103774349661926',
    'tiangua':'112684668744419',
    'camocim':'110349285657536',
    'acarau':'109573962402495',
    'baturite':'106832866014113',
    'guaramiranga':'109210479103791',
    'caico':'107788405910989',
    'mossoró':'106099089421918',
    'apodi':'110525402307152',
    'patu':'112288942116008',
    'pau dos ferros':'105525756146550',
    'grossos':'109340355759479',
    'areia branca':'108195415868706',
    'patos':'100308371472701',
    'sousa':'108268095867696',
    'cajazeiras':'107780699245016',
    'guarabira':'107953015899196',
    'bayeux':'111565675527114',
    'santa rita':'106440186055843',
    'cabedelo':'104077609629100',
    'conde':'113245178687216',
    'alhandra':'112908815392658',
    'uniao dos palmares':'108164789210988',
    'penedo':'111653428852359',
    'delmiro gouveia':'109464792413314',
    'lagarto':'111996378817689',
    'itabaiana':'104366186270185',
    'sao cristovao':'108775482480088',
    'parnaiba':'103135443060083',
    'picos':'109688562382282',
    'floriano':'110495088976395',
    'oeiras':'108660982498721',
    'campo maior':'107065775990932',
    'caxias':'110540862306824',
    'codó':'105370456163715',
    'acailândia':'151651644882964',
    'bacabal':'108460479177820',
    'balsas':'110381898991056',
    'santa ines':'112483182101738',
    'pedreiras':'108905365803996',
    'parauapebas':'168439983195266',
    'altamira':'106052312767580',
    'tucurui':'105412069491557',
    'tailandia':'126031927460575',
    'abaetetuba':'108639015827000',
    'barcarena':'107441045958335',
    'paragominas':'104134016290790',
    'redenção':'111542768912691',
    'moju':'108440489180996',
    'parintins':'105741709460482',
    'itacoatiara':'109573929061931',
    'manacapuru':'109025692448490',
    'coari':'108471949182271',
    'tefé':'112297138787006',
    'tabatinga':'110395772312532',
    'sao gabriel da cachoeira':'106145076083359',
    'palmas':'106042842768775',
    'araguaina':'106227936075145',
    'gurupi':'108144619210745',
    'porto nacional':'106243039406959',
    'paraiso do tocantins':'107597559270020',
    'itumbiara':'108257105863067',
    'caldas novas':'113592861989509',
    'luziania':'106684186032090',
    'formosa':'106419862726874',
    'catalao':'110026382353925',
    'jatai':'105542109478368',
    'mineiros':'112766178736948',
    'senador canedo':'110151399004753',
    'trindade':'135851093139473',
    'goianira':'108417729181341',
    'guapo':'103154179725302',
    'dourados':'105542109478368',
    'tres lagoas':'109087319108959',
    'corumba':'109062165779457',
    'ponta pora':'113145558699312',
    'naviraí':'112875775393654',
    'nova andradina':'178237202189948',
    'sidrolandia':'103725122999187',
    'maracaju':'112630502084744',
    'tangara da serra':'103113736396125',
    'barra do garças':'107005122664265',
    'alta floresta':'180706935288350',
    'juara':'166222813409470',
    'ji parana':'108211119206430',
    'ariquemes':'109390739086333',
    'vilhena':'102184459822836',
    'cacoal':'107463155950244',
    'rolim de moura':'103796956326394',
    'pimenta bueno':'104040512965826',
    'rio branco':'135136389876246',
    'cruzeiro do sul':'135851093139473',
    'sena madureira':'107970455897242',
    'tarauaca':'103749819663523',
    'boa vista':'103798122992844',
    'caracarai':'112208508794620',
    'santana':'110479422305767',
    'laranjal do jari':'172997372730578',
    'colatina':'107463059276374',
    'linhares':'108598895838221',
    'aracruz':'108673089164054',
    'guarapari':'104055882964648',
    'anchieta':'115221851825691',
    'piuma':'103733292998745',
    'iconha':'102182376490104',
    'rio novo do sul':'115179525161253',
    'mococa':'106104142753410',
    'casa branca':'104011469635414',
    'sao joao da boa vista':'103753526330293',
    'aguai':'113454672014107',
    'itapira':'109576155727901',
    'serra negra':'101872923188497',
    'monte alegre do sul':'106166022747219',
    'paulinia':'111819825502048',
    'hortolandia':'108154842546372',
    'sumare':'107754842580338',
    'nova odessa':'109435282408718',
    'santa barbara doeste':'103975796305176',
    'cosmopolis':'113146375362970',
    'artur nogueira':'112127388799373',
    'engenheiro coelho':'124664317594899',
    'holambra':'175386905819117',
    'jaguariuna':'107636162593144',
    'nazare paulista':'107640135931776',
    'aruja':'107549365935070',
    'ferraz de vasconcelos':'109532675739231',
    'itaquaquecetuba':'109375992422632',
    'biritiba mirim':'108220265871951',
    'salesopolis':'110137995682596',
    'santa branca':'114932215185846',
    'jacareí':'107845315905195',
    'caçapava':'104027696300581',
    'pindamonhangaba':'106437592726976',
    'guaratingueta':'106029276104165',
    'aparecida':'107844482581802',
    'lorena':'106495692721738',
    'cachoeira paulista':'107250172638229',
    'cruzeiro':'112507815432287',
    'cunha':'108111422554736',
    'natividade da serra':'112519445430108',
    'cajati':'112872318728090',
    'jacupiranga':'112428638773825',
    'pariquera-açu':'112173305466756',
    'juquia':'108105855884083',
    'ilhabela':'105987792774788',
    'sao sebastiao':'112144808801614',
    'caraguatatuba':'105997396107185',
    'ubatuba':'106278306076939',
    'lagoinha':'1711060312457873',
    'redenção da serra':'106047069436227',
    'tres coracoes':'105570776142585',
    'sao lourenco':'176771425675899',
    'caxambu':'108745212484153',
    'lambari':'109733699053634',
    'cambuquira':'105529066147221',
    'baependi':'103711296334968',
    'alfenas':'108327022521995',
    'machado':'112308685453000',
    'passos':'107673849262128',
    'pouso alegre':'112308682119742',
    'itajuba':'112981122049206',
    'santa rita do sapucai':'108038245883470',
    'sao gabriel':'108110605890492',
    'cachoeira do sul':'108218859200217',
    'teixeira de freitas':'171268569567981',
    'eunapolis':'102835029789326',
    'itamaraju':'112285505449432',
    'sarandi':'106275636069985',
    'paracambi':'109378812414245',
    'vassouras':'108175215877398',
    'tres rios':'108333322524929',
    'barra do pirai':'106114152754104',
    'valenca':'107897182565958',
    'sao jose do rio preto':'108568625834990',
    'presidente prudente':'106292852734722',
    'barretos':'111734538845160',
    'botucatu':'107534225936550',
    'itu':'106273692741859',
    'ourinhos':'105758466125069',
    'avare':'103102633063518',
    'assis':'112745438740490',
    'maringa':'111837995502320',
    'catanduva':'108373062520402',
    'london':'113944221949539',
    'diadema':'110302185664097',
    'maua':'1455037268107518',
    'sao caetano do sul':'112589668756027',
    'ribeirao pires':'106187096080045',
    'rio grande da serra':'105608069473114',
    'itapecerica da serra':'110711885619071',
    'embu das artes':'108079885886012',
    'taboao da serra':'105513359482328',
    'cotia':'108577365840750',
    'carapicuiba':'111252608898753',
    'barueri':'110871752271246',
    'santana de parnaiba':'105669342799485',
    'pirapora do bom jesus':'107879605901865',
    'cajamar':'108493659175047',
    'jandira':'109952079033892',
    'itapevi':'109439075741678',
    'sao roque':'114957941854173',
    'mairinque':'112927148721539',
    'aluminio':'181395448538971',
    'votorantim':'109535222406025',
    'iperó':'115061198506385',
    'boituva':'106124056084705',
    'porto feliz':'113231532026371',
    'cesario lange':'112655675413283',
    'jumirim':'109387919080880',
    'porangaba':'109530762400263',
    'angatuba':'113120215368572',
    'paranapanema':'108121389209263',
    'itapeva':'833073306774865',
    'itararé':'112130985466525',
    'guare':'105754609458473',
    'sao miguel arcanjo':'104336819606794',
    'capao bonito':'113301238683995',
    'ribeirao grande':'1589954824603591',
    'buri':'108272305870148',
    'coronel macedo':'107371715952828',
    'taquarituba':'112770645403832',
    'piraju':'115358968474343',
    'manduri':'106142282750796',
    'santa cruz do rio pardo':'108081092552899',
    'ribeirao do sul':'166776640026184',
    'chavantes':'108560679168955',
    'salto grande':'109283665756643',
    'ipaussu':'115393181807801',
    'canitar':'112259702119671',
    'santa barbara do rio pardo':'184559934893558',
    'vera cruz':'114501028618574',
    'garca':'105566819475728',
    'herculandia':'107568719272927',
    'lucelia':'104037146298010',
    'adamantina':'105515109481522',
    'flórida paulista':'167040989999392',
    'pacaembu':'107786682582606',
    'junqueiropolis':'107859065903233',
    'nova independencia':'108278152527400',
    'brauna':'104935112877786',
    'guararapes':'112246635459433',
    'coroados':'112495265432347',
    'gabriel monteiro':'109148525771093',
    'rubiácea':'103750006330766',
    'valparaíso':'111837995502320',
    'buritama':'105786752789006',
    'aracatuba':'103121836395318',
    'andradina':'108538559169872',
    'ilha solteira':'109377965755699',
    'pereira barreto':'113909861953170',
    'mirandopolis':'109502625735558',
    'santo antonio do aracangua':'140120172710569',
    'jales':'109395135753003',
    'nhandeara':'107953865892494',
    'uchoa':'106317276071055',
    'pindorama':'109252309102011',
    'novo horizonte':'108598895838221',
    'bady bassitt':'101898266518122',
    'cedral':'105999286105636',
    'colina':'111283858895818',
    'guaira':'109187075772010',
    'bebedouro':'108347409185723',
    'guariba':'109627439055355',
    'serrana':'115583291789003',
    'pitangueiras':'110988235592074',
    'paraguacu':'109691279048677',
    'nepomuceno':'109402632412197',
    'boa esperanca':'104010079634163',
    'campos gerais':'105035872864868',
    'ribeirao verde':'108230089204403',
    'guaxupe':'112997455384271',
    'muzambinho':'106140236084938',
    'monte belo':'109101112442126',
    'sao sebastiao do paraiso':'104309316276001',
    'itamogi':'105595602808028',
    'pratapolis':'114404675236767',
    'monte santo de minas':'108466652511420',
    'piumhi':'114644048605196',
    'sao roque de minas':'118604851537957',
    'sao joao batista do gloria':'110664502294022',
    'delfinopolis':'112821548734225',
    'capitolio':'104997209536276',
    'formiga':'113056228707863',
    'itauna':'109067359111656',
    'para de minas':'112015895489659',
    'morada nova de minas':'103767182994702',
    'dores do indaia':'108142349214007',
    'abaeté':'109698649054319',
    'pompeu':'115003208511267',
    'curvelo':'113207378693004',
    'jequitai':'109502625735558',
    'bocaiuva':'113696408640609',
    'pirapora':'107482395948066',
    'buritizeiro':'104978939537127',
    'varzea da palma':'106449606055516',
    'janaubá':'104713776234709',
    'monte azul':'108047572556793',
    'porteirinha':'171403526227801',
    'brasilia de minas':'104159176287701',
    'sao joao da ponte':'105488229485963',
    'lontra':'104077346296445',
    'francisco sa':'108302789191379',
    'riacho dos machados':'107264085971256',
    'serranopolis de minas':'183164458360872',
    'catuti':'176174415745534',
    'sao joao do pacui':'108869345801230',
    'capitao eneas':'114578488612755',
    'claro dos pocoes':'109206862433219',
    'ibiai':'110049725680010',
    'patis':'104304982943797',
    'ibiracatu':'106586489373794',
    'juramento':'113803948634634',
    'sao joao da lagoa':'1601933506748082',
    'guaraciama':'106916819339515',
    'glaucilandia':'109441959081162',
    'mirabela':'114016851945900',
    'coracoes':'105570776142585',
    'engenheiro navarro':'104848162886029',
    'varzelândia':'113078682038386',
    'capao da canoa':'104082919627554',
    'torres':'110745885663977',
    'tramandai':'107759109246539',
    'osorio':'850882721663372',
    'cidreira':'112780878735942',
    'imbé':'1019896734702219',
    'xangri-la':'162612703781452',
    'pinhal':'1625573267700320',
    'tres cachoeiras':'109619072390511',
    'arroio do sal':'115518955183869',
    'morrinhos do sul':'1007786182616014',
    'tres forquilhas':'178193528864988',
    'terra de areia':'109226849095022',
    'maquine':'109352705749350',
    'sao borja':'106077552757884',
    'quarai':'106596722706343',
    'rosario do sul':'111843788833637',
    'cacequi':'105586349476117',
    'lavras do sul':'114623845219396',
    'venancio aires':'104057582962877',
    'candelaria':'113741725306347',
    'sobradinho':'107093159322452',
    'espumoso':'103739339665167',
    'soledade':'109740585719212',
    'guapore':'103154179725302',
    'serafina correa':'170554126318491',
    'nova prata':'104092139628634',
    'veranopolis':'113000662048722',
    'bento goncalves':'112279715454580',
    'garibaldi':'108310299196255',
    'carlos barbosa':'108310299196255',
    'farroupilha':'106139216084879',
    'antonio prado':'108729739150967',
    'vacaria':'107717182584166',
    'lagoa vermelha':'115603241784140',
    'getulió vargas':'112745438740490',
    'sao valentim':'108470975844215',
    'tres de maio':'113380275344362',
    'horizontina':'105728376127702',
    'palmeira das missoes':'104930239542090',
    'concordia':'108392519191421',
    'sao miguel do oeste':'113144925366536',
    'xanxere':'113097498701173',
    'xaxim':'112432962105739',
    'coronel freitas':'108330452521779',
    'pinhalzinho':'108251399203098',
    'sao lourenco do oeste':'112675348745731',
    'maravilha':'112799448732013',
    'modelo':'114485828563373',
    'campo ere':'108354002525248',
    'romelândia':'109340072417921',
    'guaraciaba':'109697972382271',
    'dionisio cerqueira':'104039702965165',
    'sao jose do cedro':'112717858740168',
    'palma sola':'184296611586045',
    'quilombo':'105571609476757',
    'irati':'183021885043679',
    'palhoça':'104099219626468',
    'balneario piçarras':'104023769634826',
    'timbó':'113278035352203',
    'indaial':'104032612966151',
    'rodeio':'112128578799364',
    'ascurra':'112292988782339',
    'presidente getulio':'104046859630853',
    'ibirama':'104088569628199',
    'jose boiteux':'111764308839531',
    'lontras':'104077346296445',
    'agronômica':'173232686033568',
    'atalanta':'105721796128905',
    'imbuia':'139236882797975',
    'vidal ramos':'106695439362850',
    'leoberto leal':'153015464745887',
    'rancho queimado':'113218758692426',
    'angelina':'108039192551599',
    'sao joao batista':'112697228746417',
    'cambé':'105493912816591',
    'rolandia':'105644726135839',
    'ibipora':'114399201909897',
    'bela vista do paraiso':'103137819726118',
    'jataizinho':'104902532880992',
    'urai':'108401559187316',
    'sertanopolis':'109415445744727',
    'assai':'106010869429625',
    'leopoldo':'104090482959785',
    'santo antonio da platina':'105445516154960',
    'wenceslau braz':'166701433365067',
    'siqueira campos':'103761629662164',
    'jundiai do sul':'103977489639402',
    'guapirama':'108481782508847',
    'tomazina':'105725766128900',
    'jaboti':'107977462563610',
    'salto do itararé':'108490472508757',
    'loanda':'110626068965625',
    'terra rica':'107859199241758',
    'paranavaí':'111761055506671',
    'cianorte':'107584365937319',
    'altonia':'105535322812272',
    'xambre':'112914622056216',
    'ipora':'125486100849351',
    'marechal candido rondon':'113025838711524',
    'palotina':'103802252991277',
    'terra roxa':'112762942067206',
    'assis chateaubriand':'112520312149277',
    'itabela':'147288231990729',
    'itagimirim':'172512662781345',
    'guaratinga':'147288231990729',
    'mascote':'109283602424399',
    'belmonte':'109694595723037',
    'santa cruz cabralia':'106118622753695',
    'arraial d ajuda':'103114646394765',
    'trancoso':'103114646394765',
    'caraíva':'103114646394765',
    'cumuruxatiba':'104904122878916',
    'mucuri':'106033179427910',
    'nova vicosa':'114129165268560',
    'caravelas':'114129165268560',
    'alcobaça':'110476125646031',
    'morro do chapeu':'106044999425813',
    'utinga':'106051622760204',
    'america dourada':'113214478692955',
    'joao dourado':'163497667026627',
    'lapao':'103953192973313',
    'barra do mendes':'104046599633278',
    'gentio do ouro':'106124916085003',
    'ibipeba':'107827182579028',
    'ibititá':'109207392430705',
    'mulungu do morro':'108082512552773',
    'caem':'112979252048506',
    'saude':'107144902650970',
    'senhor do bonfim':'105398469493845',
    'filadélfia':'171785629523035',
    'pindobaçu':'112813682066704',
    'campo formoso':'108429879184702',
    'andorinha':'104294232944727',
    'jaguarari':'109748792384393',
    'juazeiro':'106296756076301',
    'curaca':'105663422801319',
    'casa nova':'105543682812071',
    'remanso':'108099452543752',
    'pilao arcado':'106060906092055',
    'xique-xique':'108397395850894',
    'barra':'112972125384455',
    'ibotirama':'104344722939311',
    'brotas de macaubas':'108268335867582',
    'lencois':'103768166328914',
    'seabra':'112060102144772',
    'iraquara':'107696232587157',
    'nova redenção':'114431281960118',
    'itaeté':'110245472327512',
    'ituacu':'107631522599355',
    'ribeirao do largo':'107805875909403',
    'barra do choca':'114130401989283',
    'tremedal':'103132519726855',
    'anage':'112851075395354',
    'piripá':'105999939431781',
    'licinio de almeida':'111984008818063',
    'guanambi':'109044775789586',
    'caetite':'105903739441768',
    'igapora':'113100408703426',
    'tanque novo':'1448306872157876',
    'macaúbas':'103733449665010',
    'bom jesus da lapa':'108382032519928',
    'carinhanha':'107967245891331',
    'feira da mata':'171603442873173',
    'cocos':'643808299088442',
    'correntina':'108631749161402',
    'jaborandi':'175095755846035',
    'sao desiderio':'109327385752433',
    'russas':'106190672746540',
    'limoeiro do norte':'103811112990589',
    'morada nova':'107513282605521',
    'jaguaretama':'112297258781995',
    'jaguaribara':'105668436133787',
    'solonopole':'167625306606653',
    'pedra branca':'110949735596611',
    'mombaça':'107279792635250',
    'senador pompeu':'109544632405290',
    'dep. irapuan pinheiro':'167625306606653',
    'piquet carneiro':'112444802100143',
    'tamboril':'114200388590458',
    'sao luis do curu':'104003526302640',
    'umirim':'108113442549543',
    'pentecoste':'107538689275708',
    'general sampaio':'113125028701394',
    'tejuco':'107057869326373',
    'apuiares':'108103769210239',
    'sao goncalo do amarante':'110730028945384',
    'beberibe':'108699272488562',
    'fortim':'103074746399275',
    'aracati':'107674779262094',
    'icapui':'103174453056288',
    'jijoca de jericoacoara':'109975239024973',
    'itarema':'108001415889589',
    'amontada':'112450228771000',
    'miraima':'104050052964230',
    'iraucuba':'103990109636654',
    'meruoca':'108098209212040',
    'alcantaras':'107678252588082',
    'santana do acarau':'113344928680413',
    'massape':'109506019067487',
    'cariré':'103733142998698',
    'itapage':'108814865814922',
    'lagoa grande':'103126059727233',
    'santa maria da boa vista':'104946732874901',
    'oroco':'113249798690918',
    'belem do sao francisco':'106486129384048',
    'itaiba':'104869452883701',
    'paranatama':'110369305649568',
    'tupanatinga':'115061795170753',
    'iati':'113247332020925',
    'correntes':'114990401844635',
    'palmeirina':'108979929123678',
    'lagoa do ouro':'131360786925276',
    'jupi':'104897449545821',
    'catende':'107017809330100',
    'ribeirão':'114643498545823',
    'cortês':'106576486041504',
    'barreiros':'103215259734350',
    'sao benedito do sul':'166820143355957',
    'jucati':'109872425710915',
    'jurema':'872696992819749',
    'altinho':'109284959096077',
    'bonito':'1625293894397430',
    'sertânia':'104948386208380',
    'serra talhada':'103108113062617',
    'afogados da ingazeira':'110508912307871',
    'tuparetama':'109344562423364',
    'carnaiba':'109365185753902',
    'iguaraci':'109024252458976',
    'solidão':'109786555715174',
    'sao jose do egito':'113532748661398',
    'taquaritinga do norte':'110314505661773',
    'sao caitano':'100241520017875',
    'brejo da madre de deus':'104318182941396',
    'vertente do lério':'100238300018499',
    'sao miguel dos campos':'104009342970228',
    'campo alegre':'104113452959412',
    'rio largo':'109446302408395',
    'satuba':'112302562115321',
    'messias':'107845442571938',
    'murici':'109330699086790',
    'joaquim gomes':'108147775872990',
    'porto calvo':'107144442649769',
    'maragogi':'103998666303470',
    'japaratinga':'107979029224053',
    'sao luís do quitunde':'107920325897646',
    'matriz de camaragibe':'105605226140828',
    'porto de pedras':'109608525730865',
    'sao jose da laje':'109505015735318',
    'atalaia':'108559289169181',
    'pilar':'103720496333834',
    'barra de sao miguel':'109865629040557',
    'coruripe':'112632442084037',
    'feliz deserto':'112120212138179',
    'piacabucu':'108382512516495',
    'nossa senhora do socorro':'112231252135712',
    'barra dos coqueiros':'105520216148979',
    'maruim':'106307796067562',
    'santo amaro das brotas':'113602618653349',
    'riachuelo':'103139419727013',
    'rosario do catete':'107863035903682',
    'general maynard':'110894518982821',
    'siriri':'107777135912023',
    'divina pastora':'104037212965896',
    'santa rosa de lima':'107645522589516',
    'itaporanga d ajuda':'112419695439846',
    'indiaroba':'107553892608131',
    'umbauba':'108303889190873',
    'tobias barreto':'108144122539815',
    'riachao do dantas':'109597655724822',
    'samambaia':'108144122539815',
    'pedrinhas':'104325609607107',
    'arauá':'103118766394379',
    'caicó':'107788405910989',
    'currais novos':'108044519217627',
    'parelhas':'112159838800587',
    'acari':'108335235858042',
    'jardim do seridó':'108430689181282',
    'carnauba dos dantas':'106468309383673',
    'cruzeta':'103751249663887',
    'florania':'112465462103954',
    'lagoa nova':'103126059727233',
    'cerro corá':'119868918078715',
    'bodó':'112333298783375',
    'jaçanã':'107665125929392',
    'santana do seridó':'160416890670057',
    'equador':'112897085388124',
    'sao joao do sabugi':'109125659107019',
    'jucurutu':'103772752995302',
    'itajá':'110683502336378',
    'janduís':'113140362034095',
    'messias targino':'182764925073501',
    'marcelino vieira':'109662569061005',
    'encanto':'109544632405290',
    'rafael fernandes':'109111335781937',
    'monteiro':'105994372765600',
    'sume':'113662508644496',
    'congo':'110709485622529',
    'camalaú':'113797108634654',
    'zabelê':'108590355832451',
    'sao joao do tigre':'105007852867629',
    'sao sebastiao do umbuzeiro':'106088782755449',
    'barra de santana':'103772752995302',
    'queimadas':'111993112150843',
    'esperanca':'103993772971571',
    'massaranduba':'107111822652404',
    'areia':'108165229211862',
    'bananeiras':'112956252052130',
    'solânea':'108305805861177',
    'borborema':'112527308764939',
    'cacimba de dentro':'105480056152011',
    'cuité':'103151083058264',
    'nova floresta':'109435962409722',
    'picui':'113297992015627',
    'frei martinho':'112618085417318',
    'pedra lavrada':'108451569179058',
    'paço do lumiar':'108640079159744',
    'sao jose de ribamar':'105637376137200',
    'bacabeira':'170950092936086',
    'rosario':'103116713062530',
    'cajapió':'106439939389796',
    'bacuri':'104856072885372',
    'alcantara':'106338222732800',
    'pinheiro':'109085679112040',
    'matinha':'106136312750651',
    'barra do corda':'105526552814858',
    'sao luis gonzaga':'100241463350322',
    'colinas':'151742284874002',
    'coroata':'110606405632535',
    'peritoró':'103146339725387',
    'trizidela do vale':'183423911675196',
    'lago da pedra':'108230339197065',
    'presidente dutra':'183151088362102',
    'arame':'138770186178443',
    'grajaú':'114761005206023',
    'sao domingos do maranhao':'109276839090966',
    'loreto':'110601652299026',
    'alto parnaiba':'107901092566601',
    'riachao':'107912922562755',
    'sao felix':'110296678989518',
    'carolina':'112962408720344',
    'estreito':'108379449184328',
    'porto franco':'109149219110442',
    'governador edison lobao':'110577169014274',
    'acailandia':'151651644882964',
    'sao raimundo nonato':'109316915762226',
    'barras':'103138416393482',
    'batalha':'111957382157401',
    'angical do piaui':'108431602514458',
    'jose de freitas':'103105696396192',
    'altos':'111184758905127',
    'demerval lobao':'104043959631234',
    'lagoa alegre':'110941435645356',
    'pio ix':'109576232394560',
    'simoes':'125354274193275',
    'jaicos':'103099293063650',
    'paulistana':'106081692757432',
    'valença do piaui':'107505169279406',
    'aguas lindas de goias':'175750955777759',
    'valparaiso de goias':'118168981584335',
    'goianesia':'104891666214046',
    'uruacu':'113061122044673',
    'porangatu':'106997222665619',
    'sao miguel do araguaia':'108105575876696',
    'barro alto':'109582469060966',
    'niquelandia':'109151205773227',
    'campinacu':'184479768232929',
    'minacu':'139253386130679',
    'colinas do sul':'181592421852094',
    'cavalcante':'110357088989803',
    'alto paraiso':'135851093139473',
    'sao joao d alianca':'148275371891025',
    'planaltina':'112908508722956',
    'padre bernardo':'108784052476905',
    'pirenopolis':'112720868743249',
    'abadiania':'103124659728061',
    'corumba de goias':'109490045741645',
    'sao luis de montes belos':'104883056214783',
    'jussara':'103121836395318',
    'arenopolis':'167307769971949',
    'itapuranga':'110576568968865',
    'goias':'110393505647202',
    'itaberai':'113460485332754',
    'itaucu':'106923289339457',
    'indiara':'130180967042246',
    'pontalina':'109013759127381',
    'morrinhos':'107131862651480',
    'piracanjuba':'113077158708888',
    'guarai':'108110605890492',
    'colinas do tocantins':'1468829463427261',
    'araguana':'108572659172521',
    'miracema do tocantins':'103818556323157',
    'miranorte':'109152989111993',
    'presidente kennedy':'172929396063917',
    'barrolandia':'109152989111993',
    'monte do carmo':'103977326305857',
    'porto alegre do tocantins':'113373648672696',
    'natividade':'112519445430108',
    'almas':'112463765435398',
    'dianopolis':'113373648672696',
    'taguatinga':'375833495820013',
    'arraias':'112118195469118',
    'combinado':'113712292030556',
    'aurora do tocantins':'177177772305825',
    'lavandeira':'173149902708585',
    'novo acordo':'129878610406807',
    'sorriso':'156477967728813',
    'lucas do rio verde':'177294072295222',
    'campo novo do parecis':'152602034788296',
    'sapezal':'120128041656938',
    'campo verde':'104073256294393',
    'primavera do leste':'132842920103374',
    'jaciara':'104061136298333',
    'dom aquino':'177371252288253',
    'ibiuna':'103799362991731',
    'juquitiba':'110727285621656',
    'piedade':'111866365505547',
    'tiete':'109659935727217',
    'monte mor':'107996699220971',
    'saltinho':'176260055731825',
    'charqueada':'112115112136967',
    'sao pedro':'113949485283402',
    'brotas':'108237455864568',
    'torrinha':'112144808801614',
    'dourado':'108198945879238',
    'ibitinga':'103796929658641',
    'itapolis':'105575522808711',
    'taquaritinga':'104053232965705',
    'dobrada':'112189358793930',
    'candido rodrigues':'104047476299630',
    'santa ernestina':'112104702138890',
    'pradopolis':'112603292087767',
    'luis antonio':'105084352860461',
    'altinopolis':'112255248787302',
    'batatais':'112483028764411',
    'pedregulho':'104100776294392',
    'sao jose da bela vista':'109227959103408',
    'jeriquara':'112363635442859',
    'restinga':'107960042560155',
    'sales de oliveira':'103118393062213',
    'ituverava':'108490789171321',
    'miguelopolis':'108490789171321',
    'aramina':'112321465450204',
    'buritizal':'108726572484553',
    'guara':'111775985505817',
    'orlândia':'103161779723666',
    'morro agudo':'109286989090256',
    'viradouro':'105589749475767',
    'porecatu':'110637615621640',
    'florestopolis':'107841759237116',
    'sao jerônimo da serra':'105623879470388',
    'santa mariana':'113145378699824',
    'jaguariaiva':'106136009416809',
    'piraí do sul':'112485248766562',
    'castro':'104906769545613',
    'telemaco borba':'105855539449117',
    'reserva':'112759012069282',
    'ortigueira':'107326549304393',
    'ibaiti':'107813919248792',
    'quatigua':'112196472130656',
    'conselheiro mairinck':'107745999248674',
    'japira':'103342159707846',
    'pinhalão':'112349788779410',
    'figueira':'605710779532595',
    'leópolis':'107576762605243',
    'assaí':'106010869429625',
    'bela vista do paraíso':'103137819726118',
    'paiçandu':'100245170017544',
    'mandaguaçu':'105591479473596',
    'mandaguari':'103755489663256',
    'jandaia do sul':'104717882901063',
    'sabaudia':'108103659211575',
    'kaloré':'109875119030852',
    'marumbi':'105497592816488',
    'lidianópolis':'171188152916095',
    'borrazópolis':'107694535919657',
    'grandes rios':'108164585872621',
    'cruzmaltina':'147824265268963',
    'cândido de abreu':'107777712583562',
    'ivaiporã':'108190595868839',
    'godoy moreira':'120265348040316',
    'lunardelli':'103137819726118',
    'rio branco do ivaí':'113829302021027',
    'jardim alegre':'105732099460065',
    'nova tebas':'182699361747569',
    'mato rico':'176835739001736',
    'roncador':'112056922140959',
    'mamborê':'107695369260187',
    'campo mourão':'111722322185417',
    'peabiru':'113111838703165',
    'quinta do sol':'106261672738875',
    'engenheiro beltrão':'109558862395955',
    'ubiratã':'124331364293667',
    'moreira sales':'111691958842415',
    'goioerê':'171405649554447',
    'janiópolis':'125238700873228',
    'altamira do paraná':'156077044439304',
    'corumbataí do sul':'147515568632951',
    'barbosa ferraz':'110490968978140',
    'iretama':'109364602422764',
    'nova cantu':'172028979498744',
    'laranjal':'113572475320469',
    'palmital':'673888449410928',
    'saudade do iguaçu':'178280875534199',
    'inajá':'110536738972609',
    'rondon':'113025838711524',
    'itaúna do sul':'112968208717616',
    'itanhandu':'109277915764883',
    'virgínia':'108562522509288',
    'passa quatro':'107736472589336',
    'resende costa':'104022776299829',
    'prados':'112194128807158',
    'coronel xavier chaves':'135710333153142',
    'nazareno':'105013522867786',
    'itumirim':'109532552406398',
    'campo belo':'108345052523274',
    'bambui':'111895865493856',
    'medeiros':'113868151957051',
    'doresopolis':'143661352316090',
    'lagoa da prata':'110906555600896',
    'santa quiteria':'105698479463894',
    'ipu':'104025192966759',
    'reriutaba':'112101495472637',
    'varjota':'108214299207109',
    'guaraciaba do norte':'108205582534810',
    'ubajara':'107817955913552',
    'ibiapina':'112343428778189',
    'viçosa do ceara':'105519702816101',
    'sao benedito':'109625279063015',
    'carnaubal':'106109692752849',
    'chaval':'106121806086201',
    'barroquinha':'105496182818029',
    'cruz':'112020462148165',
    'paracuru':'105605089474079',
    'paraipaba':'104053652964834',
    'trairi':'111934378823739',
    'miraíma':'108223349201813',
    'tejucuoca':'113520751998486',
    'itapajé':'108814865814922',
    'uruburetama':'109449285747169',
    'tururu':'103928162978526',
    'maracanaú':'106548656045346',
    'pacatuba':'108550125834465',
    'eusébio':'110195945666464',
    'aquiraz':'108622289167452',
    'pindoretama':'112618832084319',
    'icapuí':'103174453056288',
    'luís eduardo magalhães':'170562112963167',
    'angical':'1088585831170152',
    'wanderley':'173092922721867',
    'tabocas do brejo velho':'173917185963370',
    'cotegipe':'106976672666956',
    'santa rita de cassia':'109857159040532',
    'mansidão':'108128822541337',
    'wenceslau guimarães':'176463125711265',
    'ubaitaba':'113660191977824',
    'aurelino leal':'167755406595240',
    'ituberá':'107985489221647',
    'nilo peçanha':'109666929060287',
    'taperoá':'108072382554499',
    'camamu':'104126412956269',
    'maraú':'103155699725317',
    'buerarema':'108594232499149',
    'itajuípe':'106000192764815',
    'coaraci':'109369672416174',
    'almadina':'109318669087957',
    'ibicaraí':'109224055770841',
    'passira':'110154402336258',
    'frei miguelinho':'104964109539998',
    'sao vicente ferrer':'109715885712805',
    'machados':'104334052940342',
    'bom jardim':'113001625383527',
    'carpina':'108501139172600',
  };

  const cityRaw = (options.city || '').split(',')[0].trim()
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  const citySlug = CITY_SLUGS[cityRaw] || cityRaw.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').toLowerCase();

  // Tenta buscar o ID numérico da cidade via API do Facebook (mais confiável que slugs)
  async function getCityId(cityName) {
    try {
      const searchUrl = `https://www.facebook.com/ajax/typeahead/search/first_degree.php?value=${encodeURIComponent(cityName)}&context=city&viewer=0`;
      const resp = await page.evaluate(async (url) => {
        const r = await fetch(url, { credentials: 'include' });
        return r.text();
      }, `https://www.facebook.com/pages/search/results/?q=${encodeURIComponent(cityName)}&type=2`).catch(() => null);
      return null;
    } catch { return null; }
  }

  // Monta URL inicial com slug
  let finalUrl = `https://www.facebook.com/marketplace/${citySlug}/search/?query=${encodedKeyword}&sortBy=creation_time_descend&exact=false`;

  console.log(`[Scraper] URL: ${finalUrl}`);

  try {
    console.log(`[Scraper] [T] Acessando URL do Marketplace... [${Date.now()}]`);
    try {
      await page.goto(finalUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      let currentUrl = page.url();
      console.log(`[Scraper] [T] Página carregada [${Date.now()}]`, currentUrl.slice(0, 80));
      
      // Se redirecionou para login
      if (currentUrl.includes('login') || currentUrl.includes('checkpoint')) {
        console.log('[Scraper] Modal de login detectado — tentando fechar');
        await page.goto(finalUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        await page.evaluate(() => {
          const closeBtn = document.querySelector('[aria-label="Close"], [aria-label="Fechar"], [data-testid="dialog_dismiss"]');
          if (closeBtn) closeBtn.click();
        }).catch(() => {});
        await delay(1500);
        currentUrl = page.url();
      }

      // Se redirecionou para /category/search/ = slug não reconhecido
      if (currentUrl.includes('/category/search/') || currentUrl.includes('/marketplace/category/')) {
        console.warn(`[Scraper] Slug "${citySlug}" não reconhecido — redirecionando para busca geral`);
        options._cityMismatch = true;
        await page.goto(`https://www.facebook.com/marketplace/search/?query=${encodedKeyword}&sortBy=creation_time_descend&exact=false`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      }
    } catch (gotoErr) {
      if (gotoErr.message.includes('Sessão expirada')) throw gotoErr;
      console.error('[Scraper] Erro ao acessar URL:', gotoErr.message);
      await browser.close().catch(() => null);
      throw new Error('Não foi possível acessar o Marketplace: ' + gotoErr.message);
    }

    // Tenta fechar modal de login (sem delay — fire and forget)
    page.evaluate(() => {
      const closeBtn = document.querySelector('[aria-label="Close"], [aria-label="Fechar"]');
      if (closeBtn) closeBtn.click();
    }).catch(() => {});

    // Aguarda anúncios aparecerem (para assim que encontrar, não espera timeout)
    await page.waitForSelector('a[href*="/marketplace/item/"]', {
      timeout: 15000,
    }).catch(() => {
      console.log('[Scraper] Seletor não encontrado em 15s — coletando o que carregou');
    });

    const pageTitle = await page.title().catch(() => 'erro');
    const itemCount = await page.$$eval('a[href*="/marketplace/item/"]', els => els.length).catch(() => 0);
    console.log(`[Scraper] Título: ${pageTitle} | Anúncios encontrados: ${itemCount}`);
    
    console.log(`[Scraper] [T] Iniciando scroll... [${Date.now()}]`);
    let lastEmittedCount = 0;
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 3));
      await delay(500);
      const count = await page.$$eval('a[href*="/marketplace/item/"]', els => els.length).catch(() => 0);
      console.log(`[Scraper] [T] Scroll ${i+1}/3 | anúncios: ${count} [${Date.now()}]`);

      // Emite batch após primeiro scroll com anúncios suficientes
      if (onBatch && count > lastEmittedCount) {
        // Emite batch em qualquer scroll se tiver anúncios novos
        await delay(300);
        try {
          const partialRaw = await page.evaluate(() => {
            const results = [];
            const seen = new Set();
            document.querySelectorAll('a[href*="/marketplace/item/"]').forEach(a => {
              const href = a.href?.split('?')[0];
              if (!href || seen.has(href)) return;
              seen.add(href);
              const spans = [...a.querySelectorAll('span')].map(s => s.textContent?.trim()).filter(Boolean);
              const title = spans.find(t => t.length > 4 && !t.startsWith('R$') && !t.match(/^\d+$/)) || '';
              const priceText = spans.find(t => t.startsWith('R$')) || '';
              const img = a.querySelector('img')?.src || '';
              const locSpan = spans.find(t => t.includes(',') || (t.length > 3 && !t.startsWith('R$') && t !== title)) || '';
              results.push({ title, price_text: priceText, image_url: img, location: locSpan, listing_url: href });
            });
            return results;
          }).catch(() => []);
          if (partialRaw.length > lastEmittedCount) {
            console.log(`[Scraper] Emitindo batch ${i+1}: ${partialRaw.length} anúncios`);
            onBatch(partialRaw, i + 1, 3);
            lastEmittedCount = partialRaw.length;
          } else {
            onBatch(null, i + 1, 3);
          }
        } catch (e) {
          console.log('[Scraper] Erro no batch:', e.message);
          onBatch(null, i + 1, 3);
        }
      }

      if (count >= maxItems) break;
    }
    // Volta ao topo para garantir que todos os itens estão no DOM
    await page.evaluate(() => window.scrollTo(0, 0));
    await delay(300);
    
    console.log(`[Scraper] [T] Coletando dados dos anúncios... [${Date.now()}]`);
    // Aguarda títulos reais carregarem (substituem "Acabou de ser anunciado")
    await page.waitForFunction(() => {
      const anchors = document.querySelectorAll('a[href*="/marketplace/item/"]');
      if (anchors.length === 0) return false;
      const titles = [...anchors].map(a => {
        const spans = [...a.querySelectorAll('span')].map(s => s.textContent?.trim()).filter(Boolean);
        return spans.find(t => t.length > 4 && !t.startsWith('R$')) || '';
      });
      return titles.some(t => t && t !== 'Acabou de ser anunciado' && t.length > 5);
    }, { timeout: 15000 }).catch(() => {
      console.log('[Scraper] Títulos reais não carregaram — usando títulos genéricos');
    });

    const updatedCookies = await page.cookies();
    if (updatedCookies.some(c => c.name === 'c_user')) {
      saveCookies(sessionId, updatedCookies);
    }

    const listings = await Promise.race([
      page.evaluate(() => {
      const results = [];
      const seen = new Set();
      const anchors = document.querySelectorAll('a[href*="/marketplace/item/"]');

      anchors.forEach(anchor => {
        try {
          const href = anchor.href;
          if (!href || seen.has(href)) return;

          const idMatch = href.match(/\/item\/(\d+)/);
          const externalId = idMatch ? idMatch[1] : null;

          const allSpanTexts = [...anchor.querySelectorAll('span')]
            .map(s => s.textContent?.trim() || '')
            .filter(t => t.length > 0);

          let priceRaw = '';
          for (const t of allSpanTexts) {
            if (t.includes('R$') && /R\$\s*[\d\.,]+/.test(t)) {
              priceRaw = t;
              break;
            }
          }

          let title = anchor.getAttribute('aria-label') || '';
          // Ignora aria-label genérico
          if (!title || title.includes('R$') || title === 'Acabou de ser anunciado') {
            title = '';
            for (const t of allSpanTexts) {
              if (
                t.length > 4 &&
                t !== 'Acabou de ser anunciado' &&
                !t.startsWith('R$') &&
                !t.match(/^[\d\.,]+$/) &&
                !/^\d+\s*(km|m|min|h|dia|dias|hora|horas)/.test(t)
              ) {
                title = t;
                break;
              }
            }
          }

          if (!title || title.length < 3) return;

          let loc = '';
          const stateAbbrs = ['AC','AL','AM','AP','BA','CE','DF','ES','GO','MA','MG','MS','MT','PA','PB','PE','PI','PR','RJ','RN','RO','RR','RS','SC','SE','SP','TO'];
          for (const t of allSpanTexts) {
            if (stateAbbrs.some(uf => t.endsWith(', ' + uf) || t.endsWith(', ' + uf + ' '))) {
              loc = t.trim();
              break;
            }
          }
          if (!loc) {
            const candidates = allSpanTexts.filter(t =>
              t !== title && !t.includes('R$') && t.length > 2 && t.length < 60 && !t.match(/^\d+$/)
            );
            if (candidates.length > 0) loc = candidates[candidates.length - 1];
          }

          const img = anchor.querySelector('img');
          const imageUrl = img?.src || '';

          seen.add(href);
          results.push({
            external_id: externalId,
            title,
            price_raw: priceRaw,
            location: loc,
            image_url: imageUrl,
            listing_url: href,
            condition: '',
          });
        } catch {}
      });

      return results;
    }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('evaluate timeout')), 15000))
    ]).catch(err => {
      console.log('[Scraper] evaluate falhou:', err.message, '— retornando array vazio');
      return [];
    });

    console.log(`[Scraper] Dados coletados: ${listings.length} anúncios brutos`);
    await Promise.race([
      browser.close(),
      new Promise(resolve => setTimeout(resolve, 5000))
    ]).catch(() => {});
    if (browser._anonProxyUrl) await ProxyChain.closeAnonymizedProxy(browser._anonProxyUrl, true).catch(() => {});
    console.log(`[Scraper] [T] Browser fechado, processando... [${Date.now()}]`);

    const processed = listings.map(item => ({
      ...item,
      price: parsePrice(item.price_raw),
    }));

    const filtered = filterListings(processed, {
      removeNoPrice: options.removeNoPrice !== false,
      removeAccessories: false,
      removeDefects: false,
      keyword,
      blockedWords: options.blockedWords || [],
    });

    const sorted = sortByProximity(filtered, cityRaw);

    console.log(`[Scraper] "${keyword}" em ${cityRaw}: ${processed.length} brutos → ${sorted.length} resultados`);

    return sorted.slice(0, maxItems).map(l => ({ ...l, _cityRaw: cityRaw, _cityMismatch: options._cityMismatch || false }));

  } catch (err) {
    if (browser._anonProxyUrl) await ProxyChain.closeAnonymizedProxy(browser._anonProxyUrl, true).catch(() => {});
    await browser.close().catch(() => null);
    throw err;
  }
}

async function scrapeMarketplace(sessionId, keyword, location, maxItems = 40, options = {}, onBatch = null) {
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await scrapeMarketplaceAttempt(sessionId, keyword, location, maxItems, options, onBatch);
    } catch (err) {
      const isTunnelError = err.message && (
        err.message.includes('ERR_TUNNEL_CONNECTION_FAILED') ||
        err.message.includes('ERR_PROXY_CONNECTION_FAILED') ||
        err.message.includes('net::ERR_') ||
        err.message.includes('tunnel')
      );
      if (isTunnelError && attempt < MAX_RETRIES) {
        console.warn(`[Scraper] Erro de proxy na tentativa ${attempt}, tentando novamente... (${err.message.slice(0, 60)})`);
        await new Promise(r => setTimeout(r, 2000 * attempt));
        continue;
      }
      throw err;
    }
  }
}

async function closeBrowser(sessionId) {
  const session = activeBrowsers[sessionId];
  if (session) {
    try { await session.browser.close(); } catch {}
    delete activeBrowsers[sessionId];
  }
}

function parsePrice(priceStr) {
  if (!priceStr) return null;
  if (!priceStr.includes('R$')) return null;
  const match = priceStr.match(/R\$\s*([\d\.,]+)/);
  if (!match) return null;
  const raw = match[1];
  let normalized;
  if (raw.includes(',')) {
    normalized = raw.replace(/\./g, '').replace(',', '.');
  } else if (raw.includes('.') && raw.split('.').length === 2 && raw.split('.')[1].length !== 3) {
    normalized = raw;
  } else {
    normalized = raw.replace(/\./g, '');
  }
  const num = parseFloat(normalized);
  if (isNaN(num) || num < 10 || num > 500000) return null;
  return num;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function calcDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

const PROXIMITY_COORDS = {
  'sao paulo':[-23.5505,-46.6333],'rio de janeiro':[-22.9068,-43.1729],
  'belo horizonte':[-19.9167,-43.9345],'salvador':[-12.9714,-38.5014],
  'fortaleza':[-3.7172,-38.5433],'curitiba':[-25.4284,-49.2733],
  'manaus':[-3.1190,-60.0217],'recife':[-8.0476,-34.8770],
  'porto alegre':[-30.0346,-51.2177],'belem':[-1.4558,-48.5044],
  'goiania':[-16.6869,-49.2648],'guarulhos':[-23.4543,-46.5333],
  'campinas':[-22.9056,-47.0608],'sao luis':[-2.5297,-44.3028],
  'maceio':[-9.6658,-35.7350],'natal':[-5.7945,-35.2110],
  'teresina':[-5.0892,-42.8019],'campo grande':[-20.4428,-54.6460],
  'joao pessoa':[-7.1195,-34.8450],'osasco':[-23.5329,-46.7916],
  'santo andre':[-23.6639,-46.5383],'ribeirao preto':[-21.1704,-47.8103],
  'uberlandia':[-18.9186,-48.2772],'sorocaba':[-23.5015,-47.4526],
  'contagem':[-19.9317,-44.0536],'aracaju':[-10.9167,-37.0500],
  'feira de santana':[-12.2664,-38.9663],'cuiaba':[-15.5961,-56.0970],
  'joinville':[-26.3045,-48.8487],'florianopolis':[-27.5954,-48.5480],
  'londrina':[-23.3045,-51.1696],'juiz de fora':[-21.7642,-43.3503],
  'niteroi':[-22.8833,-43.1036],'porto velho':[-8.7612,-63.9004],
  'serra':[-20.1286,-40.3097],'caxias do sul':[-29.1678,-51.1794],
  'duque de caxias':[-22.7856,-43.3117],'nova iguacu':[-22.7592,-43.4511],
  'sao joao de meriti':[-22.8011,-43.3706],'sao goncalo':[-22.8269,-43.0539],
  'marica':[-22.9194,-42.8186],'petropolis':[-22.5050,-43.1786],
  'volta redonda':[-22.5231,-44.1036],'cabo frio':[-22.8786,-42.0189],
  'santos':[-23.9608,-46.3336],'taubate':[-23.0267,-45.5553],
  'praia grande':[-24.0056,-46.4028],'bauru':[-22.3147,-49.0619],
  'marilia':[-22.2136,-49.9456],'americana':[-22.7375,-47.3319],
  'limeira':[-22.5639,-47.4017],'piracicaba':[-22.7253,-47.6492],
  'jundiai':[-23.1864,-46.8964],'sao jose dos campos':[-23.1794,-45.8869],
  'franca':[-20.5386,-47.4008],'guaruja':[-23.9928,-46.2564],
  'itaborai':[-22.7122,-42.8594],'mage':[-22.6550,-43.0403],
  'belford roxo':[-22.7642,-43.3967],'mesquita':[-22.7814,-43.4375],
  'queimados':[-22.7172,-43.5572],'teresopolis':[-22.4122,-42.9781],
  'araruama':[-22.8722,-42.3442],'resende':[-22.4681,-44.4508],
  'saquarema':[-22.9203,-42.5100],'angra dos reis':[-23.0067,-44.3183],
  'nova friburgo':[-22.2817,-42.5319],'campos dos goytacazes':[-21.7542,-41.3244],
  'macae':[-22.3711,-41.7869],'barra mansa':[-22.5442,-44.1717],
  'itaguai':[-22.8594,-43.7769],'palhoca':[-27.6447,-48.6697],
  'sao jose':[-27.5953,-48.6349],
};

function normCity(str) {
  return (str || '').split(',')[0].trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sortByProximity(listings, cityRaw) {
  const coords = PROXIMITY_COORDS[cityRaw];
  if (!coords) return listings;
  return listings.map(l => {
    const locNorm = normCity(l.location);
    const isExact = locNorm === cityRaw;
    if (isExact) return { ...l, _dist: 0 };
    const locCoords = PROXIMITY_COORDS[locNorm];
    const dist = locCoords
      ? calcDistance(coords[0], coords[1], locCoords[0], locCoords[1])
      : 9999;
    return { ...l, _dist: dist };
  }).sort((a, b) => a._dist - b._dist)
    .map(({ _dist, ...l }) => l);
}

function analyzeListings(listings) {
  const withPrice = listings.filter(l => l.price !== null && l.price > 0);
  if (withPrice.length === 0) return { listings, stats: null };

  const prices = withPrice.map(l => l.price).sort((a, b) => a - b);
  const avg = prices.reduce((s, p) => s + p, 0) / prices.length;
  const median = prices[Math.floor(prices.length / 2)];
  const min = prices[0];
  const max = prices[prices.length - 1];
  const opportunityThreshold = avg * 0.70;

  const analyzed = listings.map(l => {
    const pct_below_avg = l.price !== null
      ? Math.round(((avg - l.price) / avg) * 100)
      : null;
    const is_opportunity = l.price !== null && l.price <= opportunityThreshold;

    // Score de oportunidade (0-100)
    let score = null;
    if (l.price !== null) {
      let s = 0;
      // % abaixo da média (0-50pts)
      if (pct_below_avg >= 30) s += 50;
      else if (pct_below_avg >= 20) s += 40;
      else if (pct_below_avg >= 10) s += 25;
      else if (pct_below_avg >= 0) s += 10;
      // abaixo da mediana (0-15pts)
      if (l.price <= median) s += 15;
      // tem imagem (0-15pts)
      if (l.image_url) s += 15;
      // proximidade — mesma cidade (0-20pts)
      const locNorm = (l.location || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').split(',')[0].trim();
      const cityNorm = (l._cityRaw || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
      if (cityNorm && locNorm === cityNorm) s += 20;
      else if (cityNorm && locNorm.includes(cityNorm)) s += 10;
      score = Math.min(100, s);
    }

    return { ...l, is_opportunity, pct_below_avg, score };
  });

  return {
    listings: analyzed,
    stats: {
      total: listings.length,
      with_price: withPrice.length,
      avg: Math.round(avg * 100) / 100,
      median: Math.round(median * 100) / 100,
      min,
      max,
      opportunity_threshold: Math.round(opportunityThreshold * 100) / 100,
      opportunities: analyzed.filter(l => l.is_opportunity).length,
    },
  };
}

module.exports = {
  openLoginWindow,
  checkLogin,
  loginWithCredentials,
  submitTwoFactor,
  scrapeMarketplace,
  closeBrowser,
  analyzeListings,
  hasSavedCookies,
  hasSavedCookiesAsync,
  saveCookies,
  launchBrowser,
  ensureSharedSession,
  SHARED_SESSION_ID,
};
