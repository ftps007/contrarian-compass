'use client';

import { useState, useMemo } from 'react';
import { samplePortfolioData } from '@/lib/sampleData';
import { DOGS_OF_DOW_2025 } from '@/lib/types';

interface TradeRecommendation {
  ticker: string;
  name: string;
  targetWeight: number;
  targetValue: number;
  shares: number;
  currentPrice: number;
  totalCost: number;
}

// Current prices from sample data (Week 3 end prices)
const currentPrices: Record<string, number> = {
  HD: 385.42,
  NKE: 72.85,
  UNH: 338.55,
  PG: 146.21,
  KO: 71.15,
  MRK: 100.45,
  JNJ: 221.34,
  AMGN: 334.18,
  CVX: 168.50,
  VZ: 39.45,
};

export default function CalculatorPage() {
  const [capital, setCapital] = useState(100000);
  const [minPosition, setMinPosition] = useState(600);

  // Get latest weights from sample data
  const latestWeights = samplePortfolioData.weeks[2].weights;

  const recommendations = useMemo(() => {
    const trades: TradeRecommendation[] = [];
    let totalAllocated = 0;

    // Sort by weight descending
    const sortedTickers = Object.entries(latestWeights)
      .filter(([_, weight]) => weight > 0)
      .sort((a, b) => b[1] - a[1]);

    for (const [ticker, weight] of sortedTickers) {
      const dogInfo = DOGS_OF_DOW_2025.find(d => d.ticker === ticker);
      const price = currentPrices[ticker];
      const targetValue = capital * weight;

      // Skip if below minimum position
      if (targetValue < minPosition) continue;

      const shares = Math.floor(targetValue / price);
      const totalCost = shares * price;

      if (shares > 0) {
        trades.push({
          ticker,
          name: dogInfo?.name || ticker,
          targetWeight: weight,
          targetValue,
          shares,
          currentPrice: price,
          totalCost,
        });
        totalAllocated += totalCost;
      }
    }

    return { trades, totalAllocated, cash: capital - totalAllocated };
  }, [capital, minPosition, latestWeights]);

  const formatCurrency = (value: number) =>
    `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const formatPercent = (value: number) =>
    `${(value * 100).toFixed(2)}%`;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">Trade Calculator</h1>
        <span className="text-sm text-gray-500">Based on Jan 23, 2026 tangency weights</span>
      </div>

      {/* Input Panel */}
      <div className="card">
        <h3 className="card-header">Your Investment</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Starting Capital ($)
            </label>
            <input
              type="number"
              value={capital}
              onChange={(e) => setCapital(Number(e.target.value))}
              className="input-field"
              min={1000}
              step={1000}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Min Position Size ($)
            </label>
            <input
              type="number"
              value={minPosition}
              onChange={(e) => setMinPosition(Number(e.target.value))}
              className="input-field"
              min={0}
              step={100}
            />
            <p className="text-xs text-gray-500 mt-1">$600+ avoids transaction costs</p>
          </div>
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="card">
          <div className="stat-label">Total to Invest</div>
          <div className="stat-value">{formatCurrency(recommendations.totalAllocated)}</div>
          <div className="text-sm text-gray-500">
            {((recommendations.totalAllocated / capital) * 100).toFixed(1)}% of capital
          </div>
        </div>
        <div className="card">
          <div className="stat-label">Cash Reserve</div>
          <div className="stat-value">{formatCurrency(recommendations.cash)}</div>
          <div className="text-sm text-gray-500">
            {((recommendations.cash / capital) * 100).toFixed(1)}% of capital
          </div>
        </div>
        <div className="card">
          <div className="stat-label">Positions</div>
          <div className="stat-value">{recommendations.trades.length}</div>
          <div className="text-sm text-gray-500">of 10 Dogs of the Dow</div>
        </div>
      </div>

      {/* Trade Recommendations */}
      <div className="card">
        <h3 className="card-header">Recommended Trades</h3>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead>
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Ticker</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Company</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Target Weight</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Current Price</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Shares to Buy</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Total Cost</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actual Weight</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {recommendations.trades.map((trade) => (
                <tr key={trade.ticker} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm font-medium text-blue-600">{trade.ticker}</td>
                  <td className="px-4 py-3 text-sm text-gray-700">{trade.name}</td>
                  <td className="px-4 py-3 text-sm text-right">{formatPercent(trade.targetWeight)}</td>
                  <td className="px-4 py-3 text-sm text-right">{formatCurrency(trade.currentPrice)}</td>
                  <td className="px-4 py-3 text-sm text-right font-semibold">{trade.shares}</td>
                  <td className="px-4 py-3 text-sm text-right">{formatCurrency(trade.totalCost)}</td>
                  <td className="px-4 py-3 text-sm text-right">
                    {formatPercent(trade.totalCost / recommendations.totalAllocated)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-gray-50 font-semibold">
                <td colSpan={5} className="px-4 py-3 text-sm text-right">Total Investment:</td>
                <td className="px-4 py-3 text-sm text-right">{formatCurrency(recommendations.totalAllocated)}</td>
                <td className="px-4 py-3 text-sm text-right">100.00%</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Copy-Paste Order List */}
      <div className="card bg-gray-50">
        <h3 className="card-header">Quick Order List</h3>
        <p className="text-sm text-gray-600 mb-4">Copy these for your broker:</p>
        <div className="bg-white p-4 rounded-lg border font-mono text-sm space-y-1">
          {recommendations.trades.map((trade) => (
            <div key={trade.ticker}>
              BUY {trade.shares} {trade.ticker} @ MARKET ({formatCurrency(trade.totalCost)})
            </div>
          ))}
        </div>
      </div>

      {/* Risk Notice */}
      <div className="card border-l-4 border-yellow-400 bg-yellow-50">
        <h3 className="text-sm font-semibold text-yellow-800">Important Notice</h3>
        <p className="text-sm text-yellow-700 mt-1">
          This calculator uses optimized tangency portfolio weights based on historical data. Past performance
          does not guarantee future results. The tangency portfolio concentrates holdings in fewer stocks
          for maximum risk-adjusted returns, which increases single-stock risk. Always consult a financial
          advisor before making investment decisions.
        </p>
      </div>
    </div>
  );
}
