"use client";

import { useState, useEffect } from "react";

const PLATFORMS = [
  { key: "youtube", label: "YouTube" },
  { key: "instagram", label: "Instagram" },
  { key: "tiktok", label: "TikTok" },
];

function formatCount(n) {
  if (n == null) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function formatTimestamp(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// Sorted by views (highest first) rather than recency - the point of this
// view is "how did each post do", so the best performer should be the
// first thing visible, not buried in a chronological list.
function AnalyticsChart({ posts }) {
  if (!posts || posts.length === 0) return null;
  const maxViews = Math.max(1, ...posts.map((p) => p.views || 0));
  const sorted = [...posts].sort((a, b) => (b.views ?? -1) - (a.views ?? -1));

  return (
    <div className="chart-list">
      {sorted.map((post, i) => (
        <div className="chart-row" key={post.url || post.id || i}>
          <a
            href={post.url}
            target="_blank"
            rel="noreferrer"
            className="chart-row-title"
            title={post.title || post.url}
          >
            {post.title || post.url}
          </a>
          <div className="chart-bar-track">
            <div
              className="chart-bar-fill"
              style={{ width: `${post.views ? Math.max(2, (post.views / maxViews) * 100) : 0}%` }}
            />
          </div>
          <div className="chart-row-stats">
            <span>{formatCount(post.views)} views</span>
            {post.likes != null && <span>{formatCount(post.likes)} likes</span>}
            {post.comments != null && <span>{formatCount(post.comments)} comments</span>}
            {post.shares != null && <span>{formatCount(post.shares)} shares</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function DashboardTab() {
  const [activePlatform, setActivePlatform] = useState("youtube");
  const [dataByPlatform, setDataByPlatform] = useState({});
  const [loadingByPlatform, setLoadingByPlatform] = useState({});
  const [errorByPlatform, setErrorByPlatform] = useState({});

  useEffect(() => {
    if (!dataByPlatform[activePlatform] && !loadingByPlatform[activePlatform]) {
      loadPlatform(activePlatform);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePlatform]);

  async function loadPlatform(platform) {
    setLoadingByPlatform((s) => ({ ...s, [platform]: true }));
    setErrorByPlatform((s) => ({ ...s, [platform]: "" }));
    try {
      const path = platform === "youtube" ? "/api/analytics/youtube" : `/api/analytics/stats?platform=${platform}`;
      const res = await fetch(path);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't load stats.");
      setDataByPlatform((s) => ({
        ...s,
        [platform]: {
          posts: data.posts || [],
          lastFetchedAt: platform === "youtube" ? new Date().toISOString() : data.lastFetchedAt,
        },
      }));
    } catch (err) {
      setErrorByPlatform((s) => ({ ...s, [platform]: err.message || "Couldn't load stats." }));
    }
    setLoadingByPlatform((s) => ({ ...s, [platform]: false }));
  }

  const current = dataByPlatform[activePlatform];
  const loading = loadingByPlatform[activePlatform];
  const err = errorByPlatform[activePlatform];

  return (
    <div className="main" style={{ maxWidth: 900 }}>
      <div className="card">
        <div className="tabs">
          {PLATFORMS.map((p) => (
            <button
              key={p.key}
              type="button"
              className={`tab-btn ${activePlatform === p.key ? "active" : ""}`}
              onClick={() => setActivePlatform(p.key)}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="field" style={{ marginTop: 16, marginBottom: 4 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <p className="hint" style={{ margin: 0 }}>
              {current?.lastFetchedAt
                ? `Last updated ${formatTimestamp(current.lastFetchedAt)}`
                : "Not loaded yet"}
            </p>
            {activePlatform === "youtube" ? (
              <button type="button" className="btn-ghost" onClick={() => loadPlatform("youtube")} disabled={loading}>
                {loading ? "Refreshing…" : "Refresh"}
              </button>
            ) : (
              <span className="hint">Ask Claude to refresh {PLATFORMS.find((p) => p.key === activePlatform)?.label} stats</span>
            )}
          </div>
        </div>

        {activePlatform !== "youtube" && (
          <p className="hint" style={{ marginBottom: 16 }}>
            {PLATFORMS.find((p) => p.key === activePlatform)?.label}'s post list can only be read from a real
            logged-in-style browser session, not automatically by this site - so this updates whenever you ask
            Claude to pull the latest numbers, not live.
          </p>
        )}

        {err && <div className="error-banner">{err}</div>}

        {loading && !current && <p className="hint">Loading…</p>}

        {current && current.posts.length === 0 && !loading && (
          <p className="hint">No stats stored yet for this platform.</p>
        )}

        {current && current.posts.length > 0 && <AnalyticsChart posts={current.posts} />}
      </div>
    </div>
  );
}
