import fs from 'fs';

const TOP_10 = ['MU', 'MRVL', 'LRCX', 'INTC', 'AMAT', 'ARM', 'TSM', 'CAT', 'SMH', 'NVDA'];

async function fetchBars(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1y&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const data = await res.json();
  const quote = data.chart.result[0].indicators.quote[0];
  const ts = data.chart.result[0].timestamp;
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    if (quote.open[i] != null && quote.close[i] != null) {
      bars.push({
        date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
        open: Number(quote.open[i]),
        close: Number(quote.close[i])
      });
    }
  }
  return bars;
}

function computeDailyOvernightReturns(barsMap) {
  // Find common dates
  const tickers = Object.keys(barsMap);
  const dateMaps = {};
  tickers.forEach(t => {
    dateMaps[t] = new Map();
    const bars = barsMap[t];
    for (let i = 0; i < bars.length - 1; i++) {
      const buyDate = bars[i].date;
      const sellDate = bars[i + 1].date;
      const r = (bars[i + 1].open - bars[i].close) / bars[i].close;
      dateMaps[t].set(buyDate, { r, sellDate });
    }
  });

  // Get common buy dates
  const firstTickerDates = [...dateMaps[tickers[0]].keys()];
  const commonDates = firstTickerDates.filter(d => tickers.every(t => dateMaps[t].has(d)));
  commonDates.sort();

  const dailyReturns = commonDates.map(date => {
    const row = { date };
    tickers.forEach(t => {
      row[t] = dateMaps[t].get(date).r;
    });
    return row;
  });

  return dailyReturns;
}

function evaluatePortfolio(weights, dailyReturns, initialCapital = 1000) {
  let value = initialCapital;
  const history = [value];
  const portfolioReturns = [];
  let peak = value;
  let maxDrawdown = 0;
  let winNights = 0;

  for (const day of dailyReturns) {
    let dayReturn = 0;
    for (const [ticker, w] of Object.entries(weights)) {
      dayReturn += w * (day[ticker] || 0);
    }
    portfolioReturns.push(dayReturn);
    if (dayReturn > 0) winNights++;

    value *= (1 + dayReturn);
    history.push(value);

    if (value > peak) peak = value;
    const dd = (peak - value) / peak;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Calculate annual Sharpe (assuming 250 trading days, risk-free rate = 0% for pure comparison)
  const meanRet = portfolioReturns.reduce((a, b) => a + b, 0) / portfolioReturns.length;
  const variance = portfolioReturns.reduce((a, b) => a + Math.pow(b - meanRet, 2), 0) / (portfolioReturns.length - 1);
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev > 0 ? (meanRet / stdDev) * Math.sqrt(250) : 0;

  // Sortino (downside deviation)
  const downReturns = portfolioReturns.filter(r => r < 0);
  const downVar = downReturns.length > 0 
    ? downReturns.reduce((a, b) => a + Math.pow(b, 2), 0) / downReturns.length
    : 0.00001;
  const sortino = Math.sqrt(downVar) > 0 ? (meanRet / Math.sqrt(downVar)) * Math.sqrt(250) : 0;

  return {
    finalValue: value,
    gainLoss: value - initialCapital,
    returnPct: ((value - initialCapital) / initialCapital) * 100,
    maxDrawdownPct: maxDrawdown * 100,
    sharpe,
    sortino,
    winRate: (winNights / dailyReturns.length) * 100,
    totalNights: dailyReturns.length
  };
}

async function runTests() {
  console.log('Fetching bar data for top 10 stocks...');
  const barsMap = {};
  for (const ticker of TOP_10) {
    barsMap[ticker] = await fetchBars(ticker);
  }

  const dailyReturns = computeDailyOvernightReturns(barsMap);
  console.log(`Aligned ${dailyReturns.length} common trading nights across all 10 stocks.\n`);

  // --- MODEL 1: Equal Weight ($100 each across all 10) ---
  const equalWeights = {};
  TOP_10.forEach(t => equalWeights[t] = 0.10);
  const resEqual = evaluatePortfolio(equalWeights, dailyReturns);

  // --- MODEL 2: Top 3 Return Heavy (MU, MRVL, LRCX: 40%, 35%, 25%) ---
  const top3Weights = { MU: 0.40, MRVL: 0.35, LRCX: 0.25 };
  TOP_10.forEach(t => { if (!top3Weights[t]) top3Weights[t] = 0; });
  const resTop3 = evaluatePortfolio(top3Weights, dailyReturns);

  // --- MODEL 3: High Win-Rate & Consistency (NVDA, TSM, CAT, SMH, MU) ---
  const winRateWeights = { NVDA: 0.25, TSM: 0.25, SMH: 0.20, CAT: 0.15, MU: 0.15 };
  TOP_10.forEach(t => { if (!winRateWeights[t]) winRateWeights[t] = 0; });
  const resWinRate = evaluatePortfolio(winRateWeights, dailyReturns);

  // --- MODEL 4: Monte Carlo / Multi-Trial Search (100,000 combinations) ---
  console.log('Running 100,000 Monte Carlo portfolio simulations to find optimal allocations...');
  let bestSharpe = -999;
  let bestSharpeWeights = null;
  let bestSharpeRes = null;

  let bestBalanced = -999;
  let bestBalancedWeights = null;
  let bestBalancedRes = null;

  let maxReturn = -999;
  let maxReturnWeights = null;
  let maxReturnRes = null;

  const N_SIMS = 100000;
  for (let s = 0; s < N_SIMS; s++) {
    // Generate random normalized weights
    const raw = TOP_10.map(() => Math.random());
    const sum = raw.reduce((a, b) => a + b, 0);
    const weights = {};
    TOP_10.forEach((t, i) => weights[t] = raw[i] / sum);

    const res = evaluatePortfolio(weights, dailyReturns);

    if (res.sharpe > bestSharpe) {
      bestSharpe = res.sharpe;
      bestSharpeWeights = weights;
      bestSharpeRes = res;
    }

    if (res.returnPct > maxReturn) {
      maxReturn = res.returnPct;
      maxReturnWeights = weights;
      maxReturnRes = res;
    }

    // Balanced score: high return, high win rate, controlled drawdown
    // Score = returnPct * (1 - maxDrawdownPct/100) * (winRate/50) * sharpe
    const balancedScore = res.returnPct * (1 - res.maxDrawdownPct / 100) * (res.winRate / 50) * Math.max(0, res.sharpe);
    if (balancedScore > bestBalanced) {
      bestBalanced = balancedScore;
      bestBalancedWeights = weights;
      bestBalancedRes = res;
    }
  }

  // Format and save report
  const report = {
    equal: { weights: equalWeights, ...resEqual },
    top3: { weights: top3Weights, ...resTop3 },
    winRateFocus: { weights: winRateWeights, ...resWinRate },
    bestSharpe: { weights: bestSharpeWeights, ...bestSharpeRes },
    bestBalanced: { weights: bestBalancedWeights, ...bestBalancedRes },
    maxReturn: { weights: maxReturnWeights, ...maxReturnRes }
  };

  fs.writeFileSync('portfolio_test_results.json', JSON.stringify(report, null, 2));

  console.log('\n================================ PORTFOLIO COMPARISON ($1,000 START) ================================');
  console.log('Strategy                     | Final Value | Return (%) | Max Drawdown | Sharpe | Win Rate');
  console.log('-------------------------------------------------------------------------------------------------');
  
  function printRow(name, res) {
    console.log(
      `${name.padEnd(28)} | ` +
      `$${res.finalValue.toFixed(2)}`.padStart(11) + ' | ' +
      `+${res.returnPct.toFixed(1)}%`.padStart(10) + ' | ' +
      `-${res.maxDrawdownPct.toFixed(1)}%`.padStart(12) + ' | ' +
      `${res.sharpe.toFixed(2)}`.padStart(6) + ' | ' +
      `${res.winRate.toFixed(1)}%`.padStart(8)
    );
  }

  printRow('1. Equal Split (10% each)', resEqual);
  printRow('2. Top 3 Momentum (MU/MRVL)', resTop3);
  printRow('3. Win-Rate Consistent', resWinRate);
  printRow('4. Max Sharpe (Optimal Risk)', bestSharpeRes);
  printRow('5. Best Balanced (Optimal)', bestBalancedRes);
  printRow('6. Max Return (Aggressive)', maxReturnRes);

  console.log('\n================================ OPTIMAL BALANCED ALLOCATION ($1,000) ================================');
  let allocatedSum = 0;
  const roundedAlloc = {};
  TOP_10.forEach(t => {
    // Round to nearest $5
    const dollars = Math.round((bestBalancedWeights[t] * 1000) / 5) * 5;
    roundedAlloc[t] = dollars;
    allocatedSum += dollars;
  });
  // Adjust rounding difference to highest weight
  const highestTicker = Object.keys(roundedAlloc).reduce((a, b) => roundedAlloc[a] > roundedAlloc[b] ? a : b);
  roundedAlloc[highestTicker] += (1000 - allocatedSum);

  TOP_10.sort((a, b) => roundedAlloc[b] - roundedAlloc[a]).forEach(t => {
    console.log(`${t.padEnd(6)}: $${roundedAlloc[t]} (${(roundedAlloc[t]/10).toFixed(1)}%)`);
  });
}

runTests();
