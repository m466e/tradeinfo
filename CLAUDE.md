# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start       # Start server on port 3000
npm run dev     # Start with auto-reload (node --watch)
```

No build step, test suite, or linter is configured.

## Environment

Create a `.env` file in the project root (see `.env.example`). Loaded at startup via `readFileSync` — no external dependency.

```
ALPACA_KEY=...       # Alpaca paper trading key (alpaca.markets, gratis)
ALPACA_SECRET=...    # Alpaca paper trading secret
FINNHUB_TOKEN=...    # Finnhub token (kräver betald plan för intradag)
```

## Architecture

Full-stack NASDAQ stock monitoring app. Node.js/Express backend + vanilla JS frontend. No transpiler or bundler.

**Backend (`server.js`)** — ES modules:
1. **Yahoo Finance auth** (`getYFAuth`) — fetches consent cookies + crumb token from fc.yahoo.com, cached 1 hour. Uses v7 API (not v8). Auto-retry with exponential backoff (1s/2s/4s) on 401/403 via `getYFAuthWithRetry`.
2. **NASDAQ symbol list** (`fetchNasdaqSymbols`) — scrapes nasdaqtrader.com, cached 24 hours
3. **Quote fetching** (`fetchYahooQuotes`) — batches up to 40 symbols per request to Yahoo Finance v7 API, normalized via `normalizeQuote()`. Includes `ma50`, `ma200` fields.
4. **Price history** (`fetchPriceHistory`) — v7/finance/chart, range=1mo, interval=1d
5. **Intraday chart** (`fetchIntradayChart`) — 1-minute candles with fallback chain: Yahoo Finance → Alpaca (IEX feed) → Finnhub
6. **News fetching** — `fetchYahooNews`, `fetchGoogleNews` (RSS), `fetchRedditPosts`; all normalized to `{title, link, publisher, time, summary, source}`
7. **Risk calculations** — `calcPriceRisk`, `calcNewsRisk`, `calcStopLoss` (ATR 14-period + swing low), `calcRSI`, `calcVWAP`, `calcRecommendation`

**Caching:**
- `riskCache` — LRU(50), TTL 15 min
- `nasdaqCache` — 24h
- `yfAuth` — 1h

API endpoints:
- `GET /api/nasdaq-symbols` — all symbols with names
- `GET /api/quote?symbols=AAPL,MSFT` — normalized quotes (max 100)
- `GET /api/risk/:symbol` — risk score, stop loss, VWAP, news sentiment, buy/sell recommendation; cached 15 min
- `GET /api/chart/:symbol` — intraday 1m candles `{ timestamps, closes, open, high, low }`
- `GET /api/health`

**Frontend (`public/`)** — served as static files by Express:
- `app.js` — all UI logic; state in module-level variables (`watchlist`, `quotes`, `prevQuotes`, `allSymbols`, `detailSymbol`, `currentRisk`); watchlist persisted to localStorage; auto-refresh configurable (15s/30s/60s/Manuell), pauses when tab is hidden
- `styles.css` — dark theme via CSS custom properties (`--bg-primary`, `--positive`, `--negative`, `--accent`)

**Layout (inside `#watchlist-panel`, flex column):**
1. `.watchlist-header` + `#watchlist-container` / `#watchlist-empty` — sortable table (click column header, ↑/↓ arrow shows active sort; supports Symbol, Namn, Pris, Förändring, %, Dag H/L, Volym, Mkt Cap, P/E, Fwd P/E, EPS, Yield, Beta, P/B)
2. `#detail-panel` (flex column):
   - `.detail-top` (flex row, align-items: stretch): `#detail-left` | `#detail-stoploss` | `#detail-risk` | `#detail-chart`
   - `#detail-articles` (full width, 2-column grid: positive/negative articles)

**Detail panel rendering** (`renderDetailBody` in app.js):
- `dom.detailBody` — symbol/price header + data columns (Dagspriser, 52-veckors, Värdering, Övrigt)
- `dom.detailStoploss` — ATR-based stop loss (tight 1.5×, standard 2×, wide 3×, swing low) + VWAP reference
- `dom.detailRisk` — risk gauge SVG (100×100, r=36) + risk label + buy/sell recommendation badge + top 4 signals
- `dom.detailChart` — intradag SVG-diagram, rightmost column, fills full height of `.detail-top`
- `dom.detailArticles` — positive/negative article lists with source badges (yahoo/google/reddit)

**Intradag chart** (`buildChartSVG`, `renderIntradayChart`, `redrawChart` in app.js):
- SVG with Y-axis price labels (dynamic tick count ≈ chartH/25), X-axis time labels at whole hours (NYSE time)
- ClipPath keeps price line within chart area; gradient fill under line
- `ResizeObserver` redraws on container resize
- Mousemove/click: vertical crosshair + price/time tooltip
- `_chartResizeObserver` disconnected on symbol change

**Recommendation signals** (15 factors, averaged -1 to +1, weighted by `signalReliabilityMultiplier`):
1. RSI (14) 2. 5-day momentum 3. SMA20 4. MA50/200 cross 5. Price vs SMA50 6. 52-week position 7. P/E 8. Forward P/E 9. News sentiment 10. VWAP (true, volume-weighted) 11. Volume ratio 12. Day range position 13. Day trend (gap + from open) 14. PEG approximation 15. P/B (skipped for marketCap > 500B)

`signalReliabilityMultiplier(marketCap)`: mega-cap 1.2×, large 1.0×, mid 0.85×, small 0.70×, micro 0.5×

`calcPriceRisk` also adds bid-ask spread component (+5/10/20 pts for illiquid quotes).

**Sentiment analysis** (`scoreSentiment` → `calcNewsRisk`):
- `POSITIVE_PHRASES` / `NEGATIVE_PHRASES`: multi-word phrases matched first (weight 2×), removed from text before word scoring
- `POSITIVE_WORDS` / `NEGATIVE_WORDS`: Set-based exact token matching (no substring false positives)
- `NEGATORS`: 3-token window inverts following sentiment ("not strong" → negative)
- Time weighting: ≤24h = 1.0×, ≤72h = 0.6×, older = 0.3×

**normalizeQuote** includes `earningsTimestamp` (from `earningsTimestamp` or `earningsTimestampStart`). Shown in detail panel "Övrigt" column with orange badge if within 7 days.

**Price alerts** (`state.alerts`, localStorage `tradeinfo_alerts`):
- Bell button per watchlist row opens modal with above/below thresholds
- `checkAlerts()` called on every quote refresh, triggers Web Notifications API on crossings

**Portfolio tracking** (`state.portfolio`, localStorage `tradeinfo_portfolio`):
- `#portfolio-panel` between watchlist table and detail panel, collapsed by default
- Add positions: symbol + shares + avg price; volume-weighted average on duplicate
- `renderPortfolio()` called on every quote refresh — live P&L ($, %) per position
- Summary bar: total cost basis, market value, total P&L
- Header badge shows total P&L (green/red) even when panel is collapsed

**Sidebar toggle:**
- `#sidebar-toggle` button positioned absolutely at the sidebar/main boundary (`left: 300px`, transitions to `0px`)
- Toggling adds/removes `sidebar-hidden` class on `<main>`, which sets `grid-template-columns: 0px 1fr`
- Sidebar hidden by default on page load

**Data flow:** Browser → Express API → Yahoo Finance v7 / Alpaca / NASDAQ Trader / Google News / Reddit → normalize → JSON → frontend state → table + detail render

## TODO

- **CSV-export** — exportera bevakningslistan till CSV
- **Realtidsdata** — WebSocket-stream från Alpaca för äkta realtidspriser (Yahoo Finance-quotes har ~15 min fördröjning)
- **Scanner/filter** — filtrera bevakningslistan på signalkriterier (t.ex. RSI < 30 + volym > 1.5×)
- **Opening Range Breakout** — beräkna och visa de första 15-30 minuternas prisspann
