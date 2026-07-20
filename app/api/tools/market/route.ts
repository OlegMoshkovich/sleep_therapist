import { NextRequest, NextResponse } from "next/server";

/**
 * Mock market-data tool for the Financial Analyst demo. The analyst policy calls
 * this via an HTTP tool node (`get_market_data(query)`), and the model analyzes
 * the returned snapshot. Deterministic pseudo-data keyed off the query so there
 * are no API keys or external dependencies — good enough to demonstrate a
 * tool-using policy. NOT real market data; do not use for actual decisions.
 */

// Deterministic hash so the same query returns a stable-ish snapshot.
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function pct(seed: number, lo: number, hi: number): number {
  const r = (seed % 10000) / 10000;
  return Number((lo + r * (hi - lo)).toFixed(2));
}

export async function GET(request: NextRequest) {
  const query = (request.nextUrl.searchParams.get("query") ?? "").trim();
  if (!query) {
    return NextResponse.json({ error: "Missing query (a ticker, index, or market topic)." }, { status: 400 });
  }

  const seed = hash(query.toLowerCase());
  const price = Number((20 + (seed % 480) + ((seed >> 4) % 100) / 100).toFixed(2));
  const dayChange = pct(seed, -3.5, 3.5);
  const week = pct(seed >> 2, -8, 8);
  const month = pct(seed >> 3, -15, 15);
  const ytd = pct(seed >> 5, -25, 40);
  const pe = pct(seed >> 6, 8, 42);
  const beta = pct(seed >> 7, 0.4, 2.1);
  const rsi = Math.round(pct(seed >> 8, 20, 80));
  const vol = Math.round(pct(seed >> 9, 10, 55));

  const indices = {
    sp500: { level: 5100 + (seed % 400), change_pct: pct(seed >> 1, -1.5, 1.5) },
    nasdaq: { level: 16000 + (seed % 1200), change_pct: pct(seed >> 2, -2, 2) },
    dow: { level: 38000 + (seed % 2000), change_pct: pct(seed >> 3, -1.2, 1.2) },
    us10y_yield_pct: pct(seed >> 4, 3.6, 4.8),
    vix: pct(seed >> 5, 11, 28),
  };

  const headlines = [
    `${query.toUpperCase()} moves ${dayChange >= 0 ? "up" : "down"} ${Math.abs(dayChange)}% amid sector rotation`,
    `Analysts revise ${query} estimates ahead of earnings`,
    `Macro: rates and inflation prints steer risk appetite`,
  ];

  return NextResponse.json({
    query,
    as_of: "mock snapshot (deterministic, not real data)",
    quote: {
      last: price,
      day_change_pct: dayChange,
      week_change_pct: week,
      month_change_pct: month,
      ytd_change_pct: ytd,
    },
    fundamentals: { pe_ratio: pe, beta, implied_volatility_pct: vol },
    technicals: { rsi_14: rsi, trend: rsi > 55 ? "bullish" : rsi < 45 ? "bearish" : "neutral" },
    indices,
    headlines,
    disclaimer: "Mock data for demonstration only — not investment advice.",
  });
}
