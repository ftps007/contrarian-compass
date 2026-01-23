// Contrarian Plays Portfolio
// Inception: August 26-27, 2025
// Prices updated: January 23, 2026

export interface ContrarianPosition {
  ticker: string;
  name: string;
  sector: string;
  recDate: string;
  rating: 'strong buy' | 'buy' | 'hold' | 'strong sell' | 'sell';
  entryPrice: number;
  currentPrice: number;
  shares: number;
  initialInvestment: number;
  currentInvestment: number;
  profitLoss: number;
  returnPct: number;
}

export interface ClosedPosition extends ContrarianPosition {
  exitDate: string;
  exitPrice: number;
}

export const openPositions: ContrarianPosition[] = [
  { ticker: 'JBTM', name: 'JBT Marel', sector: 'Industrials', recDate: '2025-08-26', rating: 'hold', entryPrice: 144.06, currentPrice: 157.42, shares: 52, initialInvestment: 7491, currentInvestment: 8186, profitLoss: 695, returnPct: 9.27 },
  { ticker: 'ROKU', name: 'Roku', sector: 'Communication', recDate: '2025-08-27', rating: 'hold', entryPrice: 97.54, currentPrice: 107.23, shares: 79, initialInvestment: 7706, currentInvestment: 8471, profitLoss: 766, returnPct: 9.93 },
  { ticker: 'PTON', name: 'Peloton Interactive', sector: 'Consumer Disc.', recDate: '2025-08-27', rating: 'hold', entryPrice: 7.58, currentPrice: 5.81, shares: 1014, initialInvestment: 7686, currentInvestment: 5891, profitLoss: -1795, returnPct: -23.35 },
  { ticker: 'EL', name: 'Estee Lauder', sector: 'Consumer Staples', recDate: '2025-08-27', rating: 'hold', entryPrice: 91.77, currentPrice: 119.49, shares: 83, initialInvestment: 7617, currentInvestment: 9918, profitLoss: 2301, returnPct: 30.21 },
  { ticker: 'PYPL', name: 'PayPal Holdings', sector: 'Financials', recDate: '2025-08-27', rating: 'hold', entryPrice: 70.06, currentPrice: 57.15, shares: 110, initialInvestment: 7707, currentInvestment: 6287, profitLoss: -1420, returnPct: -18.43 },
  { ticker: 'TSLA', name: 'Tesla', sector: 'Consumer Disc.', recDate: '2025-11-25', rating: 'hold', entryPrice: 419.40, currentPrice: 449.36, shares: 18, initialInvestment: 7549, currentInvestment: 8088, profitLoss: 539, returnPct: 7.14 },
  { ticker: 'BA', name: 'Boeing', sector: 'Industrials', recDate: '2025-11-25', rating: 'hold', entryPrice: 182.44, currentPrice: 251.41, shares: 42, initialInvestment: 7662, currentInvestment: 10559, profitLoss: 2897, returnPct: 37.80 },
  { ticker: 'SAP', name: 'SAP', sector: 'Technology', recDate: '2025-11-25', rating: 'hold', entryPrice: 237.86, currentPrice: 226.35, shares: 32, initialInvestment: 7612, currentInvestment: 7243, profitLoss: -368, returnPct: -4.84 },
  { ticker: 'NVO', name: 'Novo Nordisk', sector: 'Healthcare', recDate: '2025-11-25', rating: 'hold', entryPrice: 47.06, currentPrice: 62.23, shares: 163, initialInvestment: 7671, currentInvestment: 10143, profitLoss: 2473, returnPct: 32.24 },
  { ticker: 'UNH', name: 'United Health', sector: 'Healthcare', recDate: '2025-12-10', rating: 'hold', entryPrice: 328.37, currentPrice: 354.47, shares: 23, initialInvestment: 7553, currentInvestment: 8153, profitLoss: 600, returnPct: 7.95 },
  { ticker: 'INTC', name: 'Intel', sector: 'Technology', recDate: '2025-12-10', rating: 'hold', entryPrice: 40.78, currentPrice: 54.32, shares: 148, initialInvestment: 6035, currentInvestment: 8039, profitLoss: 2004, returnPct: 33.20 },
  { ticker: 'F', name: 'Ford', sector: 'Consumer Disc.', recDate: '2025-12-10', rating: 'hold', entryPrice: 13.41, currentPrice: 13.71, shares: 192, initialInvestment: 2575, currentInvestment: 2632, profitLoss: 58, returnPct: 2.24 },
  { ticker: 'PFE', name: 'Pfizer', sector: 'Healthcare', recDate: '2025-12-10', rating: 'strong buy', entryPrice: 25.78, currentPrice: 26.10, shares: 192, initialInvestment: 4950, currentInvestment: 5011, profitLoss: 61, returnPct: 1.24 },
  { ticker: 'CHTR', name: 'Charter Communications', sector: 'Communication', recDate: '2025-12-10', rating: 'hold', entryPrice: 213.29, currentPrice: 192.67, shares: 18, initialInvestment: 3839, currentInvestment: 3468, profitLoss: -371, returnPct: -9.67 },
  { ticker: 'NKE', name: 'Nike', sector: 'Consumer Disc.', recDate: '2026-01-08', rating: 'hold', entryPrice: 65.26, currentPrice: 65.46, shares: 118, initialInvestment: 7701, currentInvestment: 7724, profitLoss: 24, returnPct: 0.31 },
  { ticker: 'HD', name: 'Home Depot', sector: 'Consumer Disc.', recDate: '2026-01-08', rating: 'hold', entryPrice: 359.56, currentPrice: 381.03, shares: 24, initialInvestment: 8629, currentInvestment: 9145, profitLoss: 515, returnPct: 5.97 },
  { ticker: 'FMC', name: 'FMC Corp.', sector: 'Materials', recDate: '2026-01-08', rating: 'strong sell', entryPrice: 15.01, currentPrice: 16.02, shares: 75, initialInvestment: 1126, currentInvestment: 1202, profitLoss: 76, returnPct: 6.73 },
];

export const closedPositions: ClosedPosition[] = [
  { ticker: 'WBD', name: 'Warner Bros Discovery', sector: 'Communication', recDate: '2025-08-27', rating: 'hold', entryPrice: 12.06, currentPrice: 27.23, exitPrice: 27.23, exitDate: '2025-12-06', shares: 633, initialInvestment: 7634, currentInvestment: 17237, profitLoss: 9603, returnPct: 125.79 },
  { ticker: 'ETSY', name: 'Etsy', sector: 'Consumer Disc.', recDate: '2025-10-03', rating: 'hold', entryPrice: 72.38, currentPrice: 54.34, exitPrice: 54.34, exitDate: '2025-12-06', shares: 106, initialInvestment: 7672, currentInvestment: 5760, profitLoss: -1912, returnPct: -24.92 },
  { ticker: 'W', name: 'Wayfair', sector: 'Consumer Disc.', recDate: '2025-08-27', rating: 'strong buy', entryPrice: 75.46, currentPrice: 113.45, exitPrice: 113.45, exitDate: '2026-01-08', shares: 103, initialInvestment: 7772, currentInvestment: 11685, profitLoss: 3913, returnPct: 50.34 },
  { ticker: 'ON', name: 'ON Semiconductor', sector: 'Technology', recDate: '2025-11-25', rating: 'hold', entryPrice: 48.31, currentPrice: 60.89, exitPrice: 60.89, exitDate: '2026-01-08', shares: 159, initialInvestment: 7681, currentInvestment: 9682, profitLoss: 2000, returnPct: 26.04 },
];

export const portfolioSummary = {
  openInitial: 111108,
  openCurrent: 120161,
  openPL: 9053,
  openReturnPct: 8.15,
  closedInitial: 30760,
  closedProceeds: 44363,
  closedPL: 13604,
  closedReturnPct: 44.22,
  totalInvested: 141868,
  totalPL: 22657,
  totalReturnPct: 15.97,
};

export const benchmarks = {
  spx: { inception: 6481.38, current: 6913.35, returnPct: 6.66, name: 'S&P 500' },
  ndx: { inception: 23529.44, current: 25518.35, returnPct: 8.45, name: 'NASDAQ' },
  dji: { inception: 45565.11, current: 49384.01, returnPct: 8.38, name: 'Dow Jones' },
  inceptionDate: '2025-08-27',
};

// Entry batches for timeline
export const entryBatches = [
  { date: '2025-08-26', label: 'Aug 26', tickers: ['JBTM'] },
  { date: '2025-08-27', label: 'Aug 27', tickers: ['ROKU', 'PTON', 'EL', 'PYPL'] },
  { date: '2025-10-03', label: 'Oct 3', tickers: ['ETSY'] },
  { date: '2025-11-25', label: 'Nov 25', tickers: ['TSLA', 'BA', 'SAP', 'NVO'] },
  { date: '2025-12-10', label: 'Dec 10', tickers: ['UNH', 'INTC', 'F', 'PFE', 'CHTR'] },
  { date: '2026-01-08', label: 'Jan 8', tickers: ['NKE', 'HD', 'FMC'] },
];

export const exitBatches = [
  { date: '2025-12-06', label: 'Dec 6', tickers: ['WBD', 'ETSY'] },
  { date: '2026-01-08', label: 'Jan 8', tickers: ['W', 'ON'] },
];

// Time-weighted weekly returns (calculated from historical prices)
export const weeklyReturns = [
  { date: '2025-09-08', label: 'Sep 8', ret: 5.01 },
  { date: '2025-09-15', label: 'Sep 15', ret: 3.64 },
  { date: '2025-09-22', label: 'Sep 22', ret: -0.14 },
  { date: '2025-09-29', label: 'Sep 29', ret: 1.53 },
  { date: '2025-10-06', label: 'Oct 6', ret: -9.44 },
  { date: '2025-10-13', label: 'Oct 13', ret: 4.91 },
  { date: '2025-10-20', label: 'Oct 20', ret: 4.79 },
  { date: '2025-10-27', label: 'Oct 27', ret: 1.69 },
  { date: '2025-11-03', label: 'Nov 3', ret: -0.01 },
  { date: '2025-11-10', label: 'Nov 10', ret: -2.24 },
  { date: '2025-11-17', label: 'Nov 17', ret: -2.14 },
  { date: '2025-11-24', label: 'Nov 24', ret: 3.79 },
  { date: '2025-12-01', label: 'Dec 1', ret: 0.57 },
  { date: '2025-12-08', label: 'Dec 8', ret: 2.25 },
  { date: '2025-12-15', label: 'Dec 15', ret: 0.90 },
  { date: '2025-12-22', label: 'Dec 22', ret: 0.79 },
  { date: '2025-12-29', label: 'Dec 29', ret: 0.13 },
  { date: '2026-01-05', label: 'Jan 5', ret: 5.75 },
  { date: '2026-01-12', label: 'Jan 12', ret: -0.92 },
  { date: '2026-01-19', label: 'Jan 19', ret: 1.85 },
];
