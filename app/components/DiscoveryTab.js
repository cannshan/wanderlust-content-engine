"use client";

import { useState } from "react";
import { CATEGORY_OPTIONS } from "../../lib/constants";

function PlaceList({ places, emptyHint }) {
  if (places.length === 0) {
    return <p className="hint">{emptyHint}</p>;
  }
  return (
    <ul className="shotlist">
      {places.map((place, i) => (
        <li key={i}>
          <strong>{place.name}</strong>
          {place.category ? ` — ${place.category}` : ""}
          {place.area ? ` (${place.area})` : ""}
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
  );
}

export default function DiscoveryTab() {
  const [location, setLocation] = useState("");
  const [categories, setCategories] = useState(["all"]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  function toggleCategory(key) {
    setCategories((current) => {
      if (key === "all") return ["all"];
      const withoutAll = current.filter((c) => c !== "all");
      const next = withoutAll.includes(key)
        ? withoutAll.filter((c) => c !== key)
        : [...withoutAll, key];
      return next.length === 0 ? ["all"] : next;
    });
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (!location.trim() || loading) return;

    setLoading(true);
    setError("");
    setResult(null);
    try {
      const res = await fetch("/api/discovery", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ location: location.trim(), categories }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't find things to do there.");
      setResult(data.discoveryIdeas);
    } catch (err) {
      setError(err.message || "Couldn't find things to do there.");
    }
    setLoading(false);
  }

  return (
    <div className="layout">
      <div className="main">
        <form onSubmit={onSubmit} className="card">
          <div className="field">
            <label htmlFor="discoveryLocation">Location</label>
            <input
              id="discoveryLocation"
              required
              placeholder="Maine, or Boothbay Harbor, Maine"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
            />
            <p className="hint" style={{ marginTop: 6 }}>
              A town, region, or a whole state — the broader the area, the more it'll spread results across
              different towns within it.
            </p>
          </div>

          <div className="field">
            <label>Category</label>
            <div className="platform-toggle">
              <button
                type="button"
                className={`goal-option ${categories.includes("all") ? "active" : ""}`}
                onClick={() => toggleCategory("all")}
                aria-pressed={categories.includes("all")}
              >
                <span className="goal-title">All categories</span>
              </button>
              {CATEGORY_OPTIONS.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  className={`goal-option ${categories.includes(c.key) ? "active" : ""}`}
                  onClick={() => toggleCategory(c.key)}
                  aria-pressed={categories.includes(c.key)}
                >
                  <span className="goal-title">{c.label}</span>
                </button>
              ))}
            </div>
          </div>

          {error && <div className="error-banner">{error}</div>}

          <button className="btn-primary" disabled={loading || !location.trim()}>
            {loading ? "Searching…" : "Find things to do"}
          </button>
        </form>

        {result && (
          <div className="result card">
            <div className="result-head">
              <h3 style={{ fontSize: 16 }}>Result</h3>
            </div>

            <div style={{ marginBottom: 20 }}>
              <p className="hint" style={{ marginBottom: 8, fontWeight: 600 }}>
                🔥 Popular
              </p>
              <PlaceList
                places={result.popular}
                emptyHint="Nothing with real proof of popularity turned up for this category — try &quot;All categories&quot; or a broader location."
              />
            </div>

            <div style={{ marginBottom: 20 }}>
              <p className="hint" style={{ marginBottom: 8, fontWeight: 600 }}>
                ✨ Interesting / unique
              </p>
              <PlaceList
                places={result.interesting}
                emptyHint="Nothing genuinely stood out as a unique find for this category right now."
              />
            </div>

            <div>
              <p className="hint" style={{ marginBottom: 8, fontWeight: 600 }}>
                💎 Hidden gems
              </p>
              <PlaceList
                places={result.hidden}
                emptyHint="Nothing overlooked genuinely stood out for this category right now."
              />
            </div>

            <p className="hint" style={{ marginTop: 16 }}>
              Areas/towns are whatever a search result happens to state — sanity-check before building a trip
              around one, same as everywhere else in this app that relies on live search instead of a maps API.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
