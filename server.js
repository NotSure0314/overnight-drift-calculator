import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 4321;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory response cache to minimize API rate limit hits
const quoteCache = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// US NYSE Market Holidays (2024 - 2026)
const US_MARKET_HOLIDAYS = new Set([
  // 2024
  '2024-01-01', '2024-01-15', '2024-02-19', '2024-03-29', '2024-05-27',
  '2024-06-19', '2024-07-04', '2024-09-02', '2024-11-28', '2024-12-25',
  // 2025
  '2025-01-01', '2025-01-09', '2025-01-20', '2025-02-17', '2025-04-18',
  '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25'
]);

function isWeekend(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay();
  return day === 0 || day === 6;
}

/**
 * Fetch daily bars from Polygon.io from startDate to endDate
 */
async function fetchFromPolygon(ticker, startDate, endDate, apiKey) {
  const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${startDate}/${endDate}?adjusted=true&sort=asc&limit=50000&apiKey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);

  if (res.status === 429) {
    const err = new Error('Polygon.io API rate limit exceeded (5 requests/min on free tier). Please wait 60 seconds and try again.');
    err.status = 429;
    throw err;
  }

  if (res.status === 401 || res.status === 403) {
    const err = new Error('Invalid or unauthorized Polygon.io API key. Check your .env file.');
    err.status = 401;
    throw err;
  }

  if (!res.ok) {
    throw new Error(`Polygon API error (${res.status})`);
  }

  const data = await res.json();
  if (!data.results || data.results.length === 0) {
    return [];
  }

  return data.results.map((bar) => ({
    date: new Date(bar.t).toISOString().slice(0, 10),
    open: Number(bar.o),
    close: Number(bar.c)
  }));
}

/**
 * Fetch daily bars from Alpha Vantage
 */
async function fetchFromAlphaVantage(ticker, startDate, apiKey) {
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(ticker)}&outputsize=full&apikey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);

  if (res.status === 429) {
    const err = new Error('Alpha Vantage API rate limit reached. Please wait a moment and retry.');
    err.status = 429;
    throw err;
  }

  const data = await res.json();

  if (data['Note'] || data['Information']) {
    const err = new Error(data['Note'] || data['Information']);
    err.status = 429;
    throw err;
  }

  if (data['Error Message']) {
    const err = new Error(`Invalid ticker symbol "${ticker}" or no data available.`);
    err.status = 404;
    throw err;
  }

  const series = data['Time Series (Daily)'];
  if (!series) {
    return [];
  }

  return Object.entries(series)
    .filter(([date]) => date >= startDate)
    .map(([date, vals]) => ({
      date,
      open: Number(vals['1. open']),
      close: Number(vals['4. close'])
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Fetch daily bars from Yahoo Finance v8 Chart API via server proxy from startDate to endDate
 */
async function fetchFromYahoo(ticker, startDate, endDate) {
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);
  const period1 = Math.floor(Date.UTC(sy, sm - 1, sd, 0, 0, 0) / 1000);
  const period2 = Math.floor(Date.UTC(ey, em - 1, ed, 23, 59, 59) / 1000);

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${period1}&period2=${period2}&interval=1d`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
    }
  });

  if (res.status === 429) {
    const err = new Error('Market data rate limit reached. Please wait a moment before retrying.');
    err.status = 429;
    throw err;
  }

  if (res.status === 404) {
    const err = new Error(`Ticker symbol "${ticker}" was not found.`);
    err.status = 404;
    throw err;
  }

  if (!res.ok) {
    throw new Error(`Yahoo Finance upstream status ${res.status}`);
  }

  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result || !result.timestamp || !result.indicators?.quote?.[0]) {
    const err = new Error(`No trading data found for ticker "${ticker}".`);
    err.status = 404;
    throw err;
  }

  const timestamps = result.timestamp;
  const quote = result.indicators.quote[0];
  const bars = [];

  for (let i = 0; i < timestamps.length; i++) {
    const open = quote.open?.[i];
    const close = quote.close?.[i];
    if (open != null && close != null) {
      const dt = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
      bars.push({
        date: dt,
        open: Number(open),
        close: Number(close)
      });
    }
  }

  return bars;
}

/**
 * Compute daily Close-to-Open overnight returns from startDate up to the current trading day.
 * Supports both:
 *   1. Compounded (reinvesting current balance V_k each night: e.g. $1000 -> $1002 -> invest $1002 next night)
 *   2. Non-Compounded / Simple (investing fixed initial $1000 each night, summing nightly profits)
 */
async function getOvernightSeriesForTicker(ticker, startDate) {
  const upperTicker = ticker.trim().toUpperCase();
  const todayIso = new Date().toISOString().slice(0, 10);
  const cacheKey = `${upperTicker}:${startDate}:${todayIso}`;

  const cached = quoteCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const polygonKey = process.env.POLYGON_API_KEY;
  const alphaKey = process.env.ALPHAVANTAGE_API_KEY;
  const preferred = (process.env.MARKET_DATA_PROVIDER || 'polygon').toLowerCase();

  let bars = [];
  let sourceUsed = '';

  if (preferred === 'polygon' && polygonKey && polygonKey !== 'your_polygon_api_key_here') {
    bars = await fetchFromPolygon(upperTicker, startDate, todayIso, polygonKey);
    sourceUsed = 'Polygon.io';
  } else if (preferred === 'alphavantage' && alphaKey && alphaKey !== 'your_alphavantage_api_key_here') {
    bars = await fetchFromAlphaVantage(upperTicker, startDate, alphaKey);
    sourceUsed = 'Alpha Vantage';
  } else if (polygonKey && polygonKey !== 'your_polygon_api_key_here') {
    bars = await fetchFromPolygon(upperTicker, startDate, todayIso, polygonKey);
    sourceUsed = 'Polygon.io';
  } else if (alphaKey && alphaKey !== 'your_alphavantage_api_key_here') {
    bars = await fetchFromAlphaVantage(upperTicker, startDate, alphaKey);
    sourceUsed = 'Alpha Vantage';
  } else {
    bars = await fetchFromYahoo(upperTicker, startDate, todayIso);
    sourceUsed = 'Yahoo Finance Proxy';
  }

  const buyIndex = bars.findIndex((b) => b.date === startDate);
  if (buyIndex === -1) {
    const err = new Error(
      `No trading data found for ${upperTicker} on ${startDate}. Ensure the date is a valid past US market trading day and the ticker was actively traded.`
    );
    err.status = 422;
    err.code = 'NO_BUY_DATE_DATA';
    throw err;
  }

  if (buyIndex + 1 >= bars.length) {
    const err = new Error(
      `${startDate} is the most recent trading day in the dataset for ${upperTicker}; next-day market open price is not available yet.`
    );
    err.status = 422;
    err.code = 'NO_NEXT_OPEN_YET';
    throw err;
  }

  const activeBars = bars.slice(buyIndex);
  const firstBar = activeBars[0];
  const lastBar = activeBars[activeBars.length - 1];
  const prevToLastBar = activeBars[activeBars.length - 2];

  // 1. Compounded multiplier: V_{k+1} = V_k * (Open_{k+1} / Close_k)
  // 2. Simple (non-compounded) multiplier: 1 + sum((Open_{k+1} - Close_k) / Close_k)
  let compoundedMultiplier = 1.0;
  let simpleReturnSum = 0.0;
  let winningNights = 0;
  const totalNights = activeBars.length - 1;

  for (let i = 0; i < totalNights; i++) {
    const closePrice = activeBars[i].close;
    const nextOpenPrice = activeBars[i + 1].open;
    const nightReturn = (nextOpenPrice - closePrice) / closePrice;
    if (nightReturn > 0) winningNights++;
    compoundedMultiplier *= 1 + nightReturn;
    simpleReturnSum += nightReturn;
  }

  const simpleMultiplier = 1.0 + simpleReturnSum;

  const payload = {
    ticker: upperTicker,
    buyDate: firstBar.date,
    closePrice: firstBar.close,
    sellDate: lastBar.date,
    openPrice: lastBar.open,
    lastNightClosePrice: prevToLastBar.close,
    totalNights,
    winningNights,
    winRatePct: totalNights > 0 ? (winningNights / totalNights) * 100 : 0,
    compoundedMultiplier,
    simpleMultiplier,
    source: sourceUsed
  };

  quoteCache.set(cacheKey, { timestamp: Date.now(), data: payload });
  return payload;
}

/**
 * API endpoint: GET /api/config-status
 */
app.get('/api/config-status', (_req, res) => {
  const hasPolygon = Boolean(
    process.env.POLYGON_API_KEY && process.env.POLYGON_API_KEY !== 'your_polygon_api_key_here'
  );
  const hasAlpha = Boolean(
    process.env.ALPHAVANTAGE_API_KEY && process.env.ALPHAVANTAGE_API_KEY !== 'your_alphavantage_api_key_here'
  );

  res.json({
    configuredProvider: hasPolygon
      ? 'Polygon.io (.env)'
      : hasAlpha
      ? 'Alpha Vantage (.env)'
      : 'Yahoo Finance Proxy (Server-side fallback)',
    hasEnvApiKey: hasPolygon || hasAlpha
  });
});

/**
 * API endpoint: POST /api/overnight-returns
 * Body: { startDate: "YYYY-MM-DD", tickers: ["VOO", "NVDA", ...] }
 */
app.post('/api/overnight-returns', async (req, res) => {
  try {
    const { startDate, tickers } = req.body || {};

    if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      return res.status(400).json({
        error: 'Please provide a valid start date in YYYY-MM-DD format.'
      });
    }

    if (isWeekend(startDate)) {
      return res.status(400).json({
        error: `${startDate} falls on a weekend. Please select a valid past market trading day (Monday–Friday).`
      });
    }

    if (US_MARKET_HOLIDAYS.has(startDate)) {
      return res.status(400).json({
        error: `${startDate} is a US stock market holiday. Please select an active trading day.`
      });
    }

    if (!Array.isArray(tickers) || tickers.length === 0) {
      return res.status(400).json({
        error: 'Please select at least one stock ticker symbol.'
      });
    }

    const sanitizedTickers = [...new Set(tickers.map((t) => String(t).trim().toUpperCase()))];
    for (const t of sanitizedTickers) {
      if (!/^[A-Z]{1,5}(\.[A-Z]{1,2})?$/.test(t)) {
        return res.status(400).json({
          error: `Invalid ticker format "${t}". Use 1–5 letters (e.g., AAPL, BRK.B).`
        });
      }
    }

    const results = [];
    const errors = [];

    for (const ticker of sanitizedTickers) {
      try {
        const series = await getOvernightSeriesForTicker(ticker, startDate);
        results.push(series);
      } catch (tickerErr) {
        if (tickerErr.status === 429) {
          return res.status(429).json({
            error: tickerErr.message,
            partialResults: results
          });
        }
        errors.push({
          ticker,
          code: tickerErr.code || 'TICKER_ERROR',
          message: tickerErr.message || `Failed to retrieve data for ${ticker}.`
        });
      }
    }

    if (results.length === 0 && errors.length > 0) {
      return res.status(422).json({
        error: errors[0].message,
        errors
      });
    }

    return res.json({
      startDate,
      results,
      errors
    });
  } catch (err) {
    return res.status(500).json({
      error: err.message || 'Unexpected server error while fetching market data.'
    });
  }
});

if (!process.env.VERCEL) {
  app.listen(PORT);
}

export default app;
