import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Yahoo Finance auth (crumb + cookie) ─────────────────
let yfAuth = { crumb: null, cookie: null, fetchedAt: 0 };
const AUTH_TTL = 60 * 60 * 1000; // 1 hour

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── Sentiment word lists ─────────────────────────────────
const POSITIVE_WORDS = [
  'beat','beats','exceeded','record','growth','gain','gains','profit','profits',
  'surge','surges','surging','soar','soars','rise','rises','rally','rallies',
  'strong','upgrade','upgrades','upgraded','bullish','increase','increases',
  'expand','launch','success','revenue','dividend','buyback','outperform',
  'overweight','breakthrough','opportunity','recovery','rebound','accelerate',
  'improves','improved','upside','optimistic','raise','raises','partnership',
  'deal','contract','award','record high','all-time high','strong buy',
];
const NEGATIVE_WORDS = [
  'loss','losses','miss','misses','missed','decline','declines','fall','falls',
  'drop','drops','cut','cuts','warn','warns','warning','lawsuit','sued','sues',
  'bankruptcy','bankrupt','downgrade','downgrades','downgraded','bearish',
  'decrease','decreases','crash','fraud','investigation','recall','layoff',
  'layoffs','fine','fines','penalty','penalties','weak','concern','concerns',
  'uncertainty','uncertain','disappointing','disappoints','struggles','slump',
  'tumble','plunge','plunges','selloff','sell-off','recession','inflation',
  'shortfall','deficit','suspend','halt','probe','charges','charged',
  'class action','headwinds','challenges','downside','below expectations',
];

// ─── Risk cache ───────────────────────────────────────────
const riskCache = new Map();
const RISK_TTL = 15 * 60 * 1000;

async function getYFAuth() {
  const now = Date.now();
  if (yfAuth.crumb && yfAuth.cookie && (now - yfAuth.fetchedAt) < AUTH_TTL) {
    return yfAuth;
  }

  console.log('Refreshing Yahoo Finance auth...');

  // Step 1: Get cookie from fc.yahoo.com
  const fcRes = await fetch('https://fc.yahoo.com', {
    headers: { 'User-Agent': UA },
  });
  const m = (fcRes.headers.get('set-cookie') || '').match(/([A-Z0-9_]+=[^;]+)/g) || [];
  const cookie = m.map(c => c.split(';')[0]).join('; ');

  // Step 2: Get crumb
  const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, 'Cookie': cookie },
  });
  if (!crumbRes.ok) {
    throw new Error(`Failed to get crumb: ${crumbRes.status} ${crumbRes.statusText}`);
  }
  const crumb = await crumbRes.text();
  if (!crumb || crumb.length > 30) {
    throw new Error(`Invalid crumb response: ${crumb.slice(0, 50)}`);
  }

  yfAuth = { crumb, cookie, fetchedAt: now };
  console.log(`Yahoo Finance auth refreshed. Crumb: ${crumb.slice(0, 8)}...`);
  return yfAuth;
}

// ─── In-memory cache ──────────────────────────────────────
let symbolCache = { data: null, cachedAt: 0 };
const SYMBOL_TTL = 24 * 60 * 60 * 1000;

// ─── Fetch NASDAQ symbols ─────────────────────────────────
async function fetchNasdaqSymbols() {
  const now = Date.now();
  if (symbolCache.data && (now - symbolCache.cachedAt) < SYMBOL_TTL) {
    return symbolCache.data;
  }

  const url = 'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt';
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TradeInfo/1.0)' }
  });
  if (!res.ok) throw new Error(`Failed to fetch NASDAQ symbols: ${res.status}`);

  const text = await res.text();
  const lines = text.trim().split('\n');
  const dataLines = lines.slice(1, -1);

  const symbols = [];
  for (const line of dataLines) {
    const parts = line.split('|');
    if (parts.length < 7) continue;
    const symbol = parts[0].trim();
    const name = parts[1].trim();
    const testIssue = parts[3].trim();
    if (testIssue === 'Y') continue;
    if (!symbol || symbol.includes('^') || symbol.includes('/')) continue;
    symbols.push({ symbol, name });
  }

  symbolCache = { data: symbols, cachedAt: now };
  console.log(`Cached ${symbols.length} NASDAQ symbols`);
  return symbols;
}

// ─── Fetch quotes from Yahoo Finance v7 ──────────────────
async function fetchYahooQuotes(symbols) {
  const auth = await getYFAuth();
  const symbolStr = symbols.join(',');

  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbolStr)}&crumb=${encodeURIComponent(auth.crumb)}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json',
      'Referer': 'https://finance.yahoo.com/',
      'Cookie': auth.cookie,
    },
  });

  if (res.status === 401 || res.status === 403) {
    yfAuth = { crumb: null, cookie: null, fetchedAt: 0 };
    return fetchYahooQuotes(symbols);
  }

  if (!res.ok) {
    throw new Error(`Yahoo Finance API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const results = data?.quoteResponse?.result || [];
  const errors = data?.quoteResponse?.error;
  if (errors) console.warn('Yahoo Finance errors:', errors);
  return results;
}

// ─── Fetch 5-day price history ────────────────────────────
async function fetchPriceHistory(symbol) {
  const auth = await getYFAuth();
  const url = `https://query1.finance.yahoo.com/v7/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d&crumb=${encodeURIComponent(auth.crumb)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com/', 'Cookie': auth.cookie },
  });
  if (res.status === 401 || res.status === 403) {
    yfAuth = { crumb: null, cookie: null, fetchedAt: 0 };
    return fetchPriceHistory(symbol);
  }
  if (!res.ok) throw new Error(`Chart API: ${res.status}`);
  const data = await res.json();
  return data?.chart?.result?.[0] ?? null;
}

// ─── Fetch news (normalized to { title, link, publisher, time, source }) ──
async function fetchYahooNews(symbol) {
  const auth = await getYFAuth();
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&newsCount=15&quotesCount=0`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com/', 'Cookie': auth.cookie },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data?.news ?? []).map(n => ({
    title:     n.title ?? '',
    link:      n.link ?? '',
    publisher: n.publisher ?? 'Yahoo Finance',
    time:      n.providerPublishTime ?? 0,
    summary:   n.summary ?? '',
    source:    'yahoo',
  }));
}

async function fetchGoogleNews(symbol) {
  const q = encodeURIComponent(`${symbol} stock`);
  const url = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) return [];
  const xml = await res.text();
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const x = m[1];
    const title = (x.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1] ?? '').trim();
    const link  = (x.match(/<link>(.*?)<\/link>/)?.[1] ?? '').trim();
    const pub   = (x.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] ?? 'Google News').trim();
    const date  = (x.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] ?? '').trim();
    if (title && link) {
      items.push({ title, link, publisher: pub, time: date ? Math.floor(new Date(date) / 1000) : 0, summary: '', source: 'google' });
    }
    if (items.length >= 15) break;
  }
  return items;
}

async function fetchRedditPosts(symbol) {
  const url = `https://www.reddit.com/r/stocks+investing+wallstreetbets/search.json?q=${encodeURIComponent(symbol)}&sort=new&t=week&limit=15`;
  const res = await fetch(url, { headers: { 'User-Agent': 'TradeInfo/1.0' } });
  if (!res.ok) return [];
  const data = await res.json();
  return (data?.data?.children ?? []).map(p => ({
    title:     p.data.title ?? '',
    link:      `https://reddit.com${p.data.permalink}`,
    publisher: `r/${p.data.subreddit}`,
    time:      Math.floor(p.data.created_utc ?? 0),
    summary:   p.data.selftext ? p.data.selftext.slice(0, 300) : '',
    source:    'reddit',
  }));
}

// ─── Risk calculations ────────────────────────────────────
function calcPriceRisk(chartResult) {
  const q       = chartResult?.indicators?.quote?.[0];
  const closes  = (q?.close  ?? []).filter(v => v != null);
  const volumes = (q?.volume ?? []).filter(v => v != null);
  if (closes.length < 2) return { score: 50, detail: 'Otillräcklig data', todayDetail: '', volumeDetail: '' };

  // Daily returns
  const returns = [];
  for (let i = 1; i < closes.length; i++) returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);

  const todayReturn = returns.at(-1) ?? 0;
  const days        = Math.min(3, returns.length);
  const trend3d     = returns.slice(-days).reduce((a, b) => a + b, 0);

  // Annualized volatility
  const mean   = returns.reduce((a, b) => a + b, 0) / returns.length;
  const stdDev = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length) * Math.sqrt(252);

  // Volume ratio: today vs average of prior days
  let volumeRatio = 1;
  if (volumes.length >= 2) {
    const todayVol = volumes.at(-1);
    const priorVol = volumes.slice(0, -1);
    const avgVol   = priorVol.reduce((a, b) => a + b, 0) / priorVol.length;
    if (avgVol > 0) volumeRatio = todayVol / avgVol;
  }

  // Score components
  const returnContrib = -trend3d * 300;            // negative 3d trend → +risk
  const todayContrib  = -todayReturn * 200;         // extra weight on today
  const volContrib    = stdDev * 50;                // high volatility → +risk
  // High volume amplifies the direction: big sell-off on high volume = worse
  const volAmp = volumeRatio > 1.3
    ? (todayReturn < 0 ? (volumeRatio - 1) * 10 : -(volumeRatio - 1) * 5)
    : 0;

  const score     = Math.round(Math.max(5, Math.min(95, 50 + returnContrib + todayContrib + volContrib + volAmp)));
  const s3        = trend3d   >= 0 ? '+' : '';
  const sT        = todayReturn >= 0 ? '+' : '';
  const volStr    = volumeRatio.toFixed(1) + '× snitt';

  return {
    score,
    detail:       `3d: ${s3}${(trend3d * 100).toFixed(1)}%`,
    todayDetail:  `Idag: ${sT}${(todayReturn * 100).toFixed(1)}%`,
    volumeDetail: `Volym: ${volStr}`,
  };
}

function calcNewsRisk(items) {
  if (!items?.length) return { score: 50, detail: '0 nyheter', positive: [], negative: [] };
  let totalPos = 0, totalNeg = 0;

  const scored = items.map(item => {
    const text = ((item.title ?? '') + ' ' + (item.summary ?? '')).toLowerCase();
    let pos = 0, neg = 0;
    for (const w of POSITIVE_WORDS) if (text.includes(w)) pos++;
    for (const w of NEGATIVE_WORDS) if (text.includes(w)) neg++;
    totalPos += pos; totalNeg += neg;
    return { title: item.title, link: item.link, publisher: item.publisher, time: item.time, source: item.source, score: pos - neg };
  });

  const positive = scored.filter(a => a.score > 0).sort((a, b) => b.score - a.score);
  const negative = scored.filter(a => a.score < 0).sort((a, b) => a.score - b.score);

  const total = totalPos + totalNeg;
  if (!total) return { score: 50, detail: `${items.length} art., neutralt`, positive, negative };
  const sentiment = (totalNeg - totalPos) / total;
  const score = Math.round(Math.max(5, Math.min(95, 50 + sentiment * 40)));
  const label = sentiment < -0.2 ? 'positivt' : sentiment > 0.2 ? 'negativt' : 'neutralt';
  return { score, detail: `${items.length} art., ${label}`, positive, negative };
}

function riskMeta(score) {
  if (score < 30) return { level: 'low',       label: 'Låg risk',        color: '#3fb950' };
  if (score < 55) return { level: 'medium',    label: 'Medelhög risk',   color: '#d29922' };
  if (score < 75) return { level: 'high',      label: 'Hög risk',        color: '#f0883e' };
  return              { level: 'very-high', label: 'Mycket hög risk', color: '#f85149' };
}

function normalizeQuote(q) {
  const ts = q.regularMarketTime;
  return {
    symbol: q.symbol,
    name: q.longName || q.shortName || q.symbol,
    price: q.regularMarketPrice ?? null,
    change: q.regularMarketChange ?? null,
    changePct: q.regularMarketChangePercent ?? null,
    open: q.regularMarketOpen ?? null,
    prevClose: q.regularMarketPreviousClose ?? null,
    dayHigh: q.regularMarketDayHigh ?? null,
    dayLow: q.regularMarketDayLow ?? null,
    volume: q.regularMarketVolume ?? null,
    avgVolume: q.averageDailyVolume3Month ?? null,
    marketCap: q.marketCap ?? null,
    pe: q.trailingPE ?? null,
    forwardPE: q.forwardPE ?? null,
    eps: q.epsTrailingTwelveMonths ?? null,
    week52High: q.fiftyTwoWeekHigh ?? null,
    week52Low: q.fiftyTwoWeekLow ?? null,
    dividendYield: q.trailingAnnualDividendYield ?? q.dividendYield ?? null,
    beta: q.beta ?? null,
    bid: q.bid ?? null,
    ask: q.ask ?? null,
    bidSize: q.bidSize ?? null,
    askSize: q.askSize ?? null,
    priceToBook: q.priceToBook ?? null,
    bookValue: q.bookValue ?? null,
    ma50: q.fiftyDayAverage ?? null,
    ma200: q.twoHundredDayAverage ?? null,
    marketState: q.marketState ?? 'UNKNOWN',
    currency: q.currency ?? 'USD',
    quoteType: q.quoteType ?? null,
    timestamp: typeof ts === 'number' ? ts * 1000 : Date.now(),
  };
}

// ─── API Routes ───────────────────────────────────────────

// GET /api/nasdaq-symbols
app.get('/api/nasdaq-symbols', async (req, res) => {
  try {
    const symbols = await fetchNasdaqSymbols();
    res.json(symbols);
  } catch (err) {
    console.error('Error fetching NASDAQ symbols:', err.message);
    res.status(503).json({ error: 'Failed to fetch NASDAQ symbol list', message: err.message });
  }
});

// GET /api/quote?symbols=AAPL,MSFT
app.get('/api/quote', async (req, res) => {
  const symbolParam = req.query.symbols;
  if (!symbolParam) return res.status(400).json({ error: 'symbols parameter required' });

  const symbols = symbolParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (symbols.length === 0) return res.status(400).json({ error: 'No valid symbols provided' });
  if (symbols.length > 100) return res.status(400).json({ error: 'Maximum 100 symbols per request' });

  try {
    const BATCH = 40;
    const batches = [];
    for (let i = 0; i < symbols.length; i += BATCH) batches.push(symbols.slice(i, i + BATCH));

    const results = await Promise.all(batches.map(batch => fetchYahooQuotes(batch).catch(e => {
      console.error('Batch error:', e.message);
      return [];
    })));

    const normalized = results.flat().filter(Boolean).map(normalizeQuote);
    res.json(normalized);
  } catch (err) {
    console.error('Error fetching quotes:', err.message);
    res.status(500).json({ error: 'Failed to fetch quotes', message: err.message });
  }
});

// GET /api/risk/:symbol
app.get('/api/risk/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();

  const cached = riskCache.get(symbol);
  if (cached && (Date.now() - cached.cachedAt) < RISK_TTL) return res.json(cached.data);

  try {
    const [chartResult, yahooItems, googleItems, redditItems] = await Promise.all([
      fetchPriceHistory(symbol).catch(() => null),
      fetchYahooNews(symbol).catch(() => []),
      fetchGoogleNews(symbol).catch(() => []),
      fetchRedditPosts(symbol).catch(() => []),
    ]);
    // Build a list of terms to match against: symbol + significant name words
    const companyName = symbolCache.data?.find(s => s.symbol === symbol)?.name ?? '';
    const nameWords = companyName
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && !['corp', 'inc.', 'inc', 'ltd', 'llc', 'the', 'and', 'group', 'holdings', 'class'].includes(w));
    const terms = [symbol.toLowerCase(), ...nameWords];

    const allItems = [...yahooItems, ...googleItems, ...redditItems].filter(item => {
      const text = (item.title + ' ' + item.summary).toLowerCase();
      return terms.some(t => text.includes(t));
    });

    const priceRisk = calcPriceRisk(chartResult);
    const newsRisk  = calcNewsRisk(allItems);
    const score = Math.round(priceRisk.score * 0.55 + newsRisk.score * 0.45);
    const meta  = riskMeta(score);
    const data  = { symbol, score, ...meta, priceRisk, newsRisk };
    riskCache.set(symbol, { data, cachedAt: Date.now() });
    res.json(data);
  } catch (err) {
    console.error(`Risk error ${symbol}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', symbolsCached: symbolCache.data?.length ?? 0, authReady: !!yfAuth.crumb });
});

// ─── Start server ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`TradeInfo server running at http://localhost:${PORT}`);
  fetchNasdaqSymbols().catch(err => console.error('Symbol pre-warm failed:', err.message));
  getYFAuth().catch(err => console.error('Auth pre-warm failed:', err.message));
});
