import { NextResponse } from "next/server";
import { getSupabase } from "../../../../lib/supabase";

// Takes the full instruction list in its new order (not a single moved
// item) and assigns each one's position from its index - simpler than a
// per-item move endpoint, and avoids ever leaving a stale/duplicate
// position behind if a request is dropped mid-drag.
//
// Plain per-row updates rather than one upsert() call - upsert's INSERT
// path (used whenever PostgREST doesn't resolve the conflict, which it
// didn't here even given each row's own real id) has no `text` to
// satisfy that column's NOT NULL constraint, since this request only
// ever carries id + position for rows that already exist.
export async function PATCH(req) {
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

  const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === "string" && id) : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "ids is required." }, { status: 400 });
  }

  const results = await Promise.all(
    ids.map((id, position) => supabase.from("profile_instructions").update({ position }).eq("id", id))
  );
  const failed = results.find((r) => r.error);

  if (failed) return NextResponse.json({ error: failed.error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
