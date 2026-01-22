import { NextResponse } from 'next/server';

// Yahoo Finance API - fetches real-time stock prices
// Uses the publicly available Yahoo Finance v8 quote API

interface YahooQuoteResult {
  symbol: string;
  regularMarketPrice: number;
  regularMarketChange: number;
  regularMarketChangePercent: number;
  regularMarketPreviousClose: number;
  regularMarketOpen: number;
  regularMarketDayHigh: number;
  regularMarketDayLow: number;
  regularMarketVolume: number;
  regularMarketTime: number;
  marketState: string;
  shortName: string;
}

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

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const symbols = searchParams.get('symbols') || 'HD,NKE,UNH,PG,KO,MRK,JNJ,AMGN,CVX,VZ';

  try {
    // Yahoo Finance v8 quote API
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols}&fields=symbol,regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketPreviousClose,regularMarketOpen,regularMarketDayHigh,regularMarketDayLow,regularMarketVolume,regularMarketTime,marketState,shortName`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      next: { revalidate: 30 }, // Cache for 30 seconds
    });

    if (!response.ok) {
      throw new Error(`Yahoo Finance API error: ${response.status}`);
    }

    const data = await response.json();
    const quotes = data.quoteResponse?.result || [];

    const prices: Record<string, PriceData> = {};

    quotes.forEach((quote: YahooQuoteResult) => {
      prices[quote.symbol] = {
        price: quote.regularMarketPrice,
        change: quote.regularMarketChange,
        changePercent: quote.regularMarketChangePercent,
        previousClose: quote.regularMarketPreviousClose,
        open: quote.regularMarketOpen,
        high: quote.regularMarketDayHigh,
        low: quote.regularMarketDayLow,
        volume: quote.regularMarketVolume,
        marketState: quote.marketState,
        name: quote.shortName,
        lastUpdate: quote.regularMarketTime * 1000, // Convert to milliseconds
      };
    });

    // Determine market status
    const firstQuote = quotes[0];
    const marketState = firstQuote?.marketState || 'CLOSED';
    const isMarketOpen = marketState === 'REGULAR';

    return NextResponse.json({
      prices,
      timestamp: new Date().toISOString(),
      source: 'yahoo_finance',
      marketState,
      isMarketOpen,
      nextUpdate: isMarketOpen ? '30s' : 'Market closed',
    });
  } catch (error) {
    console.error('Yahoo Finance API error:', error);

    // Fallback to cached data if Yahoo Finance fails
    // Prices as of Jan 22, 2026 close (2 days after W3 execution on Jan 20)
    const fallbackPrices: Record<string, PriceData> = {
      HD: { price: 383.12, change: 1.84, changePercent: 0.48, previousClose: 381.28, open: 381.50, high: 384.20, low: 380.90, volume: 3412000, marketState: 'CLOSED', name: 'The Home Depot, Inc.', lastUpdate: Date.now() },
      NKE: { price: 72.08, change: 0.62, changePercent: 0.87, previousClose: 71.46, open: 71.60, high: 72.35, low: 71.20, volume: 8950000, marketState: 'CLOSED', name: 'NIKE, Inc.', lastUpdate: Date.now() },
      UNH: { price: 351.40, change: 2.15, changePercent: 0.62, previousClose: 349.25, open: 349.80, high: 352.60, low: 348.50, volume: 4120000, marketState: 'CLOSED', name: 'UnitedHealth Group Inc.', lastUpdate: Date.now() },
      PG: { price: 145.88, change: 0.92, changePercent: 0.63, previousClose: 144.96, open: 145.10, high: 146.30, low: 144.75, volume: 5680000, marketState: 'CLOSED', name: 'The Procter & Gamble Company', lastUpdate: Date.now() },
      KO: { price: 71.22, change: 0.38, changePercent: 0.54, previousClose: 70.84, open: 70.95, high: 71.45, low: 70.70, volume: 9230000, marketState: 'CLOSED', name: 'The Coca-Cola Company', lastUpdate: Date.now() },
      MRK: { price: 100.45, change: 1.10, changePercent: 1.11, previousClose: 99.35, open: 99.50, high: 101.00, low: 99.20, volume: 7150000, marketState: 'CLOSED', name: 'Merck & Co., Inc.', lastUpdate: Date.now() },
      JNJ: { price: 221.35, change: 1.48, changePercent: 0.67, previousClose: 219.87, open: 220.10, high: 222.00, low: 219.50, volume: 5890000, marketState: 'CLOSED', name: 'Johnson & Johnson', lastUpdate: Date.now() },
      AMGN: { price: 322.78, change: -1.92, changePercent: -0.59, previousClose: 324.70, open: 324.50, high: 326.10, low: 321.80, volume: 2340000, marketState: 'CLOSED', name: 'Amgen Inc.', lastUpdate: Date.now() },
      CVX: { price: 167.54, change: 0.88, changePercent: 0.53, previousClose: 166.66, open: 166.80, high: 168.20, low: 166.30, volume: 6780000, marketState: 'CLOSED', name: 'Chevron Corporation', lastUpdate: Date.now() },
      VZ: { price: 39.52, change: 0.28, changePercent: 0.71, previousClose: 39.24, open: 39.30, high: 39.65, low: 39.10, volume: 12500000, marketState: 'CLOSED', name: 'Verizon Communications Inc.', lastUpdate: Date.now() },
    };

    const requestedSymbols = symbols.split(',');
    const prices = requestedSymbols.reduce((acc, symbol) => {
      if (fallbackPrices[symbol]) {
        acc[symbol] = fallbackPrices[symbol];
      }
      return acc;
    }, {} as Record<string, PriceData>);

    return NextResponse.json({
      prices,
      timestamp: new Date().toISOString(),
      source: 'fallback_data',
      marketState: 'CLOSED',
      isMarketOpen: false,
      note: 'Using cached data - Yahoo Finance temporarily unavailable',
    });
  }
}
