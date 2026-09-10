"use client";

import { useState } from "react";

const initialForm = {
  idea: "",
  location: "",
  storyBeat: "",
  businessTag: "",
  format: "narrative",
  trendNotes: "",
};

export default function Dashboard() {
  const [form, setForm] = useState(initialForm);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState("");

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function onSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong.");
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function copy(text, label) {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(""), 1500);
  }

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
            <span className={`badge ${result.trend_source === "apify" ? "live" : "estimated"}`}>
              {result.trend_source === "apify" ? "Live trend data" : "AI-estimated tags"}
            </span>
          </div>

          <div className="description-box">{result.description}</div>
          <button className="btn-ghost" onClick={() => copy(result.description, "description")} style={{ marginBottom: 20 }}>
            {copied === "description" ? "Copied" : "Copy description"}
          </button>

          <div className="field">
            <label>Hashtags</label>
            <div className="chipset">
              {result.hashtags?.map((tag) => (
                <span className="chip" key={tag}>{tag}</span>
              ))}
            </div>
            <button
              className="btn-ghost"
              onClick={() => copy(result.hashtags?.join(" "), "tags")}
            >
              {copied === "tags" ? "Copied" : "Copy all tags"}
            </button>
          </div>

          {result.hashtag_rationale && (
            <p className="rationale" style={{ marginTop: 16 }}>{result.hashtag_rationale}</p>
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
