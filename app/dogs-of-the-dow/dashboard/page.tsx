'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine
} from 'recharts';
import { samplePortfolioData } from '@/lib/sampleData';

interface PriceData {
  price: number;
  change: number;
  changePercent: number;
  previousClose: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  marketState: string;
  name: string;
  lastUpdate: number;
}

interface LivePriceResponse {
  prices: Record<string, PriceData>;
  timestamp: string;
  source: string;
  marketState: string;
  isMarketOpen: boolean;
  note?: string;
}

interface PortfolioHistoryEntry {
  time: string;
  timestamp: number;
  value: number;
  change: number;
  changePercent: number;
}

function formatCurrency(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatCompact(value: number): string {
  if (value >= 1000) return `$${(value / 1000).toFixed(1)}k`;
  return `$${value.toFixed(0)}`;
}

export default function Dashboard() {
  const [livePrices, setLivePrices] = useState<LivePriceResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [portfolioHistory, setPortfolioHistory] = useState<PortfolioHistoryEntry[]>([]);
  const [refreshInterval, setRefreshInterval] = useState(900); // 15 min
  const [execPrices, setExecPrices] = useState<Record<string, Record<string, number>> | null>(null);

  const data = samplePortfolioData;
  const latestWeek = data.weeks[1]!;
  const activeWeek = data.weeks[2];
  const currentWeekNumber = data.weeks.length;

  const basePortfolioValue = data.summary.finalValue;
  const totalCash = latestWeek.portfolioValue?.cash || 0;
  const totalDividends = data.summary.totalDividends;

  const metrics = data.metrics;
  const beta = metrics.tangency.beta;

  // CAPM
  const riskFreeWeekly = data.riskFreeRate / 52;
  const equityRiskPremium = 0.045;
  const marketRiskPremiumWeekly = equityRiskPremium / 52;
  const capmExpectedReturn = riskFreeWeekly + beta * marketRiskPremiumWeekly;

  const actualWeeklyReturn = metrics.tangency.meanWeeklyReturn;
  const capmAnnual = (capmExpectedReturn * 52) * 100;
  const actualAnnual = (actualWeeklyReturn * 52) * 100;

  const calculatePortfolioValue = useCallback((prices: Record<string, PriceData>) => {
    return (activeWeek?.targetPositions || []).reduce((sum: number, p: any) => {
      const price = prices[p.ticker]?.price || 0;
      return sum + p.shares * price;
    }, 0);
  }, [activeWeek]);

  const fetchLivePrices = useCallback(async () => {
    setIsLoading(true);
    try {
      const symbols = 'HD,UNH,PG,KO,JNJ,AMGN,VZ,NKE,MRK,CVX';
      const response = await fetch(`/api/prices?symbols=${symbols}`);
      const priceData = await response.json();
      setLivePrices(priceData);
      setLastRefresh(new Date());

      if (priceData.prices && Object.keys(priceData.prices).length > 0) {
        const currentValue = calculatePortfolioValue(priceData.prices);
        const change = currentValue - basePortfolioValue;
        const changePercent = (change / basePortfolioValue) * 100;

        const now = new Date();
        const newEntry: PortfolioHistoryEntry = {
          time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
          timestamp: now.getTime(),
          value: currentValue,
          change,
          changePercent,
        };

        setPortfolioHistory(prev => [...prev, newEntry].slice(-100));
      }
    } catch (error) {
      console.error('Failed to fetch live prices:', error);
    } finally {
      setIsLoading(false);
    }
  }, [calculatePortfolioValue, basePortfolioValue]);

  useEffect(() => {
    fetchLivePrices();
    if (autoRefresh) {
      const interval = setInterval(fetchLivePrices, refreshInterval * 1000);
      return () => clearInterval(interval);
    }
  }, [fetchLivePrices, autoRefresh, refreshInterval]);

  // Fetch execution prices once
  useEffect(() => {
    async function fetchExecPrices() {
      try {
        const response = await fetch('/api/execution-prices');
        const data = await response.json();
        if (data.prices && Object.keys(data.prices).length > 0) {
          setExecPrices(data.prices);
        }
      } catch (error) {
        console.error('Failed to fetch execution prices:', error);
      }
    }
    fetchExecPrices();
  }, []);

  // Live portfolio value
  const liveStockValue = livePrices?.prices
    ? (activeWeek?.targetPositions || []).reduce((sum: number, p: any) => {
        const price = livePrices.prices[p.ticker]?.price || 0;
        return sum + p.shares * price;
      }, 0)
    : null;

  const livePortfolioValue = liveStockValue ? liveStockValue + totalCash + totalDividends : null;
  const displayPortfolioValue = livePortfolioValue || basePortfolioValue;
  const displayStockValue = liveStockValue || (latestWeek.portfolioValue?.stockValue || 0);

  const totalReturn = ((displayPortfolioValue - data.initialCapital) / data.initialCapital) * 100;
  const weeklyReturn = liveStockValue
    ? ((liveStockValue - basePortfolioValue) / basePortfolioValue) * 100
    : 0;

  // All trades since inception (using execution prices from API)
  const execDates = ['2026-01-02', '2026-01-12', '2026-01-20'];
  const allTrades: { week: string; ticker: string; action: string; shares: number; price: number | null }[] = [];

  // Week 1: initial buys from positions
  const week1 = data.weeks[0];
  if (week1?.positions) {
    week1.positions.forEach((pos: any) => {
      const apiPrice = execPrices?.[execDates[0]]?.[pos.ticker];
      allTrades.push({ week: 'W1', ticker: pos.ticker, action: 'BUY', shares: pos.shares, price: apiPrice ?? null });
    });
  }

  // Week 2: explicit trades
  if (latestWeek.trades) {
    latestWeek.trades.forEach((t: any) => {
      const apiPrice = execPrices?.[execDates[1]]?.[t.ticker];
      allTrades.push({ week: 'W2', ticker: t.ticker, action: t.action, shares: t.shares, price: apiPrice ?? null });
    });
  }

  // Week 3: trades (executed Jan 20)
  if (activeWeek?.plannedTrades) {
    activeWeek.plannedTrades.forEach((t: any) => {
      const apiPrice = execPrices?.[execDates[2]]?.[t.ticker];
      allTrades.push({ week: 'W3', ticker: t.ticker, action: t.action, shares: t.shares, price: apiPrice ?? null });
    });
  }

  return (
    <div className="space-y-0 -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8 py-4 bg-[#0d0d0d] min-h-screen">

      {/* === SINGLE UNIFIED DASHBOARD === */}
      <div className="bg-[#1a1a1a] rounded-2xl border border-[#252525] overflow-hidden">

        {/* Header: Title + Controls */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4">
          <div>
            <h1 className="text-xl font-bold text-white">Contrarian Compass</h1>
            <p className="text-gray-500 text-xs">Dogs of the Dow &middot; Tangency Portfolio</p>
          </div>
          <div className="flex items-center gap-3">
            {livePrices?.isMarketOpen && (
              <span className="flex items-center gap-1.5 px-2 py-1 bg-[#00D4AA]/10 border border-[#00D4AA]/30 rounded-full">
                <span className="w-2 h-2 rounded-full bg-[#00D4AA] animate-pulse" />
                <span className="text-[#00D4AA] text-xs font-medium">LIVE</span>
              </span>
            )}
            <button
              onClick={fetchLivePrices}
              disabled={isLoading}
              className="px-3 py-1.5 bg-[#252525] hover:bg-[#333] text-gray-300 text-xs rounded-lg transition-colors disabled:opacity-50"
            >
              {isLoading ? 'Updating...' : 'Refresh'}
            </button>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1 text-xs text-gray-500">
                <input
                  type="checkbox"
                  checked={autoRefresh}
                  onChange={(e) => setAutoRefresh(e.target.checked)}
                  className="w-3 h-3 accent-[#00D4AA]"
                />
                Auto
              </label>
              <select
                value={refreshInterval}
                onChange={(e) => setRefreshInterval(Number(e.target.value))}
                disabled={!autoRefresh}
                className="bg-[#252525] text-gray-300 text-xs rounded px-2 py-1 border border-[#333] disabled:opacity-50"
              >
                <option value={900}>15m</option>
                <option value={1800}>30m</option>
                <option value={3600}>1h</option>
              </select>
            </div>
          </div>
        </div>

        {/* Year | Week + Total Return */}
        <div className="flex items-center justify-between px-6 pb-5 border-b border-[#252525]">
          <div className="flex items-baseline gap-3">
            <span className="text-4xl font-bold text-white font-mono tracking-tight">2026</span>
            <span className="text-4xl font-light text-gray-600">|</span>
            <span className="text-4xl font-bold text-[#00D4AA] font-mono">W{currentWeekNumber}</span>
          </div>
          <div className="text-right">
            <div className={`text-3xl font-bold font-mono ${totalReturn >= 0 ? 'text-[#00D4AA]' : 'text-[#FF6B6B]'}`}>
              {totalReturn >= 0 ? '+' : ''}{totalReturn.toFixed(2)}%
            </div>
            <div className="text-gray-500 text-xs">Total Return</div>
          </div>
        </div>

        {/* Positions with Live Prices */}
        <div className="px-6 py-4">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[#333]">
                  <th className="text-left text-gray-500 text-xs uppercase tracking-wider py-2 px-1">Ticker</th>
                  <th className="text-left text-gray-500 text-xs uppercase tracking-wider py-2 px-1">Name</th>
                  <th className="text-right text-gray-500 text-xs uppercase tracking-wider py-2 px-1">Shares</th>
                  <th className="text-right text-gray-500 text-xs uppercase tracking-wider py-2 px-1">Live Price</th>
                  <th className="text-right text-gray-500 text-xs uppercase tracking-wider py-2 px-1">Change</th>
                  <th className="text-right text-gray-500 text-xs uppercase tracking-wider py-2 px-1">Mkt Value</th>
                  <th className="text-right text-gray-500 text-xs uppercase tracking-wider py-2 px-1">Weight</th>
                </tr>
              </thead>
              <tbody>
                {(activeWeek?.targetPositions || []).map((pos: any) => {
                  const priceData = livePrices?.prices?.[pos.ticker];
                  const currentPrice = priceData?.price || 0;
                  const posValue = pos.shares * currentPrice;
                  const change = priceData?.changePercent || 0;
                  return (
                    <tr key={pos.ticker} className="border-b border-[#252525]/60 hover:bg-[#252525]/30 transition-colors">
                      <td className="py-2 px-1">
                        <a
                          href={`https://finance.yahoo.com/quote/${pos.ticker}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-white font-medium hover:text-[#00D4AA] transition-colors text-sm"
                        >
                          {pos.ticker}
                        </a>
                      </td>
                      <td className="py-2 px-1 text-gray-400 text-xs truncate max-w-[120px]">
                        {priceData?.name || '-'}
                      </td>
                      <td className="py-2 px-1 text-right text-gray-300 font-mono text-sm">{pos.shares}</td>
                      <td className="py-2 px-1 text-right text-white font-mono text-sm">
                        {priceData ? `$${currentPrice.toFixed(2)}` : '-'}
                      </td>
                      <td className={`py-2 px-1 text-right font-mono text-sm ${change >= 0 ? 'text-[#00D4AA]' : 'text-[#FF6B6B]'}`}>
                        {priceData ? `${change >= 0 ? '+' : ''}${change.toFixed(2)}%` : '-'}
                      </td>
                      <td className="py-2 px-1 text-right text-white font-mono text-sm">
                        {priceData ? formatCurrency(posValue) : '-'}
                      </td>
                      <td className="py-2 px-1 text-right text-gray-400 font-mono text-sm">
                        {(pos.targetWeight * 100).toFixed(1)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Summary Row: Stocks | Cash | Dividends | Total */}
        <div className="grid grid-cols-4 gap-4 px-6 py-4 border-t border-b border-[#252525] bg-[#151515]">
          <div>
            <div className="text-gray-500 text-xs uppercase tracking-wider mb-0.5">Stocks</div>
            <div className="text-base font-bold text-white font-mono">{formatCurrency(displayStockValue)}</div>
          </div>
          <div>
            <div className="text-gray-500 text-xs uppercase tracking-wider mb-0.5">Cash (ex Div.)</div>
            <div className="text-base font-bold text-white font-mono">{formatCurrency(totalCash)}</div>
          </div>
          <div>
            <div className="text-gray-500 text-xs uppercase tracking-wider mb-0.5">Dividends</div>
            <div className="text-base font-bold text-[#00D4AA] font-mono">{formatCurrency(totalDividends)}</div>
          </div>
          <div>
            <div className="text-gray-500 text-xs uppercase tracking-wider mb-0.5">Total Value</div>
            <div className="text-base font-bold text-white font-mono">{formatCurrency(displayPortfolioValue)}</div>
          </div>
        </div>

        {/* Live Intraday Chart */}
        <div className="px-6 py-4 border-b border-[#252525]">
          {portfolioHistory.length > 1 ? (
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-gray-400 text-xs uppercase tracking-wider">Intraday</span>
                <span className="text-gray-500 text-xs">
                  {lastRefresh?.toLocaleTimeString()} &middot; {portfolioHistory.length} pts
                </span>
              </div>
              <ResponsiveContainer width="100%" height={160}>
                <AreaChart data={portfolioHistory}>
                  <defs>
                    <linearGradient id="liveGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={weeklyReturn >= 0 ? '#00D4AA' : '#FF6B6B'} stopOpacity={0.25} />
                      <stop offset="100%" stopColor={weeklyReturn >= 0 ? '#00D4AA' : '#FF6B6B'} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#252525" />
                  <XAxis dataKey="time" stroke="#666" tick={{ fill: '#666', fontSize: 9 }} axisLine={false} tickLine={false} />
                  <YAxis
                    domain={['dataMin - 50', 'dataMax + 50']}
                    tickFormatter={formatCompact}
                    stroke="#666"
                    tick={{ fill: '#666', fontSize: 9 }}
                    axisLine={false}
                    tickLine={false}
                    width={50}
                  />
                  <Tooltip
                    content={({ active, payload }) => {
                      if (active && payload && payload.length) {
                        const d = payload[0].payload as PortfolioHistoryEntry;
                        return (
                          <div className="bg-[#1e1e1e] border border-[#333] rounded p-2 shadow-xl text-xs">
                            <p className="text-white font-mono">{formatCurrency(d.value)}</p>
                            <p className={`font-mono ${d.changePercent >= 0 ? 'text-[#00D4AA]' : 'text-[#FF6B6B]'}`}>
                              {d.changePercent >= 0 ? '+' : ''}{d.changePercent.toFixed(3)}%
                            </p>
                          </div>
                        );
                      }
                      return null;
                    }}
                  />
                  <ReferenceLine y={basePortfolioValue} stroke="#444" strokeDasharray="4 4" />
                  <Area
                    type="monotone"
                    dataKey="value"
                    stroke={weeklyReturn >= 0 ? '#00D4AA' : '#FF6B6B'}
                    strokeWidth={1.5}
                    fill="url(#liveGradient)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="flex items-center justify-between py-2">
              <span className="text-gray-400 text-xs uppercase tracking-wider">Intraday</span>
              <span className="text-gray-500 text-xs">Collecting data points...</span>
            </div>
          )}
        </div>

        {/* Metrics: Sharpe, Beta, CAPM Expected, Actual */}
        <div className="grid grid-cols-4 gap-0 divide-x divide-[#252525]">
          <div className="px-6 py-4 text-center">
            <div className="text-gray-500 text-xs uppercase tracking-wider mb-1">Sharpe</div>
            <div className="text-xl font-bold text-white font-mono">{metrics.tangency.sharpeRatio.toFixed(2)}</div>
            <div className="text-gray-600 text-xs">vs {metrics.dji.sharpeRatio.toFixed(2)} DJI</div>
          </div>
          <div className="px-6 py-4 text-center">
            <div className="text-gray-500 text-xs uppercase tracking-wider mb-1">Beta</div>
            <div className="text-xl font-bold text-white font-mono">{beta.toFixed(2)}</div>
            <div className="text-gray-600 text-xs">Low risk</div>
          </div>
          <div className="px-6 py-4 text-center">
            <div className="text-gray-500 text-xs uppercase tracking-wider mb-1">CAPM Exp.</div>
            <div className="text-xl font-bold text-[#FFB800] font-mono">+{capmAnnual.toFixed(1)}%</div>
            <div className="text-gray-600 text-xs">annual</div>
          </div>
          <div className="px-6 py-4 text-center">
            <div className="text-gray-500 text-xs uppercase tracking-wider mb-1">Actual</div>
            <div className={`text-xl font-bold font-mono ${actualAnnual > capmAnnual ? 'text-[#00D4AA]' : 'text-[#FF6B6B]'}`}>
              +{actualAnnual.toFixed(1)}%
            </div>
            <div className={`text-xs ${actualAnnual > capmAnnual ? 'text-[#00D4AA]' : 'text-[#FF6B6B]'}`}>
              {actualAnnual > capmAnnual ? '+' : ''}{(actualAnnual - capmAnnual).toFixed(1)}% alpha
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3 bg-[#151515] text-xs text-gray-600">
          <span>
            {lastRefresh ? `Updated ${lastRefresh.toLocaleTimeString()}` : 'Loading...'}
            {livePrices?.source === 'fallback_data' && <span className="text-[#FFB800] ml-2">cached</span>}
          </span>
          <span>Market: {livePrices?.marketState || '-'} &middot; Yahoo Finance</span>
        </div>
      </div>

      {/* === TRADES === */}
      <div className="bg-[#1a1a1a] rounded-2xl border border-[#252525] mt-4 overflow-hidden">
        <div className="flex items-center justify-between px-6 pt-5 pb-3">
          <h2 className="text-white font-semibold">Trades</h2>
          <span className="text-gray-500 text-xs">{allTrades.length} trades since inception</span>
        </div>
        <div className="px-6 pb-5">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[#333]">
                  <th className="text-left text-gray-500 text-xs uppercase tracking-wider py-2 px-1">Week</th>
                  <th className="text-left text-gray-500 text-xs uppercase tracking-wider py-2 px-1">Action</th>
                  <th className="text-left text-gray-500 text-xs uppercase tracking-wider py-2 px-1">Ticker</th>
                  <th className="text-right text-gray-500 text-xs uppercase tracking-wider py-2 px-1">Shares (Exec. Price)</th>
                </tr>
              </thead>
              <tbody>
                {allTrades.map((trade, i) => (
                  <tr key={i} className="border-b border-[#252525]/40 hover:bg-[#252525]/30 transition-colors">
                    <td className="py-2 px-1 text-gray-500 text-xs font-mono">{trade.week}</td>
                    <td className="py-2 px-1">
                      <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                        trade.action === 'BUY'
                          ? 'bg-[#00D4AA]/15 text-[#00D4AA]'
                          : 'bg-[#FF6B6B]/15 text-[#FF6B6B]'
                      }`}>
                        {trade.action}
                      </span>
                    </td>
                    <td className="py-2 px-1 text-white text-sm font-medium">{trade.ticker}</td>
                    <td className="py-2 px-1 text-right text-gray-300 text-sm font-mono">
                      {trade.shares} <span className="text-gray-500">({trade.price !== null ? `$${trade.price.toFixed(2)}` : '-'})</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
