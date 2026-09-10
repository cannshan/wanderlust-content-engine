"use client";

import { useState } from "react";

const TREND_LABELS = {
  apify: "Live trend data (Apify)",
  web_search: "Checked via live web search",
  estimated: "AI-estimated tags",
};

const PATTERN_LABELS = {
  "animal-content": "Lever: animal content",
  "pop-culture-tie-in": "Lever: pop-culture tie-in",
  "insider-access": "Lever: insider access",
  standard: "No specific lever — standard post",
};

const PLATFORM_LABELS = {
  tiktok: "TikTok",
  instagram: "Instagram",
};

function formatPattern(pattern) {
  return PATTERN_LABELS[pattern] || "Why this should work";
}

const initialForm = {
  idea: "",
  location: "",
  storyBeat: "",
  notes: "",
  lengthSeconds: 60,
};

export default function Dashboard() {
  const [form, setForm] = useState(initialForm);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState("");
  const [activeTab, setActiveTab] = useState("tiktok");

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function generateOne(platformName) {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...form, platform: platformName }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    return data;
  }

  async function onSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setResult(null);
    setActiveTab("tiktok");

    // Two independent, parallel requests - each platform's generation is
    // faster and more reliable on its own than one combined call (a
    // combined version routinely hit Vercel's function timeout in testing).
    const [tiktokOutcome, instagramOutcome] = await Promise.allSettled([
      generateOne("tiktok"),
      generateOne("instagram"),
    ]);

    const platforms = {};
    const errors = {};
    if (tiktokOutcome.status === "fulfilled") platforms.tiktok = tiktokOutcome.value;
    else errors.tiktok = tiktokOutcome.reason?.message || "Failed to generate.";
    if (instagramOutcome.status === "fulfilled") platforms.instagram = instagramOutcome.value;
    else errors.instagram = instagramOutcome.reason?.message || "Failed to generate.";

    if (!platforms.tiktok && !platforms.instagram) {
      setError(errors.tiktok || errors.instagram || "Both platforms failed to generate.");
    } else {
      setResult({ platforms, errors });
    }
    setLoading(false);
  }

  function copy(text, label) {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(""), 1500);
  }

  const platform = result?.platforms?.[activeTab];

  return (
    <div className="shell">
      <div className="topbar">
        <div>
          <p className="eyebrow">Wine Wilderness Wanderlust</p>
          <h1>WWW Content Engine</h1>
        </div>
      </div>

      <form onSubmit={onSubmit} className="card">
        <div className="field">
          <label htmlFor="idea">Idea</label>
          <input
            id="idea"
            required
            placeholder="Goat yoga at a working farm"
            value={form.idea}
            onChange={(e) => update("idea", e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="location">Location</label>
          <input
            id="location"
            required
            placeholder="Cricket Creek Farm, Williamstown, MA"
            value={form.location}
            onChange={(e) => update("location", e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="storyBeat">Story beat / detail (optional)</label>
          <textarea
            id="storyBeat"
            rows={2}
            placeholder="Baby goats climb on you mid-pose; class ends with a cheese tasting"
            value={form.storyBeat}
            onChange={(e) => update("storyBeat", e.target.value)}
          />
        </div>

        <div className="field">
          <label>Video length (same target on both platforms)</label>
          <div className="goal-toggle">
            <button
              type="button"
              className={`goal-option ${form.lengthSeconds === 60 ? "active" : ""}`}
              onClick={() => update("lengthSeconds", 60)}
            >
              <span className="goal-title">~60 seconds</span>
              <span className="goal-sub">Required for TikTok Creator Rewards to pay out</span>
            </button>
            <button
              type="button"
              className={`goal-option ${form.lengthSeconds === 30 ? "active" : ""}`}
              onClick={() => update("lengthSeconds", 30)}
            >
              <span className="goal-title">~30 seconds</span>
              <span className="goal-sub">Faster/punchier — won't earn from TikTok Creator Rewards</span>
            </button>
          </div>
        </div>

        <div className="field">
          <label htmlFor="notes">Anything to factor in (optional)</label>
          <input
            id="notes"
            placeholder="A trending hashtag, idea, or anything that is worth mentioning"
            value={form.notes}
            onChange={(e) => update("notes", e.target.value)}
          />
        </div>

        {error && <div className="error-banner">{error}</div>}

        <button className="btn-primary" disabled={loading}>
          {loading ? "Writing…" : "Generate description + tags"}
        </button>
      </form>

      {result && (
        <div className="result card">
          <div className="result-head">
            <h3 style={{ fontSize: 16 }}>Result</h3>
          </div>

          <div className="tabs">
            {["tiktok", "instagram"].map((p) => (
              <button
                key={p}
                type="button"
                className={`tab-btn ${activeTab === p ? "active" : ""}`}
                onClick={() => setActiveTab(p)}
              >
                {PLATFORM_LABELS[p]}
                {result.errors?.[p] && !result.platforms?.[p] && " ⚠"}
              </button>
            ))}
          </div>

          {!platform && result.errors?.[activeTab] && (
            <div className="error-banner">
              {PLATFORM_LABELS[activeTab]} generation failed: {result.errors[activeTab]}
            </div>
          )}

          {platform && (
            <>
              <span className={`badge ${platform.trend_source === "estimated" ? "estimated" : "live"}`} style={{ marginBottom: 14, display: "inline-block" }}>
                {TREND_LABELS[platform.trend_source] || "AI-estimated tags"}
              </span>

              {platform.hook_strategy && (
                <div className="strategy-box">
                  <span className="badge live" style={{ marginBottom: 6, display: "inline-block" }}>
                    {formatPattern(platform.pattern_used)}
                  </span>
                  <p>{platform.hook_strategy}</p>
                </div>
              )}

              {platform.cross_post_warning && (
                <div className="warning-box">
                  <span className="warning-title">Cross-posting both platforms?</span>
                  <p>{platform.cross_post_warning}</p>
                </div>
              )}

              <div className="description-box">{platform.description}</div>
              <button className="btn-ghost" onClick={() => copy(platform.description, "description")} style={{ marginBottom: 20 }}>
                {copied === "description" ? "Copied" : "Copy description"}
              </button>

              <div className="field">
                <label>Hashtags</label>
                <div className="chipset">
                  {platform.hashtags?.map((tag) => (
                    <span className="chip" key={tag}>{tag}</span>
                  ))}
                </div>
                <button
                  className="btn-ghost"
                  onClick={() => copy(platform.hashtags?.join(" "), "tags")}
                >
                  {copied === "tags" ? "Copied" : "Copy all tags"}
                </button>
              </div>

              {platform.hashtag_rationale && (
                <p className="rationale" style={{ marginTop: 16 }}>{platform.hashtag_rationale}</p>
              )}

              {platform.video_length && (
                <div className="field" style={{ marginTop: 24 }}>
                  <label>Video length</label>
                  <div className="video-meta">
                    <span className="video-length-pill">{platform.video_length.target_seconds}</span>
                  </div>
                  {platform.video_length.why && (
                    <p className="rationale" style={{ marginTop: 10 }}>{platform.video_length.why}</p>
                  )}
                  {activeTab === "tiktok" && (
                    <p className="hint" style={{ marginTop: 8 }}>
                      {platform.lengthSeconds < 60
                        ? "At ~30s this won't earn from TikTok Creator Rewards (60s minimum), regardless of performance — a deliberate reach tradeoff, not an oversight."
                        : "Meets TikTok Creator Rewards' 60s minimum, so this one is monetization-eligible."}
                    </p>
                  )}
                  {activeTab === "instagram" && (
                    <p className="hint" style={{ marginTop: 8 }}>
                      Instagram Reels has no minimum length for its own monetization (Gifts on Reels) — this target is purely for completion rate.
                    </p>
                  )}
                </div>
              )}

              {platform.shot_notes?.length > 0 && (
                <div className="field" style={{ marginTop: 20 }}>
                  <label>Filming notes</label>
                  <ul className="shotlist">
                    {platform.shot_notes.map((note, i) => (
                      <li key={i}>{note}</li>
                    ))}
                  </ul>
                </div>
              )}

              {platform.cover_text && (
                <div className="field" style={{ marginTop: 20 }}>
                  <label>Cover / thumbnail text</label>
                  <div className="cover-suggestion">"{platform.cover_text}"</div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
