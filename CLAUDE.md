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

**Backend (`server.js`)** — ES modules, three main concerns:
1. **Yahoo Finance auth** (`getYFAuth`) — fetches consent cookies + crumb token, cached 1 hour
2. **NASDAQ symbol list** (`fetchNasdaqSymbols`) — scrapes nasdaqtrader.com, cached 24 hours
3. **Quote fetching** (`fetchYahooQuotes`) — batches up to 40 symbols per request to Yahoo Finance v8 API, then normalizes via `normalizeQuote()`

API endpoints:
- `GET /api/nasdaq-symbols` — all symbols with names
- `GET /api/quote?symbols=AAPL,MSFT` — normalized quotes (max 100)
- `GET /api/health`

**Frontend (`public/`)** — served as static files by Express:
- `app.js` — all UI logic; state held in module-level variables (`watchlist`, `quotes`, `prevQuotes`, `allSymbols`); watchlist persisted to localStorage; auto-refreshes quotes every 30 seconds
- `styles.css` — dark theme via CSS custom properties (`--bg-primary`, `--positive`, `--negative`, `--accent`)

**Data flow:** Browser → Express API → Yahoo Finance v8 / NASDAQ Trader → `normalizeQuote()` → JSON → frontend state → table render
