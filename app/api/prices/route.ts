import { NextResponse } from 'next/server';

// Free Yahoo Finance API endpoint (no API key needed)
// This uses the public Yahoo Finance query endpoint

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const symbols = searchParams.get('symbols') || 'HD,NKE,UNH,PG,KO,MRK,JNJ,AMGN,CVX,VZ';

  try {
    // Note: For production, you might want to use a more reliable free API
    // Options: Alpha Vantage (free tier), Finnhub (free tier), or client-side yfinance

    // For now, return sample data to avoid API costs
    const samplePrices: Record<string, { price: number; change: number; changePercent: number }> = {
      HD: { price: 380.17, change: 5.53, changePercent: 1.48 },
      NKE: { price: 71.23, change: -0.45, changePercent: -0.63 },
      UNH: { price: 331.02, change: -12.96, changePercent: -3.77 },
      PG: { price: 144.53, change: 0.77, changePercent: 0.54 },
      KO: { price: 70.44, change: -0.07, changePercent: -0.10 },
      MRK: { price: 99.15, change: -0.85, changePercent: -0.85 },
      JNJ: { price: 218.66, change: 14.27, changePercent: 6.98 },
      AMGN: { price: 330.41, change: 4.31, changePercent: 1.32 },
      CVX: { price: 166.26, change: 2.41, changePercent: 1.47 },
      VZ: { price: 38.91, change: -0.86, changePercent: -2.16 },
    };

    const requestedSymbols = symbols.split(',');
    const prices = requestedSymbols.reduce((acc, symbol) => {
      if (samplePrices[symbol]) {
        acc[symbol] = samplePrices[symbol];
      }
      return acc;
    }, {} as Record<string, typeof samplePrices[string]>);

    return NextResponse.json({
      prices,
      timestamp: new Date().toISOString(),
      source: 'sample_data',
      note: 'Using sample data to avoid API costs. Connect to live API for real-time prices.',
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch prices' },
      { status: 500 }
    );
  }
}
