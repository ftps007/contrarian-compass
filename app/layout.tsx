import type { Metadata } from 'next'
import Link from 'next/link'
import Image from 'next/image'
import './globals.css'

export const metadata: Metadata = {
  title: 'The Contrarian Compass - Dogs of the Dow Tangency Portfolio',
  description: 'Navigate the markets with data-driven contrarian strategies using Modern Portfolio Theory',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="bg-stone-50">
        <nav className="bg-stone-100 shadow-sm border-b border-stone-200">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex justify-between h-16">
              <div className="flex items-center">
                <Link href="/" className="flex items-center gap-3">
                  <Image
                    src="/logo.jpg"
                    alt="The Contrarian Compass"
                    width={40}
                    height={40}
                    className="rounded-full"
                  />
                  <span className="text-xl font-bold text-stone-800">
                    The Contrarian Compass
                  </span>
                </Link>
              </div>
              <div className="flex items-center space-x-1">
                <Link href="/dashboard" className="text-stone-600 hover:text-amber-800 hover:bg-stone-200 px-3 py-2 rounded-md transition-colors">
                  Dashboard
                </Link>
                <Link href="/calculator" className="text-stone-600 hover:text-amber-800 hover:bg-stone-200 px-3 py-2 rounded-md transition-colors">
                  Calculator
                </Link>
                <Link href="/backtest" className="text-stone-600 hover:text-amber-800 hover:bg-stone-200 px-3 py-2 rounded-md transition-colors">
                  Backtest
                </Link>
              </div>
            </div>
          </div>
        </nav>
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {children}
        </main>
        <footer className="bg-stone-100 border-t border-stone-200 mt-auto">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
            <p className="text-center text-sm text-stone-500">
              The Contrarian Compass - Dogs of the Dow Tangency Portfolio Strategy
            </p>
          </div>
        </footer>
      </body>
    </html>
  )
}
