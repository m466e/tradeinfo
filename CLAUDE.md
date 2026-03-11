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

**Recommendation signals** (10 factors, averaged -1 to +1):
RSI (14), 5-day momentum, SMA20, MA50/200 cross, price vs SMA50, 52-week position, P/E, forward P/E, news sentiment, VWAP → KÖP / HÅLL / SÄLJ

**Price alerts** (`state.alerts`, localStorage `tradeinfo_alerts`):
- Bell button per watchlist row opens modal with above/below thresholds
- `checkAlerts()` called on every quote refresh, triggers Web Notifications API on crossings

**Data flow:** Browser → Express API → Yahoo Finance v7 / Alpaca / NASDAQ Trader / Google News / Reddit → normalize → JSON → frontend state → table + detail render

## TODO

- **CSV-export** — exportera bevakningslistan till CSV
