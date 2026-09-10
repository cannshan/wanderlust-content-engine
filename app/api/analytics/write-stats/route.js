import { NextResponse } from "next/server";
import { getSupabase } from "../../../../lib/supabase";

// This is how Instagram/TikTok data actually gets into the Dashboard tab -
// see the "Data source" comment in lib/analytics.js for why: their post
// lists only exist inside a real browser session, not something this
// deployed app can fetch on its own. Claude calls this after browsing the
// profile and pulling stats for each post, from inside the same
// password-gated browser session already used to test the rest of this
// app - so this route relies entirely on proxy.js's existing password gate
// for protection, same as every other route here, rather than needing its
// own auth.
//
// Replaces the platform's entire stored list on each call (delete then
// insert) instead of upserting individual rows - simpler than diffing, and
// correct here: a "last 20 posts" snapshot should fully reflect the latest
// pull, not accumulate rows for posts that have since fallen out of the
// most-recent-20 window.
export async function POST(req) {
  const supabase = getSupabase();
  if (!supabase) {
    return NextResponse.json(
      { error: "Analytics storage isn't configured yet (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing)." },
      { status: 500 }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { platform, posts } = body;
  if (!platform || !Array.isArray(posts)) {
    return NextResponse.json({ error: "platform and posts (an array) are required." }, { status: 400 });
  }

  const { error: deleteError } = await supabase.from("post_stats").delete().eq("platform", platform);
  if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 500 });

  if (posts.length === 0) {
    return NextResponse.json({ written: 0 });
  }

  const rows = posts.map((p, i) => ({
    platform,
    post_url: p.url,
    title: p.title || null,
    thumbnail: p.thumbnail || null,
    views: p.views ?? null,
    likes: p.likes ?? null,
    comments: p.comments ?? null,
    shares: p.shares ?? null,
    posted_at: p.date || null,
    fetched_order: i,
  }));

  const { error: insertError } = await supabase.from("post_stats").insert(rows);
  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });

  return NextResponse.json({ written: rows.length });
}
