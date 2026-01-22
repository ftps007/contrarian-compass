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

    // Fallback to cached/sample data if Yahoo Finance fails
    const fallbackPrices: Record<string, PriceData> = {
      HD: { price: 379.55, change: -0.62, changePercent: -0.16, previousClose: 380.17, open: 379.55, high: 382.77, low: 377.51, volume: 0, marketState: 'CLOSED', name: 'The Home Depot, Inc.', lastUpdate: Date.now() },
      NKE: { price: 71.23, change: -0.45, changePercent: -0.63, previousClose: 71.68, open: 71.23, high: 72.00, low: 70.80, volume: 0, marketState: 'CLOSED', name: 'NIKE, Inc.', lastUpdate: Date.now() },
      UNH: { price: 347.25, change: 16.23, changePercent: 4.90, previousClose: 331.02, open: 347.25, high: 349.01, low: 342.55, volume: 0, marketState: 'CLOSED', name: 'UnitedHealth Group Inc.', lastUpdate: Date.now() },
      PG: { price: 144.53, change: 0.77, changePercent: 0.54, previousClose: 143.76, open: 144.53, high: 145.20, low: 144.00, volume: 0, marketState: 'CLOSED', name: 'The Procter & Gamble Company', lastUpdate: Date.now() },
      KO: { price: 70.54, change: 0.10, changePercent: 0.14, previousClose: 70.44, open: 70.54, high: 70.80, low: 70.20, volume: 0, marketState: 'CLOSED', name: 'The Coca-Cola Company', lastUpdate: Date.now() },
      MRK: { price: 99.15, change: -0.85, changePercent: -0.85, previousClose: 100.00, open: 99.15, high: 100.50, low: 98.80, volume: 0, marketState: 'CLOSED', name: 'Merck & Co., Inc.', lastUpdate: Date.now() },
      JNJ: { price: 219.00, change: 0.34, changePercent: 0.16, previousClose: 218.66, open: 219.00, high: 219.57, low: 218.00, volume: 0, marketState: 'CLOSED', name: 'Johnson & Johnson', lastUpdate: Date.now() },
      AMGN: { price: 325.50, change: -4.91, changePercent: -1.49, previousClose: 330.41, open: 325.50, high: 328.00, low: 323.00, volume: 0, marketState: 'CLOSED', name: 'Amgen Inc.', lastUpdate: Date.now() },
      CVX: { price: 166.26, change: 2.41, changePercent: 1.47, previousClose: 163.85, open: 166.26, high: 167.50, low: 165.00, volume: 0, marketState: 'CLOSED', name: 'Chevron Corporation', lastUpdate: Date.now() },
      VZ: { price: 39.04, change: 0.13, changePercent: 0.33, previousClose: 38.91, open: 39.04, high: 39.46, low: 38.90, volume: 0, marketState: 'CLOSED', name: 'Verizon Communications Inc.', lastUpdate: Date.now() },
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
