'use client';

import Link from 'next/link';

export default function DogsOfTheDowPage() {
  return (
    <div className="space-y-6">
      <div className="text-center mb-8">
        <h1 className="text-3xl font-bold text-stone-800 mb-2">Dogs of the Dow</h1>
        <p className="text-stone-600">Tangency portfolio strategy on high-yield Dow stocks</p>
      </div>

      {/* Navigation Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-4xl mx-auto">
        <Link href="/dogs-of-the-dow/dashboard" className="group">
          <div className="card hover:shadow-lg transition-shadow border-2 border-transparent hover:border-amber-700 h-full">
            <div className="text-center">
              <div className="text-4xl mb-4">📊</div>
              <h2 className="text-xl font-bold text-gray-900 mb-2 group-hover:text-amber-800">
                Dashboard
              </h2>
              <p className="text-sm text-gray-600">
                Portfolio performance, allocations, and weekly metrics
              </p>
            </div>
          </div>
        </Link>

        <Link href="/dogs-of-the-dow/calculator" className="group">
          <div className="card hover:shadow-lg transition-shadow border-2 border-transparent hover:border-amber-700 h-full">
            <div className="text-center">
              <div className="text-4xl mb-4">🧮</div>
              <h2 className="text-xl font-bold text-gray-900 mb-2 group-hover:text-amber-800">
                Calculator
              </h2>
              <p className="text-sm text-gray-600">
                Calculate exact trades for your capital
              </p>
            </div>
          </div>
        </Link>

        <Link href="/dogs-of-the-dow/backtest" className="group">
          <div className="card hover:shadow-lg transition-shadow border-2 border-transparent hover:border-amber-700 h-full">
            <div className="text-center">
              <div className="text-4xl mb-4">📈</div>
              <h2 className="text-xl font-bold text-gray-900 mb-2 group-hover:text-amber-800">
                Backtest
              </h2>
              <p className="text-sm text-gray-600">
                Historical performance analysis
              </p>
            </div>
          </div>
        </Link>
      </div>

      {/* Strategy Info */}
      <div className="card max-w-4xl mx-auto mt-8">
        <h3 className="card-header">Strategy Overview</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div className="bg-amber-50 rounded-lg p-3 text-center">
            <div className="font-bold text-amber-900">Weekly</div>
            <div className="text-stone-600">Rebalancing</div>
          </div>
          <div className="bg-amber-50 rounded-lg p-3 text-center">
            <div className="font-bold text-amber-900">Sharpe</div>
            <div className="text-stone-600">Optimized</div>
          </div>
          <div className="bg-amber-50 rounded-lg p-3 text-center">
            <div className="font-bold text-amber-900">10 Stocks</div>
            <div className="text-stone-600">Universe</div>
          </div>
          <div className="bg-amber-50 rounded-lg p-3 text-center">
            <div className="font-bold text-amber-900">156 Week</div>
            <div className="text-stone-600">Lookback</div>
          </div>
        </div>
      </div>
    </div>
  );
}
