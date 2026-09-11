import { NextResponse } from "next/server";
import { getSupabase } from "../../../../lib/supabase";

export async function PATCH(req, { params }) {
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

  const { id } = await params;
  const { platform, stats, tier, why, caption } = body;

  if (!platform || !caption) {
    return NextResponse.json({ error: "platform and caption are required." }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("profile_captions")
    .update({
      platform,
      stats: stats || null,
      tier: tier === "outlier" ? "outlier" : "baseline",
      why: why || null,
      caption,
    })
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ caption: data });
}

export async function DELETE(req, { params }) {
  const supabase = getSupabase();
  if (!supabase) {
    return NextResponse.json(
      { error: "Profile isn't configured yet (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing)." },
      { status: 500 }
    );
  }

  const { id } = await params;
  const { error } = await supabase.from("profile_captions").delete().eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
