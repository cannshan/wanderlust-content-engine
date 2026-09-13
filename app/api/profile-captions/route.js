import { NextResponse } from "next/server";
import { getSupabase } from "../../../lib/supabase";

// The Profile tab's editable version of what used to be a hardcoded list
// of 15 real captions in lib/voiceProfile.js (see DEFAULT_SAMPLE_CAPTIONS
// there, still used as a fallback if this table is empty/unconfigured).
// Read by buildSystemPrompt() to ground generated copy in Leah's actual
// voice - see the comment there for why outlier/baseline is split out.

export async function GET() {
  const supabase = getSupabase();
  if (!supabase) {
    return NextResponse.json(
      { error: "Profile isn't configured yet (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing)." },
      { status: 500 }
    );
  }

  const { data, error } = await supabase
    .from("profile_captions")
    .select("*")
    .order("position", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ captions: data });
}

export async function POST(req) {
  const supabase = getSupabase();
  if (!supabase) {
    return NextResponse.json(
      { error: "Profile isn't configured yet (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing)." },
      { status: 500 }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { platform, stats, tier, why, caption } = body;

  if (!platform || !caption) {
    return NextResponse.json({ error: "platform and caption are required." }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("profile_captions")
    .insert({
      platform,
      stats: stats || null,
      tier: tier === "outlier" ? "outlier" : "baseline",
      why: why || null,
      caption,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ caption: data });
}
