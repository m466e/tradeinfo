/* ============================================================
   TradeInfo – NASDAQ Monitor
   Main application logic
   ============================================================ */

'use strict';

// ─── State ────────────────────────────────────────────────
const state = {
  allSymbols: [],       // [{ symbol, name }]
  filteredSymbols: [],  // filtered by search
  watchlist: [],        // ['AAPL', 'MSFT', ...]
  quotes: {},           // { AAPL: { price, change, ... } }
  prevQuotes: {},       // previous prices for flash detection
  searchQuery: '',
  visibleCount: 60,     // how many list items to show
  PAGE_SIZE: 60,
  refreshTimer: null,
  countdownTimer: null,
  countdownValue: 30,
  isLoading: false,
  symbolsLoaded: false,
  detailSymbol: null,   // currently open detail panel
  currentRisk: null,    // risk data for open detail
};

// ─── DOM refs ─────────────────────────────────────────────
const $ = id => document.getElementById(id);

const dom = {
  searchInput:      $('search-input'),
  searchClear:      $('search-clear'),
  symbolList:       $('symbol-list'),
  symbolCount:      $('symbol-count'),
  showingCount:     $('showing-count'),
  loadMoreBtn:      $('load-more-btn'),
  watchlistBody:    $('watchlist-body'),
  watchlistEmpty:   $('watchlist-empty'),
  watchlistContainer: $('watchlist-container'),
  watchlistCount:   $('watchlist-count'),
  refreshBtn:       $('refresh-btn'),
  lastRefresh:      $('last-refresh'),
  countdown:        $('countdown'),
  statusMessage:    $('status-message'),
  marketBadge:      $('market-state'),
  marketLabel:      $('market-label'),
  detailBody:       $('detail-body'),
  detailArticles:   $('detail-articles'),
  detailStoploss:   $('detail-stoploss'),
  detailRisk:       $('detail-risk'),
};

// ─── Formatting helpers ────────────────────────────────────
function fmt(val, opts = {}) {
  if (val === null || val === undefined || isNaN(val)) return '–';
  const { prefix = '', suffix = '', decimals = 2 } = opts;
  return `${prefix}${Number(val).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}${suffix}`;
}

function fmtPrice(val, currency = 'USD') {
  if (val === null || val === undefined) return '–';
  const sym = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : '$';
  return `${sym}${Number(val).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtChange(val) {
  if (val === null || val === undefined || isNaN(val)) return '–';
  const sign = val >= 0 ? '+' : '';
  return `${sign}${Number(val).toFixed(2)}`;
}

function fmtChangePct(val) {
  if (val === null || val === undefined || isNaN(val)) return '–';
  const sign = val >= 0 ? '+' : '';
  return `${sign}${Number(val).toFixed(2)}%`;
}

function fmtVolume(val) {
  if (val === null || val === undefined) return '–';
  if (val >= 1e9) return `${(val / 1e9).toFixed(2)}B`;
  if (val >= 1e6) return `${(val / 1e6).toFixed(2)}M`;
  if (val >= 1e3) return `${(val / 1e3).toFixed(1)}K`;
  return String(val);
}

function fmtMarketCap(val) {
  if (val === null || val === undefined) return '–';
  if (val >= 1e12) return `$${(val / 1e12).toFixed(2)}T`;
  if (val >= 1e9)  return `$${(val / 1e9).toFixed(2)}B`;
  if (val >= 1e6)  return `$${(val / 1e6).toFixed(2)}M`;
  return `$${val.toLocaleString('en-US')}`;
}

function fmtYield(val) {
  if (val === null || val === undefined || isNaN(val) || val === 0) return '–';
  return `${(val * 100).toFixed(2)}%`;
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ─── Status helpers ────────────────────────────────────────
function setStatus(msg, type = '') {
  dom.statusMessage.textContent = msg;
  dom.statusMessage.className = type;
}

function setMarketState(state) {
  const labels = {
    REGULAR: 'Marknaden öppen',
    PRE: 'Pre-market',
    POST: 'After-hours',
    CLOSED: 'Marknaden stängd',
    UNKNOWN: '–'
  };
  const classes = {
    REGULAR: 'open',
    PRE: 'pre',
    POST: 'post',
    CLOSED: 'closed',
    UNKNOWN: ''
  };
  dom.marketBadge.className = `market-badge ${classes[state] || ''}`;
  dom.marketLabel.textContent = labels[state] || state;
}

// ─── localStorage ─────────────────────────────────────────
const STORAGE_KEY = 'tradeinfo_watchlist';

function loadWatchlist() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : [];
  } catch { return []; }
}

function saveWatchlist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.watchlist));
}

// ─── Symbol list rendering ─────────────────────────────────
function filterSymbols() {
  const q = state.searchQuery.toLowerCase().trim();
  if (!q) {
    state.filteredSymbols = state.allSymbols;
  } else {
    state.filteredSymbols = state.allSymbols.filter(s =>
      s.symbol.toLowerCase().startsWith(q) ||
      s.name.toLowerCase().includes(q)
    );
  }
  state.visibleCount = state.PAGE_SIZE;
}

function renderSymbolList() {
  const visible = state.filteredSymbols.slice(0, state.visibleCount);
  const total = state.filteredSymbols.length;

  const fragment = document.createDocumentFragment();
  for (const s of visible) {
    const li = document.createElement('li');
    const isSelected = state.watchlist.includes(s.symbol);
    if (isSelected) li.classList.add('selected');

    li.innerHTML = `
      <span class="sym-symbol">${escHtml(s.symbol)}</span>
      <span class="sym-name" title="${escHtml(s.name)}">${escHtml(s.name)}</span>
      <button class="sym-add-btn" data-symbol="${escHtml(s.symbol)}" title="${isSelected ? 'Ta bort' : 'Lägg till'}">
        ${isSelected ? '✓' : '+'}
      </button>
    `;

    li.addEventListener('click', (e) => {
      if (e.target.closest('.sym-add-btn')) return;
      toggleWatchlist(s.symbol);
    });

    li.querySelector('.sym-add-btn').addEventListener('click', () => {
      toggleWatchlist(s.symbol);
    });

    fragment.appendChild(li);
  }

  dom.symbolList.innerHTML = '';
  dom.symbolList.appendChild(fragment);

  // Update footer
  const showing = Math.min(state.visibleCount, total);
  dom.showingCount.textContent = `Visar ${showing} av ${total.toLocaleString('sv-SE')}`;
  dom.loadMoreBtn.style.display = showing < total ? 'inline' : 'none';
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Watchlist management ──────────────────────────────────
function toggleWatchlist(symbol) {
  const idx = state.watchlist.indexOf(symbol);
  if (idx === -1) {
    state.watchlist.push(symbol);
    saveWatchlist();
    renderSymbolList();
    fetchQuotes();
  } else {
    state.watchlist.splice(idx, 1);
    delete state.quotes[symbol];
    saveWatchlist();
    renderSymbolList();
    renderWatchlist();
  }
  updateWatchlistCount();
}

function updateWatchlistCount() {
  const n = state.watchlist.length;
  dom.watchlistCount.textContent = `${n} ${n === 1 ? 'aktie' : 'aktier'}`;
}

// ─── Watchlist table rendering ─────────────────────────────
function renderWatchlist() {
  const hasStocks = state.watchlist.length > 0;
  dom.watchlistEmpty.style.display     = hasStocks ? 'none' : 'flex';
  dom.watchlistContainer.style.display = hasStocks ? 'flex' : 'none';

  if (!hasStocks) return;

  const fragment = document.createDocumentFragment();

  for (const symbol of state.watchlist) {
    const q = state.quotes[symbol];
    const prev = state.prevQuotes[symbol];
    const isUp   = q && prev && q.price > prev.price;
    const isDown = q && prev && q.price < prev.price;

    const row = document.createElement('tr');
    row.dataset.symbol = symbol;

    if (isUp)   { row.classList.add('flash-up');   setTimeout(() => row.classList.remove('flash-up'),   900); }
    if (isDown) { row.classList.add('flash-down');  setTimeout(() => row.classList.remove('flash-down'), 900); }

    const changeDir  = q ? (q.change >= 0 ? 'up' : 'down')    : '';
    const changePctDir = q ? (q.changePct >= 0 ? 'up' : 'down') : '';

    row.innerHTML = `
      <td class="cell-symbol">${escHtml(symbol)}</td>
      <td class="cell-name" title="${q ? escHtml(q.name) : ''}">${q ? escHtml(shortName(q.name)) : skeleton()}</td>
      <td class="cell-price">${q ? fmtPrice(q.price, q.currency) : skeleton()}</td>
      <td class="cell-change ${changeDir}">${q ? fmtChange(q.change) : skeleton()}</td>
      <td class="cell-changepct ${changePctDir}">${q ? fmtChangePct(q.changePct) : skeleton()}</td>
      <td class="cell-muted">${q ? fmtPrice(q.open, q.currency) : skeleton()}</td>
      <td class="cell-muted">${q ? fmtPrice(q.dayHigh, q.currency) : skeleton()}</td>
      <td class="cell-muted">${q ? fmtPrice(q.dayLow, q.currency) : skeleton()}</td>
      <td class="cell-muted">${q ? fmtVolume(q.volume) : skeleton()}</td>
      <td class="cell-muted">${q ? fmtVolume(q.avgVolume) : skeleton()}</td>
      <td class="cell-muted">${q ? fmtMarketCap(q.marketCap) : skeleton()}</td>
      <td class="${q && q.pe !== null ? 'cell-muted' : 'cell-null'}">${q ? fmt(q.pe) : skeleton()}</td>
      <td class="${q && q.forwardPE !== null ? 'cell-muted' : 'cell-null'}">${q ? fmt(q.forwardPE) : skeleton()}</td>
      <td class="${q && q.eps !== null ? 'cell-muted' : 'cell-null'}">${q ? fmt(q.eps) : skeleton()}</td>
      <td class="cell-muted">${q ? fmtPrice(q.week52High, q.currency) : skeleton()}</td>
      <td class="cell-muted">${q ? fmtPrice(q.week52Low, q.currency) : skeleton()}</td>
      <td class="${q && q.dividendYield ? 'cell-muted' : 'cell-null'}">${q ? fmtYield(q.dividendYield) : skeleton()}</td>
      <td class="${q && q.beta !== null ? 'cell-muted' : 'cell-null'}">${q ? fmt(q.beta) : skeleton()}</td>
      <td class="${q && q.priceToBook !== null ? 'cell-muted' : 'cell-null'}">${q ? fmt(q.priceToBook) : skeleton()}</td>
      <td class="cell-muted">${q ? bidAsk(q) : skeleton()}</td>
      <td class="cell-muted">${q ? bidAsk(q, true) : skeleton()}</td>
      <td><button class="btn-remove" data-symbol="${escHtml(symbol)}" title="Ta bort">&times;</button></td>
    `;

    row.querySelector('.btn-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleWatchlist(symbol);
    });

    row.addEventListener('click', () => openStockDetail(symbol));

    fragment.appendChild(row);
  }

  dom.watchlistBody.innerHTML = '';
  dom.watchlistBody.appendChild(fragment);
}

function skeleton() {
  return '<span class="skeleton" style="width:50px">&nbsp;</span>';
}

function shortName(name, max = 28) {
  if (!name) return '–';
  return name.length > max ? name.slice(0, max) + '…' : name;
}

function bidAsk(q, isAsk = false) {
  const val  = isAsk ? q.ask  : q.bid;
  const size = isAsk ? q.askSize : q.bidSize;
  if (val === null || val === undefined) return '–';
  const formatted = fmtPrice(val, q.currency);
  if (size) return `${formatted} <span style="color:var(--text-muted);font-size:10px">x${size}</span>`;
  return formatted;
}

// ─── Quote fetching ────────────────────────────────────────
async function fetchQuotes() {
  if (state.watchlist.length === 0) return;
  if (state.isLoading) return;

  state.isLoading = true;
  dom.refreshBtn.classList.add('spinning');
  setStatus('Hämtar kurser…', 'loading');

  // Save previous prices for flash detection
  state.prevQuotes = {};
  for (const sym of state.watchlist) {
    if (state.quotes[sym]) state.prevQuotes[sym] = { ...state.quotes[sym] };
  }

  try {
    const symbols = state.watchlist.join(',');
    const res = await fetch(`/api/quote?symbols=${encodeURIComponent(symbols)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    for (const q of data) {
      state.quotes[q.symbol] = q;
    }

    renderWatchlist();

    // Refresh detail panel (reuse cached risk)
    if (state.detailSymbol) {
      renderDetailBody(state.quotes[state.detailSymbol], state.detailSymbol, state.currentRisk);
    }

    // Update market state from first quote
    if (data.length > 0) {
      setMarketState(data[0].marketState);
    }

    const now = new Date();
    dom.lastRefresh.textContent = `Uppdaterad ${fmtTime(now)}`;
    setStatus('Kurser uppdaterade', 'ok');
    setTimeout(() => setStatus('Klar'), 2000);

  } catch (err) {
    console.error('Quote fetch error:', err);
    setStatus(`Fel: ${err.message}`, 'error');
  } finally {
    state.isLoading = false;
    dom.refreshBtn.classList.remove('spinning');
  }
}

// ─── NASDAQ symbols fetch ──────────────────────────────────
async function fetchNasdaqSymbols() {
  setStatus('Hämtar NASDAQ-aktielista…', 'loading');
  dom.symbolCount.textContent = 'Laddar…';

  try {
    const res = await fetch('/api/nasdaq-symbols');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    state.allSymbols = data;
    filterSymbols();
    renderSymbolList();

    dom.symbolCount.textContent = `${data.length.toLocaleString('sv-SE')} aktier`;
    state.symbolsLoaded = true;
    setStatus('Klar');

  } catch (err) {
    console.error('Symbol fetch error:', err);
    dom.symbolCount.textContent = 'Fel';
    dom.symbolList.innerHTML = `<li class="placeholder-item" style="color:var(--negative)">Kunde inte hämta aktielistan: ${escHtml(err.message)}</li>`;
    setStatus(`Fel vid laddning av aktielista: ${err.message}`, 'error');
  }
}

// ─── Auto-refresh ──────────────────────────────────────────
function startAutoRefresh() {
  clearInterval(state.refreshTimer);
  clearInterval(state.countdownTimer);

  state.countdownValue = 30;

  state.refreshTimer = setInterval(() => {
    fetchQuotes();
    state.countdownValue = 30;
  }, 30_000);

  state.countdownTimer = setInterval(() => {
    state.countdownValue = Math.max(0, state.countdownValue - 1);
    dom.countdown.textContent = state.countdownValue;
  }, 1_000);
}

// ─── Search ────────────────────────────────────────────────
let searchDebounce = null;

dom.searchInput.addEventListener('input', (e) => {
  state.searchQuery = e.target.value;
  dom.searchClear.classList.toggle('visible', state.searchQuery.length > 0);

  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    filterSymbols();
    renderSymbolList();
  }, 200);
});

dom.searchClear.addEventListener('click', () => {
  dom.searchInput.value = '';
  state.searchQuery = '';
  dom.searchClear.classList.remove('visible');
  filterSymbols();
  renderSymbolList();
  dom.searchInput.focus();
});

// ─── Load more ─────────────────────────────────────────────
dom.loadMoreBtn.addEventListener('click', () => {
  state.visibleCount += state.PAGE_SIZE;
  renderSymbolList();
});

// ─── Manual refresh ────────────────────────────────────────
dom.refreshBtn.addEventListener('click', () => {
  fetchQuotes();
  state.countdownValue = 30;
  dom.countdown.textContent = 30;
});

// ─── Detail panel ──────────────────────────────────────────
async function openStockDetail(symbol) {
  state.detailSymbol = symbol;
  state.currentRisk = 'loading';
  renderDetailBody(state.quotes[symbol], symbol, 'loading');

  try {
    const res = await fetch(`/api/risk/${encodeURIComponent(symbol)}`);
    const risk = res.ok ? await res.json() : null;
    if (state.detailSymbol === symbol) {
      state.currentRisk = risk;
      renderDetailBody(state.quotes[symbol], symbol, risk);
    }
  } catch {
    if (state.detailSymbol === symbol) {
      state.currentRisk = null;
      renderDetailBody(state.quotes[symbol], symbol, null);
    }
  }
}

function riskGaugeSVG(score, color) {
  const r = 36, cx = 50, cy = 50;
  const circ = 2 * Math.PI * r;
  const maxArc = circ * 0.75;
  const fillArc = (score / 100) * maxArc;
  const rot = `rotate(135,${cx},${cy})`;
  return `<svg width="100" height="100" viewBox="0 0 100 100">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--bg-tertiary)" stroke-width="9"
      stroke-dasharray="${maxArc.toFixed(1)} ${(circ - maxArc).toFixed(1)}"
      stroke-linecap="round" transform="${rot}"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="9"
      stroke-dasharray="${fillArc.toFixed(1)} ${(circ - fillArc).toFixed(1)}"
      stroke-linecap="round" transform="${rot}"/>
    <text x="${cx}" y="${cy + 7}" text-anchor="middle" font-size="20" font-weight="700"
      fill="#e6edf3" font-family="'SF Mono',Consolas,monospace">${score}</text>
  </svg>`;
}

function renderArticles(risk) {
  const el = dom.detailArticles;
  if (!risk || risk === 'loading' || (!risk.newsRisk?.positive?.length && !risk.newsRisk?.negative?.length)) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }

  const sourceLabel = { yahoo: 'Yahoo', google: 'Google News', reddit: 'Reddit' };
  const sourceCls   = { yahoo: 'src-yahoo', google: 'src-google', reddit: 'src-reddit' };

  function articleItem(a) {
    const date = a.time ? new Date(a.time * 1000).toLocaleDateString('sv-SE', { month: 'short', day: 'numeric' }) : '';
    const src  = sourceLabel[a.source] ?? a.source ?? '';
    const cls  = sourceCls[a.source] ?? '';
    return `<a class="article-item" href="${escHtml(a.link)}" target="_blank" rel="noopener">
      <span class="article-title">${escHtml(a.title)}</span>
      <span class="article-meta">
        <span class="article-src ${cls}">${escHtml(src)}</span>
        ${escHtml(a.publisher)}${date ? ' · ' + date : ''}
      </span>
    </a>`;
  }

  const pos = risk.newsRisk.positive;
  const neg = risk.newsRisk.negative;

  el.innerHTML = `
    <div class="article-col">
      <div class="article-col-title positive">&#9650; Positiva artiklar (${pos.length})</div>
      ${pos.length ? pos.map(articleItem).join('') : '<span class="article-empty">Inga positiva artiklar</span>'}
    </div>
    <div class="article-col">
      <div class="article-col-title negative">&#9660; Negativa artiklar (${neg.length})</div>
      ${neg.length ? neg.map(articleItem).join('') : '<span class="article-empty">Inga negativa artiklar</span>'}
    </div>
  `;
  el.style.display = 'grid';
}

function renderDetailBody(q, symbol, risk) {
  function item(label, value, isNull = false) {
    return `<div class="detail-item">
      <span class="detail-item-label">${label}</span>
      <span class="detail-item-value${isNull ? ' null' : ''}">${value}</span>
    </div>`;
  }
  function col(title, items, cls = '') {
    return `<div class="detail-col${cls ? ' ' + cls : ''}"><div class="detail-col-title">${title}</div>${items}</div>`;
  }

  if (risk === 'loading') {
    dom.detailRisk.innerHTML = `<div class="risk-section"><div class="risk-loading"></div><div class="risk-label-text">Analyserar…</div></div>`;
  } else if (risk) {
    const rec = risk.recommendation;
    const recHtml = rec ? `
      <div class="risk-divider"></div>
      <div class="rec-badge" style="color:${rec.color};border-color:${rec.color}">${rec.recommendation}</div>
      <div class="rec-label">${escHtml(rec.label)}</div>
      <div class="rec-counts">
        <span class="rec-buy">▲ ${rec.buyCount} köp</span>
        <span class="rec-sell">▼ ${rec.sellCount} sälj</span>
      </div>
      <div class="rec-signals">
        ${rec.signals.map(s => `<div class="rec-signal ${s.score > 0.1 ? 'pos' : s.score < -0.1 ? 'neg' : 'neu'}">
          <span class="rec-signal-dot"></span>${escHtml(s.label)}
        </div>`).join('')}
      </div>` : '';

    dom.detailRisk.innerHTML = `<div class="risk-section">
      ${riskGaugeSVG(risk.score, risk.color)}
      <div class="risk-label-text" style="color:${risk.color}">${risk.label}</div>
      <div class="risk-detail">
        <span>${risk.priceRisk.todayDetail}</span>
        <span>${risk.priceRisk.detail}</span>
        <span>${risk.priceRisk.volumeDetail}</span>
        <span>Nyheter: ${risk.newsRisk.detail}</span>
      </div>
      ${recHtml}
    </div>`;
  } else if (symbol) {
    dom.detailRisk.innerHTML = `<div class="risk-section risk-na"><span class="risk-label-text">Risk<br>ej tillgänglig</span></div>`;
  } else {
    dom.detailRisk.innerHTML = '';
  }

  if (!q) {
    const name = symbol ? (state.allSymbols.find(s => s.symbol === symbol)?.name ?? symbol) : null;
    renderArticles(risk);
    dom.detailStoploss.innerHTML = '';
    dom.detailBody.innerHTML = symbol
      ? `<div class="detail-main"><span class="detail-symbol">${escHtml(symbol)}</span><span class="detail-name">${escHtml(name)}</span><span class="detail-price">–</span></div>`
      : '<div class="detail-placeholder">Klicka på en rad i listan för att visa detaljer</div>';
    return;
  }

  const dir = q.change >= 0 ? 'up' : 'down';

  renderArticles(risk);

  if (risk?.stopLoss) {
    dom.detailStoploss.innerHTML = `<div class="detail-col detail-col--sl">
      <div class="detail-col-title">Stop Loss ▼</div>
      ${item('ATR (14d)',     fmtPrice(risk.stopLoss.atr, q.currency))}
      ${item('Tight (1.5×)',  `${fmtPrice(risk.stopLoss.tight.price,    q.currency)} <span class="sl-pct">${risk.stopLoss.tight.pct}%</span>`)}
      ${item('Standard (2×)', `${fmtPrice(risk.stopLoss.standard.price, q.currency)} <span class="sl-pct">${risk.stopLoss.standard.pct}%</span>`)}
      ${item('Bred (3×)',     `${fmtPrice(risk.stopLoss.wide.price,     q.currency)} <span class="sl-pct">${risk.stopLoss.wide.pct}%</span>`)}
      ${item('Swing Low',     `${fmtPrice(risk.stopLoss.swingLow.price, q.currency)} <span class="sl-pct">${risk.stopLoss.swingLow.pct}%</span>`)}
    </div>`;
  } else {
    dom.detailStoploss.innerHTML = '';
  }

  dom.detailBody.innerHTML = `
    <div class="detail-main">
      <span class="detail-symbol">${escHtml(q.symbol)}</span>
      <span class="detail-name" title="${escHtml(q.name)}">${escHtml(q.name)}</span>
      <span class="detail-price">${fmtPrice(q.price, q.currency)}</span>
      <span class="detail-change ${dir}">${fmtChange(q.change)} (${fmtChangePct(q.changePct)})</span>
    </div>

    ${col('Dagspriser', [
      item('Öppning',   fmtPrice(q.open, q.currency)),
      item('Stängning', fmtPrice(q.prevClose, q.currency)),
      item('Dag Hög',   fmtPrice(q.dayHigh, q.currency)),
      item('Dag Låg',   fmtPrice(q.dayLow, q.currency)),
    ].join(''))}

    ${col('52-veckors', [
      item('Hög',         fmtPrice(q.week52High, q.currency)),
      item('Låg',         fmtPrice(q.week52Low, q.currency)),
      item('Volym',       fmtVolume(q.volume)),
      item('Snitt Vol.',  fmtVolume(q.avgVolume)),
    ].join(''))}

    ${col('Värdering', [
      item('Börsvärde', fmtMarketCap(q.marketCap)),
      item('P/E',       q.pe        !== null ? fmt(q.pe)        : '–', q.pe        === null),
      item('Fwd P/E',   q.forwardPE !== null ? fmt(q.forwardPE) : '–', q.forwardPE === null),
      item('EPS',       q.eps       !== null ? fmt(q.eps)       : '–', q.eps       === null),
    ].join(''))}

    ${col('Övrigt', [
      item('P/B',     q.priceToBook  !== null ? fmt(q.priceToBook) : '–', q.priceToBook === null),
      item('Beta',    q.beta         !== null ? fmt(q.beta)        : '–', q.beta        === null),
      item('Yield',   q.dividendYield ? fmtYield(q.dividendYield)  : '–', !q.dividendYield),
      item('Bid/Ask', `${bidAsk(q)} / ${bidAsk(q, true)}`),
    ].join(''))}
  `;
}

// ─── Init ──────────────────────────────────────────────────
async function init() {
  // Load persisted watchlist
  state.watchlist = loadWatchlist();
  updateWatchlistCount();
  renderWatchlist();

  // Start auto-refresh cycle
  startAutoRefresh();

  // Fetch initial data in parallel
  await fetchNasdaqSymbols();

  // Fetch quotes for saved watchlist
  if (state.watchlist.length > 0) {
    fetchQuotes();
  }
}

init();
