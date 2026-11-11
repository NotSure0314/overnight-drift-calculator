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

// Server-side daily OHLC bar cache + in-flight deduplication to prevent upstream 429 throttling
const barsCache = new Map();
const inFlightBarFetches = new Map();
const BARS_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_LOOKBACK_DAYS = 730; // ~2 years fetched once per ticker for local date slicing
const GET_CACHE_CONTROL = 's-maxage=300, stale-while-revalidate=600';

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

function isValidIsoDate(dateStr) {
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return false;
  }
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

function shiftIsoDate(dateStr, deltaDays) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return dt.toISOString().slice(0, 10);
}

function isWeekend(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay();
  return day === 0 || day === 6;
}

function isTradingDay(dateStr) {
  return !isWeekend(dateStr) && !US_MARKET_HOLIDAYS.has(dateStr);
}

function getNextTradingDay(dateStr) {
  let cursor = shiftIsoDate(dateStr, 1);
  while (!isTradingDay(cursor)) {
    cursor = shiftIsoDate(cursor, 1);
  }
  return cursor;
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

function parseBooleanFlag(val, defaultValue = false) {
  if (val === undefined || val === null || val === '') return defaultValue;
  if (typeof val === 'boolean') return val;
  const normalized = String(val).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return defaultValue;
}

function validateDateRange(startDate, endDate) {
  if (!isValidIsoDate(startDate)) {
    return { status: 400, error: 'Please provide a valid startDate in YYYY-MM-DD format.' };
  }
  if (isWeekend(startDate)) {
    return {
      status: 400,
      error: `${startDate} falls on a weekend. Please select a valid past market trading day (Monday–Friday).`
    };
  }
  if (US_MARKET_HOLIDAYS.has(startDate)) {
    return {
      status: 400,
      error: `${startDate} is a US stock market holiday. Please select an active trading day.`
    };
  }

  if (endDate !== undefined && endDate !== null && endDate !== '') {
    if (!isValidIsoDate(endDate)) {
      return { status: 400, error: 'Please provide a valid endDate in YYYY-MM-DD format.' };
    }
    const nextTradingDay = getNextTradingDay(startDate);
    if (endDate < nextTradingDay) {
      return {
        status: 422,
        error: `No sell open exists on or before ${endDate}; endDate must be on or after the next trading day following ${startDate} (${nextTradingDay}).`
      };
    }
  }

  return null;
}

function createRateLimitError(message, retryAfterHeader) {
  const err = new Error(message);
  err.status = 429;
  const parsed = Number(retryAfterHeader);
  err.retryAfterSeconds = Number.isFinite(parsed) && parsed > 0 ? Math.ceil(parsed) : 60;
  return err;
}

function normalizeBars(bars) {
  const byDate = new Map();
  for (const bar of bars) {
    if (bar && bar.date && Number.isFinite(bar.open) && Number.isFinite(bar.close)) {
      byDate.set(bar.date, {
        date: bar.date,
        open: Number(bar.open),
        close: Number(bar.close)
      });
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Fetch daily bars from Polygon.io
 */
async function fetchFromPolygon(ticker, startDate, endDate, apiKey) {
  const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${startDate}/${endDate}?adjusted=true&sort=asc&limit=50000&apiKey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);

  if (res.status === 429) {
    throw createRateLimitError(
      'Polygon.io API rate limit exceeded (5 requests/min on free tier). Please wait and retry.',
      res.headers.get('retry-after')
    );
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

  return normalizeBars(
    data.results.map((bar) => ({
      date: new Date(bar.t).toISOString().slice(0, 10),
      open: Number(bar.o),
      close: Number(bar.c)
    }))
  );
}

/**
 * Fetch daily bars from Alpha Vantage
 */
async function fetchFromAlphaVantage(ticker, startDate, apiKey) {
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(ticker)}&outputsize=full&apikey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);

  if (res.status === 429) {
    throw createRateLimitError(
      'Alpha Vantage API rate limit reached. Please wait a moment and retry.',
      res.headers.get('retry-after')
    );
  }

  const data = await res.json();
  if (data['Note'] || data['Information']) {
    throw createRateLimitError(data['Note'] || data['Information'], res.headers.get('retry-after'));
  }

  if (data['Error Message']) {
    const err = new Error(`Invalid ticker symbol "${ticker}" or no data available.`);
    err.status = 404;
    throw err;
  }

  const series = data['Time Series (Daily)'];
  if (!series) return [];

  return normalizeBars(
    Object.entries(series)
      .filter(([date]) => date >= startDate)
      .map(([date, vals]) => ({
        date,
        open: Number(vals['1. open']),
        close: Number(vals['4. close'])
      }))
  );
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
    throw createRateLimitError(
      'Yahoo Finance rate limit reached (429). Please retry after the cooldown period.',
      res.headers.get('retry-after')
    );
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

  return normalizeBars(bars);
}

function resolveProviderConfig() {
  const polygonKey = process.env.POLYGON_API_KEY;
  const alphaKey = process.env.ALPHAVANTAGE_API_KEY;
  const preferred = (process.env.MARKET_DATA_PROVIDER || 'polygon').toLowerCase();

  if (preferred === 'polygon' && polygonKey && polygonKey !== 'your_polygon_api_key_here') {
    return { provider: 'polygon', sourceLabel: 'Polygon.io', apiKey: polygonKey };
  }
  if (preferred === 'alphavantage' && alphaKey && alphaKey !== 'your_alphavantage_api_key_here') {
    return { provider: 'alphavantage', sourceLabel: 'Alpha Vantage', apiKey: alphaKey };
  }
  if (polygonKey && polygonKey !== 'your_polygon_api_key_here') {
    return { provider: 'polygon', sourceLabel: 'Polygon.io', apiKey: polygonKey };
  }
  if (alphaKey && alphaKey !== 'your_alphavantage_api_key_here') {
    return { provider: 'alphavantage', sourceLabel: 'Alpha Vantage', apiKey: alphaKey };
  }
  return { provider: 'yahoo', sourceLabel: 'Yahoo Finance Proxy', apiKey: null };
}

/**
 * Fetch and cache full daily OHLC bars per ticker so rapid date-range slices run locally in memory.
 */
async function getDailyBarsForTicker(ticker, requiredStartDate, requiredEndDate = null) {
  const upperTicker = ticker.trim().toUpperCase();
  const todayIso = new Date().toISOString().slice(0, 10);
  const { provider, sourceLabel, apiKey } = resolveProviderConfig();
  const cacheKey = `${provider}:${upperTicker}`;

  const cached = barsCache.get(cacheKey);
  const isFresh = cached && Date.now() - cached.fetchedAt < BARS_CACHE_TTL_MS;
  const coversStart = cached && cached.coveredFrom <= requiredStartDate;
  const coversEnd =
    !requiredEndDate ||
    (cached && (cached.coveredTo >= requiredEndDate || cached.coveredTo >= todayIso));

  if (isFresh && coversStart && coversEnd) {
    return {
      bars: cached.bars,
      source: cached.source,
      cached: true,
      staleFallback: false
    };
  }

  const defaultStart = shiftIsoDate(todayIso, -DEFAULT_LOOKBACK_DAYS);
  const fetchStart = requiredStartDate < defaultStart ? requiredStartDate : defaultStart;
  const effectiveFetchStart =
    cached && cached.coveredFrom < fetchStart ? cached.coveredFrom : fetchStart;
  const inFlightKey = `${cacheKey}:${effectiveFetchStart}:${todayIso}`;

  let fetchPromise = inFlightBarFetches.get(inFlightKey);
  if (!fetchPromise) {
    fetchPromise = (async () => {
      let bars = [];
      if (provider === 'polygon') {
        bars = await fetchFromPolygon(upperTicker, effectiveFetchStart, todayIso, apiKey);
      } else if (provider === 'alphavantage') {
        bars = await fetchFromAlphaVantage(upperTicker, effectiveFetchStart, apiKey);
      } else {
        bars = await fetchFromYahoo(upperTicker, effectiveFetchStart, todayIso);
      }

      const entry = {
        bars,
        source: sourceLabel,
        coveredFrom: effectiveFetchStart,
        coveredTo: todayIso,
        fetchedAt: Date.now()
      };
      barsCache.set(cacheKey, entry);
      return entry;
    })().finally(() => {
      inFlightBarFetches.delete(inFlightKey);
    });

    inFlightBarFetches.set(inFlightKey, fetchPromise);
  }

  try {
    const entry = await fetchPromise;
    return {
      bars: entry.bars,
      source: entry.source,
      cached: false,
      staleFallback: false
    };
  } catch (err) {
    // Serve stale cached bars on 429 or transient upstream failures if the requested range is covered
    if (
      cached &&
      coversStart &&
      (err.status === 429 || !err.status || err.status >= 500)
    ) {
      return {
        bars: cached.bars,
        source: `${cached.source} (stale cache)`,
        cached: true,
        staleFallback: true
      };
    }
    throw err;
  }
}

/**
 * Compute daily Close-to-Open overnight returns from startDate up to endDate (or latest trading day).
 * Supports singleNight=true to stop after the very next trading day's open following startDate.
 */
async function getOvernightSeriesForTicker(ticker, startDate, options = {}) {
  const upperTicker = ticker.trim().toUpperCase();
  const { endDate = null, singleNight = false } = options;

  const { bars, source, cached, staleFallback } = await getDailyBarsForTicker(
    upperTicker,
    startDate,
    endDate
  );

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

  let sellIndex = bars.length - 1;

  if (singleNight) {
    const nextBarIndex = buyIndex + 1;
    if (endDate && bars[nextBarIndex].date > endDate) {
      const err = new Error(
        `No sell open exists for ${upperTicker} on or before ${endDate} (next trading day after ${startDate} is ${bars[nextBarIndex].date}).`
      );
      err.status = 422;
      err.code = 'NO_SELL_OPEN_IN_RANGE';
      throw err;
    }
    sellIndex = nextBarIndex;
  } else if (endDate) {
    sellIndex = -1;
    for (let i = bars.length - 1; i > buyIndex; i--) {
      if (bars[i].date <= endDate) {
        sellIndex = i;
        break;
      }
    }
    if (sellIndex <= buyIndex) {
      const err = new Error(
        `No sell open exists for ${upperTicker} on or before ${endDate} following ${startDate}.`
      );
      err.status = 422;
      err.code = 'NO_SELL_OPEN_IN_RANGE';
      throw err;
    }
  }

  const activeBars = bars.slice(buyIndex, sellIndex + 1);
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

  return {
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
    source,
    cached,
    staleFallback
  };
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
    version: '1.1.0',
    timestamp: new Date().toISOString(),
    configuredProvider: hasPolygon
      ? 'Polygon.io (.env)'
      : hasAlpha
      ? 'Alpha Vantage (.env)'
      : 'Yahoo Finance Proxy (Server-side fallback)',
    hasEnvApiKey: hasPolygon || hasAlpha,
    cache: {
      cachedTickers: barsCache.size,
      ttlMinutes: BARS_CACHE_TTL_MS / 60000
    },
    endpoints: {
      singleTicker: 'GET /api/overnight/:ticker?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&singleNight=false',
      multiTickerGet: 'GET /api/overnight?tickers=NVDA,MU&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD',
      multiTickerPost: 'POST /api/overnight (and POST /api/overnight-returns)',
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
  res.set('Cache-Control', GET_CACHE_CONTROL);
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
  if (!Number.isFinite(totalAmount) || totalAmount < 1) {
    return res.status(400).json({ error: 'amount must be a positive number of at least $1.00' });
  }

  const allocations = {};
  let allocatedSum = 0;

  for (const [ticker, weight] of Object.entries(OPTIMAL_ALLOCATION_WEIGHTS)) {
    const dollars = Math.round(weight * totalAmount * 100) / 100;
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

  if (req.method === 'GET') {
    res.set('Cache-Control', GET_CACHE_CONTROL);
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
    const endDate = req.query.endDate ? String(req.query.endDate).trim() : null;
    const singleNight = parseBooleanFlag(req.query.singleNight, false);
    const compound = parseBooleanFlag(req.query.compound, true);
    const amount = parseFloat(req.query.amount ?? req.query.investment ?? 1000);

    if (!Number.isFinite(amount) || amount < 1) {
      return res.status(400).json({ error: 'amount must be a positive number of at least $1.00.' });
    }

    const dateError = validateDateRange(startDate, endDate);
    if (dateError) {
      return res.status(dateError.status).json({ error: dateError.error });
    }

    const data = await getOvernightSeriesForTicker(ticker, startDate, { endDate, singleNight });
    const mult = compound ? data.compoundedMultiplier : data.simpleMultiplier;
    const finalValue = Number((amount * mult).toFixed(2));
    const dollarGainLoss = Number((finalValue - amount).toFixed(2));
    const percentReturn = Number((((finalValue - amount) / amount) * 100).toFixed(2));

    res.set('Cache-Control', GET_CACHE_CONTROL);
    res.json({
      ticker: data.ticker,
      startDate: data.buyDate,
      startClosePrice: data.closePrice,
      endDate: data.sellDate,
      sellDate: data.sellDate,
      latestDate: data.sellDate,
      latestOpenPrice: data.openPrice,
      sellOpenPrice: data.openPrice,
      totalNights: data.totalNights,
      winningNights: data.winningNights,
      winRatePct: Number(data.winRatePct.toFixed(2)),
      compoundingEnabled: compound,
      singleNight,
      initialInvestment: amount,
      finalValue,
      dollarGainLoss,
      percentReturn,
      compoundedMultiplier: data.compoundedMultiplier,
      simpleMultiplier: data.simpleMultiplier,
      source: data.source,
      cached: data.cached,
      staleFallback: data.staleFallback
    });
  } catch (err) {
    res.set('Cache-Control', 'no-store');
    if (err.status === 429) {
      const retryAfter = err.retryAfterSeconds || 60;
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: err.message, retryAfterSeconds: retryAfter });
    }
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * 5. Multi-Ticker Handler (GET & POST)
 * GET /api/overnight?tickers=NVDA,MU,TSM&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&singleNight=false&compound=true&amount=1000
 * POST /api/overnight or POST /api/overnight-returns
 */
async function handleOvernightCalculation(req, res) {
  try {
    let startDate = '';
    let endDate = null;
    let singleNight = false;
    let tickers = [];
    let compound = true;
    let totalInvestment = 1000;
    let customAllocations = null;

    if (req.method === 'GET') {
      startDate = req.query.startDate || getDefaultTradingDate(21);
      endDate = req.query.endDate ? String(req.query.endDate).trim() : null;
      singleNight = parseBooleanFlag(req.query.singleNight, false);
      tickers = (req.query.tickers || 'VOO,NVDA,MU,AMZN,AMD,INTC,XOM')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      compound = parseBooleanFlag(req.query.compound, true);
      totalInvestment = parseFloat(req.query.amount ?? req.query.investment ?? 1000);
    } else {
      const body = req.body || {};
      startDate = body.startDate || getDefaultTradingDate(21);
      endDate = body.endDate ? String(body.endDate).trim() : null;
      singleNight = parseBooleanFlag(body.singleNight, false);
      tickers = body.tickers || [];
      compound = parseBooleanFlag(body.compound, true);
      totalInvestment = parseFloat(body.investmentAmount ?? body.amount ?? 1000);
      customAllocations = body.allocations || null;
    }

    if (!Number.isFinite(totalInvestment) || totalInvestment < 1) {
      return res.status(400).json({ error: 'Investment amount must be a positive number of at least $1.00.' });
    }

    const dateError = validateDateRange(startDate, endDate);
    if (dateError) {
      return res.status(dateError.status).json({ error: dateError.error });
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
        const series = await getOvernightSeriesForTicker(ticker, startDate, {
          endDate,
          singleNight
        });
        results.push(series);
      } catch (tickerErr) {
        if (tickerErr.status === 429) {
          const retryAfter = tickerErr.retryAfterSeconds || 60;
          res.set('Cache-Control', 'no-store');
          res.set('Retry-After', String(retryAfter));
          return res.status(429).json({
            error: tickerErr.message,
            retryAfterSeconds: retryAfter,
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
      return res.status(422).json({ error: errors[0].message, errors });
    }

    // Compute portfolio totals
    const perStockDefault = totalInvestment / results.length;
    let portfolioInvested = 0;
    let portfolioFinalValue = 0;

    const breakdown = results.map((item) => {
      const stockInvested =
        customAllocations && customAllocations[item.ticker] != null
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
        returnPct: retPct,
        compoundedMultiplier: item.compoundedMultiplier,
        simpleMultiplier: item.simpleMultiplier
      };
    });

    const totalGainLoss = Number((portfolioFinalValue - portfolioInvested).toFixed(2));
    const totalReturnPct =
      portfolioInvested > 0
        ? Number(((totalGainLoss / portfolioInvested) * 100).toFixed(2))
        : 0;

    if (req.method === 'GET') {
      res.set('Cache-Control', GET_CACHE_CONTROL);
    }

    return res.json({
      startDate,
      endDate: results[0]?.sellDate || endDate || null,
      singleNight,
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
    res.set('Cache-Control', 'no-store');
    return res.status(500).json({ error: err.message || 'Unexpected server error.' });
  }
}

app.get('/api/overnight', handleOvernightCalculation);
app.post(['/api/overnight', '/api/overnight-returns'], handleOvernightCalculation);

/**
 * 6. Interactive API Documentation
 * GET /doc, /docs, /api/doc, or /api/docs
 */
app.get(['/doc', '/docs', '/api/doc', '/api/docs'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'doc.html'));
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Overnight Drift API running on port ${PORT}`);
  });
}

export default app;
