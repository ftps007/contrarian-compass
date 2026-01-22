import { NextResponse } from 'next/server';
import YahooFinance from 'yahoo-finance2';

const yahooFinance = new YahooFinance();

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const symbols = (searchParams.get('symbols') || 'HD,UNH,PG,KO,JNJ,AMGN,VZ').split(',');

  try {
    const results: any = await yahooFinance.quote(symbols);
    const quotes: any[] = Array.isArray(results) ? results : [results];

    const prices: Record<string, any> = {};

    for (const quote of quotes) {
      if (quote && quote.symbol) {
        prices[quote.symbol] = {
          price: quote.regularMarketPrice ?? 0,
          change: quote.regularMarketChange ?? 0,
          changePercent: quote.regularMarketChangePercent ?? 0,
          previousClose: quote.regularMarketPreviousClose ?? 0,
          open: quote.regularMarketOpen ?? 0,
          high: quote.regularMarketDayHigh ?? 0,
          low: quote.regularMarketDayLow ?? 0,
          volume: quote.regularMarketVolume ?? 0,
          marketState: quote.marketState ?? 'CLOSED',
          name: quote.shortName ?? quote.symbol,
          lastUpdate: quote.regularMarketTime ? new Date(quote.regularMarketTime).getTime() : Date.now(),
        };
      }
    }

    const marketState = quotes[0]?.marketState || 'CLOSED';

    return NextResponse.json({
      prices,
      timestamp: new Date().toISOString(),
      source: 'yahoo_finance2',
      marketState,
      isMarketOpen: marketState === 'REGULAR',
    });
  } catch (error: any) {
    console.error('yahoo-finance2 error:', error?.message || error);

    return NextResponse.json({
      prices: {},
      timestamp: new Date().toISOString(),
      source: 'error',
      marketState: 'UNKNOWN',
      isMarketOpen: false,
      error: 'Failed to fetch live prices',
    }, { status: 502 });
  }
}
