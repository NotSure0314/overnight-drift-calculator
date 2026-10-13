/**
 * Overnight Drift — Close-to-Open Stock Return Calculator (Start Date -> Current)
 * Implements Apple Fluid Interface Design Principles & Modern Web Guidance
 */

const DEFAULT_STOCKS = [
  { ticker: 'VOO', name: 'Vanguard S&P 500 ETF', selected: true, isCustom: false },
  { ticker: 'NVDA', name: 'NVIDIA Corp.', selected: true, isCustom: false },
  { ticker: 'MU', name: 'Micron Technology', selected: true, isCustom: false },
  { ticker: 'AMZN', name: 'Amazon.com Inc.', selected: true, isCustom: false },
  { ticker: 'AMD', name: 'Advanced Micro Devices', selected: true, isCustom: false },
  { ticker: 'INTC', name: 'Intel Corp.', selected: true, isCustom: false },
  { ticker: 'XOM', name: 'Exxon Mobil Corp.', selected: true, isCustom: false }
];

// US NYSE Market Holidays (2024 - 2026)
const US_MARKET_HOLIDAYS = new Set([
  '2024-01-01', '2024-01-15', '2024-02-19', '2024-03-29', '2024-05-27',
  '2024-06-19', '2024-07-04', '2024-09-02', '2024-11-28', '2024-12-25',
  '2025-01-01', '2025-01-09', '2025-01-20', '2025-02-17', '2025-04-18',
  '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25'
]);

const state = {
  stocks: structuredClone(DEFAULT_STOCKS),
  allocationMode: 'equal', // 'equal' | 'custom'
  useCompound: true,       // Checked ON by default: reinvests updated balance each night
  customAllocations: {},   // { [ticker]: number }
  lastApiData: null,       // Cached latest API response for instant toggle updates
  isSubmitting: false
};

/* ==========================================================================
   1. Interruptible Critically-Damped Spring Engine (Apple Design §3 & §4)
   ========================================================================== */
const activeSprings = new WeakMap();

/**
 * Animates a numeric property using Apple's damping + response parameterization.
 * Automatically inherits live presentation value and velocity when interrupted.
 */
function animateSpringValue(targetObj, initialVal, targetVal, onUpdate, options = {}) {
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReducedMotion) {
    onUpdate(targetVal);
    return;
  }

  const dampingRatio = options.damping ?? 1.0; // 1.0 = critically damped (no bounce)
  const response = options.response ?? 0.35;   // settle speed in seconds
  const omega = (2 * Math.PI) / response;

  let existing = activeSprings.get(targetObj);
  let currentValue = existing ? existing.value : initialVal;
  let currentVelocity = existing ? existing.velocity : 0;

  if (existing && existing.rafId) {
    cancelAnimationFrame(existing.rafId);
  }

  const springState = {
    value: currentValue,
    velocity: currentVelocity,
    target: targetVal,
    lastTime: performance.now(),
    rafId: null
  };
  activeSprings.set(targetObj, springState);

  function step(now) {
    const dt = Math.min((now - springState.lastTime) / 1000, 0.064);
    springState.lastTime = now;

    const displacement = springState.value - springState.target;
    const springForce = -omega * omega * displacement;
    const dampingForce = -2 * dampingRatio * omega * springState.velocity;
    const acceleration = springForce + dampingForce;

    springState.velocity += acceleration * dt;
    springState.value += springState.velocity * dt;

    onUpdate(springState.value);

    if (
      Math.abs(springState.target - springState.value) > 0.005 ||
      Math.abs(springState.velocity) > 0.01
    ) {
      springState.rafId = requestAnimationFrame(step);
    } else {
      springState.value = springState.target;
      springState.velocity = 0;
      onUpdate(springState.target);
      activeSprings.delete(targetObj);
    }
  }

  springState.rafId = requestAnimationFrame(step);
}

/* ==========================================================================
   2. Trading Calendar Utilities & Validation
   ========================================================================== */
function isWeekendDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay();
  return day === 0 || day === 6;
}

function isTradingDay(dateStr) {
  return !isWeekendDate(dateStr) && !US_MARKET_HOLIDAYS.has(dateStr);
}

/**
 * Returns a past trading day offset by `tradingDaysBack` completed trading sessions
 */
function getPastTradingDate(tradingDaysBack = 21) {
  const now = new Date();
  const cursor = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  let count = 0;

  while (count < tradingDaysBack) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    const iso = cursor.toISOString().slice(0, 10);
    if (isTradingDay(iso)) {
      count++;
    }
  }
  return cursor.toISOString().slice(0, 10);
}

function getYtdFirstTradingDate() {
  const year = new Date().getFullYear();
  const cursor = new Date(Date.UTC(year, 0, 2));
  while (!isTradingDay(cursor.toISOString().slice(0, 10))) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return cursor.toISOString().slice(0, 10);
}

function validateStartDateInput(dateInput) {
  const val = dateInput.value;
  const errorEl = document.getElementById('date-error');
  const errorText = errorEl.querySelector('.error-text');

  if (!val) {
    dateInput.setCustomValidity('Please select a buy date.');
    errorText.textContent = 'Please select a buy date.';
    errorEl.classList.add('visible');
    return false;
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  if (val >= todayIso) {
    const msg = 'Start date must be a completed past trading day prior to today.';
    dateInput.setCustomValidity(msg);
    errorText.textContent = msg;
    errorEl.classList.add('visible');
    return false;
  }

  if (isWeekendDate(val)) {
    const msg = `${val} is on a weekend. US markets are closed Saturday and Sunday.`;
    dateInput.setCustomValidity(msg);
    errorText.textContent = msg;
    errorEl.classList.add('visible');
    return false;
  }

  if (US_MARKET_HOLIDAYS.has(val)) {
    const msg = `${val} is an official US stock market holiday. Please pick an open trading day.`;
    dateInput.setCustomValidity(msg);
    errorText.textContent = msg;
    errorEl.classList.add('visible');
    return false;
  }

  dateInput.setCustomValidity('');
  errorEl.classList.remove('visible');
  return true;
}

/* ==========================================================================
   3. Formatting Helpers
   ========================================================================== */
const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

function formatCurrency(val) {
  return usdFormatter.format(val);
}

function formatSignedCurrency(val) {
  const sign = val > 0.00005 ? '+' : val < -0.00005 ? '−' : '';
  return `${sign}${usdFormatter.format(Math.abs(val))}`;
}

function formatSignedPercent(val) {
  const sign = val > 0.00005 ? '+' : val < -0.00005 ? '−' : '';
  return `${sign}${Math.abs(val).toFixed(2)}%`;
}

function formatShares(val) {
  return Number(val).toLocaleString('en-US', {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4
  });
}

/* ==========================================================================
   4. UI Rendering & Allocation Synchronization
   ========================================================================== */
function getSelectedStocks() {
  return state.stocks.filter((s) => s.selected);
}

function getCurrentAllocationsByTicker() {
  const selected = getSelectedStocks();
  const amountInput = document.getElementById('investment-amount');
  const totalAmount = Math.max(0, parseFloat(amountInput.value) || 0);
  const allocationsByTicker = {};

  if (state.allocationMode === 'equal') {
    const perStock = selected.length > 0 ? totalAmount / selected.length : 0;
    selected.forEach((s) => {
      allocationsByTicker[s.ticker] = perStock;
    });
  } else {
    selected.forEach((s) => {
      allocationsByTicker[s.ticker] = Number(state.customAllocations[s.ticker] || 0);
    });
  }
  return allocationsByTicker;
}

function syncEqualAllocationsFromTotal() {
  const amountInput = document.getElementById('investment-amount');
  const total = Math.max(0, parseFloat(amountInput.value) || 0);
  const selected = getSelectedStocks();
  const perStock = selected.length > 0 ? total / selected.length : 0;

  selected.forEach((s) => {
    state.customAllocations[s.ticker] = Number(perStock.toFixed(2));
  });
}

function updateCompoundUI() {
  const card = document.getElementById('compound-card-label');
  const pill = document.getElementById('compound-status-pill');
  const desc = document.getElementById('compound-explanation');

  card.classList.toggle('selected', state.useCompound);
  pill.classList.toggle('off', !state.useCompound);

  if (state.useCompound) {
    pill.textContent = 'Compounding ON';
    desc.textContent =
      'Reinvests your updated balance every night (e.g., if $1,000 grows to $1,002 on Night 1, Night 2 invests $1,002 instead of $1,000).';
  } else {
    pill.textContent = 'Fixed Principal (Simple)';
    desc.textContent =
      'Compounding is OFF: Re-invests only your original starting dollar amount each night and sums the nightly gains/losses without compounding.';
  }
}

function updateAllocationExplanation() {
  const selected = getSelectedStocks();
  const amountInput = document.getElementById('investment-amount');
  const explanationEl = document.getElementById('allocation-explanation');
  const badgeEl = document.getElementById('allocation-summary-badge');
  const counterEl = document.getElementById('selection-counter');

  counterEl.textContent = `${selected.length} of ${state.stocks.length} stocks selected`;

  if (state.allocationMode === 'equal') {
    const total = Math.max(0, parseFloat(amountInput.value) || 0);
    const each = selected.length > 0 ? formatCurrency(total / selected.length) : '$0.00';
    badgeEl.textContent = 'Equal Split Allocation';
    explanationEl.innerHTML = `<strong>Active Rule:</strong> Total investment (${formatCurrency(
      total
    )}) is divided equally across ${selected.length} selected stock${
      selected.length === 1 ? '' : 's'
    } (${each} per stock).`;
  } else {
    let customSum = 0;
    selected.forEach((s) => {
      customSum += Number(state.customAllocations[s.ticker] || 0);
    });
    amountInput.value = customSum > 0 ? customSum.toFixed(2) : '';
    badgeEl.textContent = 'Per-Stock Custom Allocation';
    explanationEl.innerHTML = `<strong>Active Rule:</strong> Custom dollar amount invested per stock. Total portfolio investment automatically sums to <strong>${formatCurrency(
      customSum
    )}</strong>.`;
  }
}

function renderStockList() {
  const container = document.getElementById('stock-list');
  container.innerHTML = '';

  state.stocks.forEach((stock) => {
    const card = document.createElement('div');
    card.className = `stock-item${stock.selected ? ' selected' : ''}`;

    const topRow = document.createElement('div');
    topRow.className = 'stock-item-top';

    const label = document.createElement('label');
    label.className = 'stock-label-group';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'stock-checkbox';
    checkbox.checked = stock.selected;
    checkbox.setAttribute('aria-label', `${stock.ticker} (${stock.name})`);

    checkbox.addEventListener('change', () => {
      stock.selected = checkbox.checked;
      if (state.allocationMode === 'equal') {
        syncEqualAllocationsFromTotal();
      } else if (stock.selected && !state.customAllocations[stock.ticker]) {
        state.customAllocations[stock.ticker] = 100;
      }
      document.getElementById('stocks-error').classList.remove('visible');
      renderStockList();
      updateAllocationExplanation();
    });

    const textWrap = document.createElement('div');
    const tickerSpan = document.createElement('div');
    tickerSpan.className = 'stock-ticker-symbol';
    tickerSpan.textContent = stock.ticker;

    const nameSpan = document.createElement('div');
    nameSpan.className = 'stock-company-name';
    nameSpan.textContent = stock.name;

    textWrap.appendChild(tickerSpan);
    textWrap.appendChild(nameSpan);
    label.appendChild(checkbox);
    label.appendChild(textWrap);
    topRow.appendChild(label);

    if (stock.isCustom) {
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'remove-custom-btn';
      removeBtn.title = `Remove ${stock.ticker}`;
      removeBtn.setAttribute('aria-label', `Remove custom ticker ${stock.ticker}`);
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        state.stocks = state.stocks.filter((s) => s.ticker !== stock.ticker);
        delete state.customAllocations[stock.ticker];
        if (state.allocationMode === 'equal') {
          syncEqualAllocationsFromTotal();
        }
        renderStockList();
        updateAllocationExplanation();
      });
      topRow.appendChild(removeBtn);
    }

    card.appendChild(topRow);

    if (state.allocationMode === 'custom' && stock.selected) {
      const allocWrap = document.createElement('div');
      allocWrap.className = 'per-stock-allocation-wrap';

      const allocLabel = document.createElement('label');
      allocLabel.textContent = '$';
      allocLabel.setAttribute('for', `alloc-${stock.ticker}`);

      const allocInput = document.createElement('input');
      allocInput.type = 'number';
      allocInput.id = `alloc-${stock.ticker}`;
      allocInput.className = 'per-stock-input';
      allocInput.min = '0.01';
      allocInput.step = 'any';
      allocInput.value = state.customAllocations[stock.ticker] ?? 100;

      allocInput.addEventListener('click', (e) => e.stopPropagation());
      allocInput.addEventListener('input', () => {
        const v = Math.max(0, parseFloat(allocInput.value) || 0);
        state.customAllocations[stock.ticker] = v;
        updateAllocationExplanation();
        if (state.lastApiData) {
          renderCalculationResults(state.lastApiData, getCurrentAllocationsByTicker());
        }
      });

      allocWrap.appendChild(allocLabel);
      allocWrap.appendChild(allocInput);
      card.appendChild(allocWrap);
    }

    container.appendChild(card);
  });
}

/* ==========================================================================
   5. Custom Ticker Addition & Validation
   ========================================================================== */
function handleAddCustomTicker() {
  const input = document.getElementById('custom-ticker-input');
  const errorBox = document.getElementById('custom-ticker-error');
  const errorText = document.getElementById('custom-ticker-error-text');

  const raw = input.value.trim().toUpperCase();
  if (!raw) {
    errorText.textContent = 'Please enter a ticker symbol (e.g., AAPL).';
    errorBox.classList.add('visible');
    input.setAttribute('aria-invalid', 'true');
    return;
  }

  if (!/^[A-Z]{1,5}(\.[A-Z]{1,2})?$/.test(raw)) {
    errorText.textContent = `"${raw}" is not a valid US ticker format. Use 1–5 letters (e.g., AAPL, TSLA, BRK.B).`;
    errorBox.classList.add('visible');
    input.setAttribute('aria-invalid', 'true');
    return;
  }

  const existing = state.stocks.find((s) => s.ticker === raw);
  if (existing) {
    existing.selected = true;
    errorBox.classList.remove('visible');
    input.removeAttribute('aria-invalid');
    input.value = '';
    if (state.allocationMode === 'equal') syncEqualAllocationsFromTotal();
    renderStockList();
    updateAllocationExplanation();
    return;
  }

  state.stocks.push({
    ticker: raw,
    name: 'Custom Ticker',
    selected: true,
    isCustom: true
  });

  state.customAllocations[raw] = 100;
  errorBox.classList.remove('visible');
  input.removeAttribute('aria-invalid');
  input.value = '';

  if (state.allocationMode === 'equal') {
    syncEqualAllocationsFromTotal();
  }
  renderStockList();
  updateAllocationExplanation();
}

/* ==========================================================================
   6. Calculation Engine & Portfolio Rendering
   ========================================================================== */
function showBanner(title, message, isError = true) {
  const banner = document.getElementById('status-banner');
  const titleEl = document.getElementById('status-title');
  const msgEl = document.getElementById('status-message');

  banner.classList.toggle('error', isError);
  titleEl.textContent = title;
  msgEl.textContent = message;
  banner.hidden = false;
}

function hideBanner() {
  document.getElementById('status-banner').hidden = true;
}

const summaryNumericMemory = {
  invested: 0,
  finalValue: 0,
  gainLoss: 0,
  returnPct: 0
};

function renderCalculationResults(apiData, allocationsByTicker) {
  state.lastApiData = apiData;
  const resultsSection = document.getElementById('results-section');
  const tbody = document.getElementById('results-tbody');
  tbody.innerHTML = '';

  let totalInvested = 0;
  let totalFinalValue = 0;
  let sourceName = 'Market Data API';

  apiData.results.forEach((item) => {
    const invested = allocationsByTicker[item.ticker] ?? 0;
    const closePrice = Number(item.closePrice);
    const openPrice = Number(item.openPrice);

    // Initial shares bought on Start Date Close
    const initialShares = invested / closePrice;

    // Compounded vs. Non-Compounded (Simple) across all overnight sessions from Start Date -> Current
    const multiplier = state.useCompound
      ? Number(item.compoundedMultiplier)
      : Number(item.simpleMultiplier);

    const finalValue = invested * multiplier;
    const dollarGainLoss = finalValue - invested;
    const percentReturn = invested > 0 ? (dollarGainLoss / invested) * 100 : 0;

    // Effective shares sold on the final morning open (if compounding, finalValue / openPrice)
    const displayedShares = state.useCompound ? finalValue / openPrice : initialShares;

    totalInvested += invested;
    totalFinalValue += finalValue;
    if (item.source) sourceName = item.source;

    const isGain = dollarGainLoss > 0.00005;
    const isLoss = dollarGainLoss < -0.00005;
    const statusClass = isGain ? 'gain' : isLoss ? 'loss' : 'flat';
    const arrow = isGain ? '▲' : isLoss ? '▼' : '•';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <th scope="row">
        <div class="ticker-badge">
          <span class="ticker-pill">${item.ticker}</span>
        </div>
      </th>
      <td>${item.buyDate}</td>
      <td class="num-col">${formatCurrency(closePrice)}</td>
      <td class="num-col" title="Initial shares on ${item.buyDate}: ${formatShares(initialShares)}">${formatShares(displayedShares)}</td>
      <td>${item.sellDate} <small style="color: var(--text-tertiary);">(${item.totalNights}n)</small></td>
      <td class="num-col">${formatCurrency(openPrice)}</td>
      <td class="num-col"><strong>${formatCurrency(finalValue)}</strong></td>
      <td class="num-col">
        <span class="pnl-pill ${statusClass}">
          <span aria-hidden="true">${arrow}</span> ${formatSignedCurrency(dollarGainLoss)}
        </span>
      </td>
      <td class="num-col">
        <span class="pnl-pill ${statusClass}">
          ${formatSignedPercent(percentReturn)}
        </span>
      </td>
    `;
    tbody.appendChild(tr);
  });

  const totalGainLoss = totalFinalValue - totalInvested;
  const overallReturnPct = totalInvested > 0 ? (totalGainLoss / totalInvested) * 100 : 0;

  // Update metadata badges
  document.getElementById('data-source-badge').textContent = `Source: ${sourceName}`;
  const firstRow = apiData.results[0];
  if (firstRow) {
    const modeLabel = state.useCompound ? 'Compounded Nightly' : 'Fixed Principal (Non-Compounded)';
    document.getElementById('results-subtitle').textContent =
      `${firstRow.buyDate} → ${firstRow.sellDate} (${firstRow.totalNights} overnight trades · ${modeLabel})`;
    document.getElementById('summary-final-note').textContent = state.useCompound
      ? `Compounded across ${firstRow.totalNights} nights`
      : `Simple sum across ${firstRow.totalNights} nights`;
    document.getElementById('table-mode-caption').textContent = state.useCompound
      ? `Compounding ON: Each night reinvests the full updated balance ($1,000 → $1,002 → invests $1,002) across all ${firstRow.totalNights} overnight sessions.`
      : `Compounding OFF: Each night invests only the initial principal across all ${firstRow.totalNights} overnight sessions.`;
  }

  document.getElementById('summary-allocation-note').textContent =
    state.allocationMode === 'equal'
      ? `Split equally (${formatCurrency(totalInvested / apiData.results.length)} / stock)`
      : 'Custom per-stock allocation';

  // Color-code total summary cards
  const gainLossCard = document.getElementById('card-gain-loss');
  const returnPctCard = document.getElementById('card-return-pct');
  gainLossCard.classList.remove('gain', 'loss');
  returnPctCard.classList.remove('gain', 'loss');

  if (totalGainLoss > 0.00005) {
    gainLossCard.classList.add('gain');
    returnPctCard.classList.add('gain');
  } else if (totalGainLoss < -0.00005) {
    gainLossCard.classList.add('loss');
    returnPctCard.classList.add('loss');
  }

  resultsSection.hidden = false;

  // Animate summary figures with interruptible critically-damped springs
  const elInvested = document.getElementById('summary-invested');
  const elFinal = document.getElementById('summary-final-value');
  const elGain = document.getElementById('summary-gain-loss');
  const elPct = document.getElementById('summary-return-pct');

  animateSpringValue(elInvested, summaryNumericMemory.invested, totalInvested, (v) => {
    summaryNumericMemory.invested = v;
    elInvested.textContent = formatCurrency(v);
  });

  animateSpringValue(elFinal, summaryNumericMemory.finalValue, totalFinalValue, (v) => {
    summaryNumericMemory.finalValue = v;
    elFinal.textContent = formatCurrency(v);
  });

  animateSpringValue(elGain, summaryNumericMemory.gainLoss, totalGainLoss, (v) => {
    summaryNumericMemory.gainLoss = v;
    elGain.textContent = formatSignedCurrency(v);
  });

  animateSpringValue(elPct, summaryNumericMemory.returnPct, overallReturnPct, (v) => {
    summaryNumericMemory.returnPct = v;
    elPct.textContent = formatSignedPercent(v);
  });
}

/* ==========================================================================
   7. Form Submission & API Request Handler
   ========================================================================== */
async function handleFormSubmit(e) {
  if (e) e.preventDefault();
  hideBanner();

  const amountInput = document.getElementById('investment-amount');
  const dateInput = document.getElementById('start-date');
  const amountError = document.getElementById('amount-error');
  const stocksError = document.getElementById('stocks-error');

  // 1. Validate Investment Amount
  const totalAmount = parseFloat(amountInput.value);
  if (Number.isNaN(totalAmount) || totalAmount < 1) {
    amountInput.setAttribute('aria-invalid', 'true');
    amountError.classList.add('visible');
    amountInput.focus();
    return;
  } else {
    amountInput.removeAttribute('aria-invalid');
    amountError.classList.remove('visible');
  }

  // 2. Validate Start Date
  if (!validateStartDateInput(dateInput)) {
    dateInput.setAttribute('aria-invalid', 'true');
    dateInput.focus();
    return;
  } else {
    dateInput.removeAttribute('aria-invalid');
  }

  // 3. Validate Selected Stocks
  const selected = getSelectedStocks();
  if (selected.length === 0) {
    stocksError.classList.add('visible');
    return;
  }
  stocksError.classList.remove('visible');

  // Build per-ticker allocation map
  const allocationsByTicker = getCurrentAllocationsByTicker();
  if (state.allocationMode === 'custom') {
    for (const s of selected) {
      if ((allocationsByTicker[s.ticker] || 0) <= 0) {
        showBanner(
          'Invalid Per-Stock Allocation',
          `Please allocate more than $0.00 to ${s.ticker} or uncheck it.`
        );
        return;
      }
    }
  }

  // Set loading state
  const submitBtn = document.getElementById('calculate-btn');
  const btnText = document.getElementById('calculate-btn-text');
  const spinner = document.getElementById('loading-spinner');
  state.isSubmitting = true;
  btnText.textContent = 'Fetching Market Data…';
  spinner.hidden = false;

  try {
    const response = await fetch('/api/overnight-returns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        startDate: dateInput.value,
        tickers: selected.map((s) => s.ticker)
      })
    });

    const data = await response.json();

    if (!response.ok) {
      if (response.status === 429) {
        showBanner('API Rate Limit Reached', data.error, false);
        if (data.partialResults && data.partialResults.length > 0) {
          renderCalculationResults({ results: data.partialResults }, allocationsByTicker);
        }
        return;
      }
      showBanner('Market Data Error', data.error || 'Unable to complete calculation.', true);
      return;
    }

    if (data.errors && data.errors.length > 0) {
      const errSummary = data.errors.map((err) => `${err.ticker}: ${err.message}`).join(' | ');
      showBanner('Some Tickers Could Not Be Calculated', errSummary, false);
    }

    if (data.results && data.results.length > 0) {
      renderCalculationResults(data, allocationsByTicker);
    }
  } catch (networkErr) {
    showBanner(
      'Connection Error',
      'Could not reach the backend server. Ensure the server is running.',
      true
    );
  } finally {
    state.isSubmitting = false;
    btnText.textContent = 'Calculate Overnight Returns';
    spinner.hidden = true;
    submitBtn.blur();
  }
}

/* ==========================================================================
   8. Initialization & ARIA Synchronization (Modern Web Guidance)
   ========================================================================== */
async function init() {
  const dateInput = document.getElementById('start-date');
  const amountInput = document.getElementById('investment-amount');
  const compoundCheckbox = document.getElementById('compound-checkbox');

  // Default to 1 Month Ago (21 trading days) so Start Date -> Current is meaningful out of the box
  const defaultTradingDate = getPastTradingDate(21);
  const yesterdayIso = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  dateInput.value = defaultTradingDate;
  dateInput.max = yesterdayIso;

  syncEqualAllocationsFromTotal();
  renderStockList();
  updateAllocationExplanation();
  updateCompoundUI();

  // Check backend API key / provider status
  try {
    const res = await fetch('/api/config-status');
    if (res.ok) {
      const status = await res.json();
      document.getElementById('provider-label').textContent = status.configuredProvider;
    }
  } catch {
    document.getElementById('provider-label').textContent = 'Offline';
  }

  // Compound Checkbox Listener (ON by default)
  compoundCheckbox.addEventListener('change', () => {
    state.useCompound = compoundCheckbox.checked;
    updateCompoundUI();
    if (state.lastApiData) {
      renderCalculationResults(state.lastApiData, getCurrentAllocationsByTicker());
    }
  });

  // Investment Amount Listener
  amountInput.addEventListener('input', () => {
    if (amountInput.checkValidity() && parseFloat(amountInput.value) >= 1) {
      amountInput.removeAttribute('aria-invalid');
      document.getElementById('amount-error').classList.remove('visible');
    }
    if (state.allocationMode === 'equal') {
      syncEqualAllocationsFromTotal();
      updateAllocationExplanation();
      if (state.lastApiData) {
        renderCalculationResults(state.lastApiData, getCurrentAllocationsByTicker());
      }
    }
  });

  dateInput.addEventListener('change', () => {
    if (validateStartDateInput(dateInput)) {
      handleFormSubmit();
    }
  });

  // Preset trading date buttons
  document.querySelectorAll('[data-preset-offset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const offset = parseInt(btn.getAttribute('data-preset-offset'), 10);
      dateInput.value = getPastTradingDate(offset);
      if (validateStartDateInput(dateInput)) {
        handleFormSubmit();
      }
    });
  });

  document.querySelectorAll('[data-preset-ytd]').forEach((btn) => {
    btn.addEventListener('click', () => {
      dateInput.value = getYtdFirstTradingDate();
      if (validateStartDateInput(dateInput)) {
        handleFormSubmit();
      }
    });
  });

  // Allocation Mode Segmented Control
  const equalBtn = document.getElementById('mode-equal-btn');
  const customBtn = document.getElementById('mode-custom-btn');

  function setAllocationMode(mode) {
    state.allocationMode = mode;
    const isEqual = mode === 'equal';
    equalBtn.classList.toggle('active', isEqual);
    equalBtn.setAttribute('aria-checked', String(isEqual));
    customBtn.classList.toggle('active', !isEqual);
    customBtn.setAttribute('aria-checked', String(!isEqual));
    amountInput.readOnly = !isEqual;

    if (isEqual) {
      syncEqualAllocationsFromTotal();
    }
    renderStockList();
    updateAllocationExplanation();
    if (state.lastApiData) {
      renderCalculationResults(state.lastApiData, getCurrentAllocationsByTicker());
    }
  }

  equalBtn.addEventListener('click', () => setAllocationMode('equal'));
  customBtn.addEventListener('click', () => setAllocationMode('custom'));

  // Select All / Clear All
  document.getElementById('select-all-btn').addEventListener('click', () => {
    state.stocks.forEach((s) => (s.selected = true));
    document.getElementById('stocks-error').classList.remove('visible');
    if (state.allocationMode === 'equal') syncEqualAllocationsFromTotal();
    renderStockList();
    updateAllocationExplanation();
  });

  document.getElementById('clear-all-btn').addEventListener('click', () => {
    state.stocks.forEach((s) => (s.selected = false));
    renderStockList();
    updateAllocationExplanation();
  });

  // Custom ticker events
  document.getElementById('add-ticker-btn').addEventListener('click', handleAddCustomTicker);
  document.getElementById('custom-ticker-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddCustomTicker();
    }
  });

  document.getElementById('dismiss-status-btn').addEventListener('click', hideBanner);

  // Sync aria-invalid on blur for required inputs (Modern Web Guidance)
  const form = document.getElementById('calculator-form');
  form.addEventListener(
    'blur',
    (e) => {
      if (e.target.matches('input[required]')) {
        if (!e.target.checkValidity()) {
          e.target.setAttribute('aria-invalid', 'true');
        } else {
          e.target.removeAttribute('aria-invalid');
        }
      }
    },
    true
  );

  form.addEventListener('submit', handleFormSubmit);

  // Run initial calculation automatically so user sees results immediately
  handleFormSubmit();
}

document.addEventListener('DOMContentLoaded', init);
