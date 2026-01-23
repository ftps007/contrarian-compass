'use client';

import { useState, useMemo } from 'react';
import {
  ComposedChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Cell, LabelList, ReferenceLine,
} from 'recharts';
import {
  openPositions,
  closedPositions,
  portfolioSummary,
  benchmarks,
  weeklyReturns,
  cashFlow,
} from '@/lib/contrarianData';


export default function ContrarianPlaysPage() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'closed'>('dashboard');
  const [chartView, setChartView] = useState<'positions' | 'weekly'>('positions');
  const [sortKey, setSortKey] = useState<string>('return');
  const [sortCycle, setSortCycle] = useState<number>(1); // start descending

  const handleSort = (key: string) => {
    if (key === sortKey) {
      setSortCycle((sortCycle + 1) % 3);
    } else {
      setSortKey(key);
      setSortCycle(0);
    }
  };

  const sortedPositions = useMemo(() => {
    const positions = [...openPositions];
    if (sortCycle === 2) {
      return positions.sort((a, b) => a.ticker.localeCompare(b.ticker));
    }
    const dir = sortCycle === 0 ? 1 : -1;
    return positions.sort((a, b) => {
      switch (sortKey) {
        case 'ticker': return dir * a.ticker.localeCompare(b.ticker);
        case 'sector': return dir * a.sector.localeCompare(b.sector);
        case 'date': return dir * a.recDate.localeCompare(b.recDate);
        case 'entry': return dir * (a.entryPrice - b.entryPrice);
        case 'current': return dir * (a.currentPrice - b.currentPrice);
        case 'shares': return dir * (a.shares - b.shares);
        case 'invested': return dir * (a.initialInvestment - b.initialInvestment);
        case 'value': return dir * (a.currentInvestment - b.currentInvestment);
        case 'pl': return dir * (a.profitLoss - b.profitLoss);
        case 'return': return dir * (a.returnPct - b.returnPct);
        default: return 0;
      }
    });
  }, [sortKey, sortCycle]);

  // Chart data: return per position
  const positionChartData = useMemo(() => {
    return [...openPositions]
      .sort((a, b) => b.returnPct - a.returnPct)
      .map((p) => ({
        ticker: p.ticker,
        ret: p.returnPct,
      }));
  }, []);

  // Weekly chart data
  const weeklyChartData = useMemo(() => {
    return weeklyReturns.map((w) => ({
      week: w.label,
      ret: w.ret,
    }));
  }, []);

  const formatCurrency = (value: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }).format(value);

  const formatPercent = (value: number) =>
    `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const totalPL = portfolioSummary.openPL + portfolioSummary.closedPL;
  const totalReturnPct = (totalPL / cashFlow.totalInjected) * 100;
  const totalPortfolioValue = portfolioSummary.openCurrent + cashFlow.availableCash;

  return (
    <div className="space-y-6 -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8 py-4 bg-[#0d0d0d] min-h-screen">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div>
          <h1 className="text-xl font-bold text-white">Contrarian Plays</h1>
          <p className="text-gray-500 text-xs">Inception: Aug 26, 2025 | Against quant sentiment</p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold text-white font-mono">{formatCurrency(totalPortfolioValue)}</div>
          <div className="text-gray-500 text-xs mb-0.5">Portfolio (stocks + cash)</div>
          <div className={`text-lg font-bold font-mono ${totalPL >= 0 ? 'text-[#00D4AA]' : 'text-[#FF6B6B]'}`}>
            {formatPercent(totalReturnPct)}
            <span className="text-sm font-normal ml-1.5">({formatCurrency(totalPL)})</span>
          </div>
          <div className="text-gray-500 text-xs">return on capital injected</div>
        </div>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="bg-[#1a1a1a] rounded-2xl p-4 border border-[#252525]">
          <div className="text-gray-400 text-xs uppercase tracking-wider">Capital Injected</div>
          <div className="font-semibold text-lg text-white">{formatCurrency(cashFlow.totalInjected)}</div>
          <div className="text-gray-500 text-xs">out-of-pocket</div>
        </div>
        <div className="bg-[#1a1a1a] rounded-2xl p-4 border border-[#252525]">
          <div className="text-gray-400 text-xs uppercase tracking-wider">Open P/L</div>
          <div className={`font-semibold text-lg ${portfolioSummary.openPL >= 0 ? 'text-[#00D4AA]' : 'text-[#FF6B6B]'}`}>
            {formatPercent(portfolioSummary.openReturnPct)}
          </div>
          <div className="text-gray-500 text-xs">{formatCurrency(portfolioSummary.openPL)}</div>
        </div>
        <div className="bg-[#1a1a1a] rounded-2xl p-4 border border-[#252525]">
          <div className="text-gray-400 text-xs uppercase tracking-wider">Cash Available</div>
          <div className="font-semibold text-lg text-[#FFB800]">{formatCurrency(cashFlow.availableCash)}</div>
          <div className="text-gray-500 text-xs">for reinvestment</div>
        </div>
        <div className="bg-[#1a1a1a] rounded-2xl p-4 border border-[#252525]">
          <div className="text-gray-400 text-xs uppercase tracking-wider">vs S&P 500</div>
          <div className={`font-semibold text-lg ${(totalReturnPct - benchmarks.spx.returnPct) >= 0 ? 'text-[#00D4AA]' : 'text-[#FF6B6B]'}`}>
            {formatPercent(totalReturnPct - benchmarks.spx.returnPct)}
          </div>
          <div className="text-gray-500 text-xs">SPX: {formatPercent(benchmarks.spx.returnPct)}</div>
        </div>
        <div className="bg-[#1a1a1a] rounded-2xl p-4 border border-[#252525]">
          <div className="text-gray-400 text-xs uppercase tracking-wider">Win Rate</div>
          <div className="font-semibold text-lg text-white">
            {openPositions.filter(p => p.returnPct > 0).length + closedPositions.filter(p => p.returnPct > 0).length}/{openPositions.length + closedPositions.length}
          </div>
          <div className="text-gray-500 text-xs">
            {((openPositions.filter(p => p.returnPct > 0).length + closedPositions.filter(p => p.returnPct > 0).length) / (openPositions.length + closedPositions.length) * 100).toFixed(0)}%
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1">
        {[
          { id: 'dashboard', label: 'Dashboard' },
          { id: 'closed', label: 'Closed Positions' },
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

      {/* Dashboard Tab */}
      {activeTab === 'dashboard' && (
        <>
          {/* Returns Bar Chart */}
          <div className="bg-[#1a1a1a] rounded-2xl border border-[#252525] overflow-hidden">
            <div className="px-6 py-5 border-b border-[#252525]">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setChartView('positions')}
                    className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                      chartView === 'positions' ? 'bg-[#333] text-white' : 'text-gray-500 hover:text-gray-300'
                    }`}
                  >
                    Position Returns
                  </button>
                  <button
                    onClick={() => setChartView('weekly')}
                    className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                      chartView === 'weekly' ? 'bg-[#333] text-white' : 'text-gray-500 hover:text-gray-300'
                    }`}
                  >
                    Weekly Returns
                  </button>
                </div>
                <span className="text-gray-500 text-xs">Hover for details</span>
              </div>
              <ResponsiveContainer width="100%" height={220}>
                <ComposedChart data={chartView === 'positions' ? positionChartData : weeklyChartData} barCategoryGap={chartView === 'positions' ? '15%' : '20%'}>
                  <defs>
                    <linearGradient id="cpBarGreen" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#00D4AA" stopOpacity={1} />
                      <stop offset="100%" stopColor="#00896e" stopOpacity={0.7} />
                    </linearGradient>
                    <linearGradient id="cpBarRed" x1="0" y1="1" x2="0" y2="0">
                      <stop offset="0%" stopColor="#FF6B6B" stopOpacity={1} />
                      <stop offset="100%" stopColor="#cc4444" stopOpacity={0.7} />
                    </linearGradient>
                    <filter id="cpGlow">
                      <feGaussianBlur stdDeviation="3" result="blur" />
                      <feMerge>
                        <feMergeNode in="blur" />
                        <feMergeNode in="SourceGraphic" />
                      </feMerge>
                    </filter>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1f1f1f" vertical={false} />
                  <XAxis dataKey={chartView === 'positions' ? 'ticker' : 'week'} stroke="transparent" tick={{ fill: '#ccc', fontSize: chartView === 'positions' ? 10 : 9, fontWeight: 500 }} tickLine={false} interval={chartView === 'weekly' ? 1 : 0} />
                  <YAxis stroke="transparent" tick={{ fill: '#555', fontSize: 10 }} tickLine={false} tickFormatter={(v: number) => `${v}%`} width={40} />
                  <Tooltip
                    cursor={{ fill: 'rgba(255,255,255,0.02)' }}
                    content={({ active, payload }) => {
                      if (active && payload && payload.length) {
                        const d = payload[0]?.payload;
                        if (chartView === 'positions') {
                          const pos = openPositions.find(p => p.ticker === d.ticker);
                          if (!pos) return null;
                          return (
                            <div className="bg-[#111] border border-[#333] rounded-xl p-3.5 shadow-2xl">
                              <p className="text-white font-bold text-sm mb-1">{pos.ticker} <span className="text-gray-400 font-normal text-xs">{pos.name}</span></p>
                              <div className="space-y-1">
                                <div className="flex items-center justify-between gap-4">
                                  <span className="text-gray-400 text-xs">Return</span>
                                  <span className={`font-mono text-sm font-bold ${pos.returnPct >= 0 ? 'text-[#00D4AA]' : 'text-[#FF6B6B]'}`}>
                                    {formatPercent(pos.returnPct)}
                                  </span>
                                </div>
                                <div className="flex items-center justify-between gap-4">
                                  <span className="text-gray-400 text-xs">P/L</span>
                                  <span className={`font-mono text-sm ${pos.profitLoss >= 0 ? 'text-[#00D4AA]' : 'text-[#FF6B6B]'}`}>
                                    {formatCurrency(pos.profitLoss)}
                                  </span>
                                </div>
                                <div className="flex items-center justify-between gap-4">
                                  <span className="text-gray-400 text-xs">Entry</span>
                                  <span className="font-mono text-sm text-gray-300">${pos.entryPrice.toFixed(2)}</span>
                                </div>
                              </div>
                            </div>
                          );
                        } else {
                          return (
                            <div className="bg-[#111] border border-[#333] rounded-xl p-3.5 shadow-2xl">
                              <p className="text-white font-bold text-sm mb-2">{d.week}</p>
                              <div className="flex items-center justify-between gap-4">
                                <span className="text-gray-400 text-xs">Portfolio</span>
                                <span className={`font-mono text-sm font-bold ${d.ret >= 0 ? 'text-[#00D4AA]' : 'text-[#FF6B6B]'}`}>
                                  {d.ret >= 0 ? '+' : ''}{d.ret.toFixed(2)}%
                                </span>
                              </div>
                            </div>
                          );
                        }
                      }
                      return null;
                    }}
                  />
                  <ReferenceLine y={0} stroke="#333" />
                  {chartView === 'positions' && (
                    <ReferenceLine y={benchmarks.spx.returnPct} stroke="#555" strokeDasharray="4 4" label={{ value: 'SPX', position: 'right', fill: '#555', fontSize: 10 }} />
                  )}
                  <Bar dataKey="ret" radius={[4, 4, 0, 0]} maxBarSize={chartView === 'positions' ? 35 : 28}>
                    <LabelList
                      dataKey="ret"
                      position="top"
                      formatter={(v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(chartView === 'positions' ? 0 : 1)}%`}
                      style={{ fill: '#888', fontSize: 9, fontFamily: 'monospace' }}
                    />
                    {(chartView === 'positions' ? positionChartData : weeklyChartData).map((d, i) => (
                      <Cell
                        key={i}
                        fill={d.ret >= 0 ? 'url(#cpBarGreen)' : 'url(#cpBarRed)'}
                        style={chartView === 'weekly' && i === weeklyChartData.length - 1 ? { filter: 'url(#cpGlow)' } : {}}
                      />
                    ))}
                  </Bar>
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between px-6 py-3 bg-[#151515] text-xs text-gray-600">
              {chartView === 'positions' ? (
                <>
                  <span>Best: BA +37.8% | Worst: PTON -23.4%</span>
                  <span>SPX: {formatPercent(benchmarks.spx.returnPct)} | NDX: {formatPercent(benchmarks.ndx.returnPct)} | DJI: {formatPercent(benchmarks.dji.returnPct)}</span>
                </>
              ) : (
                <>
                  <span>Best: +5.8% (Jan 5) | Worst: -9.4% (Oct 6)</span>
                  <span>{weeklyReturns.filter(w => w.ret > 0).length} green / {weeklyReturns.filter(w => w.ret <= 0).length} red weeks</span>
                </>
              )}
            </div>
          </div>

          {/* Positions Table */}
          <div className="bg-[#1a1a1a] rounded-2xl p-6 border border-[#252525]">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-white font-semibold">Open Positions ({openPositions.length})</h3>
              <div className="text-gray-500 text-xs">Click headers to sort</div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#333]">
                    {[
                      { key: 'ticker', label: 'Ticker', align: 'left' },
                      { key: 'sector', label: 'Sector', align: 'left' },
                      { key: 'date', label: 'Entry Date', align: 'left' },
                      { key: 'entry', label: 'Entry', align: 'right' },
                      { key: 'current', label: 'Current', align: 'right' },
                      { key: 'shares', label: 'Shares', align: 'right' },
                      { key: 'invested', label: 'Cost', align: 'right' },
                      { key: 'value', label: 'Value', align: 'right' },
                      { key: 'pl', label: 'P/L', align: 'right' },
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
                  {sortedPositions.map((p, idx) => (
                    <tr key={p.ticker} className={idx !== sortedPositions.length - 1 ? 'border-b border-[#252525]' : ''}>
                      <td className="py-2 pr-3">
                        <span className="text-[#00D4AA] font-mono font-medium">{p.ticker}</span>
                      </td>
                      <td className="py-2 pr-3 text-gray-400 text-xs">{p.sector}</td>
                      <td className="py-2 pr-3 text-gray-400 text-xs font-mono">{formatDate(p.recDate)}</td>
                      <td className="py-2 pr-3 text-right text-gray-400 font-mono">${p.entryPrice.toFixed(2)}</td>
                      <td className="py-2 pr-3 text-right text-white font-mono">${p.currentPrice.toFixed(2)}</td>
                      <td className="py-2 pr-3 text-right text-white font-mono">{p.shares}</td>
                      <td className="py-2 pr-3 text-right text-gray-400 font-mono">{formatCurrency(p.initialInvestment)}</td>
                      <td className="py-2 pr-3 text-right text-white font-mono">{formatCurrency(p.currentInvestment)}</td>
                      <td className={`py-2 pr-3 text-right font-mono ${p.profitLoss >= 0 ? 'text-[#00D4AA]' : 'text-[#FF6B6B]'}`}>
                        {formatCurrency(p.profitLoss)}
                      </td>
                      <td className={`py-2 text-right font-mono font-medium ${p.returnPct >= 0 ? 'text-[#00D4AA]' : 'text-[#FF6B6B]'}`}>
                        {formatPercent(p.returnPct)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-4 pt-4 border-t border-[#333] flex flex-wrap items-center justify-between gap-2">
              <div className="text-gray-500 text-xs">
                Strategy: Buying stocks with negative quant ratings when fundamentals disagree
              </div>
              <div className="text-gray-400 text-sm flex gap-4">
                <span>Cost: <span className="text-white font-mono">{formatCurrency(portfolioSummary.openInitial)}</span></span>
                <span>Value: <span className="text-[#00D4AA] font-mono">{formatCurrency(portfolioSummary.openCurrent)}</span></span>
                <span>P/L: <span className={`font-mono ${portfolioSummary.openPL >= 0 ? 'text-[#00D4AA]' : 'text-[#FF6B6B]'}`}>{formatCurrency(portfolioSummary.openPL)}</span></span>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Closed Positions Tab */}
      {activeTab === 'closed' && (
        <>
          {/* Closed Returns Chart */}
          <div className="bg-[#1a1a1a] rounded-2xl border border-[#252525] overflow-hidden">
            <div className="px-6 py-5 border-b border-[#252525]">
              <div className="flex items-center justify-between mb-4">
                <span className="text-white text-sm font-medium">Closed Position Returns</span>
                <span className="text-gray-500 text-xs">Total realized: {formatCurrency(portfolioSummary.closedPL)}</span>
              </div>
              <ResponsiveContainer width="100%" height={180}>
                <ComposedChart data={closedPositions.map(p => ({ ticker: p.ticker, ret: p.returnPct }))} barCategoryGap="25%">
                  <defs>
                    <linearGradient id="cpClosedGreen" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#00D4AA" stopOpacity={1} />
                      <stop offset="100%" stopColor="#00896e" stopOpacity={0.7} />
                    </linearGradient>
                    <linearGradient id="cpClosedRed" x1="0" y1="1" x2="0" y2="0">
                      <stop offset="0%" stopColor="#FF6B6B" stopOpacity={1} />
                      <stop offset="100%" stopColor="#cc4444" stopOpacity={0.7} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1f1f1f" vertical={false} />
                  <XAxis dataKey="ticker" stroke="transparent" tick={{ fill: '#ccc', fontSize: 11, fontWeight: 500 }} tickLine={false} />
                  <YAxis stroke="transparent" tick={{ fill: '#555', fontSize: 10 }} tickLine={false} tickFormatter={(v: number) => `${v}%`} width={45} />
                  <Tooltip
                    cursor={{ fill: 'rgba(255,255,255,0.02)' }}
                    content={({ active, payload }) => {
                      if (active && payload && payload.length) {
                        const d = payload[0]?.payload;
                        const pos = closedPositions.find(p => p.ticker === d.ticker);
                        if (!pos) return null;
                        return (
                          <div className="bg-[#111] border border-[#333] rounded-xl p-3.5 shadow-2xl">
                            <p className="text-white font-bold text-sm mb-1">{pos.ticker} <span className="text-gray-400 font-normal text-xs">{pos.name}</span></p>
                            <div className="space-y-1">
                              <div className="flex items-center justify-between gap-4">
                                <span className="text-gray-400 text-xs">Return</span>
                                <span className={`font-mono text-sm font-bold ${pos.returnPct >= 0 ? 'text-[#00D4AA]' : 'text-[#FF6B6B]'}`}>
                                  {formatPercent(pos.returnPct)}
                                </span>
                              </div>
                              <div className="flex items-center justify-between gap-4">
                                <span className="text-gray-400 text-xs">Realized P/L</span>
                                <span className={`font-mono text-sm ${pos.profitLoss >= 0 ? 'text-[#00D4AA]' : 'text-[#FF6B6B]'}`}>
                                  {formatCurrency(pos.profitLoss)}
                                </span>
                              </div>
                              <div className="flex items-center justify-between gap-4">
                                <span className="text-gray-400 text-xs">Held</span>
                                <span className="font-mono text-sm text-gray-300">{formatDate(pos.recDate)} - {formatDate(pos.exitDate)}</span>
                              </div>
                            </div>
                          </div>
                        );
                      }
                      return null;
                    }}
                  />
                  <ReferenceLine y={0} stroke="#333" />
                  <Bar dataKey="ret" radius={[6, 6, 0, 0]} maxBarSize={60}>
                    <LabelList
                      dataKey="ret"
                      position="top"
                      formatter={(v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(0)}%`}
                      style={{ fill: '#aaa', fontSize: 11, fontWeight: 500, fontFamily: 'monospace' }}
                    />
                    {closedPositions.map((p, i) => (
                      <Cell key={i} fill={p.returnPct >= 0 ? 'url(#cpClosedGreen)' : 'url(#cpClosedRed)'} />
                    ))}
                  </Bar>
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div className="flex items-center justify-between px-6 py-3 bg-[#151515] text-xs text-gray-600">
              <span>3 winners, 1 loser | Net: {formatCurrency(portfolioSummary.closedPL)} ({formatPercent(portfolioSummary.closedReturnPct)})</span>
              <span>Avg hold: ~3 months</span>
            </div>
          </div>

          {/* Closed Positions Table */}
          <div className="bg-[#1a1a1a] rounded-2xl p-6 border border-[#252525]">
            <h3 className="text-white font-semibold mb-4">Closed Positions ({closedPositions.length})</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#333]">
                    <th className="text-left text-gray-400 text-xs uppercase tracking-wider py-3 pr-3">Ticker</th>
                    <th className="text-left text-gray-400 text-xs uppercase tracking-wider py-3 pr-3">Sector</th>
                    <th className="text-left text-gray-400 text-xs uppercase tracking-wider py-3 pr-3">Entry</th>
                    <th className="text-left text-gray-400 text-xs uppercase tracking-wider py-3 pr-3">Exit</th>
                    <th className="text-right text-gray-400 text-xs uppercase tracking-wider py-3 pr-3">Buy</th>
                    <th className="text-right text-gray-400 text-xs uppercase tracking-wider py-3 pr-3">Sell</th>
                    <th className="text-right text-gray-400 text-xs uppercase tracking-wider py-3 pr-3">Shares</th>
                    <th className="text-right text-gray-400 text-xs uppercase tracking-wider py-3 pr-3">Invested</th>
                    <th className="text-right text-gray-400 text-xs uppercase tracking-wider py-3 pr-3">Proceeds</th>
                    <th className="text-right text-gray-400 text-xs uppercase tracking-wider py-3 pr-3">P/L</th>
                    <th className="text-right text-gray-400 text-xs uppercase tracking-wider py-3">Return</th>
                  </tr>
                </thead>
                <tbody>
                  {closedPositions.map((p, idx) => (
                    <tr key={p.ticker} className={idx !== closedPositions.length - 1 ? 'border-b border-[#252525]' : ''}>
                      <td className="py-2 pr-3">
                        <span className="text-gray-300 font-mono font-medium">{p.ticker}</span>
                      </td>
                      <td className="py-2 pr-3 text-gray-400 text-xs">{p.sector}</td>
                      <td className="py-2 pr-3 text-gray-400 text-xs font-mono">{formatDate(p.recDate)}</td>
                      <td className="py-2 pr-3 text-gray-400 text-xs font-mono">{formatDate(p.exitDate)}</td>
                      <td className="py-2 pr-3 text-right text-gray-400 font-mono">${p.entryPrice.toFixed(2)}</td>
                      <td className="py-2 pr-3 text-right text-white font-mono">${p.exitPrice.toFixed(2)}</td>
                      <td className="py-2 pr-3 text-right text-white font-mono">{p.shares}</td>
                      <td className="py-2 pr-3 text-right text-gray-400 font-mono">{formatCurrency(p.initialInvestment)}</td>
                      <td className="py-2 pr-3 text-right text-white font-mono">{formatCurrency(p.currentInvestment)}</td>
                      <td className={`py-2 pr-3 text-right font-mono ${p.profitLoss >= 0 ? 'text-[#00D4AA]' : 'text-[#FF6B6B]'}`}>
                        {formatCurrency(p.profitLoss)}
                      </td>
                      <td className={`py-2 text-right font-mono font-medium ${p.returnPct >= 0 ? 'text-[#00D4AA]' : 'text-[#FF6B6B]'}`}>
                        {formatPercent(p.returnPct)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-4 pt-4 border-t border-[#333] flex flex-wrap items-center justify-between gap-2">
              <div className="text-gray-500 text-xs">
                Realized gains locked in | WBD +125.8% best performer
              </div>
              <div className="text-gray-400 text-sm flex gap-4">
                <span>Invested: <span className="text-white font-mono">{formatCurrency(portfolioSummary.closedInitial)}</span></span>
                <span>Proceeds: <span className="text-[#00D4AA] font-mono">{formatCurrency(portfolioSummary.closedProceeds)}</span></span>
                <span>Realized: <span className="text-[#00D4AA] font-mono">{formatCurrency(portfolioSummary.closedPL)}</span></span>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
