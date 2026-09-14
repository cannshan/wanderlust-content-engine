import { getSupabase } from "./supabase";

// Tier config for when this app has real per-account billing - not wired
// to any actual account yet (see CURRENT_TIER below), but defined now so
// the numbers exist in one place ahead of needing them. capUsd is each
// tier's real-spend ceiling, held at a constant 80% of priceUsd across
// every tier rather than a flat dollar margin - a flat $10 margin made
// Bronze the worst deal (50% of price = usage) and Gold the best (90%),
// which both caps profit at $10/customer forever AND makes the cheapest
// tier look like a rip-off next to the others. 80% everywhere keeps the
// value ratio identical at every tier, so upgrading never feels like a
// worse deal, while absolute margin still grows with price ($4/$10/$20).
export const TIERS = {
  bronze: { label: "Bronze", priceUsd: 20, capUsd: 16 },
  silver: { label: "Silver", priceUsd: 50, capUsd: 40 },
  gold: { label: "Gold", priceUsd: 100, capUsd: 80 },
};

// Which tier today's one shared household/password is "on" - there's no
// real account system yet (see the README), so this is a stand-in for
// the single account that exists today, not a per-customer lookup. Once
// real accounts exist, this becomes a column on that account instead of
// a constant here.
export const CURRENT_TIER = "gold";

export const CURRENT_TIER_CAP_USD = TIERS[CURRENT_TIER].capUsd;

// NOT enforced yet - see ENFORCE below. Built now, ahead of actually
// needing it, for when this app has real per-account billing: a paying
// customer on a given tier needs their own real spend capped below what
// they paid, so a heavy user can't cost more than their plan is worth.
// Blocking on it today would cap the whole shared household together
// (everyone using the one password), not a specific paying customer -
// not what a cap is for yet.
const ENFORCE_BUDGET = false;

// Shared across every route below rather than duplicated per route, so
// the wording only ever needs to change in one place. Deliberately
// explicit (unlike a generic "try again" failure) - once this is
// actually enforced for a real paying customer, they should know
// exactly what happened and when it resets, not be left guessing.
export const BUDGET_LIMIT_MESSAGE = "Monthly Limit Reached. Try again next month!";

// Calendar month, not a rolling 30 days - resets on the 1st so it lines
// up with how a real monthly subscription's billing cycle would work.
// Computed here in the server's own local time rather than any viewer's,
// since a server-side check has no request-specific timezone to go on.
function startOfMonthIso() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
}

// Checked at the top of every route that spends real Anthropic money,
// before making the call - a hard ceiling on combined spend this
// calendar month, not a per-request rate limit, once ENFORCE_BUDGET
// above is flipped on. Always computes and returns the real spentUsd
// regardless of ENFORCE, so the localhost-only spend bar (MonthlySpend.js)
// stays accurate either way - only whether `ok` can ever come back false
// depends on the flag. Fails OPEN (ok: true) if Supabase isn't
// configured or the query itself errors - same degrade-gracefully rule
// as everywhere else Supabase is optional in this app: a cost-tracking
// outage should never be what takes real features down.
export async function checkBudget() {
  const supabase = getSupabase();
  if (!supabase) return { ok: true, spentUsd: 0 };

  try {
    const { data, error } = await supabase
      .from("api_cost_logs")
      .select("cost_usd")
      .gte("created_at", startOfMonthIso());
    if (error) {
      console.error("[checkBudget] query failed, failing open:", error.message);
      return { ok: true, spentUsd: 0 };
    }
    const spentUsd = (data || []).reduce((sum, row) => sum + (row.cost_usd || 0), 0);
    return { ok: !ENFORCE_BUDGET || spentUsd < CURRENT_TIER_CAP_USD, spentUsd };
  } catch (err) {
    console.error("[checkBudget] threw, failing open:", err);
    return { ok: true, spentUsd: 0 };
  }
}
