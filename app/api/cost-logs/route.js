import { NextResponse } from "next/server";
import { getSupabase } from "../../../lib/supabase";

// Read-only view over api_cost_logs (written by logUsage() in lib/claude.js
// on every real Claude API call). Returns both the raw rows and a
// by-feature summary in one response so this can answer "what am I
// spending, and on what" without a separate aggregation query - visit
// /api/cost-logs directly in a browser, or pass ?limit= to see more/fewer
// rows (defaults to the most recent 500). Optional ?since=<ISO timestamp>
// filters to rows at or after that time - the "This week" dashboard badge
// (see WeeklySpend.js) computes the start of the current week client-side
// and passes it here, rather than this route owning a fixed idea of what
// "the week" means.
//
// raw_response (the full model output logUsage() stores for
// findDiscoveryIdeas/findNearbyFilmingIdeas - see lib/claude.js) is left
// out of the default row shape and only included with ?includeRaw=1 -
// WeeklySpend.js polls this route every 60 seconds for a cost total it
// never looks at raw text for, and that text can run several KB per row,
// so dragging it along on every poll would be pure wasted bandwidth for a
// field only ever needed when actually debugging a specific bad result.
const LOG_COLUMNS =
  "id, created_at, feature, model, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, searches, duration_ms";

export async function GET(req) {
  const supabase = getSupabase();
  if (!supabase) {
    return NextResponse.json(
      { error: "Cost logging isn't configured yet (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing)." },
      { status: 500 }
    );
  }

  const { searchParams } = new URL(req.url);
  const limit = Math.min(parseInt(searchParams.get("limit") || "500", 10) || 500, 2000);
  const since = searchParams.get("since");
  const includeRaw = searchParams.get("includeRaw") === "1";

  let query = supabase
    .from("api_cost_logs")
    .select(includeRaw ? `${LOG_COLUMNS}, raw_response` : LOG_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (since) query = query.gte("created_at", since);
  const { data, error } = await query;

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const byFeatureMap = {};
  let totalCostUsd = 0;
  for (const row of data) {
    totalCostUsd += row.cost_usd;
    const entry = byFeatureMap[row.feature] || { feature: row.feature, count: 0, cost_usd: 0, durationTotal: 0, durationCount: 0 };
    entry.count += 1;
    entry.cost_usd += row.cost_usd;
    if (row.duration_ms != null) {
      entry.durationTotal += row.duration_ms;
      entry.durationCount += 1;
    }
    byFeatureMap[row.feature] = entry;
  }
  const byFeature = Object.values(byFeatureMap)
    .map((entry) => ({
      feature: entry.feature,
      count: entry.count,
      cost_usd: Number(entry.cost_usd.toFixed(4)),
      avg_cost_usd: Number((entry.cost_usd / entry.count).toFixed(4)),
      avg_duration_ms: entry.durationCount ? Math.round(entry.durationTotal / entry.durationCount) : null,
    }))
    .sort((a, b) => b.cost_usd - a.cost_usd);

  return NextResponse.json({
    totalRows: data.length,
    totalCostUsd: Number(totalCostUsd.toFixed(4)),
    oldestLogAt: data.length ? data[data.length - 1].created_at : null,
    newestLogAt: data.length ? data[0].created_at : null,
    byFeature,
    logs: data,
  });
}
