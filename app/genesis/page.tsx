'use client';

import { useState, useMemo } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell, PieChart, Pie, Legend,
} from 'recharts';
import {
  genesisHoldings,
  benchmarks,
  calculatePortfolioMetrics,
  calculateSectorAllocation,
  weeklyPerformance,
  riskMetrics,
  calculateAlpha,
  portfolioSummary,
} from '@/lib/genesisData';

const SECTOR_COLORS: Record<string, string> = {
  'Semiconductors': '#3B82F6',
  'Nuclear': '#10B981',
  'Quantum': '#F59E0B',
  'Biotech': '#8B5CF6',
  'Materials': '#EF4444',
  'Defense': '#EC4899',
  'Cloud': '#06B6D4',
  'Industrial': '#84CC16',
  'Networking': '#F97316',
};

export default function GenesisPage() {
  const [activeTab, setActiveTab] = useState<'overview' | 'holdings' | 'performance' | 'risk'>('overview');

  const metrics = useMemo(() => calculatePortfolioMetrics(genesisHoldings), []);
  const sectorAllocation = useMemo(() => calculateSectorAllocation(genesisHoldings), []);

  // Current benchmark values (as of Jan 16, 2026)
  const spxReturn = ((benchmarks.spx.current - benchmarks.spx.inception) / benchmarks.spx.inception) * 100;
  const ndxReturn = ((benchmarks.ndx.current - benchmarks.ndx.inception) / benchmarks.ndx.inception) * 100;

  // Use priced portfolio return for alpha calculation
  const alphaVsSpx = calculateAlpha(portfolioSummary.pricedReturn, spxReturn, riskMetrics.beta);
  const alphaVsNdx = calculateAlpha(portfolioSummary.pricedReturn, ndxReturn, riskMetrics.beta);

  const formatCurrency = (value: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }).format(value);

  const formatPercent = (value: number, decimals: number = 2) =>
    `${value >= 0 ? '+' : ''}${value.toFixed(decimals)}%`;

  return (
    <div className="space-y-6 -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8 py-4 bg-[#0d0d0d] min-h-screen">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-3">
            <span className="text-3xl">🌱</span> Genesis Portfolio
          </h1>
          <p className="text-gray-400 text-sm mt-1">Inception: November 24, 2025 | As of: January 16, 2026</p>
        </div>
        <div className="text-right">
          <div className="text-gray-400 text-xs">Estimated Portfolio Value</div>
          <div className="text-2xl font-bold text-white">{formatCurrency(portfolioSummary.estimatedCurrent)}</div>
          <div className="flex items-center gap-2 justify-end">
            <span className={`text-sm font-mono ${portfolioSummary.estimatedTotalReturn >= 0 ? 'text-[#00D4AA]' : 'text-[#FF6B6B]'}`}>
              {formatPercent(portfolioSummary.estimatedTotalReturn)} est.
            </span>
            <span className="text-gray-500 text-xs">|</span>
            <span className={`text-sm font-mono ${portfolioSummary.pricedReturn >= 0 ? 'text-[#00D4AA]' : 'text-[#FF6B6B]'}`}>
              {formatPercent(portfolioSummary.pricedReturn)} priced
            </span>
          </div>
        </div>
      </div>

      {/* Key Metrics Row */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="bg-[#1a1a1a] rounded-xl p-4 border border-[#252525]">
          <div className="text-gray-400 text-xs uppercase tracking-wider">Initial Capital</div>
          <div className="text-white font-semibold text-lg">{formatCurrency(portfolioSummary.totalInitial)}</div>
        </div>
        <div className="bg-[#1a1a1a] rounded-xl p-4 border border-[#252525]">
          <div className="text-gray-400 text-xs uppercase tracking-wider">Holdings</div>
          <div className="text-white font-semibold text-lg">{portfolioSummary.totalCount}</div>
          <div className="text-gray-500 text-xs">{portfolioSummary.pricedCount} priced</div>
        </div>
        <div className="bg-[#1a1a1a] rounded-xl p-4 border border-[#252525]">
          <div className="text-gray-400 text-xs uppercase tracking-wider">vs S&P 500</div>
          <div className={`font-semibold text-lg ${(portfolioSummary.pricedReturn - spxReturn) >= 0 ? 'text-[#00D4AA]' : 'text-[#FF6B6B]'}`}>
            {formatPercent(portfolioSummary.pricedReturn - spxReturn)}
          </div>
          <div className="text-gray-500 text-xs">SPX: {formatPercent(spxReturn)}</div>
        </div>
        <div className="bg-[#1a1a1a] rounded-xl p-4 border border-[#252525]">
          <div className="text-gray-400 text-xs uppercase tracking-wider">vs NASDAQ-100</div>
          <div className={`font-semibold text-lg ${(portfolioSummary.pricedReturn - ndxReturn) >= 0 ? 'text-[#00D4AA]' : 'text-[#FF6B6B]'}`}>
            {formatPercent(portfolioSummary.pricedReturn - ndxReturn)}
          </div>
          <div className="text-gray-500 text-xs">NDX: {formatPercent(ndxReturn)}</div>
        </div>
        <div className="bg-[#1a1a1a] rounded-xl p-4 border border-[#252525]">
          <div className="text-gray-400 text-xs uppercase tracking-wider">Alpha (vs NDX)</div>
          <div className={`font-semibold text-lg ${alphaVsNdx.alpha >= 0 ? 'text-[#00D4AA]' : 'text-[#FF6B6B]'}`}>
            {formatPercent(alphaVsNdx.alpha)}
          </div>
          <div className="text-gray-500 text-xs">Beta-adjusted</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-[#333] pb-2 overflow-x-auto">
        {[
          { id: 'overview', label: 'Overview' },
          { id: 'holdings', label: 'Holdings' },
          { id: 'performance', label: 'Performance' },
          { id: 'risk', label: 'Risk Analysis' },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as typeof activeTab)}
            className={`px-4 py-2 rounded-t-lg text-sm font-medium transition-colors whitespace-nowrap ${
              activeTab === tab.id
                ? 'bg-[#1a1a1a] text-white border-t border-l border-r border-[#333]'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Overview Tab */}
      {activeTab === 'overview' && (
        <>
          {/* Executive Order Banner */}
          <div className="bg-gradient-to-r from-[#1a365d] to-[#2d3748] rounded-xl p-6 border border-[#2d4a6d]">
            <div className="flex items-start gap-4">
              <div className="text-3xl">🇺🇸</div>
              <div>
                <div className="flex items-center gap-3 mb-2">
                  <h2 className="text-lg font-bold text-white">Genesis Mission Executive Order</h2>
                  <span className="px-2 py-0.5 bg-[#FFB800]/20 text-[#FFB800] text-xs rounded-full">Nov 24, 2025</span>
                </div>
                <p className="text-gray-300 text-sm leading-relaxed">
                  Portfolio constructed to capture opportunities from the Genesis Mission Executive Order,
                  targeting AI-driven transformation across energy, biotechnology, advanced materials,
                  nuclear technology, quantum computing, and semiconductors.
                </p>
              </div>
            </div>
          </div>

          {/* Sector Allocation & Top Movers */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-[#1a1a1a] rounded-xl p-6 border border-[#252525]">
              <h3 className="text-white font-semibold mb-4">Sector Allocation</h3>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={sectorAllocation}
                      dataKey="percentage"
                      nameKey="sector"
                      cx="50%"
                      cy="50%"
                      outerRadius={80}
                      label={({ sector, percentage }) => `${sector}: ${percentage.toFixed(1)}%`}
                      labelLine={{ stroke: '#666' }}
                    >
                      {sectorAllocation.map((entry) => (
                        <Cell key={entry.sector} fill={SECTOR_COLORS[entry.sector] || '#666'} />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(value: number) => `${value.toFixed(1)}%`}
                      contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: '8px' }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="bg-[#1a1a1a] rounded-xl p-6 border border-[#252525]">
              <h3 className="text-white font-semibold mb-4">Top Movers</h3>
              <div className="space-y-2">
                <div className="text-gray-400 text-xs uppercase mb-2">Top Gainers</div>
                {metrics.topGainers.map((h) => (
                  <div key={h.ticker} className="flex items-center justify-between py-1.5 border-b border-[#252525]">
                    <div>
                      <span className="text-[#00D4AA] font-mono font-medium">{h.ticker}</span>
                      <span className="text-gray-500 text-xs ml-2">{h.theme}</span>
                    </div>
                    <span className="text-[#00D4AA] font-mono">{formatPercent(h.delta || 0)}</span>
                  </div>
                ))}
                <div className="text-gray-400 text-xs uppercase mb-2 mt-4">Laggards</div>
                {metrics.topLosers.filter(h => (h.delta || 0) < 10).slice(0, 3).map((h) => (
                  <div key={h.ticker} className="flex items-center justify-between py-1.5 border-b border-[#252525]">
                    <div>
                      <span className={`font-mono font-medium ${(h.delta || 0) < 0 ? 'text-[#FF6B6B]' : 'text-gray-300'}`}>{h.ticker}</span>
                      <span className="text-gray-500 text-xs ml-2">{h.theme}</span>
                    </div>
                    <span className={`font-mono ${(h.delta || 0) < 0 ? 'text-[#FF6B6B]' : 'text-gray-300'}`}>
                      {formatPercent(h.delta || 0)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Milestones */}
          <div className="bg-[#1a1a1a] rounded-xl p-6 border border-[#252525]">
            <h3 className="text-white font-semibold mb-4">Investment Milestones</h3>
            <div className="relative">
              <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-[#333]"></div>

              <div className="relative pl-10 pb-6">
                <div className="absolute left-2.5 w-3 h-3 rounded-full bg-[#00D4AA] border-2 border-[#1a1a1a]"></div>
                <div className="text-white font-medium">Portfolio Inception</div>
                <div className="text-gray-500 text-sm">November 24, 2025 - {formatCurrency(portfolioSummary.totalInitial)} deployed across {portfolioSummary.totalCount} positions</div>
              </div>

              <div className="relative pl-10 pb-6">
                <div className="absolute left-2.5 w-3 h-3 rounded-full bg-[#00D4AA] border-2 border-[#1a1a1a]"></div>
                <div className="text-white font-medium">8 Weeks Complete</div>
                <div className="text-gray-500 text-sm">January 16, 2026 - {formatPercent(portfolioSummary.pricedReturn)} return (priced), {formatPercent(portfolioSummary.estimatedTotalReturn)} est. total</div>
              </div>

              <div className="relative pl-10 pb-6">
                <div className="absolute left-2.5 w-3 h-3 rounded-full bg-[#FFB800] border-2 border-[#1a1a1a]"></div>
                <div className="text-white font-medium">Agency Implementation Plans Due</div>
                <div className="text-gray-500 text-sm">Q1 2026 (90 days from EO) - Watch for sector catalysts</div>
              </div>

              <div className="relative pl-10 pb-6">
                <div className="absolute left-2.5 w-3 h-3 rounded-full bg-[#333] border-2 border-[#1a1a1a]"></div>
                <div className="text-gray-400 font-medium">First Federal Funding Rounds</div>
                <div className="text-gray-500 text-sm">Q2-Q3 2026 - Expected major position appreciation</div>
              </div>

              <div className="relative pl-10 pb-6">
                <div className="absolute left-2.5 w-3 h-3 rounded-full bg-[#333] border-2 border-[#1a1a1a]"></div>
                <div className="text-gray-400 font-medium">12-Month Review</div>
                <div className="text-gray-500 text-sm">November 2026 - Rebalance and position sizing review</div>
              </div>

              <div className="relative pl-10">
                <div className="absolute left-2.5 w-3 h-3 rounded-full bg-[#333] border-2 border-[#1a1a1a]"></div>
                <div className="text-gray-400 font-medium">Target Exit Window</div>
                <div className="text-gray-500 text-sm">2028-2029 - 24-36 month investment horizon</div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Holdings Tab */}
      {activeTab === 'holdings' && (
        <div className="bg-[#1a1a1a] rounded-xl p-6 border border-[#252525]">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-white font-semibold">All Holdings ({metrics.holdingsCount})</h3>
            <div className="text-gray-500 text-xs">
              {metrics.pricedCount} with live prices | {metrics.unpricedCount} awaiting data
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#333]">
                  <th className="text-left text-gray-400 text-xs uppercase tracking-wider py-3 pr-3">Ticker</th>
                  <th className="text-left text-gray-400 text-xs uppercase tracking-wider py-3 pr-3">Sector</th>
                  <th className="text-left text-gray-400 text-xs uppercase tracking-wider py-3 pr-3">Theme</th>
                  <th className="text-right text-gray-400 text-xs uppercase tracking-wider py-3 pr-3">Shares</th>
                  <th className="text-right text-gray-400 text-xs uppercase tracking-wider py-3 pr-3">Entry</th>
                  <th className="text-right text-gray-400 text-xs uppercase tracking-wider py-3 pr-3">Current</th>
                  <th className="text-right text-gray-400 text-xs uppercase tracking-wider py-3 pr-3">Cost</th>
                  <th className="text-right text-gray-400 text-xs uppercase tracking-wider py-3 pr-3">Value</th>
                  <th className="text-right text-gray-400 text-xs uppercase tracking-wider py-3">Return</th>
                </tr>
              </thead>
              <tbody>
                {genesisHoldings.map((h, idx) => (
                  <tr key={h.ticker} className={idx !== genesisHoldings.length - 1 ? 'border-b border-[#252525]' : ''}>
                    <td className="py-2 pr-3">
                      <span className="text-[#00D4AA] font-mono font-medium">{h.ticker}</span>
                    </td>
                    <td className="py-2 pr-3">
                      <span
                        className="px-2 py-0.5 text-xs rounded"
                        style={{ backgroundColor: `${SECTOR_COLORS[h.sector]}20`, color: SECTOR_COLORS[h.sector] }}
                      >
                        {h.sector}
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-gray-400 text-xs">{h.theme}</td>
                    <td className="py-2 pr-3 text-right text-white font-mono">{h.shares.toLocaleString()}</td>
                    <td className="py-2 pr-3 text-right text-gray-400 font-mono">${h.entryPrice.toFixed(2)}</td>
                    <td className="py-2 pr-3 text-right font-mono">
                      {h.currentPrice ? (
                        <span className="text-white">${h.currentPrice.toFixed(2)}</span>
                      ) : (
                        <span className="text-gray-600">--</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right text-gray-400 font-mono">{formatCurrency(h.initialInvestment)}</td>
                    <td className="py-2 pr-3 text-right font-mono">
                      {h.currentInvestment ? (
                        <span className="text-white">{formatCurrency(h.currentInvestment)}</span>
                      ) : (
                        <span className="text-gray-600">--</span>
                      )}
                    </td>
                    <td className="py-2 text-right font-mono">
                      {h.delta !== null ? (
                        <span className={h.delta >= 0 ? 'text-[#00D4AA]' : 'text-[#FF6B6B]'}>
                          {formatPercent(h.delta)}
                        </span>
                      ) : (
                        <span className="text-gray-600">--</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 pt-4 border-t border-[#333] flex flex-wrap items-center justify-between gap-2">
            <div className="text-gray-500 text-xs">
              Entry Date: November 24, 2025 | Equal-weight ~$1,500/position
            </div>
            <div className="text-gray-400 text-sm flex gap-4">
              <span>Cost: <span className="text-white font-mono">{formatCurrency(portfolioSummary.totalInitial)}</span></span>
              <span>Value: <span className="text-[#00D4AA] font-mono">{formatCurrency(portfolioSummary.estimatedCurrent)}</span></span>
              <span>P&L: <span className="text-[#00D4AA] font-mono">{formatCurrency(portfolioSummary.estimatedCurrent - portfolioSummary.totalInitial)}</span></span>
            </div>
          </div>
        </div>
      )}

      {/* Performance Tab */}
      {activeTab === 'performance' && (
        <>
          <div className="bg-[#1a1a1a] rounded-xl p-6 border border-[#252525]">
            <h3 className="text-white font-semibold mb-4">Weekly Performance vs Benchmarks</h3>
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={weeklyPerformance} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="genesisGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#00D4AA" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="#00D4AA" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                  <XAxis dataKey="week" stroke="#666" tick={{ fill: '#999', fontSize: 12 }} />
                  <YAxis stroke="#666" tick={{ fill: '#999', fontSize: 12 }} tickFormatter={(v) => `${v}%`} />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: '8px' }}
                    formatter={(value: number, name: string) => [`${value.toFixed(1)}%`, name === 'genesis' ? 'Genesis' : name.toUpperCase()]}
                    labelStyle={{ color: '#fff' }}
                  />
                  <Area type="monotone" dataKey="genesis" stroke="#00D4AA" fill="url(#genesisGradient)" strokeWidth={2} name="genesis" />
                  <Area type="monotone" dataKey="ndx" stroke="#FFB800" fill="transparent" strokeWidth={1.5} strokeDasharray="5 5" name="ndx" />
                  <Area type="monotone" dataKey="spx" stroke="#888" fill="transparent" strokeWidth={1.5} strokeDasharray="3 3" name="spx" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div className="flex justify-center gap-6 mt-4">
              <div className="flex items-center gap-2">
                <div className="w-4 h-0.5 bg-[#00D4AA]"></div>
                <span className="text-gray-400 text-sm">Genesis</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-4 h-0.5 bg-[#FFB800]" style={{ borderTop: '2px dashed #FFB800' }}></div>
                <span className="text-gray-400 text-sm">NASDAQ-100</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-4 h-0.5 bg-[#888]" style={{ borderTop: '2px dashed #888' }}></div>
                <span className="text-gray-400 text-sm">S&P 500</span>
              </div>
            </div>
          </div>

          {/* Alpha Analysis */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-[#1a1a1a] rounded-xl p-6 border border-[#252525]">
              <h3 className="text-white font-semibold mb-4">Alpha Calculation (Seeking Alpha Style)</h3>
              <div className="space-y-4">
                <div className="bg-[#252525] rounded-lg p-4">
                  <div className="text-gray-400 text-xs mb-2">Formula</div>
                  <div className="text-white font-mono text-sm">
                    Alpha = R<sub>p</sub> - [R<sub>f</sub> + Beta x (R<sub>m</sub> - R<sub>f</sub>)]
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <div className="text-gray-400 text-xs">Portfolio Return (R<sub>p</sub>)</div>
                    <div className="text-[#00D4AA] font-mono text-lg">{formatPercent(portfolioSummary.pricedReturn)}</div>
                    <div className="text-gray-500 text-xs">Priced holdings only</div>
                  </div>
                  <div>
                    <div className="text-gray-400 text-xs">Portfolio Beta</div>
                    <div className="text-white font-mono text-lg">{riskMetrics.beta.toFixed(2)}</div>
                  </div>
                  <div>
                    <div className="text-gray-400 text-xs">NDX Return (R<sub>m</sub>)</div>
                    <div className="text-[#FFB800] font-mono text-lg">{formatPercent(ndxReturn)}</div>
                  </div>
                  <div>
                    <div className="text-gray-400 text-xs">Risk-Free Rate (8wk)</div>
                    <div className="text-gray-300 font-mono text-lg">+0.65%</div>
                  </div>
                </div>
                <div className="border-t border-[#333] pt-4">
                  <div className="text-gray-400 text-xs">Expected Return (CAPM)</div>
                  <div className="text-gray-300 font-mono">{formatPercent(alphaVsNdx.expectedReturn)}</div>
                  <div className="text-gray-400 text-xs mt-2">Alpha (Excess over CAPM)</div>
                  <div className={`font-mono text-xl ${alphaVsNdx.alpha >= 0 ? 'text-[#00D4AA]' : 'text-[#FF6B6B]'}`}>
                    {formatPercent(alphaVsNdx.alpha)}
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-[#1a1a1a] rounded-xl p-6 border border-[#252525]">
              <h3 className="text-white font-semibold mb-4">Weekly Returns Breakdown</h3>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={weeklyPerformance.slice(1).map((w, i) => ({
                    week: w.week,
                    return: i === 0 ? w.genesis : w.genesis - weeklyPerformance[i].genesis,
                  }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                    <XAxis dataKey="week" stroke="#666" tick={{ fill: '#999', fontSize: 10 }} />
                    <YAxis stroke="#666" tick={{ fill: '#999', fontSize: 10 }} tickFormatter={(v) => `${v}%`} />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: '8px' }}
                      formatter={(value: number) => [`${value.toFixed(1)}%`, 'Weekly Return']}
                    />
                    <Bar dataKey="return">
                      {weeklyPerformance.slice(1).map((_, i) => {
                        const ret = i === 0
                          ? weeklyPerformance[1].genesis
                          : weeklyPerformance[i + 1].genesis - weeklyPerformance[i].genesis;
                        return <Cell key={i} fill={ret >= 0 ? '#00D4AA' : '#FF6B6B'} />;
                      })}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                <div>
                  <div className="text-gray-400 text-xs">Best Week</div>
                  <div className="text-[#00D4AA] font-mono">+4.7%</div>
                </div>
                <div>
                  <div className="text-gray-400 text-xs">Worst Week</div>
                  <div className="text-[#FF6B6B] font-mono">-1.4%</div>
                </div>
                <div>
                  <div className="text-gray-400 text-xs">Win Rate</div>
                  <div className="text-white font-mono">7/8</div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Risk Analysis Tab */}
      {activeTab === 'risk' && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Risk Metrics */}
            <div className="bg-[#1a1a1a] rounded-xl p-6 border border-[#252525]">
              <h3 className="text-white font-semibold mb-4">Risk Metrics</h3>
              <div className="space-y-4">
                <div className="flex justify-between items-center py-2 border-b border-[#252525]">
                  <div>
                    <div className="text-white">Beta (vs NDX)</div>
                    <div className="text-gray-500 text-xs">Systematic risk exposure</div>
                  </div>
                  <div className="text-[#FFB800] font-mono text-lg">{riskMetrics.beta.toFixed(2)}</div>
                </div>
                <div className="flex justify-between items-center py-2 border-b border-[#252525]">
                  <div>
                    <div className="text-white">Volatility (Ann.)</div>
                    <div className="text-gray-500 text-xs">Standard deviation of returns</div>
                  </div>
                  <div className="text-[#FF6B6B] font-mono text-lg">{riskMetrics.volatility.toFixed(1)}%</div>
                </div>
                <div className="flex justify-between items-center py-2 border-b border-[#252525]">
                  <div>
                    <div className="text-white">Sharpe Ratio</div>
                    <div className="text-gray-500 text-xs">Risk-adjusted return</div>
                  </div>
                  <div className="text-[#00D4AA] font-mono text-lg">{riskMetrics.sharpeRatio.toFixed(2)}</div>
                </div>
                <div className="flex justify-between items-center py-2 border-b border-[#252525]">
                  <div>
                    <div className="text-white">Max Drawdown</div>
                    <div className="text-gray-500 text-xs">Largest peak-to-trough decline</div>
                  </div>
                  <div className="text-[#FF6B6B] font-mono text-lg">{riskMetrics.maxDrawdown.toFixed(1)}%</div>
                </div>
                <div className="flex justify-between items-center py-2">
                  <div>
                    <div className="text-white">VaR (95%, Weekly)</div>
                    <div className="text-gray-500 text-xs">Potential weekly loss at 95% confidence</div>
                  </div>
                  <div className="text-[#FF6B6B] font-mono text-lg">{riskMetrics.var95.toFixed(1)}%</div>
                </div>
              </div>
            </div>

            {/* Opportunity/Risk Matrix */}
            <div className="bg-[#1a1a1a] rounded-xl p-6 border border-[#252525]">
              <h3 className="text-white font-semibold mb-4">Opportunity / Risk Analysis</h3>
              <div className="space-y-4">
                <div className="bg-[#00D4AA]/10 rounded-lg p-4 border border-[#00D4AA]/30">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-[#00D4AA]">▲</span>
                    <span className="text-[#00D4AA] font-medium">Opportunities</span>
                  </div>
                  <ul className="text-gray-300 text-sm space-y-1">
                    <li>• Uranium/Nuclear: +50% avg return, policy tailwinds</li>
                    <li>• Semiconductor equipment: LRCX +48%, MU +62%</li>
                    <li>• Q1 2026 agency plans as near-term catalyst</li>
                    <li>• High beta amplifies market rallies</li>
                  </ul>
                </div>
                <div className="bg-[#FF6B6B]/10 rounded-lg p-4 border border-[#FF6B6B]/30">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-[#FF6B6B]">▼</span>
                    <span className="text-[#FF6B6B] font-medium">Risks</span>
                  </div>
                  <ul className="text-gray-300 text-sm space-y-1">
                    <li>• High volatility (42.5% annualized)</li>
                    <li>• Concentrated sector exposure</li>
                    <li>• Policy execution risk on EO implementation</li>
                    <li>• 39 holdings without live pricing data</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>

          {/* Correlation & Sector Risk */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-[#1a1a1a] rounded-xl p-6 border border-[#252525]">
              <h3 className="text-white font-semibold mb-4">Benchmark Correlation</h3>
              <div className="space-y-4">
                <div>
                  <div className="flex justify-between mb-1">
                    <span className="text-gray-400 text-sm">S&P 500</span>
                    <span className="text-white font-mono">{riskMetrics.correlation.spx.toFixed(2)}</span>
                  </div>
                  <div className="h-2 bg-[#252525] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-[#888] to-[#888]"
                      style={{ width: `${riskMetrics.correlation.spx * 100}%` }}
                    />
                  </div>
                </div>
                <div>
                  <div className="flex justify-between mb-1">
                    <span className="text-gray-400 text-sm">NASDAQ-100</span>
                    <span className="text-white font-mono">{riskMetrics.correlation.ndx.toFixed(2)}</span>
                  </div>
                  <div className="h-2 bg-[#252525] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-[#FFB800] to-[#FFB800]"
                      style={{ width: `${riskMetrics.correlation.ndx * 100}%` }}
                    />
                  </div>
                </div>
              </div>
              <div className="mt-4 text-gray-500 text-xs">
                Higher correlation with NDX reflects tech-heavy composition
              </div>
            </div>

            <div className="bg-[#1a1a1a] rounded-xl p-6 border border-[#252525]">
              <h3 className="text-white font-semibold mb-4">Sector Concentration Risk</h3>
              <div className="space-y-2">
                {sectorAllocation.slice(0, 5).map((s) => (
                  <div key={s.sector}>
                    <div className="flex justify-between mb-1">
                      <span className="text-gray-400 text-sm">{s.sector}</span>
                      <span className="text-white font-mono">{s.percentage.toFixed(1)}%</span>
                    </div>
                    <div className="h-2 bg-[#252525] rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${(s.percentage / sectorAllocation[0].percentage) * 100}%`,
                          backgroundColor: SECTOR_COLORS[s.sector]
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-4 text-gray-500 text-xs">
                Top 5 sectors represent {sectorAllocation.slice(0, 5).reduce((sum, s) => sum + s.percentage, 0).toFixed(1)}% of portfolio
              </div>
            </div>
          </div>

          {/* Risk Warning */}
          <div className="bg-[#FF6B6B]/10 rounded-xl p-4 border border-[#FF6B6B]/30">
            <div className="flex items-start gap-3">
              <div className="text-[#FF6B6B] text-lg">⚠️</div>
              <div>
                <div className="text-[#FF6B6B] font-medium text-sm">High Risk Portfolio</div>
                <div className="text-gray-400 text-xs mt-1">
                  Genesis is a speculative, thematic portfolio with concentrated sector exposure and high beta.
                  The 1.85 beta means the portfolio is expected to move ~85% more than the market in either direction.
                  Position sizing should reflect individual risk tolerance. This is not investment advice.
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
