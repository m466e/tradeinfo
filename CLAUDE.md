# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start       # Start server on port 3000
npm run dev     # Start with auto-reload (node --watch)
```

No build step, test suite, or linter is configured.

## Architecture

Full-stack NASDAQ stock monitoring app. Node.js/Express backend + vanilla JS frontend. No transpiler or bundler.

**Backend (`server.js`)** — ES modules:
1. **Yahoo Finance auth** (`getYFAuth`) — fetches consent cookies + crumb token from fc.yahoo.com, cached 1 hour. Uses v7 API (not v8).
2. **NASDAQ symbol list** (`fetchNasdaqSymbols`) — scrapes nasdaqtrader.com, cached 24 hours
3. **Quote fetching** (`fetchYahooQuotes`) — batches up to 40 symbols per request to Yahoo Finance v7 API, normalized via `normalizeQuote()`. Includes `ma50`, `ma200` fields.
4. **Price history** (`fetchPriceHistory`) — v7/finance/chart, range=1mo, interval=1d
5. **News fetching** — `fetchYahooNews`, `fetchGoogleNews` (RSS), `fetchRedditPosts`; all normalized to `{title, link, publisher, time, summary, source}`
6. **Risk calculations** — `calcPriceRisk`, `calcNewsRisk`, `calcStopLoss` (ATR 14-period + swing low), `calcRSI`, `calcRecommendation`

API endpoints:
- `GET /api/nasdaq-symbols` — all symbols with names
- `GET /api/quote?symbols=AAPL,MSFT` — normalized quotes (max 100)
- `GET /api/risk/:symbol` — risk score, stop loss, news sentiment, buy/sell recommendation; cached 15 min
- `GET /api/health`

**Frontend (`public/`)** — served as static files by Express:
- `app.js` — all UI logic; state in module-level variables (`watchlist`, `quotes`, `prevQuotes`, `allSymbols`, `detailSymbol`, `currentRisk`); watchlist persisted to localStorage; auto-refreshes every 30 seconds
- `styles.css` — dark theme via CSS custom properties (`--bg-primary`, `--positive`, `--negative`, `--accent`)

**Layout (inside `#watchlist-panel`, flex column):**
1. `.watchlist-header` + `#watchlist-container` / `#watchlist-empty` — table fixed at 8-row height (331px)
2. `#detail-panel` (flex column):
   - `.detail-top` (flex row): `#detail-left` (scrollable detail columns) | `#detail-stoploss` | `#detail-risk`
   - `#detail-articles` (full width, 2-column grid: positive/negative articles)

**Detail panel rendering** (`renderDetailBody` in app.js):
- `dom.detailBody` — symbol/price header + data columns (Dagspriser, 52-veckors, Värdering, Övrigt)
- `dom.detailStoploss` — ATR-based stop loss (tight 1.5×, standard 2×, wide 3×, swing low)
- `dom.detailRisk` — risk gauge SVG (100×100, r=36) + risk label + buy/sell recommendation badge + top 4 signals
- `dom.detailArticles` — positive/negative article lists with source badges (yahoo/google/reddit)

**Recommendation signals** (9 factors, averaged -1 to +1):
RSI (14), 5-day momentum, SMA20, MA50/200 cross, price vs SMA50, 52-week position, P/E, forward P/E, news sentiment → KÖP / HÅLL / SÄLJ

**Data flow:** Browser → Express API → Yahoo Finance v7 / NASDAQ Trader / Google News / Reddit → normalize → JSON → frontend state → table + detail render
