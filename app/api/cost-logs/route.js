import { NextResponse } from "next/server";
import { getSupabase } from "../../../lib/supabase";

// Read-only view over api_cost_logs (written by logUsage() in lib/claude.js
// on every real Claude API call). Returns both the raw rows and a
// by-feature summary in one response so this can answer "what am I
// spending, and on what" without a separate aggregation query - visit
// /api/cost-logs directly in a browser, or pass ?limit= to see more/fewer
// rows (defaults to the most recent 500). Optional ?since=<ISO timestamp>
// filters to rows at or after that time - the "this month" dashboard
// badge (see MonthlySpend.js) computes the start of the current calendar
// month client-side and passes it here, rather than this route owning a
// fixed idea of what "the month" means.
//
// raw_response (the full model output logUsage() stores for
// findDiscoveryIdeas/findNearbyFilmingIdeas - see lib/claude.js) is left
// out of the default row shape and only included with ?includeRaw=1 -
// MonthlySpend.js polls this route every 60 seconds for a cost total it
// never looks at raw text for, and that text can run several KB per row,
// so dragging it along on every poll would be pure wasted bandwidth for a
// field only ever needed when actually debugging a specific bad result.
//
// is_local (written by logUsage from the request's Host header) is what
// separates real usage from development. ?source= filters on it:
// "remote" for what someone actually using the deployed app cost,
// "local" for your own testing, "all" for both. The totals block always
// reports every bucket regardless of the filter, so a caller can show
// the split without a second request - and "unknown" is reported
// honestly rather than folded into either side, since every row logged
// before this column existed has no origin recorded.
const LOG_COLUMNS =
  "id, created_at, feature, model, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, searches, duration_ms, is_local";

const SOURCES = ["all", "remote", "local"];

function matchesSource(row, source) {
  if (source === "remote") return row.is_local === false;
  if (source === "local") return row.is_local === true;
  return true;
}

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
  const requestedSource = searchParams.get("source");
  const source = SOURCES.includes(requestedSource) ? requestedSource : "all";

  let query = supabase
    .from("api_cost_logs")
    .select(includeRaw ? `${LOG_COLUMNS}, raw_response` : LOG_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (since) query = query.gte("created_at", since);
  const { data, error } = await query;

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Every bucket is totalled from the same fetched rows, so the split is
  // always available even when byFeature/logs below are narrowed to one
  // source - one round trip answers both "what did this cost" and "whose
  // spend was it".
  const totals = { all: 0, remote: 0, local: 0, unknown: 0 };
  const counts = { all: 0, remote: 0, local: 0, unknown: 0 };
  for (const row of data) {
    const bucket = row.is_local === true ? "local" : row.is_local === false ? "remote" : "unknown";
    totals.all += row.cost_usd;
    totals[bucket] += row.cost_usd;
    counts.all += 1;
    counts[bucket] += 1;
  }
  for (const key of Object.keys(totals)) totals[key] = Number(totals[key].toFixed(4));

  const rows = data.filter((row) => matchesSource(row, source));

  const byFeatureMap = {};
  let totalCostUsd = 0;
  for (const row of rows) {
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
    source,
    totalRows: rows.length,
    // Scoped to `source`, so an existing caller passing no source still
    // sees the same all-inclusive number it always did.
    totalCostUsd: Number(totalCostUsd.toFixed(4)),
    totals,
    counts,
    oldestLogAt: rows.length ? rows[rows.length - 1].created_at : null,
    newestLogAt: rows.length ? rows[0].created_at : null,
    byFeature,
    logs: rows,
  });
}
