import { NextResponse } from "next/server";
import { getSupabase } from "../../../../lib/supabase";

// Read-only: returns whatever's currently stored for a platform, plus when
// it was last refreshed. This is how the Dashboard tab gets Instagram and
// TikTok data - both need a real browser session to discover their post
// list (see the "Data source" comment in lib/analytics.js), which a
// Vercel serverless function can't do, so there's no live fetch here to
// trigger - just a read of whatever Claude last wrote via /write-stats.
export async function GET(req) {
  const supabase = getSupabase();
  if (!supabase) {
    return NextResponse.json(
      { error: "Analytics storage isn't configured yet (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing)." },
      { status: 500 }
    );
  }

  const platform = new URL(req.url).searchParams.get("platform");
  if (!platform) {
    return NextResponse.json({ error: "platform query param is required." }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("post_stats")
    .select("*")
    .eq("platform", platform)
    .order("fetched_order", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const lastFetchedAt = data.length > 0 ? data[0].fetched_at : null;
  return NextResponse.json({ posts: data, lastFetchedAt });
}
