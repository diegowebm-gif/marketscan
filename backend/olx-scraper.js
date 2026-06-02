const puppeteer = require('puppeteer');
const path = require('path');
const os = require('os');
const fs = require('fs');

function findChromePath() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), '.cache', 'puppeteer', 'chrome', 'win64-121.0.6167.85', 'chrome-win64', 'chrome.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return undefined;
}

function normalize(str) {
  return (str || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function parsePrice(str) {
  if (!str) return null;
  const match = str.match(/R\$\s*([\d\.,]+)/);
  if (!match) return null;
  const raw = match[1];
  let normalized = raw.includes(',')
    ? raw.replace(/\./g, '').replace(',', '.')
    : raw.replace(/\./g, '');
  const num = parseFloat(normalized);
  return isNaN(num) || num < 10 || num > 500000 ? null : num;
}

function isRelevant(title, keyword) {
  if (!keyword) return true;
  const t = normalize(title);
  const kw = normalize(keyword);
  if (t.includes(kw)) return true;
  const words = kw.split(/\s+/).filter(w => w.length > 2);
  if (!words.length) return true;
  const matched = words.filter(w => t.includes(w));
  return matched.length >= Math.ceil(words.length / 2);
}

async function scrapeOLX(keyword, city, maxItems = 30) {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: findChromePath(),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  // Monta URL da OLX com cidade normalizada (sem acentos)
  // Mapeamento cidade → slug OLX (usa regiões/estados)
  const OLX_SLUGS = {
    // RJ
    'marica':'regiao-de-niteroi-rj','niteroi':'regiao-de-niteroi-rj',
    'sao goncalo':'regiao-de-niteroi-rj','itaborai':'regiao-de-niteroi-rj',
    'rio de janeiro':'estado-do-rio-de-janeiro','duque de caxias':'grande-rio',
    'nova iguacu':'grande-rio','belford roxo':'grande-rio',
    'petropolis':'regiao-serrana-rj','cabo frio':'regiao-dos-lagos-rj',
    'volta redonda':'sul-fluminense','campos dos goytacazes':'norte-fluminense',
    // SP
    'sao paulo':'estado-de-sao-paulo','campinas':'campinas-e-regiao',
    'santos':'baixada-santista','sao jose dos campos':'vale-do-paraiba-sp',
    'ribeirao preto':'ribeirao-preto-e-regiao','sorocaba':'sorocaba-e-regiao',
    // MG
    'belo horizonte':'estado-de-minas-gerais','uberlandia':'triangulo-mineiro',
    'juiz de fora':'zona-da-mata-mg',
    // RS
    'porto alegre':'estado-do-rio-grande-do-sul','caxias do sul':'serra-gaucha',
    // SC
    'florianopolis':'estado-de-santa-catarina','joinville':'norte-catarinense',
    // PR
    'curitiba':'estado-do-parana','londrina':'norte-do-parana',
    // BA
    'salvador':'estado-da-bahia',
    // CE
    'fortaleza':'estado-do-ceara',
    // PE
    'recife':'estado-de-pernambuco',
    // GO
    'goiania':'estado-de-goias',
    // DF
    'brasilia':'distrito-federal-e-entorno',
    // AM
    'manaus':'estado-do-amazonas',
    // PA
    'belem':'estado-do-para',
    // MA
    'sao luis':'estado-do-maranhao',
    // PI
    'teresina':'estado-do-piaui',
    // AL
    'maceio':'estado-de-alagoas',
    // SE
    'aracaju':'estado-de-sergipe',
    // RN
    'natal':'estado-do-rio-grande-do-norte',
    // PB
    'joao pessoa':'estado-da-paraiba',
    // MT
    'cuiaba':'estado-do-mato-grosso',
    // MS
    'campo grande':'estado-do-mato-grosso-do-sul',
    // ES
    'vitoria':'estado-do-espirito-santo',
  };

  const cityKey = normalize((city || '').split(',')[0].trim());
  const olxSlug = OLX_SLUGS[cityKey] || 'brasil';
  const encodedKeyword = encodeURIComponent(keyword);
  const url = `https://www.olx.com.br/${olxSlug}?q=${encodedKeyword}&o=1`;

  console.log(`[OLX] Buscando: ${url}`);

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Debug: ver o que a OLX está retornando
    const pageTitle = await page.title();
    const pageUrl = page.url();
    console.log(`[OLX] Página carregada: "${pageTitle}" | URL: ${pageUrl}`);

    // Tenta vários seletores
    const selector = await Promise.race([
      page.waitForSelector('[data-lurker-detail]', { timeout: 8000 }).then(() => '[data-lurker-detail]'),
      page.waitForSelector('section[data-ds-component="DS-NewAdCard"]', { timeout: 8000 }).then(() => 'DS-NewAdCard'),
      page.waitForSelector('li[class*="fnmrjs"]', { timeout: 8000 }).then(() => 'fnmrjs'),
      page.waitForSelector('a[href*="/anuncio/"]', { timeout: 8000 }).then(() => 'anuncio-link'),
      new Promise(r => setTimeout(() => r('timeout'), 8000)),
    ]).catch(() => 'timeout');

    console.log(`[OLX] Seletor encontrado: ${selector}`);

    // Conta elementos
    const counts = await page.evaluate(() => {
      return {
        lurker: document.querySelectorAll('[data-lurker-detail]').length,
        articles: document.querySelectorAll('article').length,
        links: document.querySelectorAll('a[href*="/anuncio/"]').length,
        sections: document.querySelectorAll('section').length,
        nextData: !!document.getElementById('__NEXT_DATA__'),
        bodyLen: document.body?.innerHTML?.length || 0,
      };
    });
    console.log('[OLX] Elementos encontrados:', JSON.stringify(counts));

    const listings = await page.evaluate((kw) => {
      const results = [];
      const seen = new Set();

      // Seletores da OLX (tenta múltiplos formatos)
      const cards = document.querySelectorAll(
        'section[data-lurker-detail], li[data-lurker-detail], article[data-lurker-detail], [class*="AdCard"], [class*="ad-card"]'
      );

      cards.forEach(card => {
        try {
          // Título
          const titleEl = card.querySelector('h2, h3, [class*="title"], [class*="Title"]');
          const title = titleEl?.textContent?.trim() || '';
          if (!title || title.length < 3) return;

          // Preço
          const priceEl = card.querySelector('[class*="price"], [class*="Price"], [data-testid*="price"]');
          const priceRaw = priceEl?.textContent?.trim() || '';

          // Link
          const linkEl = card.querySelector('a[href*="/item/"], a[href*="olx.com.br"]');
          const url = linkEl?.href || '';
          if (!url || seen.has(url)) return;

          // Localização
          const locEl = card.querySelector('[class*="location"], [class*="Location"], [class*="city"]');
          const location = locEl?.textContent?.trim() || '';

          // Imagem
          const imgEl = card.querySelector('img');
          const imageUrl = imgEl?.src || imgEl?.dataset?.src || '';

          seen.add(url);
          results.push({ title, price_raw: priceRaw, location, listing_url: url, image_url: imageUrl, source: 'olx' });
        } catch {}
      });

      // Fallback: tenta pegar via JSON do Next.js
      if (results.length === 0) {
        try {
          const nextData = document.getElementById('__NEXT_DATA__');
          if (nextData) {
            const data = JSON.parse(nextData.textContent);
            const ads = data?.props?.pageProps?.ads ||
                        data?.props?.pageProps?.listingProps?.ads || [];
            ads.forEach(ad => {
              const title = ad.title || ad.subject || '';
              const price = ad.price?.value?.raw || ad.priceValue || '';
              const url = ad.url || '';
              if (title && url && !seen.has(url)) {
                seen.add(url);
                results.push({
                  title,
                  price_raw: typeof price === 'number' ? `R$ ${price}` : price,
                  location: ad.location?.municipality?.name || '',
                  listing_url: url,
                  image_url: ad.images?.[0]?.original || '',
                  source: 'olx',
                });
              }
            });
          }
        } catch {}
      }

      return results;
    }, keyword);

    await browser.close();

    const processed = listings
      .filter(l => isRelevant(l.title, keyword))
      .map(l => ({ ...l, price: parsePrice(l.price_raw) }))
      .slice(0, maxItems);

    console.log(`[OLX] ${processed.length} anúncios encontrados`);
    return processed;

  } catch (err) {
    await browser.close().catch(() => null);
    console.error('[OLX] Erro:', err.message);
    return [];
  }
}

function analyzeOLX(listings) {
  const withPrice = listings.filter(l => l.price !== null && l.price > 0);
  if (withPrice.length === 0) return { listings, stats: null };
  const prices = withPrice.map(l => l.price).sort((a, b) => a - b);
  const avg = prices.reduce((s, p) => s + p, 0) / prices.length;
  const median = prices[Math.floor(prices.length / 2)];
  const threshold = avg * 0.70;
  const analyzed = listings.map(l => ({
    ...l,
    is_opportunity: l.price !== null && l.price <= threshold,
    pct_below_avg: l.price !== null ? Math.round(((avg - l.price) / avg) * 100) : null,
  }));
  return {
    listings: analyzed,
    stats: {
      total: listings.length, with_price: withPrice.length,
      avg: Math.round(avg * 100) / 100,
      median: Math.round(median * 100) / 100,
      min: prices[0], max: prices[prices.length - 1],
      opportunity_threshold: Math.round(threshold * 100) / 100,
      opportunities: analyzed.filter(l => l.is_opportunity).length,
    },
  };
}

module.exports = { scrapeOLX, analyzeOLX };
