import { createClient } from "@supabase/supabase-js";

// Server-only client - uses the service_role key, which bypasses row-level
// security, so this file must never be imported from client-side code.
// That's safe here because every Supabase call in this app already only
// happens inside API route handlers (same pattern as ANTHROPIC_API_KEY),
// never in app/page.js directly. No auth/multi-tenancy needed since the
// whole app is already gated behind one shared dashboard password - saved
// ideas are shared across whoever has that password, same as everything
// else here.
let client = null;

export function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  if (!client) client = createClient(url, key);
  return client;
}
