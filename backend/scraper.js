const puppeteer = require('puppeteer');
const os = require('os');
const fs = require('fs');
const path = require('path');

const activeBrowsers = {};
const COOKIES_DIR = path.join(__dirname, '../data/cookies');

if (!fs.existsSync(COOKIES_DIR)) fs.mkdirSync(COOKIES_DIR, { recursive: true });

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
  if (t.includes(kw)) return true;
  const stopwords = ['de','do','da','os','as','um','uma','para','com','sem','pro','pra','e'];
  const words = kw.split(/\s+/).filter(w => w.length > 2 && !stopwords.includes(w));
  if (words.length === 0) return true;
  return words.filter(w => t.includes(w)).length >= 1;
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
  fs.writeFileSync(cookiePath(sessionId), JSON.stringify(cookies, null, 2));
}

function loadCookies(sessionId) {
  const p = cookiePath(sessionId);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function hasSavedCookies(sessionId) {
  const cookies = loadCookies(sessionId);
  if (!cookies) return false;
  return cookies.some(c => c.name === 'c_user');
}

// ─── Chrome ───────────────────────────────────────────────
function findChromePath() {
  const candidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    process.env.PUPPETEER_EXECUTABLE_PATH,
    path.join(os.homedir(), '.cache', 'puppeteer', 'chrome', 'linux-131.0.6778.204', 'chrome-linux64', 'chrome'),
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

// Bright Data — proxy residencial BR com suporte nativo ao Puppeteer
const PROXY_USER = 'brd-customer-hl_7f589202-zone-marketscan';
const PROXY_PASS = 'i1s805bc6ktx';
const PROXY_HOST = 'brd.superproxy.io';
const PROXY_PORT = 33335;

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

  // Tenta com proxy BR primeiro, depois direto como fallback
  const attempts = [getNextProxyUrl(), null];
  let lastError = '';

  for (let i = 0; i < attempts.length; i++) {
    const proxyUrl = attempts[i];
    console.log(`[Login] Tentativa ${i + 1}/${attempts.length}${proxyUrl ? ' via Bright Data BR' : ' direto'}`);
    const result = await tryLoginWithProxy(sessionId, email, password, proxyUrl);
    if (result.ok || result.status === 'needs_2fa') return result;
    lastError = result.error || 'Falha desconhecida';
    console.log(`[Login] Tentativa ${i + 1} falhou: ${lastError}`);
  }

  return { ok: false, status: 'error', error: lastError };
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
    // Injeta senha via evaluate para evitar problemas com @ e caracteres especiais
    await page.evaluate((pwd) => {
      const input = document.querySelector('#pass, input[name="pass"], input[type="password"]');
      if (input) {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeInputValueSetter.call(input, pwd);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, password);
    await delay(300);

    // Pressiona Enter para submeter
    await passSel.press('Enter');

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null);

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

    // Verifica se precisa de 2FA / checkpoint
    const needs2FA =
      url.includes('/checkpoint') ||
      url.includes('/two_step_verification') ||
      url.includes('/login/device-based') ||
      url.includes('approvals') ||
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

async function scrapeMarketplace(sessionId, keyword, location, maxItems = 40, options = {}) {
  const cookies = loadCookies(sessionId);
  if (!cookies) throw new Error('Sessão não encontrada. Faça login primeiro.');

  console.log(`[Scraper] Iniciando busca headless: "${keyword}" (${cookies.length} cookies)`);

  const browser = await launchBrowser();
  const page = await browser.newPage();

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded' });
  await page.setCookie(...cookies);
  
  // Verifica se os cookies funcionaram
  const testCookies = await page.cookies();
  const hasSession = testCookies.some(c => c.name === 'c_user');
  console.log(`[Scraper] Sessão Facebook ativa: ${hasSession}`);
  if (!hasSession) {
    await browser.close();
    throw new Error('Sessão expirada. Faça login no Facebook novamente.');
  }

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
    'sao paulo':'sao-paulo','rio de janeiro':'rio-de-janeiro','belo horizonte':'belo-horizonte',
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
    'duque de caxias':'duque-de-caxias','nova iguacu':'nova-iguacu',
    'sao joao de meriti':'sao-joao-de-meriti','sao goncalo':'sao-goncalo',
    'marica':'marica','petropolis':'petropolis','volta redonda':'volta-redonda',
    'cabo frio':'cabo-frio','santos':'santos','taubate':'taubate',
    'praia grande':'praia-grande','bauru':'bauru','marilia':'marilia',
    'americana':'americana','limeira':'limeira','piracicaba':'piracicaba',
    'jundiai':'jundiai','indaiatuba':'indaiatuba','sao jose dos campos':'sao-jose-dos-campos',
    'franca':'franca','guaruja':'guaruja','suzano':'suzano',
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
  };

  const cityRaw = (options.city || '').split(',')[0].trim()
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  const citySlug = CITY_SLUGS[cityRaw] || cityRaw.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

  const url = citySlug
    ? `https://www.facebook.com/marketplace/${citySlug}/search/?query=${encodedKeyword}&sortBy=creation_time_descend`
    : `https://www.facebook.com/marketplace/search/?query=${encodedKeyword}&sortBy=creation_time_descend`;

  console.log(`[Scraper] URL: ${url}`);

  try {
    console.log('[Scraper] Acessando URL do Marketplace...');
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      console.log('[Scraper] Página carregada, URL atual:', page.url().slice(0, 80));
    } catch (gotoErr) {
      console.error('[Scraper] Erro ao acessar URL:', gotoErr.message);
      await browser.close().catch(() => null);
      throw new Error('Não foi possível acessar o Marketplace: ' + gotoErr.message);
    }

    // Aguarda anúncios com timeout curto e continua mesmo sem eles
    await page.waitForSelector('a[href*="/marketplace/item/"]', {
      timeout: 20000,
    }).catch(() => {
      console.log('[Scraper] Seletor não encontrado em 20s — coletando o que carregou');
    });
    
    // Log do que está na página para debug
    const pageTitle = await page.title().catch(() => 'erro');
    const itemCount = await page.$$eval('a[href*="/marketplace/item/"]', els => els.length).catch(() => 0);
    console.log(`[Scraper] Título: ${pageTitle} | Anúncios encontrados: ${itemCount}`);

    console.log('[Scraper] Iniciando scroll...');
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await delay(800);
      console.log(`[Scraper] Scroll ${i+1}/4`);
    }
    console.log('[Scraper] Coletando dados dos anúncios...');
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
    console.log('[Scraper] Browser fechado, processando...');

    const processed = listings.map(item => ({
      ...item,
      price: parsePrice(item.price_raw),
    }));

    const filtered = filterListings(processed, {
      removeNoPrice: options.removeNoPrice !== false,
      removeAccessories: false,
      removeDefects: false,
      keyword: '',
      blockedWords: options.blockedWords || [],
    });

    const sorted = sortByProximity(filtered, cityRaw);

    console.log(`[Scraper] "${keyword}" em ${cityRaw}: ${processed.length} brutos → ${sorted.length} resultados`);

    return sorted.slice(0, maxItems);

  } catch (err) {
    await browser.close().catch(() => null);
    throw err;
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

  const analyzed = listings.map(l => ({
    ...l,
    is_opportunity: l.price !== null && l.price <= opportunityThreshold,
    pct_below_avg: l.price !== null
      ? Math.round(((avg - l.price) / avg) * 100)
      : null,
  }));

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
  saveCookies,
};
