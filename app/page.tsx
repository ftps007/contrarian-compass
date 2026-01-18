'use client';

import Link from 'next/link';
import Image from 'next/image';

export default function HomePage() {
  return (
    <div className="min-h-[80vh] flex flex-col items-center justify-center">
      {/* Logo */}
      <div className="mb-8">
        <Image
          src="/logo.jpg"
          alt="The Contrarian Compass"
          width={250}
          height={250}
          className="rounded-full shadow-lg"
          priority
        />
      </div>

      {/* Tagline */}
      <p className="text-xl text-gray-600 mb-12 text-center max-w-xl">
        Navigate the markets with data-driven contrarian strategies
      </p>

      {/* Navigation Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-4xl w-full">
        <Link href="/dashboard" className="group">
          <div className="card hover:shadow-lg transition-shadow border-2 border-transparent hover:border-amber-700 h-full">
            <div className="text-center">
              <div className="text-4xl mb-4">📊</div>
              <h2 className="text-xl font-bold text-gray-900 mb-2 group-hover:text-amber-800">
                Dashboard
              </h2>
              <p className="text-sm text-gray-600">
                View portfolio performance, allocations, and weekly metrics
              </p>
            </div>
          </div>
        </Link>

        <Link href="/calculator" className="group">
          <div className="card hover:shadow-lg transition-shadow border-2 border-transparent hover:border-amber-700 h-full">
            <div className="text-center">
              <div className="text-4xl mb-4">🧮</div>
              <h2 className="text-xl font-bold text-gray-900 mb-2 group-hover:text-amber-800">
                Calculator
              </h2>
              <p className="text-sm text-gray-600">
                Calculate exact trades for your capital using tangency weights
              </p>
            </div>
          </div>
        </Link>

        <Link href="/backtest" className="group">
          <div className="card hover:shadow-lg transition-shadow border-2 border-transparent hover:border-amber-700 h-full">
            <div className="text-center">
              <div className="text-4xl mb-4">📈</div>
              <h2 className="text-xl font-bold text-gray-900 mb-2 group-hover:text-amber-800">
                Backtest
              </h2>
              <p className="text-sm text-gray-600">
                Configure parameters and analyze historical performance
              </p>
            </div>
          </div>
        </Link>
      </div>

      {/* Strategy Summary */}
      <div className="mt-12 max-w-2xl text-center">
        <h3 className="text-lg font-semibold text-gray-800 mb-4">
          Dogs of the Dow - Tangency Portfolio Strategy
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div className="bg-amber-50 rounded-lg p-3">
            <div className="font-bold text-amber-900">Weekly</div>
            <div className="text-gray-600">Rebalancing</div>
          </div>
          <div className="bg-amber-50 rounded-lg p-3">
            <div className="font-bold text-amber-900">Sharpe</div>
            <div className="text-gray-600">Optimized</div>
          </div>
          <div className="bg-amber-50 rounded-lg p-3">
            <div className="font-bold text-amber-900">10 Stocks</div>
            <div className="text-gray-600">Universe</div>
          </div>
          <div className="bg-amber-50 rounded-lg p-3">
            <div className="font-bold text-amber-900">156 Week</div>
            <div className="text-gray-600">Lookback</div>
          </div>
        </div>
      </div>
    </div>
  );
}
