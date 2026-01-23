'use client';

import Link from 'next/link';
import Image from 'next/image';
import { samplePortfolioData } from '@/lib/sampleData';
import { portfolioSummary as genesisSummary } from '@/lib/genesisData';
import { cashFlow, portfolioSummary as contrarianSummary } from '@/lib/contrarianData';

const portfolioStats = {
  dogs: {
    initial: samplePortfolioData.initialCapital,
    current: samplePortfolioData.summary.finalValue + (samplePortfolioData.summary.totalDividends || 0),
    returnPct: samplePortfolioData.summary.totalReturn * 100,
  },
  contrarian: {
    initial: cashFlow.totalInjected,
    current: contrarianSummary.openCurrent + cashFlow.availableCash,
    returnPct: ((contrarianSummary.openCurrent + cashFlow.availableCash - cashFlow.totalInjected) / cashFlow.totalInjected) * 100,
  },
  genesis: {
    initial: genesisSummary.totalInitial,
    current: genesisSummary.estimatedCurrent,
    returnPct: genesisSummary.estimatedTotalReturn,
  },
};

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(value);
}

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
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl w-full">
        <Link href="/dogs-of-the-dow" className="group">
          <div className="relative h-64 rounded-lg overflow-hidden shadow-md hover:shadow-xl transition-shadow border-2 border-transparent hover:border-amber-700">
            <Image
              src="/dogs_of_the_dow.jpg"
              alt="Dogs of the Dow"
              fill
              className="object-cover group-hover:scale-105 transition-transform duration-300"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent" />
            <div className="absolute bottom-0 left-0 right-0 p-4 text-white">
              <h2 className="text-xl font-bold mb-1">Dogs of the Dow</h2>
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-300">{formatCurrency(portfolioStats.dogs.initial)} &rarr; {formatCurrency(portfolioStats.dogs.current)}</span>
                <span className={`font-mono font-bold ${portfolioStats.dogs.returnPct >= 0 ? 'text-[#00D4AA]' : 'text-[#FF6B6B]'}`}>
                  {portfolioStats.dogs.returnPct >= 0 ? '+' : ''}{portfolioStats.dogs.returnPct.toFixed(2)}%
                </span>
              </div>
            </div>
          </div>
        </Link>

        <Link href="/contrarian-plays" className="group">
          <div className="relative h-64 rounded-lg overflow-hidden shadow-md hover:shadow-xl transition-shadow border-2 border-transparent hover:border-amber-700">
            <Image
              src="/contrarian_plays.jpg"
              alt="Contrarian Plays"
              fill
              className="object-cover group-hover:scale-105 transition-transform duration-300"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent" />
            <div className="absolute bottom-0 left-0 right-0 p-4 text-white">
              <h2 className="text-xl font-bold mb-1">Contrarian Plays</h2>
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-300">{formatCurrency(portfolioStats.contrarian.initial)} &rarr; {formatCurrency(portfolioStats.contrarian.current)}</span>
                <span className={`font-mono font-bold ${portfolioStats.contrarian.returnPct >= 0 ? 'text-[#00D4AA]' : 'text-[#FF6B6B]'}`}>
                  {portfolioStats.contrarian.returnPct >= 0 ? '+' : ''}{portfolioStats.contrarian.returnPct.toFixed(2)}%
                </span>
              </div>
            </div>
          </div>
        </Link>

        <Link href="/genesis" className="group">
          <div className="relative h-64 rounded-lg overflow-hidden shadow-md hover:shadow-xl transition-shadow border-2 border-transparent hover:border-amber-700">
            <Image
              src="/genesis.jpg"
              alt="Genesis"
              fill
              className="object-cover group-hover:scale-105 transition-transform duration-300"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent" />
            <div className="absolute bottom-0 left-0 right-0 p-4 text-white">
              <h2 className="text-xl font-bold mb-1">Genesis</h2>
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-300">{formatCurrency(portfolioStats.genesis.initial)} &rarr; {formatCurrency(portfolioStats.genesis.current)}</span>
                <span className={`font-mono font-bold ${portfolioStats.genesis.returnPct >= 0 ? 'text-[#00D4AA]' : 'text-[#FF6B6B]'}`}>
                  {portfolioStats.genesis.returnPct >= 0 ? '+' : ''}{portfolioStats.genesis.returnPct.toFixed(2)}%
                </span>
              </div>
            </div>
          </div>
        </Link>
      </div>
    </div>
  );
}
