export interface PortfolioWeights {
  [ticker: string]: number;
}

export interface PortfolioPosition {
  ticker: string;
  shares: number;
  price: number;
  value: number;
  weight: number;
  costBasis: number;
  gainLoss: number;
  gainLossPercent: number;
}

export interface PortfolioState {
  date: string;
  positions: PortfolioPosition[];
  cash: number;
  dividends: number;
  stockValue: number;
  totalValue: number;
}

export interface Trade {
  ticker: string;
  action: 'BUY' | 'SELL';
  shares: number;
  price: number;
  value: number;
}

export interface WeekData {
  calcDate: string;
  execDate: string;
  periodEnd: string;
  weights: PortfolioWeights;
  trades: Trade[];
  portfolioState: PortfolioState;
  weeklyReturn: number;
}

export interface PerformanceMetrics {
  totalReturn: number;
  meanWeeklyReturn: number;
  weeklyVolatility: number;
  sharpeRatio: number;
  beta: number;
  alpha: number;
}

export interface DividendPayment {
  date: string;
  ticker: string;
  shares: number;
  perShare: number;
  amount: number;
}

export interface BacktestResult {
  weeks: WeekData[];
  metrics: PerformanceMetrics;
  dividends: DividendPayment[];
  priceReturn: number;
  dividendReturn: number;
  totalReturn: number;
}

export const DOGS_OF_DOW_2025 = [
  { ticker: 'HD', name: 'Home Depot', sector: 'Consumer Discretionary' },
  { ticker: 'NKE', name: 'Nike', sector: 'Consumer Discretionary' },
  { ticker: 'UNH', name: 'UnitedHealth', sector: 'Healthcare' },
  { ticker: 'PG', name: 'Procter & Gamble', sector: 'Consumer Staples' },
  { ticker: 'KO', name: 'Coca-Cola', sector: 'Consumer Staples' },
  { ticker: 'MRK', name: 'Merck', sector: 'Healthcare' },
  { ticker: 'JNJ', name: 'Johnson & Johnson', sector: 'Healthcare' },
  { ticker: 'AMGN', name: 'Amgen', sector: 'Healthcare' },
  { ticker: 'CVX', name: 'Chevron', sector: 'Energy' },
  { ticker: 'VZ', name: 'Verizon', sector: 'Communication Services' },
];

export const TICKERS = DOGS_OF_DOW_2025.map(d => d.ticker);
