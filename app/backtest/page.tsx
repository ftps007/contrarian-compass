'use client';

import { useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  BarChart, Bar
} from 'recharts';
import { samplePortfolioData } from '@/lib/sampleData';
import { DOGS_OF_DOW_2025 } from '@/lib/types';

export default function BacktestPage() {
  const [capital, setCapital] = useState(100000);
  const [maxWeight, setMaxWeight] = useState(50);
  const [lookbackWeeks, setLookbackWeeks] = useState(156);
  const [minPosition, setMinPosition] = useState(600);

  // Use sample data for display (calculations would run on backend in production)
  const data = samplePortfolioData;

  // Scale results based on capital
  const scaleFactor = capital / 100000;
  const scaledFinalValue = data.summary.finalValue * scaleFactor;
  const scaledTotalReturn = data.summary.totalReturn;
  const scaledDividends = data.summary.totalDividends * scaleFactor;

  const formatCurrency = (value: number) =>
    `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">Backtest Configuration</h1>
        <span className="text-sm text-gray-500">All calculations run locally - no server costs</span>
      </div>

      {/* Configuration Panel */}
      <div className="card">
        <h3 className="card-header">Parameters</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Initial Capital ($)
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
              Max Weight (%)
            </label>
            <input
              type="number"
              value={maxWeight}
              onChange={(e) => setMaxWeight(Number(e.target.value))}
              className="input-field"
              min={10}
              max={100}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Lookback Period (weeks)
            </label>
            <input
              type="number"
              value={lookbackWeeks}
              onChange={(e) => setLookbackWeeks(Number(e.target.value))}
              className="input-field"
              min={26}
              max={260}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Min Position ($)
            </label>
            <input
              type="number"
              value={minPosition}
              onChange={(e) => setMinPosition(Number(e.target.value))}
              className="input-field"
              min={0}
              step={100}
            />
            <p className="text-xs text-gray-500 mt-1">$600 = no transaction costs</p>
          </div>
        </div>

        <div className="mt-6 flex gap-4">
          <button className="btn-primary">
            Run Backtest
          </button>
          <button className="btn-secondary">
            Reset to Defaults
          </button>
        </div>

        <p className="mt-4 text-sm text-gray-500">
          Note: Full backtest requires Python backend. Current view shows sample data scaled to your capital.
        </p>
      </div>

      {/* Results Summary */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="card">
          <div className="stat-label">Final Value</div>
          <div className="stat-value">{formatCurrency(scaledFinalValue)}</div>
          <div className="text-sm text-gray-500">from {formatCurrency(capital)}</div>
        </div>
        <div className="card">
          <div className="stat-label">Total Return</div>
          <div className={`stat-value ${scaledTotalReturn >= 0 ? 'positive' : 'negative'}`}>
            {scaledTotalReturn >= 0 ? '+' : ''}{(scaledTotalReturn * 100).toFixed(2)}%
          </div>
          <div className="text-sm text-gray-500">2-week period</div>
        </div>
        <div className="card">
          <div className="stat-label">Price Return</div>
          <div className="stat-value positive">+{(data.summary.priceReturn * 100).toFixed(2)}%</div>
          <div className="text-sm text-gray-500">{formatCurrency(data.summary.priceReturn * capital)}</div>
        </div>
        <div className="card">
          <div className="stat-label">Dividend Income</div>
          <div className="stat-value">{formatCurrency(scaledDividends)}</div>
          <div className="text-sm text-gray-500">{(data.summary.dividendReturn * 100).toFixed(2)}% yield</div>
        </div>
      </div>

      {/* Equity Curve */}
      <div className="card">
        <h3 className="card-header">Equity Curve Comparison</h3>
        <ResponsiveContainer width="100%" height={400}>
          <LineChart data={data.portfolioValueHistory.map(d => ({
            ...d,
            tangency: d.tangency * scaleFactor,
            equalWeight: d.equalWeight * scaleFactor,
            dji: d.dji * scaleFactor,
          }))}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="date" />
            <YAxis
              domain={[(capital * 0.98), (capital * 1.06)]}
              tickFormatter={(v) => `$${(v/1000).toFixed(0)}k`}
            />
            <Tooltip formatter={(value: number) => formatCurrency(value)} />
            <Legend />
            <Line type="monotone" dataKey="tangency" name="Tangency Portfolio" stroke="#3B82F6" strokeWidth={2} dot={{ fill: '#3B82F6' }} />
            <Line type="monotone" dataKey="equalWeight" name="Equal Weight" stroke="#10B981" strokeWidth={2} dot={{ fill: '#10B981' }} />
            <Line type="monotone" dataKey="dji" name="Dow Jones" stroke="#F59E0B" strokeWidth={2} dot={{ fill: '#F59E0B' }} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Weight Evolution */}
      <div className="card">
        <h3 className="card-header">Weight Evolution Over Time</h3>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={data.weightHistory}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="date" />
            <YAxis tickFormatter={(v) => `${v}%`} />
            <Tooltip formatter={(value: number) => `${value.toFixed(2)}%`} />
            <Legend />
            <Bar dataKey="HD" stackId="a" fill="#3B82F6" />
            <Bar dataKey="AMGN" stackId="a" fill="#10B981" />
            <Bar dataKey="JNJ" stackId="a" fill="#F59E0B" />
            <Bar dataKey="KO" stackId="a" fill="#EF4444" />
            <Bar dataKey="UNH" stackId="a" fill="#8B5CF6" />
            <Bar dataKey="VZ" stackId="a" fill="#EC4899" />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Dogs of the Dow Universe */}
      <div className="card">
        <h3 className="card-header">Dogs of the Dow 2025 Universe</h3>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead>
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Ticker</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Company</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Sector</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Current Weight</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {DOGS_OF_DOW_2025.map((dog) => {
                const weights = data.weeks[2].weights as Record<string, number>;
                const weight = weights[dog.ticker] || 0;
                return (
                  <tr key={dog.ticker} className={weight > 0 ? 'bg-blue-50' : ''}>
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">{dog.ticker}</td>
                    <td className="px-4 py-3 text-sm text-gray-700">{dog.name}</td>
                    <td className="px-4 py-3 text-sm text-gray-500">{dog.sector}</td>
                    <td className="px-4 py-3 text-sm text-right font-medium">
                      {weight > 0 ? `${(weight * 100).toFixed(2)}%` : '-'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Methodology */}
      <div className="card bg-gray-50">
        <h3 className="card-header">Methodology</h3>
        <div className="prose prose-sm max-w-none">
          <ul className="list-disc list-inside space-y-2 text-sm text-gray-700">
            <li><strong>Optimization:</strong> Maximize Sharpe ratio using SLSQP algorithm</li>
            <li><strong>Covariance:</strong> Ledoit-Wolf shrinkage for stable estimates</li>
            <li><strong>Rebalancing:</strong> Weekly (Friday calculation, Monday execution at open)</li>
            <li><strong>Risk-Free Rate:</strong> 3-Month T-Bill (^IRX) - currently {(data.riskFreeRate * 100).toFixed(2)}%</li>
            <li><strong>Constraints:</strong> Long-only, max weight {maxWeight}%, min position ${minPosition}</li>
            <li><strong>Transaction Costs:</strong> $0 (with positions ≥ $600)</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
