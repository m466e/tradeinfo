import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

// Load .env file if present (no external dependency)
try {
  const env = readFileSync(new URL('.env', import.meta.url), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
} catch {}

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

// ─── LRU Cache ────────────────────────────────────────────
class LRUCache {
  constructor(max) {
    this.max = max;
    this.cache = new Map();
  }
  get(key) {
    if (!this.cache.has(key)) return undefined;
    const val = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, val);
    return val;
  }
  set(key, val) {
    if (this.cache.has(key)) this.cache.delete(key);
    else if (this.cache.size >= this.max) {
      this.cache.delete(this.cache.keys().next().value);
    }
    this.cache.set(key, val);
  }
  has(key) { return this.cache.has(key); }
}

// ─── Risk cache (LRU, max 50 entries) ────────────────────
const riskCache = new LRUCache(50);
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

// ─── Auth with exponential backoff retry ─────────────────
async function getYFAuthWithRetry(maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      yfAuth = { crumb: null, cookie: null, fetchedAt: 0 };
      return await getYFAuth();
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      const delay = 1000 * 2 ** (attempt - 1);
      console.warn(`Auth attempt ${attempt} failed, retrying in ${delay}ms:`, err.message);
      await new Promise(r => setTimeout(r, delay));
    }
  }
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
// retryAuth flag prevents infinite recursion
async function fetchYahooQuotes(symbols, retryAuth = false) {
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
    if (retryAuth) throw new Error(`Yahoo Finance auth failed after retry: ${res.status}`);
    console.warn(`Quote fetch got ${res.status}, refreshing auth with retry...`);
    await getYFAuthWithRetry();
    return fetchYahooQuotes(symbols, true);
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

// ─── Fetch 1-month daily price history ───────────────────
async function fetchPriceHistory(symbol, retryAuth = false) {
  const auth = await getYFAuth();
  const url = `https://query1.finance.yahoo.com/v7/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1mo&crumb=${encodeURIComponent(auth.crumb)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com/', 'Cookie': auth.cookie },
  });
  if (res.status === 401 || res.status === 403) {
    if (retryAuth) throw new Error(`Price history auth failed after retry: ${res.status}`);
    console.warn(`Price history got ${res.status}, refreshing auth with retry...`);
    await getYFAuthWithRetry();
    return fetchPriceHistory(symbol, true);
  }
  if (!res.ok) throw new Error(`Chart API: ${res.status}`);
  const data = await res.json();
  return data?.chart?.result?.[0] ?? null;
}

// ─── Fetch intraday chart via Finnhub (1m candles) ───────
const FINNHUB_TOKEN  = (process.env.FINNHUB_TOKEN  ?? '').trim();
const ALPACA_KEY     = (process.env.ALPACA_KEY     ?? '').trim();
const ALPACA_SECRET  = (process.env.ALPACA_SECRET  ?? '').trim();

async function fetchIntradayChartFinnhub(symbol) {
  if (!FINNHUB_TOKEN) throw new Error('FINNHUB_TOKEN saknas');
  const to   = Math.floor(Date.now() / 1000);
  const from = to - 24 * 3600;
  const url  = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=1&from=${from}&to=${to}&token=${FINNHUB_TOKEN}`;
  const res  = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (res.status === 403) throw new Error('Finnhub 403 – intradag-candles kräver betald plan');
  if (!res.ok) throw new Error(`Finnhub: ${res.status}`);
  const data = await res.json();
  if (data.s !== 'ok') throw new Error(`Finnhub: ${data.s ?? 'no_data'}`);
  return { timestamps: data.t, closes: data.c, open: data.o?.[0] ?? data.c?.[0], source: 'finnhub' };
}

// ─── Fetch intraday chart via Yahoo Finance (1m fallback) ─
async function fetchIntradayChartYahoo(symbol, retryAuth = false) {
  const auth = await getYFAuth();
  const url  = `https://query1.finance.yahoo.com/v7/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=false&crumb=${encodeURIComponent(auth.crumb)}`;
  const res  = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com/', 'Cookie': auth.cookie },
  });
  if ((res.status === 401 || res.status === 403) && !retryAuth) {
    await getYFAuthWithRetry();
    return fetchIntradayChartYahoo(symbol, true);
  }
  if (!res.ok) throw new Error(`Yahoo chart: ${res.status}`);
  const json   = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error('Yahoo chart: tomt svar');
  const timestamps = result.timestamp ?? [];
  const closes     = result.indicators?.quote?.[0]?.close ?? [];
  const filtered   = timestamps.map((t, i) => ({ t, c: closes[i] })).filter(p => p.c != null);
  return {
    timestamps: filtered.map(p => p.t),
    closes:     filtered.map(p => p.c),
    open:       result.indicators?.quote?.[0]?.open?.[0] ?? filtered[0]?.c ?? null,
    source:     'yahoo',
  };
}

// ─── Fetch intraday chart via Alpaca (1m candles, IEX feed) ──
async function fetchIntradayChartAlpaca(symbol) {
  if (!ALPACA_KEY || !ALPACA_SECRET) throw new Error('ALPACA_KEY/ALPACA_SECRET saknas');

  // Today's market session: 09:30–16:00 ET
  const now   = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);

  const url = `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars`
    + `?timeframe=1Min`
    + `&start=${start.toISOString()}`
    + `&end=${now.toISOString()}`
    + `&feed=iex`
    + `&limit=1000`;

  const res = await fetch(url, {
    headers: {
      'APCA-API-KEY-ID':     ALPACA_KEY,
      'APCA-API-SECRET-KEY': ALPACA_SECRET,
      'Accept':              'application/json',
    },
  });
  if (!res.ok) throw new Error(`Alpaca: ${res.status}`);
  const data = await res.json();
  const bars = data.bars ?? [];
  if (!bars.length) throw new Error('Alpaca: inga bars returnerades');

  return {
    timestamps: bars.map(b => Math.floor(new Date(b.t).getTime() / 1000)),
    closes:     bars.map(b => b.c),
    open:       bars[0]?.o ?? bars[0]?.c ?? null,
    source:     'alpaca',
  };
}

async function fetchIntradayChart(symbol) {
  try {
    return await fetchIntradayChartYahoo(symbol);
  } catch (err) {
    console.warn(`[chart] Yahoo misslyckades (${err.message})`);
  }
  if (ALPACA_KEY && ALPACA_SECRET) {
    try {
      return await fetchIntradayChartAlpaca(symbol);
    } catch (err) {
      console.warn(`[chart] Alpaca misslyckades (${err.message})`);
    }
  }
  if (FINNHUB_TOKEN) {
    return fetchIntradayChartFinnhub(symbol);
  }
  throw new Error('Alla diagramkällor misslyckades');
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
function calcPriceRisk(chartResult, quote) {
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

  let score       = Math.round(Math.max(5, Math.min(95, 50 + returnContrib + todayContrib + volContrib + volAmp)));
  const s3        = trend3d   >= 0 ? '+' : '';
  const sT        = todayReturn >= 0 ? '+' : '';
  const volStr    = volumeRatio.toFixed(1) + '× snitt';

  // Bid-Ask spread component — widens risk score for illiquid quotes
  if (quote?.bid > 0 && quote?.ask > 0 && quote?.price > 0) {
    const spread = (quote.ask - quote.bid) / quote.price;
    if (spread > 0.005) score = Math.min(100, score + 20);       // > 50 bps: kritisk
    else if (spread > 0.002) score = Math.min(100, score + 10);  // > 20 bps: varning
    else if (spread > 0.0005) score = Math.min(100, score + 5);  // > 5 bps: noterbar
  }

  return {
    score,
    detail:       `3d: ${s3}${(trend3d * 100).toFixed(1)}%`,
    todayDetail:  `Idag: ${sT}${(todayReturn * 100).toFixed(1)}%`,
    volumeDetail: `Volym: ${volStr}`,
  };
}

function calcStopLoss(chartResult) {
  const q      = chartResult?.indicators?.quote?.[0];
  const closes = q?.close  ?? [];
  const highs  = q?.high   ?? [];
  const lows   = q?.low    ?? [];

  // Align: keep only indices where all three are non-null
  const valid = closes.map((c, i) => ({ c, h: highs[i], l: lows[i] }))
                       .filter(v => v.c != null && v.h != null && v.l != null);

  if (valid.length < 3) return null;

  const currentPrice = valid.at(-1).c;
  const N = Math.min(14, valid.length - 1);
  const slice = valid.slice(-N - 1);      // N+1 bars to compute N true ranges

  // Average True Range over N periods
  let atrSum = 0;
  for (let i = 1; i <= N; i++) {
    const { h, l } = slice[i];
    const prev = slice[i - 1].c;
    atrSum += Math.max(h - l, Math.abs(h - prev), Math.abs(l - prev));
  }
  const atr = atrSum / N;

  // Recent swing low: lowest low over last 10 bars
  const swingLow = Math.min(...valid.slice(-10).map(v => v.l));

  function stop(price) {
    return { price, pct: +((price - currentPrice) / currentPrice * 100).toFixed(2) };
  }

  return {
    atr,
    currentPrice,
    tight:    stop(currentPrice - 1.5 * atr),
    standard: stop(currentPrice - 2.0 * atr),
    wide:     stop(currentPrice - 3.0 * atr),
    swingLow: stop(swingLow),
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

// ─── RSI helper ───────────────────────────────────────────
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

// ─── VWAP calculation ─────────────────────────────────────
// Takes intraday data { timestamps, closes } from fetchIntradayChart.
// Approximates VWAP as mean of intraday closes when per-minute volume is unavailable.
function calcVWAP(intradayData) {
  const closes = intradayData?.closes;
  if (!closes?.length) return null;
  return closes.reduce((s, c) => s + c, 0) / closes.length;
}

// ─── Market-cap signal reliability multiplier ─────────────
function signalReliabilityMultiplier(marketCap) {
  if (!marketCap) return 1.0;
  if (marketCap > 200e9) return 1.2;
  if (marketCap > 10e9)  return 1.0;
  if (marketCap > 2e9)   return 0.85;
  if (marketCap > 300e6) return 0.70;
  return 0.5;
}

// ─── Buy/Sell recommendation ──────────────────────────────
function calcRecommendation(chartResult, quote, newsRisk, intradayData) {
  const q      = chartResult?.indicators?.quote?.[0];
  const closes = (q?.close ?? []).filter(v => v != null);
  const signals = [];

  // 1. RSI (14-period) — oversold = köp, overköpt = sälj
  const rsi = calcRSI(closes, 14);
  if (rsi !== null) {
    const rv = rsi < 30 ? 1 : rsi < 45 ? 0.5 : rsi < 55 ? 0 : rsi < 70 ? -0.5 : -1;
    const rl = rsi < 30 ? `RSI ${rsi.toFixed(0)} – översålt` : rsi < 45 ? `RSI ${rsi.toFixed(0)} – lågt`
             : rsi < 55 ? `RSI ${rsi.toFixed(0)} – neutralt` : rsi < 70 ? `RSI ${rsi.toFixed(0)} – högt`
             : `RSI ${rsi.toFixed(0)} – överköpt`;
    signals.push({ name: 'RSI', score: rv, label: rl });
  }

  // 2. 5-dagars momentum
  if (closes.length >= 6) {
    const mom = (closes.at(-1) - closes.at(-6)) / closes.at(-6);
    const mv = mom > 0.05 ? 1 : mom > 0.02 ? 0.5 : mom > -0.02 ? 0 : mom > -0.05 ? -0.5 : -1;
    const sign = mom >= 0 ? '+' : '';
    signals.push({ name: 'Momentum 5d', score: mv, label: `${sign}${(mom * 100).toFixed(1)}% (5 dagar)` });
  }

  // 3. SMA20 (beräknad från chartdata)
  if (closes.length >= 5) {
    const n = Math.min(20, closes.length);
    const sma20 = closes.slice(-n).reduce((a, b) => a + b, 0) / n;
    const diff  = (closes.at(-1) - sma20) / sma20;
    const sv    = diff > 0.05 ? 0.5 : diff > 0.01 ? 0.25 : diff > -0.01 ? 0 : diff > -0.05 ? -0.25 : -0.5;
    const dir   = diff >= 0 ? 'över' : 'under';
    signals.push({ name: 'SMA20', score: sv, label: `${Math.abs(diff * 100).toFixed(1)}% ${dir} SMA20` });
  }

  // 4. MA50 vs MA200 (Golden/Death cross) — från quote-data
  if (quote?.ma50 && quote?.ma200) {
    const cross = (quote.ma50 - quote.ma200) / quote.ma200;
    const cv    = cross > 0.02 ? 0.75 : cross > -0.02 ? 0 : -0.75;
    const cl    = cross > 0.02 ? 'Gyllene kors (SMA50 > SMA200)' : cross > -0.02 ? 'SMA50 ≈ SMA200' : 'Dödskors (SMA50 < SMA200)';
    signals.push({ name: 'MA-kors', score: cv, label: cl });
  }

  // 5. Pris vs SMA50 — från quote
  if (quote?.ma50 && quote?.price) {
    const diff = (quote.price - quote.ma50) / quote.ma50;
    const sv   = diff > 0.05 ? 0.5 : diff > 0 ? 0.25 : diff > -0.05 ? -0.25 : -0.5;
    const dir  = diff >= 0 ? 'över' : 'under';
    signals.push({ name: 'Pris/SMA50', score: sv, label: `${Math.abs(diff * 100).toFixed(1)}% ${dir} SMA50` });
  }

  // 6. Position inom 52-veckorsintervall
  if (quote?.week52High && quote?.week52Low && quote?.price) {
    const range = quote.week52High - quote.week52Low;
    if (range > 0) {
      const pos = (quote.price - quote.week52Low) / range;
      const pv  = pos < 0.2 ? 1 : pos < 0.4 ? 0.5 : pos < 0.6 ? 0 : pos < 0.8 ? -0.5 : -1;
      const pl  = pos < 0.2 ? `Nära 52v lägsta (${(pos * 100).toFixed(0)}%)`
                : pos < 0.4 ? `Lägre del av 52v (${(pos * 100).toFixed(0)}%)`
                : pos < 0.6 ? `Mitt i 52v-intervall (${(pos * 100).toFixed(0)}%)`
                : pos < 0.8 ? `Övre del av 52v (${(pos * 100).toFixed(0)}%)`
                : `Nära 52v högsta (${(pos * 100).toFixed(0)}%)`;
      signals.push({ name: '52v-position', score: pv, label: pl });
    }
  }

  // 7. P/E (trailing)
  if (quote?.pe != null && quote.pe > 0) {
    const pev = quote.pe < 10 ? 1 : quote.pe < 20 ? 0.5 : quote.pe < 30 ? 0 : quote.pe < 50 ? -0.5 : -1;
    const pel = quote.pe < 10 ? `P/E ${quote.pe.toFixed(1)} – lågt`
              : quote.pe < 30 ? `P/E ${quote.pe.toFixed(1)}`
              : `P/E ${quote.pe.toFixed(1)} – högt`;
    signals.push({ name: 'P/E', score: pev, label: pel });
  } else if (quote?.pe != null && quote.pe < 0) {
    signals.push({ name: 'P/E', score: -0.5, label: 'P/E negativt (förlust)' });
  }

  // 8. Forward P/E vs trailing (earnings-förbättring)
  if (quote?.forwardPE && quote?.pe && quote.pe > 0 && quote.forwardPE > 0) {
    const imp = (quote.pe - quote.forwardPE) / quote.pe;
    const fv  = imp > 0.15 ? 0.75 : imp > 0.05 ? 0.25 : imp > -0.1 ? 0 : -0.5;
    const fl  = imp > 0.05 ? `Fwd P/E ${quote.forwardPE.toFixed(1)} – vinstökning väntas`
              : imp < -0.1 ? `Fwd P/E ${quote.forwardPE.toFixed(1)} – vinstminskning väntas`
              : `Fwd P/E ${quote.forwardPE.toFixed(1)}`;
    signals.push({ name: 'Fwd P/E', score: fv, label: fl });
  }

  // 9. Nyhetssentiment
  if (newsRisk && (newsRisk.positive?.length || newsRisk.negative?.length)) {
    const sentScore = (50 - newsRisk.score) / 50; // -1 till +1
    const nv = Math.max(-1, Math.min(1, sentScore));
    const nl = nv > 0.3 ? `Positiva nyheter (${newsRisk.positive.length} art.)`
             : nv < -0.3 ? `Negativa nyheter (${newsRisk.negative.length} art.)`
             : `Neutrala nyheter`;
    signals.push({ name: 'Nyheter', score: nv, label: nl });
  }

  // 10. VWAP-signal (intradagsdata)
  const vwap = calcVWAP(intradayData);
  if (vwap !== null && quote?.price) {
    const diff = (quote.price - vwap) / vwap;
    const vv   = diff > 0.03 ? 0.5 : diff > 0.005 ? 0.25 : diff > -0.005 ? 0 : diff > -0.03 ? -0.25 : -0.5;
    const dir  = diff >= 0 ? 'över' : 'under';
    signals.push({ name: 'VWAP', score: vv, label: `${Math.abs(diff * 100).toFixed(1)}% ${dir} VWAP` });
  }

  // 11. Volymratio
  if (quote?.volume && quote?.avgVolume && quote?.avgVolume > 0) {
    const ratio = quote.volume / quote.avgVolume;
    const changeDir = (quote.changePct ?? 0) >= 0 ? 1 : -1;
    if (ratio > 1.5) {
      const vv = changeDir * (ratio > 3 ? 1 : ratio > 2 ? 0.75 : 0.5);
      signals.push({ name: 'Volym', score: vv, label: `${ratio.toFixed(1)}× snittvolym` });
    } else if (ratio < 0.5) {
      signals.push({ name: 'Volym', score: 0, label: `${ratio.toFixed(1)}× snittvolym – svag övertygelse` });
    }
  }

  // 12. Dagsspann-position
  if (quote?.dayHigh && quote?.dayLow && quote?.price) {
    const range = quote.dayHigh - quote.dayLow;
    if (range > 0) {
      const pos = (quote.price - quote.dayLow) / range;
      const dv = pos > 0.8 ? 0.75 : pos > 0.6 ? 0.375 : pos > 0.4 ? 0 : pos > 0.2 ? -0.375 : -0.75;
      const pct = (pos * 100).toFixed(0);
      const dl = pos > 0.7 ? `Nära dagshögsta (${pct}% av spann)`
               : pos < 0.3 ? `Nära dagslägsta (${pct}% av spann)`
               : `Mitt i dagsspann (${pct}%)`;
      signals.push({ name: 'Dagsspann', score: dv, label: dl });
    }
  }

  // 13. Pris vs öppningskurs (dagstrend)
  if (quote?.price && quote?.open && quote?.prevClose) {
    const gap      = (quote.open - quote.prevClose) / quote.prevClose;
    const fromOpen = (quote.price - quote.open) / quote.open;
    const combined = gap * 0.4 + fromOpen * 0.6;
    const gv = combined > 0.03 ? 0.75 : combined > 0.01 ? 0.375 :
               combined > -0.01 ? 0 : combined > -0.03 ? -0.375 : -0.75;
    const gapLabel = Math.abs(gap) > 0.005 ? ` (gap ${gap >= 0 ? '+' : ''}${(gap * 100).toFixed(1)}%)` : '';
    const dir = fromOpen >= 0 ? 'upp' : 'ned';
    signals.push({ name: 'Dagstrend', score: gv,
      label: `${Math.abs(fromOpen * 100).toFixed(1)}% ${dir} sedan öppning${gapLabel}` });
  }

  // 14. PEG-approximation
  if (quote?.pe > 0 && quote?.forwardPE > 0 && quote.pe !== quote.forwardPE) {
    const impliedGrowth = (quote.pe / quote.forwardPE) - 1;
    if (impliedGrowth > 0) {
      const peg = quote.forwardPE / (impliedGrowth * 100);
      if (peg > 0 && peg < 100) {
        const pgv = peg < 0.5 ? 1 : peg < 1.0 ? 0.5 : peg < 1.5 ? 0 : peg < 2.0 ? -0.5 : -1;
        signals.push({ name: 'PEG', score: pgv, label: `PEG ≈ ${peg.toFixed(1)}` });
      }
    }
  }

  // 15. P/B-signal
  if (quote?.priceToBook != null && quote.priceToBook > 0) {
    if (!quote.marketCap || quote.marketCap < 500e9) {
      const pb  = quote.priceToBook;
      const pbv = pb < 1.0 ? 0.75 : pb < 2.0 ? 0.375 : pb < 5.0 ? 0 : pb < 10.0 ? -0.25 : -0.5;
      const pbl = pb < 1.0 ? `P/B ${pb.toFixed(1)} – under bokfört värde`
                : pb > 10  ? `P/B ${pb.toFixed(1)} – högt premiumvärdering`
                : `P/B ${pb.toFixed(1)}`;
      signals.push({ name: 'P/B', score: pbv, label: pbl });
    }
  }

  if (signals.length === 0) return null;

  const rawAvg = signals.reduce((s, x) => s + x.score, 0) / signals.length;
  const avg    = Math.max(-1, Math.min(1, rawAvg * signalReliabilityMultiplier(quote?.marketCap)));

  let recommendation, color, label;
  if      (avg >  0.4)  { recommendation = 'KÖP';  color = '#3fb950'; label = 'Stark köpsignal';  }
  else if (avg >  0.1)  { recommendation = 'KÖP';  color = '#85c88a'; label = 'Svag köpsignal';   }
  else if (avg > -0.1)  { recommendation = 'HÅLL'; color = '#d29922'; label = 'Neutral – avvakta'; }
  else if (avg > -0.4)  { recommendation = 'SÄLJ'; color = '#f0883e'; label = 'Svag säljsignal';  }
  else                  { recommendation = 'SÄLJ'; color = '#f85149'; label = 'Stark säljsignal';  }

  const buyCount  = signals.filter(s => s.score >  0.1).length;
  const sellCount = signals.filter(s => s.score < -0.1).length;
  const top = [...signals].sort((a, b) => Math.abs(b.score) - Math.abs(a.score)).slice(0, 4);

  return { recommendation, color, label, avg: +avg.toFixed(2), buyCount, sellCount, signals: top, vwap };
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

// GET /api/chart/:symbol  — intraday 1m candles (Finnhub → Yahoo fallback)
app.get('/api/chart/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const data = await fetchIntradayChart(symbol);
    console.log(`[chart] ${symbol}: ${data.closes.length} punkter via ${data.source}`);
    const high = data.closes.length ? Math.max(...data.closes) : null;
    const low  = data.closes.length ? Math.min(...data.closes) : null;
    res.json({ timestamps: data.timestamps, closes: data.closes, open: data.open, high, low });
  } catch (err) {
    console.error(`Intraday chart error ${symbol}:`, err.message);
    res.status(502).json({ error: err.message });
  }
});

// GET /api/risk/:symbol
app.get('/api/risk/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();

  const cached = riskCache.get(symbol);
  if (cached && (Date.now() - cached.cachedAt) < RISK_TTL) return res.json(cached.data);

  try {
    const [chartResult, yahooItems, googleItems, redditItems, quoteResults, intradayData] = await Promise.all([
      fetchPriceHistory(symbol).catch(() => null),
      fetchYahooNews(symbol).catch(() => []),
      fetchGoogleNews(symbol).catch(() => []),
      fetchRedditPosts(symbol).catch(() => []),
      fetchYahooQuotes([symbol]).catch(() => []),
      fetchIntradayChart(symbol).catch(() => null),
    ]);
    const quote = quoteResults.length > 0 ? normalizeQuote(quoteResults[0]) : null;
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

    const priceRisk      = calcPriceRisk(chartResult, quote);
    const newsRisk       = calcNewsRisk(allItems);
    const stopLoss       = calcStopLoss(chartResult);
    const vwap           = calcVWAP(intradayData);
    const recommendation = calcRecommendation(chartResult, quote, newsRisk, intradayData);
    const score = Math.round(priceRisk.score * 0.55 + newsRisk.score * 0.45);
    const meta  = riskMeta(score);
    const data  = { symbol, score, ...meta, priceRisk, newsRisk, stopLoss, vwap, recommendation };
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
