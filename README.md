# Overnight Drift — Close-to-Open Stock Return Calculator

A responsive single-page web application that calculates hypothetical overnight returns from buying stocks at the regular market close (4:00 PM ET) on a selected start date and selling at the next trading day's opening price (9:30 AM ET).

## Features

- **Flexible Capital Allocation**: Default `$1,000` investment (minimum `$1`), with an explicit toggle in the UI between **Equal Split Across Selected Stocks** and **Custom Per-Stock Dollar Allocation**.
- **Pre-Selected Basket & Custom Tickers**: Pre-loaded with `VOO`, `NVDA`, `MU` (Micron), `AMZN` (Amazon), `AMD`, `INTC` (Intel), and `XOM` (Exxon Mobil), plus validated custom ticker input.
- **Trading Calendar & Edge-Case Protection**:
  - Blocks weekends and official US NYSE market holidays.
  - Detects when a selected start date has no trading data or is the most recent session without a next-day opening price yet.
  - Handles invalid ticker symbols and upstream rate limits (`HTTP 429`) gracefully with partial-result rendering and clear banners.
- **Secure API Key Management**: Never exposes API keys in client code. All requests are routed through the local Node/Express backend (`server.js`), which reads `POLYGON_API_KEY` or `ALPHAVANTAGE_API_KEY` from `.env` and includes a server-side Yahoo Finance proxy fallback + 15-minute in-memory cache.

---

## Setup & Running Instructions

### 1. Prerequisites
- **Node.js** `v18.0.0` or higher (includes native `fetch`).

### 2. Install Dependencies
```bash
npm install
```

### 3. Configure Market Data API Keys
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Open `.env` and add your free API key from either **Polygon.io** or **Alpha Vantage**:
- **Polygon.io (Recommended)**: Sign up for a free key at [https://polygon.io/](https://polygon.io/) and set `POLYGON_API_KEY=your_key`.
- **Alpha Vantage**: Sign up for a free key at [https://www.alphavantage.co/support/#api-key](https://www.alphavantage.co/support/#api-key) and set `ALPHAVANTAGE_API_KEY=your_key` and `MARKET_DATA_PROVIDER=alphavantage`.
- **Zero-Key Fallback**: If neither key is set in `.env`, the backend automatically falls back to its server-side Yahoo Finance v8 chart proxy so the app remains immediately testable.

### 4. Start the Application
```bash
npm start
```
Then open [http://localhost:3000](http://localhost:3000) in your browser.
