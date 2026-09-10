"use client";

import { useState, useEffect } from "react";

const PATTERN_LABELS = {
  "animal-content": "Lever: animal content",
  "pop-culture-tie-in": "Lever: pop-culture tie-in",
  "insider-access": "Lever: insider access",
  standard: "No specific lever — standard post",
};

const PLATFORM_LABELS = {
  tiktok: "TikTok",
  instagram: "Instagram",
  youtube: "YouTube",
};

const PLATFORM_ORDER = ["tiktok", "instagram", "youtube"];

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
  const [selectedPlatforms, setSelectedPlatforms] = useState({
    tiktok: true,
    instagram: true,
    youtube: true,
  });
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState("");
  const [activeTab, setActiveTab] = useState("tiktok");
  const [savedIdeas, setSavedIdeas] = useState([]);
  const [savedIdeasLoading, setSavedIdeasLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadSavedIdeas();
  }, []);

  async function loadSavedIdeas() {
    setSavedIdeasLoading(true);
    try {
      const res = await fetch("/api/ideas");
      if (res.ok) {
        const data = await res.json();
        setSavedIdeas(data.ideas || []);
      }
    } catch {
      // Sidebar just stays empty/stale - saving/generating still works.
    }
    setSavedIdeasLoading(false);
  }

  async function saveCurrentResult() {
    if (!result || saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/ideas", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...result.formSnapshot,
          platforms: result.attempted,
          results: result.platforms,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setSavedIdeas((list) => [data.savedIdea, ...list]);
        setResult((r) => ({ ...r, savedId: data.savedIdea.id }));
      }
    } catch {
      // Leaves the Save button active so they can just try again.
    }
    setSaving(false);
  }

  function loadSavedIdea(saved) {
    setForm({
      idea: saved.idea,
      location: saved.location,
      storyBeat: saved.story_beat || "",
      notes: saved.notes || "",
      lengthSeconds: saved.length_seconds,
    });
    setSelectedPlatforms({
      tiktok: saved.platforms.includes("tiktok"),
      instagram: saved.platforms.includes("instagram"),
      youtube: saved.platforms.includes("youtube"),
    });
    setResult({
      platforms: saved.results,
      errors: {},
      attempted: saved.platforms,
      savedId: saved.id,
      formSnapshot: {
        idea: saved.idea,
        location: saved.location,
        storyBeat: saved.story_beat || "",
        notes: saved.notes || "",
        lengthSeconds: saved.length_seconds,
      },
    });
    setActiveTab(saved.platforms[0]);
    setError("");
  }

  async function deleteSavedIdea(id) {
    setSavedIdeas((list) => list.filter((s) => s.id !== id));
    // If the deleted idea is the one currently on screen, the Save button
    // needs to un-stick from "Saved" - otherwise it stays disabled for a
    // result that no longer actually exists in the saved list.
    setResult((r) => (r?.savedId === id ? { ...r, savedId: null } : r));
    try {
      await fetch(`/api/ideas/${id}`, { method: "DELETE" });
    } catch {
      // Already removed from the visible list; a failed delete just means
      // it'll reappear next time the sidebar reloads, not silently lost.
    }
  }

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  function togglePlatform(p) {
    setSelectedPlatforms((s) => ({ ...s, [p]: !s[p] }));
  }

  const platformsToGenerate = PLATFORM_ORDER.filter((p) => selectedPlatforms[p]);

  async function generateOne(platformName, menuCheck, locationContext) {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...form, platform: platformName, menuCheck, locationContext }),
    });
    const raw = await res.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      // A non-JSON body means the platform (Vercel) killed the request
      // before our own code could respond - most likely the function
      // timeout, not an application error.
      throw new Error("Request timed out or failed before completing. Try again.");
    }
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    return data;
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (platformsToGenerate.length === 0) return;

    // Captured now, not read from `form` later - the form stays editable
    // while a generation is in flight, and Save needs to persist what was
    // actually generated, not whatever the fields currently hold.
    const formSnapshot = { ...form };

    setLoading(true);
    setError("");
    setResult(null);
    setActiveTab(platformsToGenerate[0]);

    // Neither the menu check nor the location-tag search varies by
    // platform (a restaurant's menu and a place's real-world popularity
    // don't change based on which app it's posted to), so both run once
    // here, in parallel with each other, and get passed into every
    // platform request below - instead of each platform's own
    // /api/generate call repeating the same live searches.
    async function fetchContext(path, body) {
      try {
        const res = await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) return null;
        return await res.json();
      } catch {
        // Degrades silently, same as if the check had found nothing -
        // generation still proceeds, just without that grounding.
        return null;
      }
    }

    const [menuData, locationData] = await Promise.all([
      fetchContext("/api/menu-check", {
        idea: form.idea,
        location: form.location,
        storyBeat: form.storyBeat,
        notes: form.notes,
      }),
      fetchContext("/api/location-search", {
        idea: form.idea,
        location: form.location,
        storyBeat: form.storyBeat,
      }),
    ]);
    const menuCheck = menuData?.menuCheck ?? null;
    const locationContext = locationData?.locationContext ?? null;

    // Independent, parallel requests, one per selected platform - each
    // platform's generation is faster and more reliable on its own than
    // one combined call (a combined version routinely hit Vercel's
    // function timeout in testing).
    const outcomes = await Promise.allSettled(
      platformsToGenerate.map((p) => generateOne(p, menuCheck, locationContext))
    );

    const platforms = {};
    const errors = {};
    outcomes.forEach((outcome, i) => {
      const p = platformsToGenerate[i];
      if (outcome.status === "fulfilled") platforms[p] = outcome.value;
      else errors[p] = outcome.reason?.message || "Failed to generate.";
    });

    if (Object.keys(platforms).length === 0) {
      setError(
        errors[platformsToGenerate[0]] ||
          (platformsToGenerate.length > 1
            ? "All selected platforms failed to generate."
            : "Failed to generate.")
      );
    } else {
      setResult({ platforms, errors, attempted: platformsToGenerate, formSnapshot, savedId: null });
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
          <h1>Wine Wilderness Wanderlust</h1>
        </div>
      </div>

      <div className="layout">
      <div className="main">
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
          <label>Platforms to generate</label>
          <div className="platform-toggle">
            {PLATFORM_ORDER.map((p) => (
              <button
                key={p}
                type="button"
                className={`goal-option ${selectedPlatforms[p] ? "active" : ""}`}
                onClick={() => togglePlatform(p)}
                aria-pressed={selectedPlatforms[p]}
              >
                <span className="goal-title">{PLATFORM_LABELS[p]}</span>
              </button>
            ))}
          </div>
          {platformsToGenerate.length === 0 && (
            <p className="hint" style={{ marginTop: 6 }}>Pick at least one platform.</p>
          )}
        </div>

        <div className="field">
          <label>Video length (same target across platforms)</label>
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

        <button className="btn-primary" disabled={loading || platformsToGenerate.length === 0}>
          {loading ? "Writing…" : "Generate description + tags"}
        </button>
      </form>

      {result && (
        <div className="result card">
          <div className="result-head">
            <h3 style={{ fontSize: 16 }}>Result</h3>
            <button className="btn-ghost" onClick={saveCurrentResult} disabled={saving || !!result.savedId}>
              {result.savedId ? "Saved" : saving ? "Saving…" : "Save this idea"}
            </button>
          </div>

          <div className="tabs">
            {(result.attempted || PLATFORM_ORDER).map((p) => (
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
              {platform.hook_strategy && (
                <div className="strategy-box">
                  <span className="badge live" style={{ marginBottom: 6, display: "inline-block" }}>
                    {formatPattern(platform.pattern_used)}
                  </span>
                  <p>{platform.hook_strategy}</p>
                </div>
              )}

              {platform.title && (
                <div className="field">
                  <label>Title</label>
                  <div className="description-box">{platform.title}</div>
                  <button className="btn-ghost" onClick={() => copy(platform.title, "title")}>
                    {copied === "title" ? "Copied" : "Copy title"}
                  </button>
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
                  {activeTab === "youtube" && (
                    <p className="hint" style={{ marginTop: 8 }}>
                      YouTube Shorts has no fixed monetization floor tied to this video's length like TikTok does — Partner Program eligibility runs off overall channel watch hours and subscribers, not this individual short.
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

              {platform.location_tag && (
                <div className="field" style={{ marginTop: 20 }}>
                  <label>Suggested location tag</label>
                  <div className="cover-suggestion">📍 {platform.location_tag}</div>
                  {platform.location_tag_why && (
                    <p className="rationale" style={{ marginTop: 10 }}>{platform.location_tag_why}</p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
      </div>

      <aside className="sidebar">
        <h3 style={{ fontSize: 14, marginBottom: 12 }}>Saved ideas</h3>
        {savedIdeasLoading && <p className="hint">Loading…</p>}
        {!savedIdeasLoading && savedIdeas.length === 0 && (
          <p className="hint">Nothing saved yet. Generate something and hit "Save this idea" to plan ahead for the week.</p>
        )}
        <div className="saved-list">
          {savedIdeas.map((s) => (
            <div key={s.id} className={`saved-item ${result?.savedId === s.id ? "active" : ""}`}>
              <button type="button" className="saved-item-main" onClick={() => loadSavedIdea(s)}>
                <div className="saved-item-idea">{s.idea}</div>
                <div className="saved-item-meta">{s.location}</div>
                <div className="saved-item-chips">
                  {s.platforms.map((p) => (
                    <span className="saved-chip" key={p}>{PLATFORM_LABELS[p]}</span>
                  ))}
                </div>
              </button>
              <button
                type="button"
                className="saved-item-delete"
                onClick={() => deleteSavedIdea(s.id)}
                aria-label="Delete saved idea"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </aside>
      </div>
    </div>
  );
}
