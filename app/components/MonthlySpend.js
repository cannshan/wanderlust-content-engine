"use client";

import { useState, useEffect } from "react";

// Calendar month, not a rolling 30 days - resets on the 1st, matching how
// a real monthly subscription's billing cycle would work. Same boundary
// startOfMonthIso() in lib/budget.js computes server-side; duplicated
// here rather than imported since that file also touches the server-only
// Supabase client, which has no reason to be pulled into a client bundle.
function startOfMonthIso() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
}

// Kept in sync with lib/budget.js's TIERS/CURRENT_TIER by hand, not
// imported from there directly - see the comment above startOfMonthIso.
const CURRENT_TIER_LABEL = "Gold";
const CURRENT_TIER_CAP_USD = 80;

const REFRESH_MS = 60_000;
// There's only one shared DASHBOARD_PASSWORD in this app - no separate
// "owner" account to gate this on, and it's not something the person
// actually using the deployed app (not the one building it) should ever
// see. Gated on hostname instead of a manual flag: always on for local
// dev (localhost/127.0.0.1, whatever port), always off on any deployed
// hostname - no link to remember, and nobody using the real site can end
// up seeing it, on any device, ever.
const LOCAL_HOSTNAMES = ["localhost", "127.0.0.1"];

// Small badge in the shell's topbar, visible from every tab - a running
// total of what this month's Claude API calls have actually cost, pulled
// from api_cost_logs (see logUsage() in lib/claude.js and /api/cost-logs),
// shown against the current tier's cap (see lib/budget.js - not currently
// enforced, just visible here ahead of being turned on for a real
// account). Same degrade-gracefully rule as the rest of this app: if
// Supabase/the table isn't set up, or this isn't a local dev hostname,
// this just renders nothing rather than an error or a locked-looking
// placeholder.
export default function MonthlySpend() {
  const [totalUsd, setTotalUsd] = useState(null);
  const [available, setAvailable] = useState(true);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(LOCAL_HOSTNAMES.includes(window.location.hostname));
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`/api/cost-logs?since=${encodeURIComponent(startOfMonthIso())}&limit=2000`);
        if (!res.ok) {
          if (!cancelled) setAvailable(false);
          return;
        }
        const data = await res.json();
        if (!cancelled) setTotalUsd(data.totalCostUsd ?? 0);
      } catch {
        if (!cancelled) setAvailable(false);
      }
    }

    load();
    const interval = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [visible]);

  if (!visible || !available || totalUsd === null) return null;

  const percent = Math.min(100, (totalUsd / CURRENT_TIER_CAP_USD) * 100);
  // Matches the current tier's cap in lib/budget.js (not yet enforced,
  // see ENFORCE_BUDGET there) - amber once more than half spent, red once
  // the cap itself is reached, so this reads as an early warning, not
  // just a number.
  const barColor = totalUsd >= CURRENT_TIER_CAP_USD ? "var(--bad)" : percent >= 50 ? "var(--amber)" : "var(--forest)";

  return (
    <div
      className="monthly-spend"
      title={`Total real Claude API cost logged since the 1st, against the ${CURRENT_TIER_LABEL} tier's $${CURRENT_TIER_CAP_USD}/mo cap (lib/budget.js, not yet enforced) - only visible on localhost`}
    >
      {CURRENT_TIER_LABEL} · this month: <strong>${totalUsd.toFixed(2)}</strong> / ${CURRENT_TIER_CAP_USD}
      <div className="monthly-spend-bar">
        <div className="monthly-spend-bar-fill" style={{ width: `${percent}%`, background: barColor }} />
      </div>
    </div>
  );
}
