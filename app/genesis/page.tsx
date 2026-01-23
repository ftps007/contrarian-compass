'use client';

import { useState, useMemo } from 'react';
import {
  AreaChart, Area, ComposedChart, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Bar, Cell, PieChart, Pie, ReferenceLine, LabelList,
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
  const [sortKey, setSortKey] = useState<string>('ticker');
  const [sortCycle, setSortCycle] = useState<number>(0); // 0=asc, 1=desc, 2=alpha

  const metrics = useMemo(() => calculatePortfolioMetrics(genesisHoldings), []);
  const sectorAllocation = useMemo(() => calculateSectorAllocation(genesisHoldings), []);

  const handleSort = (key: string) => {
    if (key === sortKey) {
      setSortCycle((sortCycle + 1) % 3);
    } else {
      setSortKey(key);
      setSortCycle(0);
    }
  };

  const sortedHoldings = useMemo(() => {
    const holdings = [...genesisHoldings];
    if (sortCycle === 2) {
      return holdings.sort((a, b) => a.ticker.localeCompare(b.ticker));
    }
    const dir = sortCycle === 0 ? 1 : -1;
    return holdings.sort((a, b) => {
      let va: number | string = 0, vb: number | string = 0;
      switch (sortKey) {
        case 'ticker': va = a.ticker; vb = b.ticker; return dir * (va as string).localeCompare(vb as string);
        case 'sector': va = a.sector; vb = b.sector; return dir * (va as string).localeCompare(vb as string);
        case 'theme': va = a.theme; vb = b.theme; return dir * (va as string).localeCompare(vb as string);
        case 'shares': va = a.shares; vb = b.shares; break;
        case 'entry': va = a.entryPrice; vb = b.entryPrice; break;
        case 'current': va = a.currentPrice || 0; vb = b.currentPrice || 0; break;
        case 'cost': va = a.initialInvestment; vb = b.initialInvestment; break;
        case 'value': va = a.currentInvestment || 0; vb = b.currentInvestment || 0; break;
        case 'return': va = a.delta || -999; vb = b.delta || -999; break;
      }
      return dir * ((va as number) - (vb as number));
    });
  }, [sortKey, sortCycle]);

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
      <div className="flex items-center justify-between mb-2">
        <div>
          <h1 className="text-xl font-bold text-white">Genesis Portfolio</h1>
          <p className="text-gray-500 text-xs">Inception: Nov 24, 2025</p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold text-white font-mono">{formatCurrency(portfolioSummary.estimatedCurrent)}</div>
          <div className="text-gray-500 text-xs mb-0.5">Portfolio (estimated)</div>
          <div className={`text-lg font-bold font-mono ${portfolioSummary.estimatedTotalReturn >= 0 ? 'text-[#00D4AA]' : 'text-[#FF6B6B]'}`}>
            {formatPercent(portfolioSummary.estimatedTotalReturn)}
            <span className="text-sm font-normal ml-1.5">({formatCurrency(portfolioSummary.estimatedCurrent - portfolioSummary.totalInitial)})</span>
          </div>
          <div className="text-gray-500 text-xs">seit Inception</div>
        </div>
      </div>

      {/* Key Metrics Row */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="bg-[#1a1a1a] rounded-2xl p-4 border border-[#252525]">
          <div className="text-gray-400 text-xs uppercase tracking-wider">Initial Capital</div>
          <div className="text-white font-semibold text-lg">{formatCurrency(portfolioSummary.totalInitial)}</div>
        </div>
        <div className="bg-[#1a1a1a] rounded-2xl p-4 border border-[#252525]">
          <div className="text-gray-400 text-xs uppercase tracking-wider">Holdings</div>
          <div className="text-white font-semibold text-lg">{portfolioSummary.totalCount}</div>
          <div className="text-gray-500 text-xs">{portfolioSummary.pricedCount} priced</div>
        </div>
        <div className="bg-[#1a1a1a] rounded-2xl p-4 border border-[#252525]">
          <div className="text-gray-400 text-xs uppercase tracking-wider">vs S&P 500</div>
          <div className={`font-semibold text-lg ${(portfolioSummary.pricedReturn - spxReturn) >= 0 ? 'text-[#00D4AA]' : 'text-[#FF6B6B]'}`}>
            {formatPercent(portfolioSummary.pricedReturn - spxReturn)}
          </div>
          <div className="text-gray-500 text-xs">SPX: {formatPercent(spxReturn)}</div>
        </div>
        <div className="bg-[#1a1a1a] rounded-2xl p-4 border border-[#252525]">
          <div className="text-gray-400 text-xs uppercase tracking-wider">vs NASDAQ-100</div>
          <div className={`font-semibold text-lg ${(portfolioSummary.pricedReturn - ndxReturn) >= 0 ? 'text-[#00D4AA]' : 'text-[#FF6B6B]'}`}>
            {formatPercent(portfolioSummary.pricedReturn - ndxReturn)}
          </div>
          <div className="text-gray-500 text-xs">NDX: {formatPercent(ndxReturn)}</div>
        </div>
        <div className="bg-[#1a1a1a] rounded-2xl p-4 border border-[#252525]">
          <div className="text-gray-400 text-xs uppercase tracking-wider">Alpha (vs NDX)</div>
          <div className={`font-semibold text-lg ${alphaVsNdx.alpha >= 0 ? 'text-[#00D4AA]' : 'text-[#FF6B6B]'}`}>
            {formatPercent(alphaVsNdx.alpha)}
          </div>
          <div className="text-gray-500 text-xs">Beta-adjusted</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1">
        {[
          { id: 'overview', label: 'Overview' },
          { id: 'holdings', label: 'Holdings' },
          { id: 'performance', label: 'Performance' },
          { id: 'risk', label: 'Risk Analysis' },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as typeof activeTab)}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
              activeTab === tab.id
                ? 'bg-[#252525] text-white'
                : 'text-gray-500 hover:text-gray-300 hover:bg-[#1a1a1a]'
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
          <div className="bg-gradient-to-r from-[#1a365d] to-[#2d3748] rounded-2xl p-6 border border-[#2d4a6d]">
            <div className="flex items-start gap-4">
              <div className="text-3xl">🇺🇸</div>
              <div>
                <div className="flex items-center gap-3 mb-2">
                  <a
                    href="https://www.whitehouse.gov/presidential-actions/2025/11/launching-the-genesis-mission/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-lg font-bold text-white hover:text-[#00D4AA] transition-colors"
                  >
                    Genesis Mission Executive Order &rarr;
                  </a>
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
            <div className="bg-[#1a1a1a] rounded-2xl p-6 border border-[#252525]">
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
                      contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: '8px', color: '#fff' }}
                      itemStyle={{ color: '#ccc' }}
                      labelStyle={{ color: '#fff', fontWeight: 600 }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="bg-[#1a1a1a] rounded-2xl p-6 border border-[#252525]">
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
          <div className="bg-[#1a1a1a] rounded-2xl p-6 border border-[#252525]">
            <h3 className="text-white font-semibold mb-4">EO Implementation Timeline</h3>
            <div className="relative">
              <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-[#333]"></div>

              <div className="relative pl-10 pb-6">
                <div className="absolute left-2.5 w-3 h-3 rounded-full bg-[#00D4AA] border-2 border-[#1a1a1a]"></div>
                <div className="text-white font-medium">Portfolio Inception & EO Signed</div>
                <div className="text-gray-500 text-sm">November 24, 2025 - {formatCurrency(portfolioSummary.totalInitial)} deployed across {portfolioSummary.totalCount} positions</div>
              </div>

              <div className="relative pl-10 pb-6">
                <div className="absolute left-2.5 w-3 h-3 rounded-full bg-[#00D4AA] border-2 border-[#1a1a1a] ring-2 ring-[#00D4AA]/40"></div>
                <div className="flex items-center gap-2">
                  <span className="text-white font-medium">60-Day: S&T Challenges Due</span>
                  <span className="px-1.5 py-0.5 bg-[#00D4AA]/20 text-[#00D4AA] text-[10px] rounded-full font-medium">TODAY</span>
                </div>
                <div className="text-gray-500 text-sm">January 23, 2026 - DOE must identify 20+ science & technology challenges across advanced manufacturing, biotech, critical materials, nuclear energy, quantum, and semiconductors</div>
              </div>

              <div className="relative pl-10 pb-6">
                <div className="absolute left-2.5 w-3 h-3 rounded-full bg-[#FFB800] border-2 border-[#1a1a1a]"></div>
                <div className="text-white font-medium">90-Day: Computing Resources Inventory</div>
                <div className="text-gray-500 text-sm">February 22, 2026 - DOE identifies federal computing, storage, networking resources (on-premises + cloud HPC) and industry partnerships to support the Genesis Platform</div>
              </div>

              <div className="relative pl-10 pb-6">
                <div className="absolute left-2.5 w-3 h-3 rounded-full bg-[#FFB800] border-2 border-[#1a1a1a]"></div>
                <div className="text-white font-medium">120-Day: Data & Model Assets Plan</div>
                <div className="text-gray-500 text-sm">March 24, 2026 - Initial data/model assets identified with digitization, standardization, and cybersecurity plan for incorporating datasets from federal research, academia, and private sector</div>
              </div>

              <div className="relative pl-10 pb-6">
                <div className="absolute left-2.5 w-3 h-3 rounded-full bg-[#333] border-2 border-[#1a1a1a]"></div>
                <div className="text-gray-400 font-medium">240-Day: Robotic Lab & AI Experimentation Review</div>
                <div className="text-gray-500 text-sm">July 22, 2026 - DOE reviews capabilities across national laboratories for robotic laboratories and AI-directed experimentation facilities</div>
              </div>

              <div className="relative pl-10 pb-6">
                <div className="absolute left-2.5 w-3 h-3 rounded-full bg-[#333] border-2 border-[#1a1a1a]"></div>
                <div className="text-gray-400 font-medium">270-Day: Initial Platform Operating Capability</div>
                <div className="text-gray-500 text-sm">August 21, 2026 - DOE must demonstrate initial operating capability of the Genesis Platform for at least one national S&T challenge. Key catalyst for sector appreciation</div>
              </div>

              <div className="relative pl-10 pb-6">
                <div className="absolute left-2.5 w-3 h-3 rounded-full bg-[#333] border-2 border-[#1a1a1a]"></div>
                <div className="text-gray-400 font-medium">12-Month Portfolio Review</div>
                <div className="text-gray-500 text-sm">November 2026 - Rebalance and position sizing based on EO implementation progress and sector performance</div>
              </div>

              <div className="relative pl-10">
                <div className="absolute left-2.5 w-3 h-3 rounded-full bg-[#333] border-2 border-[#1a1a1a]"></div>
                <div className="text-gray-400 font-medium">Target Exit Window</div>
                <div className="text-gray-500 text-sm">2028-2029 - Full platform operational capability expected; 24-36 month investment horizon</div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Holdings Tab */}
      {activeTab === 'holdings' && (
        <div className="bg-[#1a1a1a] rounded-2xl p-6 border border-[#252525]">
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
                  {[
                    { key: 'ticker', label: 'Ticker', align: 'left' },
                    { key: 'sector', label: 'Sector', align: 'left' },
                    { key: 'theme', label: 'Theme', align: 'left' },
                    { key: 'shares', label: 'Shares', align: 'right' },
                    { key: 'entry', label: 'Entry', align: 'right' },
                    { key: 'current', label: 'Current', align: 'right' },
                    { key: 'cost', label: 'Cost', align: 'right' },
                    { key: 'value', label: 'Value', align: 'right' },
                    { key: 'return', label: 'Return', align: 'right' },
                  ].map((col) => (
                    <th
                      key={col.key}
                      onClick={() => handleSort(col.key)}
                      className={`text-${col.align} text-gray-400 text-xs uppercase tracking-wider py-3 pr-3 cursor-pointer hover:text-white transition-colors select-none`}
                    >
                      {col.label}
                      {sortKey === col.key && (
                        <span className="ml-1 text-[#00D4AA]">
                          {sortCycle === 0 ? '↑' : sortCycle === 1 ? '↓' : 'A'}
                        </span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedHoldings.map((h, idx) => (
                  <tr key={h.ticker} className={idx !== sortedHoldings.length - 1 ? 'border-b border-[#252525]' : ''}>
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
          <div className="bg-[#1a1a1a] rounded-2xl border border-[#252525] overflow-hidden">
            {/* Weekly Returns Bar Chart */}
            <div className="px-6 py-5 border-b border-[#252525]">
              <div className="flex items-center justify-between mb-4">
                <span className="text-white text-sm font-medium">Weekly Returns</span>
                <span className="text-gray-500 text-xs">Hover for benchmark comparison</span>
              </div>
              <ResponsiveContainer width="100%" height={200}>
                <ComposedChart data={weeklyPerformance.slice(1).map((w, i) => ({
                  week: w.week,
                  ret: i === 0 ? w.genesis : w.genesis - weeklyPerformance[i].genesis,
                  ndx: i === 0 ? w.ndx : w.ndx - weeklyPerformance[i].ndx,
                  spx: i === 0 ? w.spx : w.spx - weeklyPerformance[i].spx,
                }))} barCategoryGap="25%">
                  <defs>
                    <linearGradient id="genBarGreen" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#00D4AA" stopOpacity={1} />
                      <stop offset="100%" stopColor="#00896e" stopOpacity={0.7} />
                    </linearGradient>
                    <linearGradient id="genBarRed" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#FF6B6B" stopOpacity={1} />
                      <stop offset="100%" stopColor="#cc4444" stopOpacity={0.7} />
                    </linearGradient>
                    <filter id="genGlow">
                      <feGaussianBlur stdDeviation="3" result="blur" />
                      <feMerge>
                        <feMergeNode in="blur" />
                        <feMergeNode in="SourceGraphic" />
                      </feMerge>
                    </filter>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1f1f1f" vertical={false} />
                  <XAxis dataKey="week" stroke="transparent" tick={{ fill: '#ccc', fontSize: 11, fontWeight: 500 }} tickLine={false} />
                  <YAxis stroke="transparent" tick={{ fill: '#555', fontSize: 10 }} tickLine={false} tickFormatter={(v: number) => `${v.toFixed(0)}%`} width={35} />
                  <Tooltip
                    cursor={{ fill: 'rgba(255,255,255,0.02)' }}
                    content={({ active, payload }) => {
                      if (active && payload && payload.length) {
                        const d = payload[0]?.payload;
                        return (
                          <div className="bg-[#111] border border-[#333] rounded-xl p-3.5 shadow-2xl">
                            <p className="text-white font-bold text-sm mb-2">{d.week}</p>
                            <div className="space-y-1">
                              <div className="flex items-center justify-between gap-4">
                                <span className="text-gray-400 text-xs">Genesis</span>
                                <span className={`font-mono text-sm font-bold ${d.ret >= 0 ? 'text-[#00D4AA]' : 'text-[#FF6B6B]'}`}>
                                  {d.ret >= 0 ? '+' : ''}{d.ret.toFixed(2)}%
                                </span>
                              </div>
                              <div className="flex items-center justify-between gap-4">
                                <span className="text-gray-400 text-xs">NDX</span>
                                <span className="font-mono text-sm text-[#FFB800]">
                                  {d.ndx >= 0 ? '+' : ''}{d.ndx.toFixed(2)}%
                                </span>
                              </div>
                              <div className="flex items-center justify-between gap-4">
                                <span className="text-gray-400 text-xs">SPX</span>
                                <span className="font-mono text-sm text-gray-400">
                                  {d.spx >= 0 ? '+' : ''}{d.spx.toFixed(2)}%
                                </span>
                              </div>
                              <div className="border-t border-[#333] pt-1 mt-1">
                                <div className="flex items-center justify-between gap-4">
                                  <span className="text-gray-400 text-xs">vs NDX</span>
                                  <span className={`font-mono text-sm font-bold ${(d.ret - d.ndx) >= 0 ? 'text-[#00D4AA]' : 'text-[#FF6B6B]'}`}>
                                    {(d.ret - d.ndx) >= 0 ? '+' : ''}{(d.ret - d.ndx).toFixed(2)}%
                                  </span>
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      }
                      return null;
                    }}
                  />
                  <ReferenceLine y={0} stroke="#333" />
                  <Bar dataKey="ret" radius={[6, 6, 0, 0]} maxBarSize={50}>
                    <LabelList
                      dataKey="ret"
                      position="top"
                      formatter={(v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`}
                      style={{ fill: '#aaa', fontSize: 10, fontWeight: 500, fontFamily: 'monospace' }}
                    />
                    {weeklyPerformance.slice(1).map((_, i) => {
                      const ret = i === 0
                        ? weeklyPerformance[1].genesis
                        : weeklyPerformance[i + 1].genesis - weeklyPerformance[i].genesis;
                      return (
                        <Cell
                          key={i}
                          fill={ret >= 0 ? 'url(#genBarGreen)' : 'url(#genBarRed)'}
                          style={i === weeklyPerformance.length - 2 ? { filter: 'url(#genGlow)' } : {}}
                        />
                      );
                    })}
                  </Bar>
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* Metrics Grid */}
            <div className="grid grid-cols-4 gap-0 divide-x divide-[#252525]">
              <div className="px-6 py-4 text-center">
                <div className="text-gray-500 text-xs uppercase tracking-wider mb-1">Alpha</div>
                <div className={`text-xl font-bold font-mono ${alphaVsNdx.alpha >= 0 ? 'text-[#00D4AA]' : 'text-[#FF6B6B]'}`}>
                  {formatPercent(alphaVsNdx.alpha)}
                </div>
                <div className="text-gray-600 text-xs">vs NDX (CAPM)</div>
              </div>
              <div className="px-6 py-4 text-center">
                <div className="text-gray-500 text-xs uppercase tracking-wider mb-1">Beta</div>
                <div className="text-xl font-bold text-white font-mono">{riskMetrics.beta.toFixed(2)}</div>
                <div className="text-gray-600 text-xs">High risk</div>
              </div>
              <div className="px-6 py-4 text-center">
                <div className="text-gray-500 text-xs uppercase tracking-wider mb-1">Sharpe</div>
                <div className="text-xl font-bold text-white font-mono">{riskMetrics.sharpeRatio.toFixed(2)}</div>
                <div className="text-gray-600 text-xs">Risk-adj.</div>
              </div>
              <div className="px-6 py-4 text-center">
                <div className="text-gray-500 text-xs uppercase tracking-wider mb-1">Win Rate</div>
                <div className="text-xl font-bold text-[#00D4AA] font-mono">7/8</div>
                <div className="text-gray-600 text-xs">87.5%</div>
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between px-6 py-3 bg-[#151515] text-xs text-gray-600">
              <span>Best: +3.4% | Worst: -1.7%</span>
              <span>CAPM Expected: {formatPercent(alphaVsNdx.expectedReturn)}</span>
            </div>
          </div>

          {/* Cumulative Performance */}
          <div className="bg-[#1a1a1a] rounded-2xl border border-[#252525] overflow-hidden mt-4">
            <div className="px-6 py-5">
              <div className="flex items-center justify-between mb-4">
                <span className="text-white text-sm font-medium">Cumulative Returns</span>
                <span className="text-gray-500 text-xs">Hover for details</span>
              </div>
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={weeklyPerformance} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="genesisGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#00D4AA" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#00D4AA" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1f1f1f" vertical={false} />
                  <XAxis dataKey="week" stroke="transparent" tick={{ fill: '#ccc', fontSize: 11, fontWeight: 500 }} tickLine={false} />
                  <YAxis stroke="transparent" tick={{ fill: '#555', fontSize: 10 }} tickLine={false} tickFormatter={(v) => `${v}%`} width={40} />
                  <Tooltip
                    content={({ active, payload, label }) => {
                      if (active && payload && payload.length) {
                        return (
                          <div className="bg-[#111] border border-[#333] rounded-xl p-3.5 shadow-2xl">
                            <p className="text-white font-bold text-sm mb-2">{label}</p>
                            <div className="space-y-1">
                              {payload.map((p: any) => (
                                <div key={p.name} className="flex items-center justify-between gap-4">
                                  <span className="text-gray-400 text-xs">{p.name === 'genesis' ? 'Genesis' : p.name.toUpperCase()}</span>
                                  <span className="font-mono text-sm" style={{ color: p.color }}>
                                    {p.value >= 0 ? '+' : ''}{Number(p.value).toFixed(1)}%
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      }
                      return null;
                    }}
                  />
                  <ReferenceLine y={0} stroke="#333" />
                  <Area type="monotone" dataKey="genesis" stroke="#00D4AA" fill="url(#genesisGradient)" strokeWidth={2.5} name="genesis" />
                  <Area type="monotone" dataKey="ndx" stroke="#FFB800" fill="transparent" strokeWidth={1.5} strokeDasharray="5 5" name="ndx" />
                  <Area type="monotone" dataKey="spx" stroke="#666" fill="transparent" strokeWidth={1.5} strokeDasharray="3 3" name="spx" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            {/* Legend footer */}
            <div className="flex items-center justify-center gap-6 px-6 py-3 bg-[#151515] text-xs text-gray-500">
              <div className="flex items-center gap-1.5">
                <div className="w-2.5 h-2.5 rounded-full bg-[#00D4AA]" />
                <span>Genesis</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-0 border-t-2 border-dashed border-[#FFB800]" />
                <span>NDX</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-0 border-t-2 border-dashed border-[#666]" />
                <span>SPX</span>
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
            <div className="bg-[#1a1a1a] rounded-2xl p-6 border border-[#252525]">
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
            <div className="bg-[#1a1a1a] rounded-2xl p-6 border border-[#252525]">
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
            <div className="bg-[#1a1a1a] rounded-2xl p-6 border border-[#252525]">
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

            <div className="bg-[#1a1a1a] rounded-2xl p-6 border border-[#252525]">
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
          <div className="bg-[#FF6B6B]/10 rounded-2xl p-4 border border-[#FF6B6B]/30">
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
