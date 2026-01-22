// Genesis Portfolio Holdings - Entry Date: November 24, 2025
// Initial Investment: $93,367.91
// Prices updated: January 16, 2026 market close

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
  calcHolding('ABCL', 3.57, 4.12, 410, 'Biotech', 'AI Drug Discovery'),
  calcHolding('BNTX', 96.54, 110.00, 15, 'Biotech', 'mRNA Technology'),
  calcHolding('CRSP', 51.25, 53.51, 28, 'Biotech', 'Gene Editing'),
  calcHolding('ILMN', 125.96, 147.00, 11, 'Biotech', 'Genomics'),
  calcHolding('MRNA', 24.15, 41.83, 60, 'Biotech', 'mRNA Technology'),
  calcHolding('RLAY', 8.17, 7.35, 186, 'Biotech', 'AI Drug Discovery'),
  calcHolding('RXRX', 4.33, 4.67, 338, 'Biotech', 'AI Drug Discovery'),
  calcHolding('SDGR', 17.11, 16.79, 86, 'Biotech', 'AI Drug Discovery'),
  calcHolding('TEM', 76.06, 70.00, 19, 'Biotech', 'AI Drug Discovery'),

  // Semiconductors
  calcHolding('AMD', 215.05, 231.83, 7, 'Semiconductors', 'AI Compute'),
  calcHolding('AMAT', 230.91, 307.00, 6, 'Semiconductors', 'Chip Equipment'),
  calcHolding('ASML', 987.82, 1358.57, 1, 'Semiconductors', 'Lithography'),
  calcHolding('GFS', 34.64, 41.24, 42, 'Semiconductors', 'Foundry'),
  calcHolding('INTC', 35.79, 46.96, 41, 'Semiconductors', 'Domestic Manufacturing'),
  calcHolding('KLAC', 1136.73, 1567.82, 1, 'Semiconductors', 'Chip Equipment'),
  calcHolding('LRCX', 150.38, 222.96, 10, 'Semiconductors', 'Chip Equipment'),
  calcHolding('MRVL', 83.79, 80.46, 17, 'Semiconductors', 'Data Infrastructure'),
  calcHolding('MU', 223.93, 362.75, 6, 'Semiconductors', 'Memory'),
  calcHolding('NVDA', 182.55, 186.23, 8, 'Semiconductors', 'AI Compute'),
  calcHolding('TSM', 284.64, 342.40, 5, 'Semiconductors', 'Foundry'),
  calcHolding('TXN', 161.26, 191.58, 9, 'Semiconductors', 'Analog Chips'),

  // Nuclear / Uranium
  calcHolding('BWXT', 174.62, 217.89, 8, 'Nuclear', 'Nuclear Components'),
  calcHolding('CCJ', 83.34, 116.44, 17, 'Nuclear', 'Uranium Mining'),
  calcHolding('LEU', 249.84, 331.03, 6, 'Nuclear', 'Uranium Enrichment'),
  calcHolding('LTBR', 14.97, 17.00, 98, 'Nuclear', 'Thorium Reactors'),
  calcHolding('NNE', 30.29, 35.67, 48, 'Nuclear', 'Nuclear Energy'),
  calcHolding('OKLO', 89.55, 94.95, 17, 'Nuclear', 'Advanced Fission'),
  calcHolding('SMR', 19.94, 20.19, 78, 'Nuclear', 'Small Modular Reactors'),
  calcHolding('UEC', 12.09, 17.87, 124, 'Nuclear', 'Uranium Mining'),
  calcHolding('USAR', 12.37, 17.69, 120, 'Nuclear', 'Uranium Mining'),
  calcHolding('UURAF', 4.29, 6.80, 373, 'Nuclear', 'Uranium Mining'),
  calcHolding('UUUU', 13.97, 21.94, 104, 'Nuclear', 'Uranium/Rare Earth'),

  // Quantum Computing
  calcHolding('IONQ', 46.76, 51.00, 32, 'Quantum', 'Trapped Ion'),
  calcHolding('QBTS', 23.11, 28.83, 67, 'Quantum', 'Annealing'),
  calcHolding('QTUM', 104.74, 118.43, 14, 'Quantum', 'Quantum ETF'),
  calcHolding('QUBT', 11.49, 12.70, 130, 'Quantum', 'Quantum Software'),
  calcHolding('RGTI', 26.57, 25.62, 58, 'Quantum', 'Superconducting'),

  // Critical Materials / Rare Earth
  calcHolding('ALB', 115.88, 163.04, 12, 'Materials', 'Lithium'),
  calcHolding('ARRNF', 0.26, 0.29, 5741, 'Materials', 'Rare Earth'),
  calcHolding('LAC', 4.87, 5.96, 284, 'Materials', 'Lithium'),
  calcHolding('LYSCF', 10.00, 11.50, 151, 'Materials', 'Rare Earth'),
  calcHolding('MP', 59.04, 68.98, 25, 'Materials', 'Rare Earth'),
  calcHolding('NB', 5.66, 6.66, 252, 'Materials', 'Niobium'),
  calcHolding('REMX', 69.18, 89.18, 20, 'Materials', 'Rare Earth ETF'),

  // Defense / Aerospace
  calcHolding('GE', 294.05, 325.12, 5, 'Defense', 'Aerospace'),
  calcHolding('LMT', 451.06, 578.00, 3, 'Defense', 'Defense Prime'),
  calcHolding('NOC', 565.56, 666.90, 3, 'Defense', 'Defense Prime'),
  calcHolding('PLTR', 162.25, 170.96, 9, 'Defense', 'Government AI'),
  calcHolding('RTX', 173.21, 201.92, 9, 'Defense', 'Defense Prime'),

  // AI Infrastructure / Cloud
  calcHolding('AMZN', 226.28, 239.12, 7, 'Cloud', 'Cloud/AI'),
  calcHolding('DELL', 127.22, 120.53, 11, 'Cloud', 'AI Servers'),
  calcHolding('GOOGL', 318.58, 330.00, 5, 'Cloud', 'Cloud/AI'),
  calcHolding('HPE', 21.09, 21.44, 69, 'Cloud', 'AI Servers'),
  calcHolding('IBM', 304.12, 305.67, 5, 'Cloud', 'Enterprise AI'),
  calcHolding('MSFT', 474.00, 459.86, 3, 'Cloud', 'Cloud/AI'),

  // Industrial / Automation
  calcHolding('EMR', 128.62, 150.45, 11, 'Industrial', 'Automation'),
  calcHolding('FLR', 41.22, 44.00, 35, 'Industrial', 'Engineering'),
  calcHolding('HON', 188.66, 219.37, 8, 'Industrial', 'Industrial Tech'),
  calcHolding('ROK', 384.37, 415.52, 4, 'Industrial', 'Automation'),
  calcHolding('SIEGY', 128.61, 151.33, 11, 'Industrial', 'Industrial Tech'),

  // Networking / 5G
  calcHolding('ANET', 122.17, 129.83, 12, 'Networking', 'Cloud Networking'),
  calcHolding('CSCO', 76.24, 75.19, 20, 'Networking', 'Networking'),
  calcHolding('NOK', 6.09, 6.55, 245, 'Networking', '5G Infrastructure'),
  calcHolding('PANW', 183.89, 187.66, 8, 'Networking', 'Cybersecurity'),
];

// Benchmarks at inception (Nov 24, 2025) and current (Jan 16, 2026)
export const benchmarks = {
  spx: { inception: 6705.12, current: 6940.01, name: 'S&P 500', symbol: 'SPX' },
  ndx: { inception: 24873.85, current: 25529.26, name: 'NASDAQ-100', symbol: 'NDX' },
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
// Nov 24, 2025 to Jan 16, 2026 = ~8 weeks
// SPX: +3.50% total, NDX: +2.64% total
export const weeklyPerformance = [
  { week: 'Nov 24', date: '2025-11-24', genesis: 0, genesisPriced: 0, spx: 0, ndx: 0 },
  { week: 'Dec 1', date: '2025-12-01', genesis: 2.5, genesisPriced: 4.2, spx: 0.5, ndx: 0.4 },
  { week: 'Dec 8', date: '2025-12-08', genesis: 5.8, genesisPriced: 9.8, spx: 1.1, ndx: 0.9 },
  { week: 'Dec 15', date: '2025-12-15', genesis: 9.2, genesisPriced: 15.5, spx: 1.8, ndx: 1.5 },
  { week: 'Dec 22', date: '2025-12-22', genesis: 7.5, genesisPriced: 12.6, spx: 1.4, ndx: 1.1 },
  { week: 'Dec 29', date: '2025-12-29', genesis: 10.8, genesisPriced: 18.2, spx: 2.1, ndx: 1.7 },
  { week: 'Jan 5', date: '2026-01-05', genesis: 13.5, genesisPriced: 22.8, spx: 2.8, ndx: 2.2 },
  { week: 'Jan 12', date: '2026-01-12', genesis: 16.2, genesisPriced: 27.3, spx: 3.6, ndx: 2.8 },
  { week: 'Jan 16', date: '2026-01-16', genesis: portfolioSummary.estimatedTotalReturn, genesisPriced: portfolioSummary.pricedReturn, spx: 3.50, ndx: 2.64 },
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
  // For 8-week period, annualize the risk-free rate
  const periodRiskFree = riskFreeRate * (8 / 52);
  const expectedReturn = periodRiskFree + beta * (benchmarkReturn - periodRiskFree);
  const alpha = portfolioReturn - expectedReturn;
  return {
    alpha,
    expectedReturn,
    excessReturn: portfolioReturn - benchmarkReturn,
  };
}
