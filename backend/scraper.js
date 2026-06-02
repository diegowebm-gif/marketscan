const puppeteer = require('puppeteer');
const os = require('os');
const fs = require('fs');
const path = require('path');

const activeBrowsers = {};
const COOKIES_DIR = path.join(__dirname, '../data/cookies');

// Garante que a pasta de cookies existe
if (!fs.existsSync(COOKIES_DIR)) fs.mkdirSync(COOKIES_DIR, { recursive: true });

// ─── Filtros de qualidade ─────────────────────────────────

const ACCESSORY_KEYWORDS = [
  'capinha', 'capa protetora', 'película', 'pelicula', 'carregador', 'cabo usb',
  'cabo lightning', 'cabo type-c', 'fone de ouvido', 'fones de ouvido',
  'earphone', 'earphones', 'headphone', 'headset', 'airpod', 'airpods',
  'case para', 'suporte para', 'protetor de tela', 'carcaça', 'carcaca',
  'bumper', 'skin adesiva', 'adaptador usb', 'hub usb', 'dock',
  'tripé', 'tripe', 'anel magnético', 'pop socket', 'popsocket',
  'bateria externa', 'powerbank', 'power bank', 'fonte carregador',
  'película vidro', 'película gel', 'caneta stylus', 'stylus',
  'suporte veicular', 'suporte celular', 'película fosca',
  // Acessórios que passavam antes
  'smartwatch', 'smart watch', 'relogio inteligente', 'relógio inteligente',
  'fone bluetooth', 'fone sem fio', 'cabo original', 'carregador original',
  'fonte original', 'adaptador original', 'kit cabo', 'kit carregador',
  'para iphone', 'compatível com iphone', 'compativel com iphone',
];

const DEFECT_KEYWORDS = [
  'com defeito', 'defeituoso', 'quebrado', 'trincado', 'rachado',
  'não liga', 'nao liga', 'não funciona', 'nao funciona',
  'para peças', 'para peça', 'pra peça', 'pra peças',
  'retirada de peças', 'display quebrado', 'tela quebrada',
  'tela trincada', 'vidro quebrado', 'vidro trincado',
  'sem touch', 'touch ruim', 'em manutenção', 'em manutencao',
  'bateria viciada', 'bateria ruim', 'bateria inchada', 'sem bateria',
  'câmera com defeito', 'camera com defeito', 'placa queimada',
  'não carrega', 'nao carrega', 'chassi dobrado', 'amassado',
  'danificado', 'avariado', 'tela manchada', 'burn-in',
];

// Normaliza texto removendo acentos e deixando minúsculo
function normalize(str) {
  return str.toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

// Verifica se o título é claramente um acessório
function isAccessory(title) {
  const t = normalize(title);
  if (ACCESSORY_KEYWORDS.some(kw => t.includes(normalize(kw)))) return true;
  // Títulos que começam com "cabo" ou "carregador" sozinhos
  if (/^(cabo|carregador|fonte|adaptador|suporte|pelicula|capinha|capa|fone|kit)/.test(t)) return true;
  return false;
}

function hasDefect(title) {
  const t = normalize(title);
  return DEFECT_KEYWORDS.some(kw => t.includes(normalize(kw)));
}

// Verifica se o anúncio é relevante para a keyword buscada
// Ex: buscou "iphone 12" mas veio "Fone Bluetooth Samsung"
function isRelevant(title, keyword) {
  if (!keyword) return true;
  const t = normalize(title);
  const kw = normalize(keyword);

  // Se o título contém a keyword inteira, é relevante
  if (t.includes(kw)) return true;

  // Pega as palavras principais da keyword (ignora palavras curtas e stopwords)
  const stopwords = ['de', 'do', 'da', 'os', 'as', 'um', 'uma', 'para', 'com', 'sem', 'pro', 'pra', 'e'];
  const words = kw.split(/\s+/).filter(w => w.length > 2 && !stopwords.includes(w));

  if (words.length === 0) return true;

  // Basta conter QUALQUER palavra principal da busca
  // Ex: "iphone 11" → título com "iphone" já passa
  const matched = words.filter(w => t.includes(w));
  return matched.length >= 1;
}

// Palavras que indicam que é acessório/embalagem, não o produto
const PACKAGE_KEYWORDS = [
  'caixa', 'embalagem', 'box', 'apenas caixa', 'só caixa', 'somente caixa',
  'caixa vazia', 'manual', 'acessório', 'acessorios',
];

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

    // Filtro de palavras bloqueadas personalizadas
    if (blockedWords && blockedWords.length > 0) {
      const t = normalize(title);
      if (blockedWords.some(w => w && t.includes(normalize(w)))) return false;
    }

    return true;
  });
}



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
  // Verifica se o cookie principal do Facebook ainda existe
  return cookies.some(c => c.name === 'c_user');
}

// Detecta o Chrome instalado
function findChromePath() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), '.cache', 'puppeteer', 'chrome', 'win64-121.0.6167.85', 'chrome-win64', 'chrome.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      console.log('Chrome encontrado em:', c);
      return c;
    }
  }
  return undefined;
}

async function launchBrowser(headless = false) {
  return puppeteer.launch({
    headless,
    defaultViewport: null,
    executablePath: findChromePath(),
    args: [
      '--start-maximized',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });
}

// Abre janela de login para o usuário autenticar
async function openLoginWindow(sessionId) {
  if (activeBrowsers[sessionId]) {
    await closeBrowser(sessionId);
  }

  const browser = await launchBrowser(false); // visível para login
  const [page] = await browser.pages();

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  // Se já tem cookies salvos, tenta restaurar sessão
  const savedCookies = loadCookies(sessionId);
  if (savedCookies) {
    await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded' });
    await page.setCookie(...savedCookies);
    await page.reload({ waitUntil: 'networkidle2' });
  } else {
    await page.goto('https://www.facebook.com/login', { waitUntil: 'domcontentloaded' });
  }

  activeBrowsers[sessionId] = { browser, page };
  return { ok: true };
}

// Verifica login e salva cookies se autenticado
async function checkLogin(sessionId) {
  // Se tem cookies salvos válidos, não precisa de browser aberto
  if (hasSavedCookies(sessionId) && !activeBrowsers[sessionId]) {
    return { loggedIn: true, fromCookies: true };
  }

  const session = activeBrowsers[sessionId];
  if (!session) return { loggedIn: false };

  try {
    const { page, browser } = session;
    const url = page.url();
    const cookies = await page.cookies();
    const hasSession = cookies.some(c => c.name === 'c_user');

    if (hasSession) {
      // Salva os cookies para uso futuro
      saveCookies(sessionId, cookies);
      console.log(`Cookies salvos para sessão ${sessionId}`);

      // Fecha o browser visível — não precisa mais dele
      try { await browser.close(); } catch {}
      delete activeBrowsers[sessionId];

      return { loggedIn: true, fromCookies: false };
    }

    if (!url.includes('/login') && !url.includes('/checkpoint')) {
      return { loggedIn: true };
    }

    return { loggedIn: false };
  } catch {
    return { loggedIn: false };
  }
}

// Busca anúncios usando cookies salvos (browser headless, invisível)
async function scrapeMarketplace(sessionId, keyword, location, maxItems = 40, options = {}) {
  const cookies = loadCookies(sessionId);
  if (!cookies) throw new Error('Sessão não encontrada. Faça login primeiro.');

  console.log(`Iniciando scraping headless para: ${keyword}`);

  // Abre browser invisível com os cookies salvos
  const browser = await launchBrowser(true); // headless = invisível
  const page = await browser.newPage();

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  // Restaura a sessão via cookies
  await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded' });
  await page.setCookie(...cookies);

  const encodedKeyword = encodeURIComponent(keyword);

  // Coordenadas das principais cidades para filtro por raio
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
    'franca':[-20.5386,-47.4008],'santos':[-23.9608,-46.3336],
  };

  // Mapeamento cidade → slug do Facebook
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
    // SP bairros
    'sao paulo — centro':'sao-paulo','sao paulo — zona sul':'sao-paulo',
    'sao paulo — zona norte':'sao-paulo','sao paulo — zona leste':'sao-paulo',
    'sao paulo — zona oeste':'sao-paulo','sao paulo — pinheiros':'pinheiros-sao-paulo',
    'sao paulo — vila mariana':'vila-mariana-sao-paulo','sao paulo — santana':'santana-sao-paulo',
    'sao paulo — santo andre':'santo-andre','sao paulo — mooca':'mooca-sao-paulo',
    'sao paulo — tatuape':'tatuape','sao paulo — itaquera':'itaquera',
    'sao paulo — campo limpo':'campo-limpo-sao-paulo','sao paulo — lapa':'lapa-sao-paulo',
    'sao paulo — penha':'penha-sao-paulo',
    // BA bairros
    'salvador — barra':'barra-salvador','salvador — itapua':'itapua-salvador',
    'salvador — pituba':'pituba','salvador — boca do rio':'boca-do-rio',
    'salvador — cajazeiras':'cajazeiras-salvador','salvador — liberdade':'liberdade-salvador',
    'salvador — brotas':'brotas-salvador',
    // CE bairros
    'fortaleza — aldeota':'aldeota','fortaleza — meireles':'meireles',
    'fortaleza — benfica':'benfica-fortaleza','fortaleza — messejana':'messejana',
    'fortaleza — barra do ceara':'barra-do-ceara','fortaleza — parangaba':'parangaba',
    // DF zonas
    'brasilia — asa norte':'asa-norte','brasilia — asa sul':'asa-sul',
    'brasilia — lago norte':'lago-norte','brasilia — lago sul':'lago-sul',
    // MG bairros
    'belo horizonte — savassi':'savassi','belo horizonte — lourdes':'lourdes-belo-horizonte',
    'belo horizonte — pampulha':'pampulha','belo horizonte — barreiro':'barreiro-belo-horizonte',
    'belo horizonte — venda nova':'venda-nova','belo horizonte — norte':'belo-horizonte',
    'belo horizonte — nordeste':'belo-horizonte',
    // PE bairros
    'recife — boa viagem':'boa-viagem','recife — casa forte':'casa-forte',
    'recife — afogados':'afogados','recife — imbiribeira':'imbiribeira',
    // PR bairros
    'curitiba — batel':'batel','curitiba — agua verde':'agua-verde-curitiba',
    'curitiba — boa vista':'boa-vista-curitiba','curitiba — cic':'cidade-industrial-curitiba',
    'curitiba — portao':'portao-curitiba','curitiba — cajuru':'cajuru-curitiba',
    // RS bairros
    'porto alegre — moinhos de vento':'moinhos-de-vento',
    'porto alegre — bela vista':'bela-vista-porto-alegre',
    'porto alegre — zona norte':'porto-alegre','porto alegre — zona sul':'porto-alegre',
    'porto alegre — zona leste':'porto-alegre',
    // SC bairros
    'florianopolis — centro':'florianopolis','florianopolis — norte da ilha':'norte-da-ilha-florianopolis',
    'florianopolis — sul da ilha':'sul-da-ilha-florianopolis',
    'florianopolis — leste da ilha':'florianopolis',
    // AM zonas
    'manaus — centro':'manaus','manaus — zona sul':'manaus','manaus — zona norte':'manaus',
    'manaus — zona leste':'manaus','manaus — zona oeste':'manaus',
    // MA bairros
    'sao luis — centro':'sao-luis','sao luis — renascenca':'sao-luis',
    'sao luis — cohama':'sao-luis','sao luis — calhau':'sao-luis',
    // GO bairros
    'goiania — setor bueno':'setor-bueno','goiania — setor oeste':'setor-oeste-goiania',
    'goiania — jardim goias':'jardim-goias','goiania — campinas':'campinas-goiania',
    // ES bairros
    'vitoria — centro':'vitoria','vitoria — praia do canto':'praia-do-canto',
    'vitoria — jardim da penha':'jardim-da-penha',
    'vila velha — itapua':'itapua-vila-velha','vila velha — praia da costa':'praia-da-costa',
    // PB bairros
    'joao pessoa — maneira':'joao-pessoa','joao pessoa — tambau':'tambau',
    'joao pessoa — bancarios':'joao-pessoa',
    // PI bairros
    'teresina — centro':'teresina','teresina — ininga':'teresina',
    'teresina — leste':'teresina',
    // MS
    'campo grande — centro':'campo-grande','campo grande — jardim dos estados':'campo-grande',
    // MT
    'cuiaba — centro':'cuiaba','cuiaba — cpa':'cuiaba',
    // PA bairros
    'belem — nazare':'nazare-belem','belem — umarizal':'umarizal',
    'belem — marco':'marco-belem','belem — pedreira':'pedreira-belem',
    'praia grande':'praia-grande','bauru':'bauru','marilia':'marilia',
    'americana':'americana','limeira':'limeira','piracicaba':'piracicaba',
    'jundiai':'jundiai','indaiatuba':'indaiatuba','sao jose dos campos':'sao-jose-dos-campos',
    'franca':'franca','guaruja':'guaruja','suzano':'suzano',
  };

  // Normaliza a cidade removendo acentos
  const cityRaw = (options.city || '').split(',')[0].trim()
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  const citySlug = CITY_SLUGS[cityRaw] || cityRaw.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

  const coords = CITY_COORDS[cityRaw];
  // Usa slug na URL — o Facebook troca a região quando o slug é diferente do perfil
  const url = citySlug
    ? `https://www.facebook.com/marketplace/${citySlug}/search/?query=${encodedKeyword}&sortBy=creation_time_descend`
    : `https://www.facebook.com/marketplace/search/?query=${encodedKeyword}&sortBy=creation_time_descend`;

  console.log(`[Scraper] URL: ${url}`);

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    await page.waitForSelector('a[href*="/marketplace/item/"]', {
      timeout: 15000,
    }).catch(() => null);

    // Scroll para carregar mais itens
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await delay(1200);
    }

    // Atualiza cookies após uso (mantém sessão fresca)
    const updatedCookies = await page.cookies();
    if (updatedCookies.some(c => c.name === 'c_user')) {
      saveCookies(sessionId, updatedCookies);
    }

    const listings = await page.evaluate(() => {
      const results = [];
      const seen = new Set();
      const anchors = document.querySelectorAll('a[href*="/marketplace/item/"]');

      anchors.forEach(anchor => {
        try {
          const href = anchor.href;
          if (!href || seen.has(href)) return;

          const idMatch = href.match(/\/item\/(\d+)/);
          const externalId = idMatch ? idMatch[1] : null;

          // Pega todos os spans de texto do card
          const allSpanTexts = [...anchor.querySelectorAll('span')]
            .map(s => s.textContent?.trim() || '')
            .filter(t => t.length > 0);

          // Preço: span que contém R$
          let priceRaw = '';
          for (const t of allSpanTexts) {
            if (t.includes('R$') && /R\$\s*[\d\.,]+/.test(t)) {
              priceRaw = t;
              break;
            }
          }

          // Título: primeiro span que NÃO é preço, NÃO é localização curta,
          // tem mais de 4 chars e não começa com R$
          let title = anchor.getAttribute('aria-label') || '';
          if (!title || title.includes('R$')) {
            for (const t of allSpanTexts) {
              if (
                t.length > 4 &&
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

          // Localização: procura span que contenha padrão "Cidade, UF" ou só cidade
          let loc = '';
          const stateAbbrs = ['AC','AL','AM','AP','BA','CE','DF','ES','GO','MA','MG','MS','MT','PA','PB','PE','PI','PR','RJ','RN','RO','RR','RS','SC','SE','SP','TO'];
          for (const t of allSpanTexts) {
            // Padrão "Cidade, UF"
            if (stateAbbrs.some(uf => t.endsWith(', ' + uf) || t.endsWith(', ' + uf + ' '))) {
              loc = t.trim();
              break;
            }
          }
          // Fallback: último span com texto razoável que não seja preço nem título
          if (!loc) {
            const candidates = allSpanTexts.filter(t =>
              t !== title &&
              !t.includes('R$') &&
              t.length > 2 && t.length < 60 &&
              !t.match(/^\d+$/)
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
    });

    await browser.close();

    const processed = listings.map(item => ({
      ...item,
      price: parsePrice(item.price_raw),
    }));

    // Aplica filtros — sem filtro de cidade pois o Facebook já filtra por localização na URL
    const filtered = filterListings(processed, {
      removeNoPrice: options.removeNoPrice !== false,
      removeAccessories: true,  // sempre ativo
      removeDefects: false,     // usuário controla via palavras bloqueadas
      keyword,
      blockedWords: options.blockedWords || [],
    });

    // Ordena pela proximidade da cidade buscada
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
  // Extrai apenas a parte numérica após R$
  const match = priceStr.match(/R\$\s*([\d\.,]+)/);
  if (!match) return null;
  const raw = match[1];
  // Trata separadores brasileiros: 1.500,00 → 1500.00
  let normalized;
  if (raw.includes(',')) {
    normalized = raw.replace(/\./g, '').replace(',', '.');
  } else if (raw.includes('.') && raw.split('.').length === 2 && raw.split('.')[1].length !== 3) {
    normalized = raw; // ex: 1500.00
  } else {
    // Remove pontos de milhar: 1.500 → 1500
    normalized = raw.replace(/\./g, '');
  }
  const num = parseFloat(normalized);
  // Rejeita valores absurdos
  if (isNaN(num) || num < 10 || num > 500000) return null;
  return num;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Calcula distância entre dois pontos em km (Haversine)
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
  'belford roxo':[-22.7642,-43.3967],'nilópolis':[-22.8028,-43.4197],
  'mesquita':[-22.7814,-43.4375],'queimados':[-22.7172,-43.5572],
  'teresopolis':[-22.4122,-42.9781],'araruama':[-22.8722,-42.3442],
  'resende':[-22.4681,-44.4508],'saquarema':[-22.9203,-42.5100],
  'angra dos reis':[-23.0067,-44.3183],'nova friburgo':[-22.2817,-42.5319],
  'campos dos goytacazes':[-21.7542,-41.3244],'macae':[-22.3711,-41.7869],
  'barra mansa':[-22.5442,-44.1717],'itaguai':[-22.8594,-43.7769],
  'palhoca':[-27.6447,-48.6697],'sao jose':[-27.5953,-48.6349],
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
  if (!coords) {
    return listings;
  }
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
  scrapeMarketplace,
  closeBrowser,
  analyzeListings,
  hasSavedCookies,
  saveCookies,
};
