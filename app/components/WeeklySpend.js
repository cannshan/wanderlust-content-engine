"use client";

import { useState, useEffect } from "react";

// Monday 00:00 local time - a fixed calendar-week boundary (not a rolling
// 7 days), so the number visibly resets each Monday rather than always
// showing "the last 7 days" regardless of which day it is.
function startOfWeekIso() {
  const now = new Date();
  const day = now.getDay();
  const diffToMonday = day === 0 ? 6 : day - 1;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diffToMonday);
  return monday.toISOString();
}

const REFRESH_MS = 60_000;
// There's only one shared DASHBOARD_PASSWORD in this app - no separate
// "owner" account to gate this on - so visibility is a per-browser
// localStorage flag instead: hidden by default (what anyone else sharing
// the password sees), and only turned on in the one browser that visits
// with ?showCosts=1 once. That visit persists the flag, so it doesn't
// need to be in the URL again after the first time.
const SHOW_FLAG_KEY = "wwwShowCostBadge";

// Small badge in the shell's topbar, visible from every tab - a running
// total of what this week's Claude API calls have actually cost, pulled
// from api_cost_logs (see logUsage() in lib/claude.js and /api/cost-logs).
// Same degrade-gracefully rule as the rest of this app: if Supabase/the
// table isn't set up, or this browser hasn't unlocked it, this just
// renders nothing rather than an error or a locked-looking placeholder.
export default function WeeklySpend() {
  const [totalUsd, setTotalUsd] = useState(null);
  const [available, setAvailable] = useState(true);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get("showCosts") === "1") {
        localStorage.setItem(SHOW_FLAG_KEY, "1");
      }
      setVisible(localStorage.getItem(SHOW_FLAG_KEY) === "1");
    } catch {
      // Storage unavailable (private browsing) - stays hidden, same as
      // the default for everyone who hasn't unlocked it.
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`/api/cost-logs?since=${encodeURIComponent(startOfWeekIso())}&limit=2000`);
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

  return (
    <div className="weekly-spend" title="Total real Claude API cost logged since Monday, across every feature - only visible in this browser">
      This week: <strong>${totalUsd.toFixed(2)}</strong>
    </div>
  );
}
