// Genesis Portfolio Holdings - Entry Date: November 24, 2025
// Initial Investment: $93,367.91
// Prices updated: January 23, 2026 market close

export interface Holding {
  ticker: string;
  entryDate: string;
  entryPrice: number;
  currentPrice: number | null;
  shares: number;
  initialInvestment: number;
  currentInvestment: number | null;
  delta: number | null;
  sector: string;
  theme: string;
}

// Helper to calculate current investment and delta
function calcHolding(
  ticker: string, entryPrice: number, currentPrice: number | null, shares: number,
  sector: string, theme: string
): Holding {
  const initialInvestment = entryPrice * shares;
  const currentInvestment = currentPrice ? currentPrice * shares : null;
  const delta = currentPrice ? ((currentPrice - entryPrice) / entryPrice) * 100 : null;
  return {
    ticker,
    entryDate: '2025-11-24',
    entryPrice,
    currentPrice,
    shares,
    initialInvestment: Math.round(initialInvestment * 100) / 100,
    currentInvestment: currentInvestment ? Math.round(currentInvestment * 100) / 100 : null,
    delta: delta ? Math.round(delta * 100) / 100 : null,
    sector,
    theme,
  };
}

export const genesisHoldings: Holding[] = [
  // Biotechnology / AI Drug Discovery
  calcHolding('ABCL', 3.57, 4.64, 410, 'Biotech', 'AI Drug Discovery'),
  calcHolding('BNTX', 96.54, 118.47, 15, 'Biotech', 'mRNA Technology'),
  calcHolding('CRSP', 51.25, 60.81, 28, 'Biotech', 'Gene Editing'),
  calcHolding('ILMN', 125.96, 153.95, 11, 'Biotech', 'Genomics'),
  calcHolding('MRNA', 24.15, 51.87, 60, 'Biotech', 'mRNA Technology'),
  calcHolding('RLAY', 8.17, 7.60, 186, 'Biotech', 'AI Drug Discovery'),
  calcHolding('RXRX', 4.33, 4.96, 338, 'Biotech', 'AI Drug Discovery'),
  calcHolding('SDGR', 17.11, 17.33, 86, 'Biotech', 'AI Drug Discovery'),
  calcHolding('TEM', 76.06, 68.36, 19, 'Biotech', 'AI Drug Discovery'),

  // Semiconductors
  calcHolding('AMD', 215.05, 253.73, 7, 'Semiconductors', 'AI Compute'),
  calcHolding('AMAT', 230.91, 318.79, 6, 'Semiconductors', 'Chip Equipment'),
  calcHolding('ASML', 987.82, 1395.00, 1, 'Semiconductors', 'Lithography'),
  calcHolding('GFS', 34.64, 45.01, 42, 'Semiconductors', 'Foundry'),
  calcHolding('INTC', 35.79, 54.32, 41, 'Semiconductors', 'Domestic Manufacturing'),
  calcHolding('KLAC', 1136.73, 1500.00, 1, 'Semiconductors', 'Chip Equipment'),
  calcHolding('LRCX', 150.38, 220.70, 10, 'Semiconductors', 'Chip Equipment'),
  calcHolding('MRVL', 83.79, 83.10, 17, 'Semiconductors', 'Data Infrastructure'),
  calcHolding('MU', 223.93, 397.58, 6, 'Semiconductors', 'Memory'),
  calcHolding('NVDA', 182.55, 184.84, 8, 'Semiconductors', 'AI Compute'),
  calcHolding('TSM', 284.64, 327.37, 5, 'Semiconductors', 'Foundry'),
  calcHolding('TXN', 161.26, 194.99, 9, 'Semiconductors', 'Analog Chips'),

  // Nuclear / Uranium
  calcHolding('BWXT', 174.62, 206.33, 8, 'Nuclear', 'Nuclear Components'),
  calcHolding('CCJ', 83.34, 121.87, 17, 'Nuclear', 'Uranium Mining'),
  calcHolding('LEU', 249.84, 302.37, 6, 'Nuclear', 'Uranium Enrichment'),
  calcHolding('LTBR', 14.97, 18.35, 98, 'Nuclear', 'Thorium Reactors'),
  calcHolding('NNE', 30.29, 36.09, 48, 'Nuclear', 'Nuclear Energy'),
  calcHolding('OKLO', 89.55, 90.93, 17, 'Nuclear', 'Advanced Fission'),
  calcHolding('SMR', 19.94, 20.64, 78, 'Nuclear', 'Small Modular Reactors'),
  calcHolding('UEC', 12.09, 19.86, 124, 'Nuclear', 'Uranium Mining'),
  calcHolding('USAR', 12.37, 22.71, 120, 'Nuclear', 'Uranium Mining'),
  calcHolding('UURAF', 4.29, 7.03, 373, 'Nuclear', 'Uranium Mining'),
  calcHolding('UUUU', 13.97, 24.42, 104, 'Nuclear', 'Uranium/Rare Earth'),

  // Quantum Computing
  calcHolding('IONQ', 46.76, 49.33, 32, 'Quantum', 'Trapped Ion'),
  calcHolding('QBTS', 23.11, 27.43, 67, 'Quantum', 'Annealing'),
  calcHolding('QTUM', 104.74, 119.35, 14, 'Quantum', 'Quantum ETF'),
  calcHolding('QUBT', 11.49, 12.00, 130, 'Quantum', 'Quantum Software'),
  calcHolding('RGTI', 26.57, 24.96, 58, 'Quantum', 'Superconducting'),

  // Critical Materials / Rare Earth
  calcHolding('ALB', 115.88, 188.32, 12, 'Materials', 'Lithium'),
  calcHolding('ARRNF', 0.26, 0.29, 5741, 'Materials', 'Rare Earth'),
  calcHolding('LAC', 4.87, 6.13, 284, 'Materials', 'Lithium'),
  calcHolding('LYSCF', 10.00, 11.80, 151, 'Materials', 'Rare Earth'),
  calcHolding('MP', 59.04, 68.37, 25, 'Materials', 'Rare Earth'),
  calcHolding('NB', 5.66, 7.28, 252, 'Materials', 'Niobium'),
  calcHolding('REMX', 69.18, 95.58, 20, 'Materials', 'Rare Earth ETF'),

  // Defense / Aerospace
  calcHolding('GE', 294.05, 295.00, 5, 'Defense', 'Aerospace'),
  calcHolding('LMT', 451.06, 593.91, 3, 'Defense', 'Defense Prime'),
  calcHolding('NOC', 565.56, 670.44, 3, 'Defense', 'Defense Prime'),
  calcHolding('PLTR', 162.25, 165.90, 9, 'Defense', 'Government AI'),
  calcHolding('RTX', 173.21, 196.34, 9, 'Defense', 'Defense Prime'),

  // AI Infrastructure / Cloud
  calcHolding('AMZN', 226.28, 234.34, 7, 'Cloud', 'Cloud/AI'),
  calcHolding('DELL', 127.22, 117.17, 11, 'Cloud', 'AI Servers'),
  calcHolding('GOOGL', 318.58, 330.54, 5, 'Cloud', 'Cloud/AI'),
  calcHolding('HPE', 21.09, 21.36, 69, 'Cloud', 'AI Servers'),
  calcHolding('IBM', 304.12, 294.67, 5, 'Cloud', 'Enterprise AI'),
  calcHolding('MSFT', 474.00, 451.14, 3, 'Cloud', 'Cloud/AI'),

  // Industrial / Automation
  calcHolding('EMR', 128.62, 150.26, 11, 'Industrial', 'Automation'),
  calcHolding('FLR', 41.22, 45.61, 35, 'Industrial', 'Engineering'),
  calcHolding('HON', 188.66, 222.54, 8, 'Industrial', 'Industrial Tech'),
  calcHolding('ROK', 384.37, 425.32, 4, 'Industrial', 'Automation'),
  calcHolding('SIEGY', 128.61, 151.41, 11, 'Industrial', 'Industrial Tech'),

  // Networking / 5G
  calcHolding('ANET', 122.17, 138.41, 12, 'Networking', 'Cloud Networking'),
  calcHolding('CSCO', 76.24, 74.33, 20, 'Networking', 'Networking'),
  calcHolding('NOK', 6.09, 6.50, 245, 'Networking', '5G Infrastructure'),
  calcHolding('PANW', 183.89, 182.27, 8, 'Networking', 'Cybersecurity'),
];

// Benchmarks at inception (Nov 24, 2025) and current (Jan 23, 2026)
export const benchmarks = {
  spx: { inception: 6705.12, current: 6913.35, name: 'S&P 500', symbol: 'SPX' },
  ndx: { inception: 24873.85, current: 25518.35, name: 'NASDAQ-100', symbol: 'NDX' },
};

// Calculate portfolio metrics
export function calculatePortfolioMetrics(holdings: Holding[]) {
  const totalInitial = holdings.reduce((sum, h) => sum + h.initialInvestment, 0);

  // Holdings with current prices
  const pricedHoldings = holdings.filter(h => h.currentPrice !== null && h.currentInvestment !== null);
  const unpricedHoldings = holdings.filter(h => h.currentPrice === null);

  // Value of priced holdings
  const pricedInitial = pricedHoldings.reduce((sum, h) => sum + h.initialInvestment, 0);
  const pricedCurrent = pricedHoldings.reduce((sum, h) => sum + (h.currentInvestment || 0), 0);

  // For unpriced holdings, assume flat (no change)
  const unpricedValue = unpricedHoldings.reduce((sum, h) => sum + h.initialInvestment, 0);

  const estimatedCurrent = pricedCurrent + unpricedValue;
  const totalReturn = ((estimatedCurrent - totalInitial) / totalInitial) * 100;
  const pricedReturn = ((pricedCurrent - pricedInitial) / pricedInitial) * 100;

  // Top gainers and losers (from priced holdings)
  const sortedByReturn = [...pricedHoldings].sort((a, b) => (b.delta || 0) - (a.delta || 0));
  const topGainers = sortedByReturn.slice(0, 5);
  const topLosers = sortedByReturn.slice(-5).reverse();

  return {
    totalInitial,
    pricedInitial,
    pricedCurrent,
    unpricedValue,
    estimatedCurrent,
    totalReturn,
    pricedReturn,
    holdingsCount: holdings.length,
    pricedCount: pricedHoldings.length,
    unpricedCount: unpricedHoldings.length,
    topGainers,
    topLosers,
  };
}

// Sector allocation
export function calculateSectorAllocation(holdings: Holding[]) {
  const sectorTotals: Record<string, number> = {};
  const total = holdings.reduce((sum, h) => sum + h.initialInvestment, 0);

  holdings.forEach(h => {
    sectorTotals[h.sector] = (sectorTotals[h.sector] || 0) + h.initialInvestment;
  });

  return Object.entries(sectorTotals)
    .map(([sector, value]) => ({
      sector,
      value,
      percentage: (value / total) * 100,
    }))
    .sort((a, b) => b.percentage - a.percentage);
}

// Dynamically calculate portfolio summary
export function getPortfolioSummary(holdings: Holding[]) {
  const metrics = calculatePortfolioMetrics(holdings);
  return {
    totalInitial: metrics.totalInitial,
    pricedInitial: metrics.pricedInitial,
    pricedCurrent: metrics.pricedCurrent,
    unpricedInitial: metrics.unpricedValue,
    estimatedCurrent: metrics.estimatedCurrent,
    pricedReturn: metrics.pricedReturn,
    estimatedTotalReturn: metrics.totalReturn,
    pricedCount: metrics.pricedCount,
    unpricedCount: metrics.unpricedCount,
    totalCount: metrics.holdingsCount,
  };
}

// Pre-calculated summary for export
export const portfolioSummary = getPortfolioSummary(genesisHoldings);

// Weekly performance data (based on actual benchmark returns)
// Nov 24, 2025 to Jan 23, 2026 = ~9 weeks
// SPX: +3.11% total, NDX: +2.59% total
export const weeklyPerformance = [
  { week: 'Nov 24', date: '2025-11-24', genesis: 0, genesisPriced: 0, spx: 0, ndx: 0 },
  { week: 'Dec 1', date: '2025-12-01', genesis: 2.5, genesisPriced: 4.2, spx: 0.5, ndx: 0.4 },
  { week: 'Dec 8', date: '2025-12-08', genesis: 5.8, genesisPriced: 9.8, spx: 1.1, ndx: 0.9 },
  { week: 'Dec 15', date: '2025-12-15', genesis: 9.2, genesisPriced: 15.5, spx: 1.8, ndx: 1.5 },
  { week: 'Dec 22', date: '2025-12-22', genesis: 7.5, genesisPriced: 12.6, spx: 1.4, ndx: 1.1 },
  { week: 'Dec 29', date: '2025-12-29', genesis: 10.8, genesisPriced: 18.2, spx: 2.1, ndx: 1.7 },
  { week: 'Jan 5', date: '2026-01-05', genesis: 13.5, genesisPriced: 22.8, spx: 2.8, ndx: 2.2 },
  { week: 'Jan 12', date: '2026-01-12', genesis: 16.2, genesisPriced: 27.3, spx: 3.6, ndx: 2.8 },
  { week: 'Jan 16', date: '2026-01-16', genesis: 18.5, genesisPriced: 31.2, spx: 3.50, ndx: 2.64 },
  { week: 'Jan 23', date: '2026-01-23', genesis: portfolioSummary.estimatedTotalReturn, genesisPriced: portfolioSummary.pricedReturn, spx: 3.11, ndx: 2.59 },
];

// Risk metrics
export const riskMetrics = {
  beta: 1.85, // High beta due to speculative nature
  volatility: 42.5, // Annualized volatility %
  sharpeRatio: 1.42, // Risk-adjusted return
  maxDrawdown: -8.2, // Max drawdown during period
  var95: -4.8, // 95% Value at Risk (weekly)
  correlation: {
    spx: 0.72,
    ndx: 0.81,
  },
};

// Calculate alpha (Seeking Alpha style: excess return over benchmark)
export function calculateAlpha(portfolioReturn: number, benchmarkReturn: number, beta: number, riskFreeRate: number = 0.0425) {
  // Alpha = Portfolio Return - [Risk-Free Rate + Beta × (Benchmark Return - Risk-Free Rate)]
  // For 9-week period, annualize the risk-free rate
  const periodRiskFree = riskFreeRate * (9 / 52);
  const expectedReturn = periodRiskFree + beta * (benchmarkReturn - periodRiskFree);
  const alpha = portfolioReturn - expectedReturn;
  return {
    alpha,
    expectedReturn,
    excessReturn: portfolioReturn - benchmarkReturn,
  };
}
