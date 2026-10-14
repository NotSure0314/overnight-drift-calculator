import fs from 'fs';

// 100 highly liquid, prominent US equities across multiple sectors + major ETFs
const TICKERS = [
  // Mega-cap Tech & Semiconductors
  'NVDA', 'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'AMD', 'INTC',
  'MU', 'QCOM', 'TSM', 'ASML', 'AMAT', 'LRCX', 'KLAC', 'TXN', 'ADI', 'ARM',
  'MRVL', 'SMCI', 'ON', 'MCHP', 'MPWR',
  // Enterprise Software, Cloud & Cybersecurity
  'CRM', 'ADBE', 'NOW', 'PANW', 'CRWD', 'PLTR', 'SNOW', 'ORCL', 'INTU', 'IBM',
  'WDAY', 'NET', 'DDOG', 'ZS', 'FTNT',
  // Financials & Fintech
  'JPM', 'BAC', 'WFC', 'C', 'GS', 'MS', 'V', 'MA', 'AXP', 'BLK',
  'SCHW', 'COIN', 'HOOD', 'PYPL', 'SQ',
  // Healthcare, Pharma & Biotech
  'LLY', 'NVO', 'UNH', 'JNJ', 'ABBV', 'MRK', 'PFE', 'TMO', 'ABT', 'ISRG',
  'VRTX', 'REGN', 'AMGN', 'GILD', 'BMY',
  // Consumer, Retail & Discretionary
  'WMT', 'COST', 'TGT', 'HD', 'LOW', 'NKE', 'SBUX', 'MCD', 'CMG', 'BKNG',
  'ABNB', 'LULU', 'TJX', 'ROST', 'MELI',
  // Industrials, Aerospace, Defense & Autos
  'CAT', 'DE', 'GE', 'RTX', 'LMT', 'BA', 'HON', 'UNP', 'UPS', 'FDX',
  'F', 'GM', 'UBER', 'RACE',
  // Energy, Utilities & Materials
  'XOM', 'CVX', 'COP', 'SLB', 'EOG', 'LIN', 'FCX', 'NEM',
  // Media & Telecom
  'NFLX', 'DIS', 'CMCSA', 'TMUS',
  // Benchmark Indices
  'SPY', 'QQQ', 'VOO', 'IWM', 'SMH'
];

async function fetchHistory(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1y&interval=1d`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${ticker}: status ${res.status}`);
  }
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result || !result.timestamp || !result.indicators?.quote?.[0]) {
    throw new Error(`No data for ${ticker}`);
  }
  const timestamps = result.timestamp;
  const quote = result.indicators.quote[0];
  const bars = [];
  for (let i = 0; i < timestamps.length; i++) {
    const o = quote.open?.[i];
    const c = quote.close?.[i];
    if (o != null && c != null) {
      bars.push({
        date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
        open: Number(o),
        close: Number(c)
      });
    }
  }
  return bars;
}

function analyzeOvernight(bars) {
  if (bars.length < 2) return null;

  let compMultiplier = 1.0;
  let simpleSum = 0.0;
  let wins = 0;
  const totalNights = bars.length - 1;

  for (let i = 0; i < totalNights; i++) {
    const close = bars[i].close;
    const nextOpen = bars[i + 1].open;
    const nightReturn = (nextOpen - close) / close;
    if (nightReturn > 0) wins++;
    compMultiplier *= (1 + nightReturn);
    simpleSum += nightReturn;
  }

  const buyAndHoldReturn = (bars[bars.length - 1].close - bars[0].close) / bars[0].close;

  return {
    totalNights,
    wins,
    winRate: (wins / totalNights) * 100,
    compoundedReturnPct: (compMultiplier - 1.0) * 100,
    simpleReturnPct: simpleSum * 100,
    buyAndHoldReturnPct: buyAndHoldReturn * 100,
    startDate: bars[0].date,
    endDate: bars[bars.length - 1].date
  };
}

async function runSimulation() {
  console.log(`Starting simulation for ${TICKERS.length} stocks...`);
  const results = [];
  const batchSize = 10;

  for (let i = 0; i < TICKERS.length; i += batchSize) {
    const batch = TICKERS.slice(i, i + batchSize);
    const batchPromises = batch.map(async (ticker) => {
      try {
        const bars = await fetchHistory(ticker);
        const stats = analyzeOvernight(bars);
        if (stats) {
          return { ticker, ...stats };
        }
      } catch (err) {
        console.error(`Error processing ${ticker}:`, err.message);
      }
      return null;
    });

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults.filter(Boolean));
    process.stdout.write(`Processed ${Math.min(i + batchSize, TICKERS.length)}/${TICKERS.length}\r`);
    await new Promise((r) => setTimeout(r, 600)); // Be polite to API
  }

  console.log(`\nSimulation complete! Successfully processed ${results.length} stocks.`);

  // Sort by compounded overnight return descending
  results.sort((a, b) => b.compoundedReturnPct - a.compoundedReturnPct);

  fs.writeFileSync('simulation_results.json', JSON.stringify(results, null, 2));

  console.log('\n================================ TOP 10 OVERNIGHT WINNERS ================================');
  console.log('Rank | Ticker | Compounded Ret | Simple Ret | Win Rate | Buy & Hold | Outperformance');
  console.log('-----------------------------------------------------------------------------------------');
  results.slice(0, 10).forEach((r, idx) => {
    const diff = (r.compoundedReturnPct - r.buyAndHoldReturnPct).toFixed(1);
    const diffStr = diff >= 0 ? `+${diff}%` : `${diff}%`;
    console.log(
      `${String(idx + 1).padStart(4)} | ` +
      `${r.ticker.padEnd(6)} | ` +
      `${(r.compoundedReturnPct >= 0 ? '+' : '') + r.compoundedReturnPct.toFixed(1) + '%'}`.padStart(14) + ' | ' +
      `${(r.simpleReturnPct >= 0 ? '+' : '') + r.simpleReturnPct.toFixed(1) + '%'}`.padStart(10) + ' | ' +
      `${r.winRate.toFixed(1)}%`.padStart(8) + ' | ' +
      `${(r.buyAndHoldReturnPct >= 0 ? '+' : '') + r.buyAndHoldReturnPct.toFixed(1) + '%'}`.padStart(10) + ' | ' +
      `${diffStr}`.padStart(14)
    );
  });

  // Benchmark stats
  const spy = results.find(r => r.ticker === 'SPY');
  const qqq = results.find(r => r.ticker === 'QQQ');
  console.log('\n================================ BENCHMARK COMPARISON ================================');
  if (spy) console.log(`SPY Overnight: ${spy.compoundedReturnPct.toFixed(1)}% | Win Rate: ${spy.winRate.toFixed(1)}% | Buy & Hold: ${spy.buyAndHoldReturnPct.toFixed(1)}%`);
  if (qqq) console.log(`QQQ Overnight: ${qqq.compoundedReturnPct.toFixed(1)}% | Win Rate: ${qqq.winRate.toFixed(1)}% | Buy & Hold: ${qqq.buyAndHoldReturnPct.toFixed(1)}%`);
}

runSimulation();
