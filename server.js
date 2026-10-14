import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 4321;

// Enable CORS for all incoming requests so any external app/frontend can consume the API
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

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

// Pre-calculated top 10 overnight performers benchmark dataset
const TOP_PERFORMERS = [
  { rank: 1, ticker: 'MU', name: 'Micron Technology', compoundedReturnPct: 223.7, simpleReturnPct: 132.9, winRatePct: 54.4, buyAndHoldPct: 376.3 },
  { rank: 2, ticker: 'MRVL', name: 'Marvell Technology', compoundedReturnPct: 208.1, simpleReturnPct: 127.0, winRatePct: 54.4, buyAndHoldPct: 175.9 },
  { rank: 3, ticker: 'LRCX', name: 'Lam Research', compoundedReturnPct: 132.3, simpleReturnPct: 97.0, winRatePct: 53.6, buyAndHoldPct: 98.2 },
  { rank: 4, ticker: 'INTC', name: 'Intel Corp.', compoundedReturnPct: 104.7, simpleReturnPct: 84.6, winRatePct: 52.4, buyAndHoldPct: 164.1 },
  { rank: 5, ticker: 'AMAT', name: 'Applied Materials', compoundedReturnPct: 82.0, simpleReturnPct: 69.9, winRatePct: 52.8, buyAndHoldPct: 96.3 },
  { rank: 6, ticker: 'ARM', name: 'ARM Holdings', compoundedReturnPct: 77.8, simpleReturnPct: 70.0, winRatePct: 52.4, buyAndHoldPct: 39.5 },
  { rank: 7, ticker: 'TSM', name: 'Taiwan Semiconductor', compoundedReturnPct: 77.2, simpleReturnPct: 61.3, winRatePct: 55.2, buyAndHoldPct: 41.1 },
  { rank: 8, ticker: 'CAT', name: 'Caterpillar', compoundedReturnPct: 71.1, simpleReturnPct: 57.1, winRatePct: 54.8, buyAndHoldPct: 40.2 },
  { rank: 9, ticker: 'SMH', name: 'VanEck Semiconductor ETF', compoundedReturnPct: 71.0, simpleReturnPct: 57.9, winRatePct: 55.6, buyAndHoldPct: 65.2 },
  { rank: 10, ticker: 'NVDA', name: 'NVIDIA Corp.', compoundedReturnPct: 68.2, simpleReturnPct: 54.5, winRatePct: 57.6, buyAndHoldPct: 23.1 }
];

// Pre-calculated optimal portfolio allocation weights
const OPTIMAL_ALLOCATION_WEIGHTS = {
  MU: 0.33,
  MRVL: 0.305,
  CAT: 0.10,
  NVDA: 0.06,
  TSM: 0.055,
  SMH: 0.04,
  LRCX: 0.035,
  ARM: 0.035,
  INTC: 0.03,
  AMAT: 0.01
};

function isWeekend(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay();
  return day === 0 || day === 6;
}

function isTradingDay(dateStr) {
  return !isWeekend(dateStr) && !US_MARKET_HOLIDAYS.has(dateStr);
}

function getDefaultTradingDate(daysBack = 21) {
  const now = new Date();
  const cursor = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  let count = 0;
  while (count < daysBack) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    const iso = cursor.toISOString().slice(0, 10);
    if (isTradingDay(iso)) count++;
  }
  return cursor.toISOString().slice(0, 10);
}

/**
 * Fetch daily bars from Polygon.io
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
  if (!series) return [];

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
 * Fetch daily bars from Yahoo Finance v8 Chart API via server proxy
 */
async function fetchFromYahoo(ticker, startDate, endDate) {
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);
  const period1 = Math.floor(Date.UTC(sy, sm - 1, sd, 0, 0, 0) / 1000);
  const period2 = Math.floor(Date.UTC(ey, em - 1, ed, 23, 59, 59) / 1000);

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${period1}&period2=${period2}&interval=1d`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }
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
 * Compute daily Close-to-Open overnight returns from startDate up to current trading day.
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

// ============================================================================
// REST API ENDPOINTS
// ============================================================================

/**
 * 1. Health & Status
 * GET /api/status or GET /api/health
 */
app.get(['/api/status', '/api/health', '/api/config-status'], (_req, res) => {
  const hasPolygon = Boolean(
    process.env.POLYGON_API_KEY && process.env.POLYGON_API_KEY !== 'your_polygon_api_key_here'
  );
  const hasAlpha = Boolean(
    process.env.ALPHAVANTAGE_API_KEY && process.env.ALPHAVANTAGE_API_KEY !== 'your_alphavantage_api_key_here'
  );

  res.json({
    status: 'ok',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    configuredProvider: hasPolygon
      ? 'Polygon.io (.env)'
      : hasAlpha
      ? 'Alpha Vantage (.env)'
      : 'Yahoo Finance Proxy (Server-side fallback)',
    hasEnvApiKey: hasPolygon || hasAlpha,
    endpoints: {
      singleTicker: 'GET /api/overnight/:ticker',
      multiTickerGet: 'GET /api/overnight?tickers=NVDA,MU&startDate=YYYY-MM-DD',
      multiTickerPost: 'POST /api/overnight',
      topPerformers: 'GET /api/top-performers',
      portfolioOptimize: 'GET /api/optimize?amount=1000'
    }
  });
});

/**
 * 2. Top Performers Screen
 * GET /api/top-performers
 */
app.get('/api/top-performers', (_req, res) => {
  res.json({
    description: 'Top 10 overnight drift performers ranked by 1-year compounded Close-to-Next-Open returns',
    period: 'Past 250 trading nights',
    strategy: 'Buy at regular session Close (4:00 PM ET) -> Sell at next session Open (9:30 AM ET)',
    topPerformers: TOP_PERFORMERS
  });
});

/**
 * 3. Portfolio Optimization
 * GET /api/optimize?amount=1000
 * POST /api/optimize
 */
app.all('/api/optimize', (req, res) => {
  const totalAmount = parseFloat(req.query.amount || req.body?.amount || 1000);
  if (isNaN(totalAmount) || totalAmount < 1) {
    return res.status(400).json({ error: 'amount must be a positive number of at least $1.00' });
  }

  const allocations = {};
  let allocatedSum = 0;

  for (const [ticker, weight] of Object.entries(OPTIMAL_ALLOCATION_WEIGHTS)) {
    const dollars = Math.round((weight * totalAmount) * 100) / 100;
    allocations[ticker] = {
      dollars,
      weightPct: Number((weight * 100).toFixed(1))
    };
    allocatedSum += dollars;
  }

  // Adjust any fractional cent difference on the top ticker
  const diff = Number((totalAmount - allocatedSum).toFixed(2));
  if (diff !== 0) {
    allocations['MU'].dollars = Number((allocations['MU'].dollars + diff).toFixed(2));
  }

  res.json({
    investmentAmount: totalAmount,
    strategy: 'Optimal Balanced Overnight Portfolio (Model 5)',
    historicalMetrics: {
      compoundedReturnPct: 167.5,
      projectedFinalValue: Number((totalAmount * 2.6752).toFixed(2)),
      maxDrawdownPct: 14.8,
      sharpeRatio: 2.62,
      winRatePct: 55.6
    },
    allocations
  });
});

/**
 * 4. Single Ticker Overnight Lookup
 * GET /api/overnight/:ticker
 */
app.get('/api/overnight/:ticker', async (req, res) => {
  try {
    const ticker = req.params.ticker.trim().toUpperCase();
    if (!/^[A-Z]{1,5}(\.[A-Z]{1,2})?$/.test(ticker)) {
      return res.status(400).json({ error: `Invalid ticker format "${ticker}".` });
    }

    const startDate = req.query.startDate || getDefaultTradingDate(21);
    const compound = req.query.compound !== 'false';
    const amount = parseFloat(req.query.amount || req.query.investment || 1000);

    if (isWeekend(startDate) || US_MARKET_HOLIDAYS.has(startDate)) {
      return res.status(400).json({ error: `${startDate} is not an active US market trading day.` });
    }

    const data = await getOvernightSeriesForTicker(ticker, startDate);
    const mult = compound ? data.compoundedMultiplier : data.simpleMultiplier;
    const finalValue = Number((amount * mult).toFixed(2));
    const dollarGainLoss = Number((finalValue - amount).toFixed(2));
    const percentReturn = Number((((finalValue - amount) / amount) * 100).toFixed(2));

    res.json({
      ticker: data.ticker,
      startDate: data.buyDate,
      startClosePrice: data.closePrice,
      latestDate: data.sellDate,
      latestOpenPrice: data.openPrice,
      totalNights: data.totalNights,
      winningNights: data.winningNights,
      winRatePct: Number(data.winRatePct.toFixed(2)),
      compoundingEnabled: compound,
      initialInvestment: amount,
      finalValue,
      dollarGainLoss,
      percentReturn,
      source: data.source
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * 5. Multi-Ticker Handler (GET & POST)
 * GET /api/overnight?tickers=NVDA,MU,TSM&startDate=YYYY-MM-DD&compound=true&amount=1000
 * POST /api/overnight or POST /api/overnight-returns
 */
async function handleOvernightCalculation(req, res) {
  try {
    let startDate = '';
    let tickers = [];
    let compound = true;
    let totalInvestment = 1000;
    let customAllocations = null;

    if (req.method === 'GET') {
      startDate = req.query.startDate || getDefaultTradingDate(21);
      tickers = (req.query.tickers || 'VOO,NVDA,MU,AMZN,AMD,INTC,XOM').split(',').map(s => s.trim());
      compound = req.query.compound !== 'false';
      totalInvestment = parseFloat(req.query.amount || req.query.investment || 1000);
    } else {
      const body = req.body || {};
      startDate = body.startDate || getDefaultTradingDate(21);
      tickers = body.tickers || [];
      compound = body.compound !== false;
      totalInvestment = parseFloat(body.investmentAmount || 1000);
      customAllocations = body.allocations || null;
    }

    if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      return res.status(400).json({ error: 'Please provide a valid start date in YYYY-MM-DD format.' });
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
      return res.status(400).json({ error: 'Please provide at least one stock ticker symbol.' });
    }

    const sanitizedTickers = [...new Set(tickers.map((t) => String(t).trim().toUpperCase()))];
    for (const t of sanitizedTickers) {
      if (!/^[A-Z]{1,5}(\.[A-Z]{1,2})?$/.test(t)) {
        return res.status(400).json({ error: `Invalid ticker format "${t}".` });
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
          return res.status(429).json({ error: tickerErr.message, partialResults: results });
        }
        errors.push({
          ticker,
          code: tickerErr.code || 'TICKER_ERROR',
          message: tickerErr.message || `Failed to retrieve data for ${ticker}.`
        });
      }
    }

    if (results.length === 0 && errors.length > 0) {
      return res.status(422).json({ error: errors[0].message, errors });
    }

    // Compute portfolio totals
    const perStockDefault = totalInvestment / results.length;
    let portfolioInvested = 0;
    let portfolioFinalValue = 0;

    const breakdown = results.map(item => {
      const stockInvested = customAllocations && customAllocations[item.ticker] != null
        ? Number(customAllocations[item.ticker])
        : perStockDefault;

      const mult = compound ? item.compoundedMultiplier : item.simpleMultiplier;
      const finalVal = Number((stockInvested * mult).toFixed(2));
      const pnl = Number((finalVal - stockInvested).toFixed(2));
      const retPct = stockInvested > 0 ? Number(((pnl / stockInvested) * 100).toFixed(2)) : 0;

      portfolioInvested += stockInvested;
      portfolioFinalValue += finalVal;

      return {
        ticker: item.ticker,
        buyDate: item.buyDate,
        closePrice: item.closePrice,
        sellDate: item.sellDate,
        openPrice: item.openPrice,
        totalNights: item.totalNights,
        winRatePct: Number(item.winRatePct.toFixed(2)),
        invested: stockInvested,
        finalValue: finalVal,
        gainLoss: pnl,
        returnPct: retPct
      };
    });

    const totalGainLoss = Number((portfolioFinalValue - portfolioInvested).toFixed(2));
    const totalReturnPct = portfolioInvested > 0 
      ? Number(((totalGainLoss / portfolioInvested) * 100).toFixed(2)) 
      : 0;

    return res.json({
      startDate,
      compoundingEnabled: compound,
      portfolioSummary: {
        totalInvested: Number(portfolioInvested.toFixed(2)),
        totalFinalValue: Number(portfolioFinalValue.toFixed(2)),
        totalGainLoss,
        overallReturnPct: totalReturnPct,
        stocksCount: results.length
      },
      results, // raw series data for frontend backward compatibility
      breakdown,
      errors
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unexpected server error.' });
  }
}

app.get('/api/overnight', handleOvernightCalculation);
app.post(['/api/overnight', '/api/overnight-returns'], handleOvernightCalculation);

/**
 * 6. Interactive API Documentation
 * GET /docs or GET /api/docs
 */
app.get(['/docs', '/api/docs'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'docs.html'));
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Overnight Drift API running on port ${PORT}`);
  });
}

export default app;
