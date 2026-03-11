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
  alerts: {},           // { AAPL: { above: 200, below: 150 } }
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
  sortKey: null,        // column key for watchlist sort
  sortDir: -1,          // -1 = descending, 1 = ascending
  alertModalSymbol: null,
  refreshInterval: 30,  // seconds; 0 = manual
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
  refreshInterval:  $('refresh-interval'),
  lastRefresh:      $('last-refresh'),
  countdown:        $('countdown'),
  countdownWrap:    document.querySelector('.countdown-wrap'),
  statusMessage:    $('status-message'),
  marketBadge:      $('market-state'),
  marketLabel:      $('market-label'),
  detailBody:       $('detail-body'),
  detailChart:      $('detail-chart'),
  detailArticles:   $('detail-articles'),
  detailStoploss:   $('detail-stoploss'),
  detailRisk:       $('detail-risk'),
  alertModal:       $('alert-modal'),
  alertModalSymbol: $('alert-modal-symbol'),
  alertAbove:       $('alert-above'),
  alertBelow:       $('alert-below'),
  alertSaveBtn:     $('alert-save-btn'),
  alertClearBtn:    $('alert-clear-btn'),
  alertCancelBtn:   $('alert-cancel-btn'),
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

function setMarketState(ms) {
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
  dom.marketBadge.className = `market-badge ${classes[ms] || ''}`;
  dom.marketLabel.textContent = labels[ms] || ms;
}

// ─── localStorage ─────────────────────────────────────────
const STORAGE_KEY        = 'tradeinfo_watchlist';
const ALERTS_STORAGE_KEY = 'tradeinfo_alerts';

function loadWatchlist() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : [];
  } catch { return []; }
}

function saveWatchlist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.watchlist));
}

function loadAlerts() {
  try {
    const saved = localStorage.getItem(ALERTS_STORAGE_KEY);
    return saved ? JSON.parse(saved) : {};
  } catch { return {}; }
}

function saveAlerts() {
  localStorage.setItem(ALERTS_STORAGE_KEY, JSON.stringify(state.alerts));
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

// ─── Sort helpers ─────────────────────────────────────────
function getSortedWatchlist() {
  if (!state.sortKey) return state.watchlist;
  const strKeys = new Set(['symbol', 'shortName']);
  return [...state.watchlist].sort((a, b) => {
    if (strKeys.has(state.sortKey)) {
      const va = state.sortKey === 'symbol' ? a : (state.quotes[a]?.shortName ?? a);
      const vb = state.sortKey === 'symbol' ? b : (state.quotes[b]?.shortName ?? b);
      return state.sortDir * va.localeCompare(vb);
    }
    const qa = state.quotes[a];
    const qb = state.quotes[b];
    if (!qa || !qb) return 0;
    return state.sortDir * ((qa[state.sortKey] ?? 0) - (qb[state.sortKey] ?? 0));
  });
}

function updateSortHeaders() {
  const ths = document.querySelectorAll('#watchlist-table th[data-sort-key]');
  for (const th of ths) {
    th.classList.remove('sort-active');
    const arrow = th.querySelector('.sort-arrow');
    if (arrow) arrow.remove();
    if (th.dataset.sortKey === state.sortKey) {
      th.classList.add('sort-active');
      const span = document.createElement('span');
      span.className = 'sort-arrow';
      span.textContent = state.sortDir === -1 ? '↓' : '↑';
      th.appendChild(span);
    }
  }
}

// ─── Watchlist table rendering ─────────────────────────────
function renderWatchlist() {
  const hasStocks = state.watchlist.length > 0;
  dom.watchlistEmpty.style.display     = hasStocks ? 'none' : 'flex';
  dom.watchlistContainer.style.display = hasStocks ? 'flex' : 'none';

  if (!hasStocks) return;

  const sorted = getSortedWatchlist();
  const fragment = document.createDocumentFragment();

  for (const symbol of sorted) {
    const q = state.quotes[symbol];
    const prev = state.prevQuotes[symbol];
    const isUp   = q && prev && q.price > prev.price;
    const isDown = q && prev && q.price < prev.price;
    const hasAlert = !!(state.alerts[symbol]?.above || state.alerts[symbol]?.below);

    const row = document.createElement('tr');
    row.dataset.symbol = symbol;

    if (isUp)   { row.classList.add('flash-up');   setTimeout(() => row.classList.remove('flash-up'),   900); }
    if (isDown) { row.classList.add('flash-down');  setTimeout(() => row.classList.remove('flash-down'), 900); }

    const changeDir    = q ? (q.change >= 0 ? 'up' : 'down')    : '';
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
      <td>
        <button class="btn-alert${hasAlert ? ' active' : ''}" data-symbol="${escHtml(symbol)}" title="Prisnotifiering">&#128276;</button>
        <button class="btn-remove" data-symbol="${escHtml(symbol)}" title="Ta bort">&times;</button>
      </td>
    `;

    row.querySelector('.btn-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleWatchlist(symbol);
    });

    row.querySelector('.btn-alert').addEventListener('click', (e) => {
      e.stopPropagation();
      openAlertModal(symbol);
    });

    row.addEventListener('click', () => openStockDetail(symbol));

    fragment.appendChild(row);
  }

  dom.watchlistBody.innerHTML = '';
  dom.watchlistBody.appendChild(fragment);
  updateSortHeaders();
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
      const prev = state.quotes[q.symbol];
      state.quotes[q.symbol] = q;
      // Check price alerts on each refresh
      if (prev) checkAlerts(q.symbol, q.price, prev.price);
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
  state.refreshTimer = null;

  const interval = state.refreshInterval;

  if (interval === 0) {
    // Manual mode: hide countdown
    dom.countdownWrap.style.display = 'none';
    return;
  }

  dom.countdownWrap.style.display = '';
  state.countdownValue = interval;
  dom.countdown.textContent = interval;

  state.refreshTimer = setInterval(() => {
    fetchQuotes();
    state.countdownValue = interval;
  }, interval * 1000);

  state.countdownTimer = setInterval(() => {
    state.countdownValue = Math.max(0, state.countdownValue - 1);
    dom.countdown.textContent = state.countdownValue;
  }, 1_000);
}

// ─── Page Visibility API — pause/resume on tab switch ─────
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearInterval(state.refreshTimer);
    clearInterval(state.countdownTimer);
    state.refreshTimer = null;
  } else {
    // Tab became visible: fetch immediately then restart cycle
    if (state.refreshInterval > 0) {
      fetchQuotes();
      startAutoRefresh();
    }
  }
});

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
  if (state.refreshInterval > 0) {
    state.countdownValue = state.refreshInterval;
    dom.countdown.textContent = state.refreshInterval;
  }
});

// ─── Refresh interval select ───────────────────────────────
dom.refreshInterval.addEventListener('change', () => {
  state.refreshInterval = parseInt(dom.refreshInterval.value, 10);
  startAutoRefresh();
});

// ─── Column sort ───────────────────────────────────────────
document.querySelector('#watchlist-table thead').addEventListener('click', (e) => {
  const th = e.target.closest('th[data-sort-key]');
  if (!th) return;
  const key = th.dataset.sortKey;
  if (state.sortKey === key) {
    state.sortDir *= -1;
  } else {
    state.sortKey = key;
    state.sortDir = -1;
  }
  renderWatchlist();
});

// ─── Price alerts ─────────────────────────────────────────
function checkAlerts(symbol, newPrice, prevPrice) {
  const alert = state.alerts[symbol];
  if (!alert || !newPrice || !prevPrice) return;

  if (alert.above && prevPrice < alert.above && newPrice >= alert.above) {
    sendNotification(symbol, `${symbol} passerade $${alert.above} uppåt (nu $${newPrice.toFixed(2)})`);
  }
  if (alert.below && prevPrice > alert.below && newPrice <= alert.below) {
    sendNotification(symbol, `${symbol} passerade $${alert.below} nedåt (nu $${newPrice.toFixed(2)})`);
  }
}

function sendNotification(symbol, body) {
  if (Notification.permission !== 'granted') return;
  new Notification(`TradeInfo – ${symbol}`, { body, icon: '/favicon.ico' });
}

function openAlertModal(symbol) {
  state.alertModalSymbol = symbol;
  dom.alertModalSymbol.textContent = symbol;
  const existing = state.alerts[symbol] ?? {};
  dom.alertAbove.value = existing.above ?? '';
  dom.alertBelow.value = existing.below ?? '';
  dom.alertModal.style.display = 'flex';
  dom.alertAbove.focus();
}

function closeAlertModal() {
  dom.alertModal.style.display = 'none';
  state.alertModalSymbol = null;
}

dom.alertSaveBtn.addEventListener('click', () => {
  const sym = state.alertModalSymbol;
  if (!sym) return;
  const above = parseFloat(dom.alertAbove.value);
  const below = parseFloat(dom.alertBelow.value);
  state.alerts[sym] = {
    above: isNaN(above) ? null : above,
    below: isNaN(below) ? null : below,
  };
  saveAlerts();
  closeAlertModal();
  renderWatchlist();
});

dom.alertClearBtn.addEventListener('click', () => {
  const sym = state.alertModalSymbol;
  if (sym) {
    delete state.alerts[sym];
    saveAlerts();
  }
  closeAlertModal();
  renderWatchlist();
});

dom.alertCancelBtn.addEventListener('click', closeAlertModal);

dom.alertModal.addEventListener('click', (e) => {
  if (e.target === dom.alertModal) closeAlertModal();
});

// ─── Detail panel ──────────────────────────────────────────
async function openStockDetail(symbol) {
  state.detailSymbol = symbol;
  state.currentRisk = 'loading';
  renderDetailBody(state.quotes[symbol], symbol, 'loading');
  renderIntradayChart(symbol);

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

// ─── Intraday SVG chart ───────────────────────────────────
let _chartData = null;
let _chartResizeObserver = null;

function buildChartSVG(closes, timestamps, open, containerW) {
  const W    = containerW || 300;
  const H    = 160;
  const PADL = 50;   // space for Y price labels
  const PADR = 6;
  const PADT = 6;
  const PADB = 20;   // space for X time labels
  const chartW = W - PADL - PADR;
  const chartH = H - PADT - PADB;

  const minVal    = Math.min(...closes);
  const maxVal    = Math.max(...closes);
  const range     = maxVal - minVal || 1;
  const lastPrice = closes.at(-1);
  const lineColor = lastPrice >= (open ?? lastPrice) ? 'var(--positive)' : 'var(--negative)';

  function toX(i) { return PADL + (i / (closes.length - 1)) * chartW; }
  function toY(v) { return PADT + chartH - ((v - minVal) / range) * chartH; }

  // ── Nice Y-tick levels ──────────────────────────────────
  function niceStep(r, steps) {
    const rough = r / steps;
    const mag   = Math.pow(10, Math.floor(Math.log10(rough)));
    const norm  = rough / mag;
    const nice  = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
    return nice * mag;
  }
  const step   = niceStep(range, 3);
  const yStart = Math.ceil(minVal / step) * step;
  const yTicks = [];
  for (let v = yStart; v <= maxVal + step * 0.01; v = parseFloat((v + step).toFixed(10))) {
    if (v >= minVal - step * 0.01 && v <= maxVal + step * 0.01) yTicks.push(v);
  }

  // ── X-ticks at whole hours (NYSE time) ─────────────────
  const xTicks = [];
  if (timestamps?.length) {
    for (let i = 0; i < timestamps.length; i++) {
      const d = new Date(timestamps[i] * 1000);
      const mins = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' });
      if (mins.endsWith(':00')) {
        xTicks.push({ i, label: mins.replace(':00', '') + ':00' });
      }
    }
  }

  // ── Grid + labels ───────────────────────────────────────
  const gridLines = yTicks.map(v => {
    const y = toY(v).toFixed(1);
    return `<line x1="${PADL}" y1="${y}" x2="${W - PADR}" y2="${y}" stroke="var(--border)" stroke-width="0.5"/>`;
  }).join('');

  const yLabels = yTicks.map(v => {
    const y = toY(v).toFixed(1);
    const lbl = v >= 1000 ? v.toFixed(0) : v >= 100 ? v.toFixed(1) : v.toFixed(2);
    return `<text x="${PADL - 5}" y="${y}" dy="0.35em" text-anchor="end" font-size="9" fill="var(--text-muted)" font-family="'SF Mono',Consolas,monospace">${lbl}</text>`;
  }).join('');

  const xLabels = xTicks.map(({ i, label }) => {
    const x = toX(i).toFixed(1);
    return `<line x1="${x}" y1="${PADT + chartH}" x2="${x}" y2="${PADT + chartH + 3}" stroke="var(--border)" stroke-width="0.5"/>
            <text x="${x}" y="${H - 3}" text-anchor="middle" font-size="9" fill="var(--text-muted)" font-family="'SF Mono',Consolas,monospace">${label}</text>`;
  }).join('');

  // ── Price line + fill ───────────────────────────────────
  const points  = closes.map((c, i) => `${toX(i).toFixed(1)},${toY(c).toFixed(1)}`).join(' ');
  const baseY   = (PADT + chartH).toFixed(1);
  const fillPts = `${toX(0).toFixed(1)},${baseY} ${points} ${toX(closes.length - 1).toFixed(1)},${baseY}`;

  const openY    = open != null ? toY(open).toFixed(1) : null;
  const openLine = openY != null
    ? `<line x1="${PADL}" y1="${openY}" x2="${W - PADR}" y2="${openY}" stroke="var(--text-muted)" stroke-width="1" stroke-dasharray="3,3"/>`
    : '';

  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"
      data-w="${W}" data-h="${H}" data-padl="${PADL}" data-padr="${PADR}" data-padt="${PADT}" data-padb="${PADB}">
    <defs>
      <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${lineColor}" stop-opacity="0.18"/>
        <stop offset="100%" stop-color="${lineColor}" stop-opacity="0.01"/>
      </linearGradient>
      <clipPath id="chartClip">
        <rect x="${PADL}" y="${PADT}" width="${chartW}" height="${chartH}"/>
      </clipPath>
    </defs>
    ${gridLines}
    ${yLabels}
    ${xLabels}
    <g clip-path="url(#chartClip)">
      ${openLine}
      <polygon points="${fillPts}" fill="url(#chartFill)"/>
      <polyline points="${points}" fill="none" stroke="${lineColor}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
    </g>
    <line class="chart-crosshair" x1="-1" y1="${PADT}" x2="-1" y2="${PADT + chartH}" stroke="var(--text-muted)" stroke-width="1" stroke-dasharray="2,2"/>
    <circle class="chart-dot" cx="-10" cy="-10" r="3" fill="${lineColor}" stroke="var(--bg-primary)" stroke-width="1.5"/>
  </svg>`;
}

function attachChartInteraction(closes, timestamps, open) {
  const svg = dom.detailChart.querySelector('svg');
  const tooltip = dom.detailChart.querySelector('.chart-tooltip');
  if (!svg) return;

  function onMove(e) {
    const rect  = svg.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const relX  = clientX - rect.left;
    const W     = parseFloat(svg.getAttribute('data-w')    || rect.width);
    const H     = parseFloat(svg.getAttribute('data-h')    || rect.height);
    const PADL  = parseFloat(svg.getAttribute('data-padl') || 4);
    const PADR  = parseFloat(svg.getAttribute('data-padr') || 4);
    const PADT  = parseFloat(svg.getAttribute('data-padt') || 4);
    const PADB  = parseFloat(svg.getAttribute('data-padb') || 4);
    const chartW = W - PADL - PADR;
    const chartH = H - PADT - PADB;
    const scaleX = rect.width > 0 ? W / rect.width : 1;
    const svgX   = relX * scaleX;

    const idx = Math.round(((svgX - PADL) / chartW) * (closes.length - 1));
    const i   = Math.max(0, Math.min(closes.length - 1, idx));
    const price = closes[i];
    const ts    = timestamps?.[i];

    const crosshair = svg.querySelector('.chart-crosshair');
    const dot = svg.querySelector('.chart-dot');
    if (crosshair) {
      const xPos = PADL + (i / (closes.length - 1)) * chartW;
      crosshair.setAttribute('x1', xPos.toFixed(1));
      crosshair.setAttribute('x2', xPos.toFixed(1));
      const minVal = Math.min(...closes);
      const maxVal = Math.max(...closes);
      const range  = maxVal - minVal || 1;
      const yPos   = PADT + chartH - ((price - minVal) / range) * chartH;
      if (dot) { dot.setAttribute('cx', xPos.toFixed(1)); dot.setAttribute('cy', yPos.toFixed(1)); }
    }

    if (tooltip) {
      const timeStr = ts ? new Date(ts * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' }) : '';
      tooltip.textContent = `$${price.toFixed(2)}${timeStr ? '  ' + timeStr : ''}`;
    }
  }

  function onLeave() {
    const crosshair = svg.querySelector('.chart-crosshair');
    const dot = svg.querySelector('.chart-dot');
    if (crosshair) { crosshair.setAttribute('x1', '-1'); crosshair.setAttribute('x2', '-1'); }
    if (dot) { dot.setAttribute('cx', '-10'); dot.setAttribute('cy', '-10'); }
    if (tooltip) {
      const lastPrice = closes.at(-1);
      tooltip.textContent = `$${lastPrice.toFixed(2)}`;
    }
  }

  svg.addEventListener('mousemove', onMove);
  svg.addEventListener('mouseleave', onLeave);
  svg.addEventListener('touchmove', onMove, { passive: true });
  svg.addEventListener('touchend', onLeave);
  svg.addEventListener('click', onMove);
}

function redrawChart() {
  if (!_chartData) return;
  const { closes, timestamps, open } = _chartData;
  const w = dom.detailChart.clientWidth - 16; // subtract padding
  if (w < 10) return;
  const svg = dom.detailChart.querySelector('svg');
  if (svg) svg.remove();
  const header = dom.detailChart.querySelector('.chart-header');
  dom.detailChart.insertAdjacentHTML('beforeend', buildChartSVG(closes, timestamps, open, w));
  attachChartInteraction(closes, timestamps, open);
  // restore tooltip to last price
  const tooltip = dom.detailChart.querySelector('.chart-tooltip');
  if (tooltip) tooltip.textContent = `$${closes.at(-1).toFixed(2)}`;
}

async function renderIntradayChart(symbol) {
  dom.detailChart.style.display = 'none';
  dom.detailChart.innerHTML = '';
  _chartData = null;
  if (_chartResizeObserver) { _chartResizeObserver.disconnect(); _chartResizeObserver = null; }

  try {
    const res = await fetch(`/api/chart/${encodeURIComponent(symbol)}`);
    if (!res.ok) return;
    const data = await res.json();
    if (!data.closes || data.closes.length < 2) return;

    _chartData = data;
    const lastPrice = data.closes.at(-1);
    const lastTime  = data.timestamps?.at(-1);
    const timeStr   = lastTime ? new Date(lastTime * 1000).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' }) : '';

    dom.detailChart.innerHTML = `
      <div class="chart-header">
        <span>Intradag (5 min)</span>
        <span class="chart-tooltip">$${lastPrice.toFixed(2)}${timeStr ? '  ' + timeStr : ''}</span>
      </div>`;
    dom.detailChart.style.display = 'flex';

    // Wait one frame so clientWidth is known
    requestAnimationFrame(() => {
      redrawChart();
      _chartResizeObserver = new ResizeObserver(() => redrawChart());
      _chartResizeObserver.observe(dom.detailChart);
    });
  } catch (err) {
    console.error('Intraday chart error:', err);
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
    const vwapRow = risk.vwap != null
      ? item('VWAP', `${fmtPrice(risk.vwap, q.currency)} <span class="sl-vwap">ref</span>`)
      : '';
    dom.detailStoploss.innerHTML = `<div class="detail-col detail-col--sl">
      <div class="detail-col-title">Stop Loss ▼</div>
      ${item('ATR (14d)',     fmtPrice(risk.stopLoss.atr, q.currency))}
      ${item('Tight (1.5×)',  `${fmtPrice(risk.stopLoss.tight.price,    q.currency)} <span class="sl-pct">${risk.stopLoss.tight.pct}%</span>`)}
      ${item('Standard (2×)', `${fmtPrice(risk.stopLoss.standard.price, q.currency)} <span class="sl-pct">${risk.stopLoss.standard.pct}%</span>`)}
      ${item('Bred (3×)',     `${fmtPrice(risk.stopLoss.wide.price,     q.currency)} <span class="sl-pct">${risk.stopLoss.wide.pct}%</span>`)}
      ${item('Swing Low',     `${fmtPrice(risk.stopLoss.swingLow.price, q.currency)} <span class="sl-pct">${risk.stopLoss.swingLow.pct}%</span>`)}
      ${vwapRow}
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
  // Load persisted watchlist and alerts
  state.watchlist = loadWatchlist();
  state.alerts    = loadAlerts();
  updateWatchlistCount();
  renderWatchlist();

  // Request notification permission
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }

  // Sync refresh interval select to state
  state.refreshInterval = parseInt(dom.refreshInterval.value, 10);

  // Start auto-refresh cycle
  startAutoRefresh();

  // Fetch initial data
  await fetchNasdaqSymbols();

  // Fetch quotes for saved watchlist
  if (state.watchlist.length > 0) {
    fetchQuotes();
  }
}

init();
