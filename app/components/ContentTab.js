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

const CATEGORY_OPTIONS = [
  { key: "foodie", label: "Foodie" },
  { key: "hiking", label: "Hiking" },
  { key: "speakeasies", label: "Speakeasies / bars" },
  { key: "museums", label: "Museums" },
];

// Raw file size cap for an uploaded menu photo/PDF - base64 encoding
// inflates size by ~33%, so 4MB raw becomes ~5.3MB in the request body.
// Kept safely under Vercel's serverless request body limit.
const MAX_MENU_FILE_BYTES = 4 * 1024 * 1024;

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // reader.result is a data URL like "data:image/jpeg;base64,/9j/4AA...."
      // - strip the prefix, keep just the base64 payload.
      const base64 = String(reader.result).split(",")[1] || "";
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

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

export default function ContentTab() {
  const [form, setForm] = useState(initialForm);
  const [selectedPlatforms, setSelectedPlatforms] = useState({
    tiktok: true,
    instagram: true,
    youtube: true,
  });
  const [extras, setExtras] = useState({
    voiceover: false,
    music: false,
    styling: false,
  });
  const [isRestaurant, setIsRestaurant] = useState(false);
  const [restaurantName, setRestaurantName] = useState("");
  const [menuLink, setMenuLink] = useState("");
  const [menuFile, setMenuFile] = useState(null);
  const [menuFileError, setMenuFileError] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState("");
  const [activeTab, setActiveTab] = useState("tiktok");
  const [savedIdeas, setSavedIdeas] = useState([]);
  const [savedIdeasLoading, setSavedIdeasLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [nearbyCategories, setNearbyCategories] = useState(["all"]);
  const [nearbyLoading, setNearbyLoading] = useState(false);
  const [nearbyResult, setNearbyResult] = useState(null);
  const [nearbyError, setNearbyError] = useState("");

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
          // The styling tip is platform-agnostic (no per-platform tab of
          // its own), so it rides along inside the results blob under a
          // reserved key rather than needing its own saved_ideas column -
          // "_styling_tip" can never collide with a real platform key.
          results: { ...result.platforms, _styling_tip: result.stylingTip ?? null },
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
    const { _styling_tip: stylingTip, ...platformResults } = saved.results || {};

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
    // The menu link comes back too, but never a file - that was never
    // saved in the first place (see the comment on the restaurant_name/
    // menu_link insert in app/api/ideas/route.js).
    setIsRestaurant(!!saved.restaurant_name);
    setRestaurantName(saved.restaurant_name || "");
    setMenuLink(saved.menu_link || "");
    setMenuFile(null);
    setMenuFileError("");
    setNearbyResult(null);
    setNearbyError("");
    setResult({
      platforms: platformResults,
      errors: {},
      attempted: saved.platforms,
      savedId: saved.id,
      stylingTip: stylingTip ?? null,
      formSnapshot: {
        idea: saved.idea,
        location: saved.location,
        storyBeat: saved.story_beat || "",
        notes: saved.notes || "",
        lengthSeconds: saved.length_seconds,
        restaurantName: saved.restaurant_name || "",
        menuLink: saved.menu_link || "",
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

  function toggleExtra(key) {
    setExtras((e) => ({ ...e, [key]: !e[key] }));
  }

  // "All" and the specific categories are mutually exclusive - picking a
  // specific one drops "all", and clearing every specific one falls back
  // to "all" rather than leaving nothing selected (an empty selection
  // would be ambiguous with "search nothing").
  function toggleNearbyCategory(key) {
    setNearbyCategories((current) => {
      if (key === "all") return ["all"];
      const withoutAll = current.filter((c) => c !== "all");
      const next = withoutAll.includes(key)
        ? withoutAll.filter((c) => c !== key)
        : [...withoutAll, key];
      return next.length === 0 ? ["all"] : next;
    });
  }

  async function findNearbyIdeas() {
    if (!result?.formSnapshot || nearbyLoading) return;
    setNearbyLoading(true);
    setNearbyError("");
    try {
      const res = await fetch("/api/nearby-ideas", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idea: result.formSnapshot.idea,
          location: result.formSnapshot.location,
          storyBeat: result.formSnapshot.storyBeat,
          categories: nearbyCategories,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't find nearby ideas.");
      setNearbyResult(data.nearbyIdeas);
    } catch (err) {
      setNearbyError(err.message || "Couldn't find nearby ideas.");
    }
    setNearbyLoading(false);
  }

  function handleMenuFileChange(e) {
    const file = e.target.files?.[0] || null;
    if (file && file.size > MAX_MENU_FILE_BYTES) {
      setMenuFileError("That file's too big - please use something under 4MB (a phone photo of the menu is fine).");
      setMenuFile(null);
      e.target.value = "";
      return;
    }
    setMenuFileError("");
    setMenuFile(file);
  }

  const platformsToGenerate = PLATFORM_ORDER.filter((p) => selectedPlatforms[p]);

  async function generateOne(platformName, restaurantContext, locationContext) {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...form,
        platform: platformName,
        restaurantContext,
        locationContext,
        includeVoiceover: extras.voiceover,
        includeMusic: extras.music,
      }),
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
    // actually generated, not whatever the fields currently hold. The menu
    // link rides along the same way (see saveCurrentResult) - the uploaded
    // file itself deliberately doesn't, nothing to snapshot there.
    const formSnapshot = {
      ...form,
      restaurantName: isRestaurant ? restaurantName.trim() : "",
      menuLink: isRestaurant ? menuLink.trim() : "",
    };

    setLoading(true);
    setError("");
    setResult(null);
    setActiveTab(platformsToGenerate[0]);
    // A fresh generation means a new location - last run's nearby-ideas
    // search no longer applies to it.
    setNearbyResult(null);
    setNearbyError("");

    // Neither the restaurant check nor the location-tag search varies by
    // platform (a menu and a place's real-world popularity don't change
    // based on which app it's posted to), so both run once here, in
    // parallel with each other, and get passed into every platform
    // request below - instead of each platform's own /api/generate call
    // repeating the same live read/search.
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

    // The restaurant check is opt-in via the checkbox now, not
    // auto-detected - only fires (and only reads the uploaded menu file,
    // which needs converting to base64 first) when isRestaurant is on and
    // a restaurant name was actually given. Styling is opt-in the same
    // way. Neither adds a request at all when its toggle is off.
    const menuFileBase64 = menuFile ? await fileToBase64(menuFile) : null;

    const [restaurantData, locationData, stylingData] = await Promise.all([
      isRestaurant && restaurantName.trim()
        ? fetchContext("/api/restaurant-check", {
            restaurantName: restaurantName.trim(),
            location: form.location,
            idea: form.idea,
            storyBeat: form.storyBeat,
            menuLink: menuLink.trim() || null,
            menuFileBase64,
            menuFileMediaType: menuFile?.type || null,
          })
        : Promise.resolve(null),
      fetchContext("/api/location-search", {
        idea: form.idea,
        location: form.location,
        storyBeat: form.storyBeat,
      }),
      extras.styling
        ? fetchContext("/api/styling", {
            idea: form.idea,
            location: form.location,
            storyBeat: form.storyBeat,
          })
        : Promise.resolve(null),
    ]);
    const restaurantContext = restaurantData?.restaurantContext ?? null;
    const locationContext = locationData?.locationContext ?? null;
    const stylingTip = stylingData?.stylingTip ?? null;

    // Independent, parallel requests, one per selected platform - each
    // platform's generation is faster and more reliable on its own than
    // one combined call (a combined version routinely hit Vercel's
    // function timeout in testing).
    const outcomes = await Promise.allSettled(
      platformsToGenerate.map((p) => generateOne(p, restaurantContext, locationContext))
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
      setResult({ platforms, errors, attempted: platformsToGenerate, formSnapshot, savedId: null, stylingTip });
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
          <label>Filming extras (optional)</label>
          <div className="platform-toggle">
            <button
              type="button"
              className={`goal-option ${extras.voiceover ? "active" : ""}`}
              onClick={() => toggleExtra("voiceover")}
              aria-pressed={extras.voiceover}
            >
              <span className="goal-title">Voiceover script</span>
            </button>
            <button
              type="button"
              className={`goal-option ${extras.music ? "active" : ""}`}
              onClick={() => toggleExtra("music")}
              aria-pressed={extras.music}
            >
              <span className="goal-title">Music suggestion</span>
            </button>
            <button
              type="button"
              className={`goal-option ${extras.styling ? "active" : ""}`}
              onClick={() => toggleExtra("styling")}
              aria-pressed={extras.styling}
            >
              <span className="goal-title">Styling tips</span>
            </button>
          </div>
        </div>

        <div className="field">
          <label>Restaurant / bar (optional)</label>
          <button
            type="button"
            className={`goal-option ${isRestaurant ? "active" : ""}`}
            onClick={() => setIsRestaurant((v) => !v)}
            aria-pressed={isRestaurant}
            style={{ width: "100%" }}
          >
            <span className="goal-title">This post is about a restaurant/bar</span>
            <span className="goal-sub">Pulls a real menu item and restaurant-specific research into the post</span>
          </button>
        </div>

        {isRestaurant && (
          <>
            <div className="field">
              <label htmlFor="restaurantName">Restaurant name</label>
              <input
                id="restaurantName"
                required
                placeholder="Freeport Oyster Bar"
                value={restaurantName}
                onChange={(e) => setRestaurantName(e.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="menuLink">Menu link (optional)</label>
              <input
                id="menuLink"
                placeholder="https://theirsite.com/menu"
                value={menuLink}
                onChange={(e) => setMenuLink(e.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="menuFile">Or upload a menu photo/PDF (optional)</label>
              <input id="menuFile" type="file" accept="image/*,application/pdf" onChange={handleMenuFileChange} />
              {menuFile && <p className="hint" style={{ marginTop: 6 }}>{menuFile.name}</p>}
              {menuFileError && (
                <p className="hint" style={{ marginTop: 6, color: "var(--bad)" }}>{menuFileError}</p>
              )}
            </div>
          </>
        )}

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

          {result.stylingTip && (
            <div className="field" style={{ marginBottom: 20 }}>
              <label>Styling tip (same for every platform)</label>
              <p className="rationale">{result.stylingTip}</p>
            </div>
          )}

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

              {platform.voiceover_script && (
                <div className="field" style={{ marginTop: 20 }}>
                  <label>Voiceover script</label>
                  <div className="description-box">{platform.voiceover_script}</div>
                  <button className="btn-ghost" onClick={() => copy(platform.voiceover_script, "voiceover")}>
                    {copied === "voiceover" ? "Copied" : "Copy voiceover script"}
                  </button>
                </div>
              )}

              {platform.music_suggestion && (
                <div className="field" style={{ marginTop: 20 }}>
                  <label>Music suggestion</label>
                  <ul className="shotlist">
                    {platform.music_suggestion
                      .split("\n")
                      .map((line) => line.trim())
                      .filter(Boolean)
                      .map((line, i) => (
                        <li key={i}>{line}</li>
                      ))}
                  </ul>
                </div>
              )}
            </>
          )}

          <div
            className="field"
            style={{ marginTop: 28, paddingTop: 24, borderTop: "1px solid var(--border)" }}
          >
            <label>Nearby filming ideas (same trip, ~10 miles)</label>
            <p className="hint" style={{ marginBottom: 10 }}>
              Find other real places worth filming near {result.formSnapshot.location} so this can
              be a multi-post day instead of a single stop.
            </p>
            <div className="platform-toggle" style={{ marginBottom: 10 }}>
              <button
                type="button"
                className={`goal-option ${nearbyCategories.includes("all") ? "active" : ""}`}
                onClick={() => toggleNearbyCategory("all")}
                aria-pressed={nearbyCategories.includes("all")}
              >
                <span className="goal-title">All categories</span>
              </button>
              {CATEGORY_OPTIONS.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  className={`goal-option ${nearbyCategories.includes(c.key) ? "active" : ""}`}
                  onClick={() => toggleNearbyCategory(c.key)}
                  aria-pressed={nearbyCategories.includes(c.key)}
                >
                  <span className="goal-title">{c.label}</span>
                </button>
              ))}
            </div>
            <button type="button" className="btn-ghost" onClick={findNearbyIdeas} disabled={nearbyLoading}>
              {nearbyLoading ? "Searching…" : nearbyResult ? "Search again" : "Find nearby ideas"}
            </button>

            {nearbyError && (
              <div className="error-banner" style={{ marginTop: 12 }}>
                {nearbyError}
              </div>
            )}

            {nearbyResult && (
              <div style={{ marginTop: 16 }}>
                <div style={{ marginBottom: 20 }}>
                  <p className="hint" style={{ marginBottom: 8, fontWeight: 600 }}>
                    🔥 Already popular / proven potential
                  </p>
                  {nearbyResult.viral.length === 0 && (
                    <p className="hint">
                      Nothing with real proof of popularity turned up nearby for this category — try
                      "All categories" or check back later.
                    </p>
                  )}
                  <ul className="shotlist">
                    {nearbyResult.viral.map((place, i) => (
                      <li key={i}>
                        <strong>{place.name}</strong>
                        {place.category ? ` — ${place.category}` : ""}
                        {place.distance ? ` (${place.distance})` : ""}
                        <br />
                        {place.why}
                        {place.angle && (
                          <>
                            <br />
                            <em>Angle: {place.angle}</em>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>

                <div>
                  <p className="hint" style={{ marginBottom: 8, fontWeight: 600 }}>
                    💎 Hidden gems / overlooked
                  </p>
                  {nearbyResult.hidden.length === 0 && (
                    <p className="hint">Nothing overlooked genuinely stood out nearby for this category right now.</p>
                  )}
                  <ul className="shotlist">
                    {nearbyResult.hidden.map((place, i) => (
                      <li key={i}>
                        <strong>{place.name}</strong>
                        {place.category ? ` — ${place.category}` : ""}
                        {place.distance ? ` (${place.distance})` : ""}
                        <br />
                        {place.why}
                        {place.angle && (
                          <>
                            <br />
                            <em>Angle: {place.angle}</em>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>

                <p className="hint" style={{ marginTop: 8 }}>
                  Distances are estimates pulled from search results, not GPS-verified — sanity-check
                  drive time before building the day around one.
                </p>
              </div>
            )}
          </div>
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
  );
}
