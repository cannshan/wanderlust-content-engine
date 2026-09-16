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

// Sunday-start week, for the visitor-facing badge below - resets every
// Sunday rather than the 1st, since that badge isn't tied to the monthly
// billing-cycle cap the developer badge checks against; it's just a plain
// "what has this cost recently" read for whoever's actually using the app.
function startOfWeekIso() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
  return start.toISOString();
}

// Kept in sync with lib/budget.js's TIERS/CURRENT_TIER by hand, not
// imported from there directly - see the comment above startOfMonthIso.
const CURRENT_TIER_LABEL = "Gold";
const CURRENT_TIER_CAP_USD = 80;

const REFRESH_MS = 60_000;
// Which of the two badges below renders is decided by hostname, not a
// manual flag: localhost/127.0.0.1 (any port) is you, developing - the
// full monthly/every-source/tier-cap view. Any real deployed hostname is
// someone actually using the app - a plain weekly total of real usage
// only, with your own local testing never mixed into what they see.
const LOCAL_HOSTNAMES = ["localhost", "127.0.0.1"];

// Which bucket the headline number counts, on the developer badge only -
// the visitor-facing badge is always locked to "remote", since showing a
// real visitor an "Testing" bucket that means nothing to them (or letting
// them see the app's own dev-testing spend at all) isn't the point.
// "remote" is the default here too: the question this badge exists to
// answer is what the app costs when someone actually uses it, and a total
// quietly inflated by a morning of development testing answers a
// different question badly. The other two are a click away rather than
// gone.
const SOURCES = [
  { key: "remote", label: "Real use", blurb: "the deployed app" },
  { key: "local", label: "Testing", blurb: "localhost" },
  { key: "all", label: "All", blurb: "everything logged" },
];

function usd(n) {
  return `$${(n ?? 0).toFixed(2)}`;
}

// Small badge in the shell's topbar, visible from every tab - see the two
// branches below the loading effects for what it shows to whom. Pulled
// from api_cost_logs (see logUsage() in lib/claude.js and /api/cost-logs)
// either way. Same degrade-gracefully rule as the rest of this app: if
// Supabase/the table isn't set up, or the hostname isn't known yet
// (nothing client-side to read during the server render), this just
// renders nothing rather than an error or a locked-looking placeholder.
export default function MonthlySpend() {
  // null until the hostname effect below runs client-side, so the first
  // client render matches the (also-nothing-shown) server render instead
  // of guessing which badge to show and possibly flashing the wrong one.
  const [role, setRole] = useState(null);
  const [data, setData] = useState(null);
  const [available, setAvailable] = useState(true);
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState("remote");

  useEffect(() => {
    setRole(LOCAL_HOSTNAMES.includes(window.location.hostname) ? "local" : "remote");
  }, []);

  const isDeveloper = role === "local";

  useEffect(() => {
    if (!role) return;
    let cancelled = false;

    async function load() {
      try {
        // The visitor-facing badge is always this week, always remote-only
        // - the developer badge keeps its existing month + selectable
        // source.
        const since = isDeveloper ? startOfMonthIso() : startOfWeekIso();
        const effectiveSource = isDeveloper ? source : "remote";
        const res = await fetch(
          `/api/cost-logs?since=${encodeURIComponent(since)}&limit=2000&source=${effectiveSource}`
        );
        if (!res.ok) {
          if (!cancelled) setAvailable(false);
          return;
        }
        const json = await res.json();
        if (!cancelled) setData(json);
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
  }, [role, isDeveloper, source]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!role || !available || !data) return null;

  const byFeature = data.byFeature || [];

  if (!isDeveloper) {
    // The visitor-facing badge: one number (this week's real usage so
    // far) and a breakdown toggle, nothing else - no source chips (always
    // remote, nothing to switch between), no tier-cap bar (that cap is a
    // monthly developer/budget concept, not something a visitor's weekly
    // total should be measured against).
    return (
      <div className="monthly-spend">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title="Real usage cost since this Sunday - click for the breakdown"
          style={{
            background: "transparent",
            border: "none",
            padding: 0,
            font: "inherit",
            color: "inherit",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          This week: <strong>{usd(data.totalCostUsd)}</strong> <span style={{ opacity: 0.6 }}>{open ? "▾" : "▸"}</span>
        </button>

        {open && (
          <div className="monthly-spend-panel">
            {byFeature.length === 0 ? (
              <p className="hint" style={{ margin: 0 }}>
                Nothing logged yet this week.
              </p>
            ) : (
              <table className="monthly-spend-table">
                <thead>
                  <tr>
                    <th>Feature</th>
                    <th style={{ textAlign: "right" }}>Cost</th>
                    <th style={{ textAlign: "right" }}>Calls</th>
                  </tr>
                </thead>
                <tbody>
                  {byFeature.map((f) => (
                    <tr key={f.feature}>
                      <td>{f.feature}</td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{usd(f.cost_usd)}</td>
                      <td style={{ textAlign: "right", color: "var(--ink-faint)" }}>{f.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    );
  }

  const totals = data.totals || {};
  const counts = data.counts || {};
  // The headline follows whichever bucket is selected, so the bar and the
  // number never disagree with the table underneath them.
  const shown = source === "all" ? totals.all : source === "local" ? totals.local : totals.remote;
  const percent = Math.min(100, ((shown || 0) / CURRENT_TIER_CAP_USD) * 100);
  // Matches the current tier's cap in lib/budget.js (not yet enforced,
  // see ENFORCE_BUDGET there) - amber once more than half spent, red once
  // the cap itself is reached, so this reads as an early warning, not
  // just a number.
  const barColor = shown >= CURRENT_TIER_CAP_USD ? "var(--bad)" : percent >= 50 ? "var(--amber)" : "var(--forest)";
  const activeSource = SOURCES.find((s) => s.key === source);

  return (
    <div className="monthly-spend">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={`${activeSource.label} (${activeSource.blurb}) this month, against the ${CURRENT_TIER_LABEL} tier's $${CURRENT_TIER_CAP_USD}/mo cap (lib/budget.js, not yet enforced) - click for the breakdown. Only visible on localhost.`}
        style={{
          background: "transparent",
          border: "none",
          padding: 0,
          font: "inherit",
          color: "inherit",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        {activeSource.label} · this month: <strong>{usd(shown)}</strong> / ${CURRENT_TIER_CAP_USD}{" "}
        <span style={{ opacity: 0.6 }}>{open ? "▾" : "▸"}</span>
        <div className="monthly-spend-bar">
          <div className="monthly-spend-bar-fill" style={{ width: `${percent}%`, background: barColor }} />
        </div>
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            left: 0,
            zIndex: 40,
            width: 340,
            maxHeight: "70vh",
            overflowY: "auto",
            background: "var(--bg-raised)",
            border: "1px solid var(--line)",
            borderRadius: 10,
            boxShadow: "0 8px 28px rgba(0,0,0,.14)",
            padding: 12,
          }}
        >
          <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
            {SOURCES.map((s) => (
              <button
                key={s.key}
                type="button"
                className={`category-chip-btn ${source === s.key ? "active" : ""}`}
                onClick={() => setSource(s.key)}
                title={s.blurb}
              >
                {s.label}
              </button>
            ))}
          </div>

          {/* The split is always all three buckets, whatever's selected -
              the point of the badge is comparing them. "Unknown" is every
              row logged before calls started recording where they came
              from; it's shown rather than folded into either side so the
              three still add up to the real total. */}
          <div style={{ fontSize: 11.5, color: "var(--ink-faint)", marginBottom: 10, lineHeight: 1.7 }}>
            <div>
              Real use <strong style={{ color: "var(--ink)" }}>{usd(totals.remote)}</strong> · {counts.remote || 0} calls
            </div>
            <div>
              Testing <strong style={{ color: "var(--ink)" }}>{usd(totals.local)}</strong> · {counts.local || 0} calls
            </div>
            {counts.unknown > 0 && (
              <div>
                Unknown (before tracking) <strong style={{ color: "var(--ink)" }}>{usd(totals.unknown)}</strong> ·{" "}
                {counts.unknown} calls
              </div>
            )}
          </div>

          {byFeature.length === 0 ? (
            <p className="hint" style={{ margin: 0 }}>
              Nothing logged for {activeSource.label.toLowerCase()} this month.
            </p>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
              <thead>
                <tr style={{ color: "var(--ink-faint)", textAlign: "left" }}>
                  <th style={{ fontWeight: 500, padding: "3px 0" }}>Feature</th>
                  <th style={{ fontWeight: 500, padding: "3px 0", textAlign: "right" }}>Cost</th>
                  <th style={{ fontWeight: 500, padding: "3px 0", textAlign: "right" }}>Calls</th>
                </tr>
              </thead>
              <tbody>
                {byFeature.map((f) => (
                  <tr key={f.feature} style={{ borderTop: "1px solid var(--line)" }}>
                    <td style={{ padding: "4px 6px 4px 0", wordBreak: "break-word" }}>{f.feature}</td>
                    <td style={{ padding: "4px 0", textAlign: "right", whiteSpace: "nowrap" }}>{usd(f.cost_usd)}</td>
                    <td style={{ padding: "4px 0", textAlign: "right", color: "var(--ink-faint)" }}>{f.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
