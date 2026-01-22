// Sample data from our January 2026 analysis
// Live tracking enabled - prices update in real-time during market hours

export const samplePortfolioData = {
  initialCapital: 100000,
  riskFreeRate: 0.03557, // 3-Month T-Bill as of Jan 16, 2026
  lookbackWeeks: 156,
  maxWeight: 0.50,
  minPosition: 600,

  weeks: [
    {
      label: 'Week 1',
      calcDate: '2026-01-02',
      execDate: '2026-01-05',
      periodEnd: '2026-01-09',
      weights: {
        HD: 0.2630,
        NKE: 0,
        UNH: 0.0594,
        PG: 0,
        KO: 0.0356,
        MRK: 0,
        JNJ: 0.2623,
        AMGN: 0.3055,
        CVX: 0,
        VZ: 0.0742,
      },
      positions: [
        { ticker: 'HD', shares: 76, execPrice: 342.70, endPrice: 374.64, costBasis: 26045.20 },
        { ticker: 'UNH', shares: 17, execPrice: 335.45, endPrice: 343.98, costBasis: 5702.65 },
        { ticker: 'KO', shares: 51, execPrice: 68.92, endPrice: 70.51, costBasis: 3514.92 },
        { ticker: 'JNJ', shares: 127, execPrice: 205.87, endPrice: 204.39, costBasis: 26145.49 },
        { ticker: 'AMGN', shares: 94, execPrice: 324.92, endPrice: 326.10, costBasis: 30542.48 },
        { ticker: 'VZ', shares: 186, execPrice: 39.74, endPrice: 39.77, costBasis: 7391.74 },
      ],
      portfolioValue: {
        start: 100000,
        end: 102615.95,
        stockValue: 101795.18,
        cash: 820.76,
        dividends: 0,
      },
      weeklyReturn: 0.0262,
    },
    {
      label: 'Week 2',
      calcDate: '2026-01-09',
      execDate: '2026-01-12',
      periodEnd: '2026-01-16',
      weights: {
        HD: 0.2754,
        NKE: 0,
        UNH: 0.0741,
        PG: 0,
        KO: 0.1214,
        MRK: 0,
        JNJ: 0.2468,
        AMGN: 0.2561,
        CVX: 0,
        VZ: 0.0264,
      },
      positions: [
        { ticker: 'HD', shares: 75, execPrice: 374.64, endPrice: 380.17, costBasis: 25702.50 },
        { ticker: 'UNH', shares: 22, execPrice: 341.42, endPrice: 331.02, costBasis: 7409.75 },
        { ticker: 'KO', shares: 120, execPrice: 70.90, endPrice: 70.44, costBasis: 8508.00 },
        { ticker: 'JNJ', shares: 123, execPrice: 205.55, endPrice: 218.66, costBasis: 25282.65 },
        { ticker: 'AMGN', shares: 79, execPrice: 328.47, endPrice: 330.41, costBasis: 25949.13 },
        { ticker: 'VZ', shares: 120, execPrice: 39.82, endPrice: 38.91, costBasis: 4778.40 },
      ],
      trades: [
        { ticker: 'HD', action: 'SELL', shares: 1, price: 374.64, value: 374.64 },
        { ticker: 'UNH', action: 'BUY', shares: 5, price: 341.42, value: 1707.10 },
        { ticker: 'KO', action: 'BUY', shares: 69, price: 70.90, value: 4892.10 },
        { ticker: 'JNJ', action: 'SELL', shares: 4, price: 205.55, value: 822.20 },
        { ticker: 'AMGN', action: 'SELL', shares: 15, price: 328.47, value: 4927.05 },
        { ticker: 'VZ', action: 'SELL', shares: 66, price: 39.82, value: 2628.12 },
      ],
      dividends: [
        { date: '2026-01-12', ticker: 'VZ', shares: 120, perShare: 0.69, amount: 82.80 },
      ],
      portfolioValue: {
        start: 102615.95,
        end: 104587.90,
        stockValue: 103761.34,
        cash: 826.55,
        dividends: 82.80,
      },
      weeklyReturn: 0.0192,
    },
    {
      label: 'Week 3',
      calcDate: '2026-01-16',
      execDate: '2026-01-20', // Tuesday - MLK Day was Jan 19
      periodEnd: '2026-01-23',
      status: 'active', // Currently in progress - executing today
      weights: {
        HD: 0.3079,
        NKE: 0,
        UNH: 0.0592,
        PG: 0.0138,
        KO: 0.0951,
        MRK: 0,
        JNJ: 0.2787,
        AMGN: 0.2213,
        CVX: 0,
        VZ: 0.0240,
      },
      // Target positions for Week 3 (to be executed at market open Jan 21)
      targetPositions: [
        { ticker: 'HD', shares: 84, targetWeight: 0.3079 },
        { ticker: 'JNJ', shares: 133, targetWeight: 0.2787 },
        { ticker: 'AMGN', shares: 70, targetWeight: 0.2213 },
        { ticker: 'KO', shares: 140, targetWeight: 0.0951 },
        { ticker: 'UNH', shares: 19, targetWeight: 0.0592 },
        { ticker: 'VZ', shares: 64, targetWeight: 0.0240 },
        { ticker: 'PG', shares: 10, targetWeight: 0.0138 },
      ],
      // Trades to execute on Jan 21 (based on Jan 17 closing prices)
      plannedTrades: [
        { ticker: 'HD', action: 'BUY', shares: 9, estimatedPrice: 379.55 },
        { ticker: 'UNH', action: 'SELL', shares: 3, estimatedPrice: 347.25 },
        { ticker: 'PG', action: 'BUY', shares: 10, estimatedPrice: 144.53 },
        { ticker: 'KO', action: 'BUY', shares: 20, estimatedPrice: 70.54 },
        { ticker: 'JNJ', action: 'BUY', shares: 10, estimatedPrice: 219.00 },
        { ticker: 'AMGN', action: 'SELL', shares: 9, estimatedPrice: 325.50 },
        { ticker: 'VZ', action: 'SELL', shares: 56, estimatedPrice: 39.04 },
      ],
      // CAPM expected return for Week 3
      expectedReturn: {
        tangency: 0.0030, // Rf + β(Rm - Rf) = 0.0684% + 0.31 × (estimated market return)
        note: 'CAPM expected return based on historical beta',
      },
    },
  ],

  summary: {
    totalReturn: 0.0459,
    priceReturn: 0.0451,
    dividendReturn: 0.0008,
    totalDividends: 82.80,
    finalValue: 104587.90,
  },

  metrics: {
    tangency: {
      totalReturn: 0.0459,
      meanWeeklyReturn: 0.0227,
      weeklyVolatility: 0.0049,
      sharpeRatio: 4.48,
      beta: 0.27,
      alpha: 0.0195,
    },
    equalWeight: {
      totalReturn: 0.0268,
      meanWeeklyReturn: 0.0134,
      weeklyVolatility: 0.0131,
      sharpeRatio: 0.97,
      beta: 0.71,
      alpha: 0.0060,
    },
    dji: {
      totalReturn: 0.0202,
      meanWeeklyReturn: 0.0081,
      weeklyVolatility: 0.0168,
      sharpeRatio: 0.45,
      beta: 1.0,
      alpha: 0,
    },
  },

  weightHistory: [
    { date: '2026-01-02', HD: 26.30, AMGN: 30.55, JNJ: 26.23, VZ: 7.42, UNH: 5.94, KO: 3.56 },
    { date: '2026-01-09', HD: 27.54, AMGN: 25.61, JNJ: 24.68, KO: 12.14, UNH: 7.41, VZ: 2.64 },
    { date: '2026-01-16', HD: 30.79, JNJ: 27.87, AMGN: 22.13, KO: 9.51, UNH: 5.92, VZ: 2.40, PG: 1.38 },
  ],

  returnComparison: [
    { name: 'Week 1', dates: 'Jan 2 - Jan 9', tangency: 2.62, equalWeight: 2.26, dji: 2.32 },
    { name: 'Week 2', dates: 'Jan 12 - Jan 16', tangency: 1.92, equalWeight: 0.41, dji: -0.29 },
  ],

  portfolioValueHistory: [
    { date: 'Jan 2', tangency: 100000, equalWeight: 100000, dji: 100000 },
    { date: 'Jan 9', tangency: 102616, equalWeight: 102260, dji: 102320 },
    { date: 'Jan 16', tangency: 104588, equalWeight: 102679, dji: 102020 },
  ],
};

export const sectorAllocation = [
  { name: 'Healthcare', value: 55.92, color: '#3B82F6' },
  { name: 'Consumer Discretionary', value: 30.79, color: '#10B981' },
  { name: 'Consumer Staples', value: 10.89, color: '#F59E0B' },
  { name: 'Communication Services', value: 2.40, color: '#8B5CF6' },
];

export const riskMetrics = {
  maxDrawdown: -1.2,
  var95: -2.1,
  trackingError: 1.8,
  informationRatio: 1.2,
};
