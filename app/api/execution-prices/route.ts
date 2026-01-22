import { NextResponse } from 'next/server';
import YahooFinance from 'yahoo-finance2';

const yahooFinance = new YahooFinance();

// Cache execution prices permanently (they never change)
let cachedPrices: Record<string, Record<string, number>> | null = null;

// Trade executions: date → tickers that were traded
const EXECUTIONS = [
  {
    date: '2026-01-02', // W1 execution (first trading day 2026)
    tickers: ['HD', 'UNH', 'KO', 'JNJ', 'AMGN', 'VZ'],
  },
  {
    date: '2026-01-12', // W2 execution
    tickers: ['HD', 'UNH', 'KO', 'JNJ', 'AMGN', 'VZ'],
  },
  {
    date: '2026-01-20', // W3 execution
    tickers: ['HD', 'UNH', 'PG', 'KO', 'JNJ', 'AMGN', 'VZ'],
  },
];

export async function GET() {
  // Return cached if available
  if (cachedPrices) {
    return NextResponse.json({
      prices: cachedPrices,
      source: 'cache',
      timestamp: new Date().toISOString(),
    });
  }

  try {
    const prices: Record<string, Record<string, number>> = {};

    for (const exec of EXECUTIONS) {
      const dateKey = exec.date;
      prices[dateKey] = {};

      // Fetch 3-day window around execution date to ensure we get data
      const period1 = new Date(exec.date);
      period1.setDate(period1.getDate() - 1);
      const period2 = new Date(exec.date);
      period2.setDate(period2.getDate() + 2);

      for (const ticker of exec.tickers) {
        try {
          const result: any[] = await yahooFinance.historical(ticker, {
            period1: period1.toISOString().split('T')[0],
            period2: period2.toISOString().split('T')[0],
            interval: '1d',
          });

          // Find the exact date or closest trading day
          const execDate = new Date(exec.date).getTime();
          const match = result.find((r: any) => {
            const d = new Date(r.date).getTime();
            return Math.abs(d - execDate) < 86400000; // within 1 day
          });

          if (match) {
            // Use opening price as execution price (trades execute at market open)
            prices[dateKey][ticker] = match.open;
          }
        } catch (e: any) {
          console.error(`Failed to fetch ${ticker} for ${dateKey}:`, e?.message);
        }
      }
    }

    // Cache permanently
    cachedPrices = prices;

    return NextResponse.json({
      prices,
      source: 'yahoo_finance2_historical',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('Execution prices error:', error?.message || error);

    return NextResponse.json({
      prices: {},
      source: 'error',
      error: 'Failed to fetch historical prices',
      timestamp: new Date().toISOString(),
    }, { status: 502 });
  }
}
