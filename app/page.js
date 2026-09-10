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

const CONTENT_TYPE_LABELS = {
  entertainment: "Entertainment (single striking moment)",
  practical: "Practical (tips / itinerary)",
  story: "Story / POV (atmosphere to sit in)",
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
  businessTag: "",
  format: "narrative",
  trendNotes: "",
  goal: "monetize",
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
          <h1>Wanderlust Content Engine</h1>
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
          <label>TikTok goal (Instagram has no monetization floor either way)</label>
          <div className="goal-toggle">
            <button
              type="button"
              className={`goal-option ${form.goal === "monetize" ? "active" : ""}`}
              onClick={() => update("goal", "monetize")}
            >
              <span className="goal-title">Monetize on TikTok</span>
              <span className="goal-sub">60s+ — required to earn from Creator Rewards</span>
            </button>
            <button
              type="button"
              className={`goal-option ${form.goal === "reach" ? "active" : ""}`}
              onClick={() => update("goal", "reach")}
            >
              <span className="goal-title">Maximize reach / growth</span>
              <span className="goal-sub">No floor — shortest length that still holds attention</span>
            </button>
          </div>
        </div>

        <div className="row-2">
          <div className="field">
            <label htmlFor="businessTag">Business to tag (optional)</label>
            <input
              id="businessTag"
              placeholder="@cricketcreekfarm"
              value={form.businessTag}
              onChange={(e) => update("businessTag", e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="format">Format</label>
            <select
              id="format"
              value={form.format}
              onChange={(e) => update("format", e.target.value)}
            >
              <option value="narrative">Narrative story</option>
              <option value="itinerary">Itinerary list</option>
            </select>
          </div>
        </div>

        <div className="field">
          <label htmlFor="trendNotes">Trend you spotted (optional)</label>
          <input
            id="trendNotes"
            placeholder="Sound or hashtag from Creative Center / Content Gap"
            value={form.trendNotes}
            onChange={(e) => update("trendNotes", e.target.value)}
          />
          <p className="hint">
            Checked automatically too — this is only for something you found yourself that's worth prioritizing.
          </p>
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
                    <span className="video-type-label">
                      {CONTENT_TYPE_LABELS[platform.video_length.content_type] || platform.video_length.content_type}
                    </span>
                  </div>
                  {platform.video_length.why && (
                    <p className="rationale" style={{ marginTop: 10 }}>{platform.video_length.why}</p>
                  )}
                  {activeTab === "tiktok" && (
                    <p className="hint" style={{ marginTop: 8 }}>
                      {platform.goal === "reach"
                        ? "Goal was reach/growth — no length floor applied on TikTok. Anything under 60s won't earn from Creator Rewards though."
                        : "Goal was TikTok monetization — floored at 60s, since Creator Rewards pays $0 on anything shorter regardless of performance."}
                    </p>
                  )}
                  {activeTab === "instagram" && (
                    <p className="hint" style={{ marginTop: 8 }}>
                      Instagram Reels has no minimum length for its own monetization (Gifts on Reels) — this target is for completion rate, not a payout rule.
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

      <p className="footer-note">
        Trend data comes from Apify (see README) when configured, otherwise Claude estimates tags from proven patterns.
        Voice modeled on 15 of Leah's real posts.
      </p>
    </div>
  );
}
