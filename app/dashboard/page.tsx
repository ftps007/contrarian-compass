'use client';

import { useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  PieChart, Pie, Cell, LineChart, Line, AreaChart, Area
} from 'recharts';
import { samplePortfolioData, sectorAllocation } from '@/lib/sampleData';

const COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#06B6D4'];

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatCurrency(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState<'overview' | 'positions' | 'trades'>('overview');
  const data = samplePortfolioData;

  return (
    <div className="space-y-6">
      {/* Header Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="card">
          <div className="stat-label">Portfolio Value</div>
          <div className="stat-value">{formatCurrency(data.summary.finalValue)}</div>
          <div className={`text-sm ${data.summary.totalReturn >= 0 ? 'positive' : 'negative'}`}>
            {data.summary.totalReturn >= 0 ? '+' : ''}{formatPercent(data.summary.totalReturn)} total return
          </div>
        </div>
        <div className="card">
          <div className="stat-label">Weekly Sharpe Ratio</div>
          <div className="stat-value">{data.metrics.tangency.sharpeRatio.toFixed(3)}</div>
          <div className="text-sm text-gray-500">
            vs {data.metrics.equalWeight.sharpeRatio.toFixed(3)} equal-weight
          </div>
        </div>
        <div className="card">
          <div className="stat-label">Weekly Alpha</div>
          <div className={`stat-value ${data.metrics.tangency.alpha >= 0 ? 'positive' : 'negative'}`}>
            {data.metrics.tangency.alpha >= 0 ? '+' : ''}{formatPercent(data.metrics.tangency.alpha)}
          </div>
          <div className="text-sm text-gray-500">vs CAPM expectation</div>
        </div>
        <div className="card">
          <div className="stat-label">Dividend Income</div>
          <div className="stat-value">{formatCurrency(data.summary.totalDividends)}</div>
          <div className="text-sm text-gray-500">{formatPercent(data.summary.dividendReturn)} yield</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <nav className="flex space-x-8">
          {['overview', 'positions', 'trades'].map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab as typeof activeTab)}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${
                activeTab === tab
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </nav>
      </div>

      {activeTab === 'overview' && (
        <div className="space-y-6">
          {/* Charts Row 1 */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Portfolio Value Chart */}
            <div className="card">
              <h3 className="card-header">Portfolio Value Progression</h3>
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={data.portfolioValueHistory}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis domain={[99000, 105000]} tickFormatter={(v) => `$${(v/1000).toFixed(0)}k`} />
                  <Tooltip formatter={(value: number) => formatCurrency(value)} />
                  <Legend />
                  <Area type="monotone" dataKey="tangency" name="Tangency" stroke="#3B82F6" fill="#3B82F6" fillOpacity={0.3} />
                  <Area type="monotone" dataKey="equalWeight" name="Equal Weight" stroke="#10B981" fill="#10B981" fillOpacity={0.3} />
                  <Area type="monotone" dataKey="dji" name="DJI" stroke="#F59E0B" fill="#F59E0B" fillOpacity={0.3} />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            {/* Weekly Returns Comparison */}
            <div className="card">
              <h3 className="card-header">Weekly Returns Comparison</h3>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={data.returnComparison}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" />
                  <YAxis tickFormatter={(v) => `${v}%`} />
                  <Tooltip formatter={(value: number) => `${value.toFixed(2)}%`} />
                  <Legend />
                  <Bar dataKey="tangency" name="Tangency" fill="#3B82F6" />
                  <Bar dataKey="equalWeight" name="Equal Weight" fill="#10B981" />
                  <Bar dataKey="dji" name="DJI" fill="#F59E0B" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Charts Row 2 */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Weight Allocation Pie */}
            <div className="card">
              <h3 className="card-header">Current Allocation (Jan 16)</h3>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={Object.entries(data.weeks[2].weights)
                      .filter(([_, v]) => v > 0)
                      .map(([ticker, weight]) => ({ name: ticker, value: weight * 100 }))}
                    cx="50%"
                    cy="50%"
                    labelLine={false}
                    label={({ name, value }) => `${name}: ${value.toFixed(1)}%`}
                    outerRadius={100}
                    dataKey="value"
                  >
                    {Object.entries(data.weeks[2].weights)
                      .filter(([_, v]) => v > 0)
                      .map((_, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                  </Pie>
                  <Tooltip formatter={(value: number) => `${value.toFixed(2)}%`} />
                </PieChart>
              </ResponsiveContainer>
            </div>

            {/* Sector Allocation */}
            <div className="card">
              <h3 className="card-header">Sector Allocation</h3>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={sectorAllocation}
                    cx="50%"
                    cy="50%"
                    labelLine={false}
                    label={({ name, value }) => `${name}: ${value.toFixed(1)}%`}
                    outerRadius={100}
                    dataKey="value"
                  >
                    {sectorAllocation.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value: number) => `${value.toFixed(2)}%`} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Performance Metrics Table */}
          <div className="card">
            <h3 className="card-header">Performance Metrics (Weekly)</h3>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead>
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Metric</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Tangency</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Equal-Weight</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">DJI</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  <tr>
                    <td className="px-4 py-3 text-sm text-gray-900">Total Return (2 weeks)</td>
                    <td className="px-4 py-3 text-sm text-right font-medium positive">{formatPercent(data.metrics.tangency.totalReturn)}</td>
                    <td className="px-4 py-3 text-sm text-right">{formatPercent(data.metrics.equalWeight.totalReturn)}</td>
                    <td className="px-4 py-3 text-sm text-right">{formatPercent(data.metrics.dji.totalReturn)}</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 text-sm text-gray-900">Mean Weekly Return</td>
                    <td className="px-4 py-3 text-sm text-right font-medium">{formatPercent(data.metrics.tangency.meanWeeklyReturn)}</td>
                    <td className="px-4 py-3 text-sm text-right">{formatPercent(data.metrics.equalWeight.meanWeeklyReturn)}</td>
                    <td className="px-4 py-3 text-sm text-right">{formatPercent(data.metrics.dji.meanWeeklyReturn)}</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 text-sm text-gray-900">Weekly Volatility</td>
                    <td className="px-4 py-3 text-sm text-right font-medium">{formatPercent(data.metrics.tangency.weeklyVolatility)}</td>
                    <td className="px-4 py-3 text-sm text-right">{formatPercent(data.metrics.equalWeight.weeklyVolatility)}</td>
                    <td className="px-4 py-3 text-sm text-right">{formatPercent(data.metrics.dji.weeklyVolatility)}</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 text-sm text-gray-900">Sharpe Ratio (Weekly)</td>
                    <td className="px-4 py-3 text-sm text-right font-medium">{data.metrics.tangency.sharpeRatio.toFixed(3)}</td>
                    <td className="px-4 py-3 text-sm text-right">{data.metrics.equalWeight.sharpeRatio.toFixed(3)}</td>
                    <td className="px-4 py-3 text-sm text-right">{data.metrics.dji.sharpeRatio.toFixed(3)}</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 text-sm text-gray-900">Beta (vs DJI)</td>
                    <td className="px-4 py-3 text-sm text-right font-medium">{data.metrics.tangency.beta.toFixed(3)}</td>
                    <td className="px-4 py-3 text-sm text-right">{data.metrics.equalWeight.beta.toFixed(3)}</td>
                    <td className="px-4 py-3 text-sm text-right">1.000</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 text-sm text-gray-900">Alpha (Weekly)</td>
                    <td className="px-4 py-3 text-sm text-right font-medium positive">{formatPercent(data.metrics.tangency.alpha)}</td>
                    <td className="px-4 py-3 text-sm text-right">{formatPercent(data.metrics.equalWeight.alpha)}</td>
                    <td className="px-4 py-3 text-sm text-right">0.00%</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'positions' && (
        <div className="card">
          <h3 className="card-header">Current Positions (Jan 16, 2026)</h3>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead>
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Ticker</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Shares</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Price</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Market Value</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Weight</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Cost Basis</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Gain/Loss</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {data.weeks[2].positions.map((pos) => {
                  const marketValue = pos.shares * pos.endPrice;
                  const gainLoss = marketValue - pos.costBasis;
                  const weights = data.weeks[2].weights as Record<string, number>;
                  const weight = weights[pos.ticker] || 0;
                  return (
                    <tr key={pos.ticker}>
                      <td className="px-4 py-3 text-sm font-medium text-gray-900">{pos.ticker}</td>
                      <td className="px-4 py-3 text-sm text-right">{pos.shares}</td>
                      <td className="px-4 py-3 text-sm text-right">{formatCurrency(pos.endPrice)}</td>
                      <td className="px-4 py-3 text-sm text-right">{formatCurrency(marketValue)}</td>
                      <td className="px-4 py-3 text-sm text-right">{(weight * 100).toFixed(2)}%</td>
                      <td className="px-4 py-3 text-sm text-right">{formatCurrency(pos.costBasis)}</td>
                      <td className={`px-4 py-3 text-sm text-right font-medium ${gainLoss >= 0 ? 'positive' : 'negative'}`}>
                        {gainLoss >= 0 ? '+' : ''}{formatCurrency(gainLoss)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="bg-gray-50">
                  <td className="px-4 py-3 text-sm font-medium text-gray-900">Total</td>
                  <td className="px-4 py-3 text-sm text-right"></td>
                  <td className="px-4 py-3 text-sm text-right"></td>
                  <td className="px-4 py-3 text-sm text-right font-medium">{formatCurrency(data.weeks[2].portfolioValue.stockValue)}</td>
                  <td className="px-4 py-3 text-sm text-right"></td>
                  <td className="px-4 py-3 text-sm text-right"></td>
                  <td className="px-4 py-3 text-sm text-right font-medium positive">
                    +{formatCurrency(data.weeks[2].portfolioValue.end - data.initialCapital)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'trades' && (
        <div className="space-y-6">
          {data.weeks.map((week, idx) => (
            <div key={idx} className="card">
              <h3 className="card-header">{week.label}: {week.calcDate} → {week.execDate}</h3>
              {week.trades && week.trades.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead>
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Action</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Ticker</th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Shares</th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Price</th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Value</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {week.trades.map((trade, tidx) => (
                        <tr key={tidx}>
                          <td className={`px-4 py-3 text-sm font-medium ${trade.action === 'BUY' ? 'text-green-600' : 'text-red-600'}`}>
                            {trade.action}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-900">{trade.ticker}</td>
                          <td className="px-4 py-3 text-sm text-right">{trade.shares}</td>
                          <td className="px-4 py-3 text-sm text-right">{formatCurrency(trade.price)}</td>
                          <td className="px-4 py-3 text-sm text-right">{formatCurrency(trade.value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-gray-500">Initial investment - all buy orders</p>
              )}

              {week.dividends && week.dividends.length > 0 && (
                <div className="mt-4 p-4 bg-green-50 rounded-lg">
                  <h4 className="text-sm font-medium text-green-800 mb-2">Dividends Received</h4>
                  {week.dividends.map((div, didx) => (
                    <p key={didx} className="text-sm text-green-700">
                      {div.date}: {div.ticker} - {div.shares} shares × ${div.perShare.toFixed(4)} = {formatCurrency(div.amount)}
                    </p>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Risk-Free Rate Info */}
      <div className="card bg-gray-50">
        <h3 className="card-header">Parameters</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <span className="text-gray-500">Risk-Free Rate:</span>
            <span className="ml-2 font-medium">{(data.riskFreeRate * 100).toFixed(4)}%</span>
            <span className="text-xs text-gray-400 ml-1">(3M T-Bill)</span>
          </div>
          <div>
            <span className="text-gray-500">Lookback:</span>
            <span className="ml-2 font-medium">{data.lookbackWeeks} weeks</span>
          </div>
          <div>
            <span className="text-gray-500">Max Weight:</span>
            <span className="ml-2 font-medium">{data.maxWeight * 100}%</span>
          </div>
          <div>
            <span className="text-gray-500">Min Position:</span>
            <span className="ml-2 font-medium">{formatCurrency(data.minPosition)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
