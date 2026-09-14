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

// Small badge in the shell's topbar, visible from every tab - a running
// total of what this week's Claude API calls have actually cost, pulled
// from api_cost_logs (see logUsage() in lib/claude.js and /api/cost-logs).
// Same degrade-gracefully rule as the rest of this app: if Supabase/the
// table isn't set up, this just renders nothing rather than an error.
export default function WeeklySpend() {
  const [totalUsd, setTotalUsd] = useState(null);
  const [available, setAvailable] = useState(true);

  useEffect(() => {
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
  }, []);

  if (!available || totalUsd === null) return null;

  return (
    <div className="weekly-spend" title="Total real Claude API cost logged since Monday, across every feature">
      This week: <strong>${totalUsd.toFixed(2)}</strong>
    </div>
  );
}
