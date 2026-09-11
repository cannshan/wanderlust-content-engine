"use client";

import { useState, useEffect } from "react";
import { CATEGORY_OPTIONS } from "../../lib/constants";
import { useCategorizedItems } from "../../lib/useCategorizedItems";
import { CategoryFilterRow, CategorizePanel } from "./CategoryUI";

function PlaceList({ places, emptyHint, bucket, resultLocation, savedKeys, onSave, suggestions, onSuggest }) {
  if (places.length === 0) {
    return <p className="hint">{emptyHint}</p>;
  }
  return (
    <ul className="shotlist">
      {places.map((place, i) => {
        const key = `${resultLocation}::${place.name}`;
        const saved = savedKeys.has(key);
        const sug = suggestions[key] || {};
        return (
          <li key={i}>
            <div className="place-row">
              <div className="place-info">
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
              </div>
              <button
                type="button"
                className="btn-ghost place-save-btn"
                disabled={saved}
                onClick={() => onSave(place, bucket)}
              >
                {saved ? "Saved" : "Save"}
              </button>
            </div>

            <div className="place-suggest-row">
              <button
                type="button"
                className="btn-ghost"
                disabled={!!sug.loadingMode}
                onClick={() => onSuggest(place, "food")}
              >
                {sug.loadingMode === "food" ? "Looking…" : "Foodie/Explore Advice"}
              </button>
              <button
                type="button"
                className="btn-ghost"
                disabled={!!sug.loadingMode}
                onClick={() => onSuggest(place, "style")}
              >
                {sug.loadingMode === "style" ? "Looking…" : "Clothes to Wear"}
              </button>
              <button
                type="button"
                className="btn-ghost"
                disabled={!!sug.loadingMode}
                onClick={() => onSuggest(place, "both")}
              >
                {sug.loadingMode === "both" ? "Looking…" : "Suggest Both"}
              </button>
            </div>

            {sug.error && (
              <p className="hint" style={{ color: "var(--bad)", marginTop: 6 }}>{sug.error}</p>
            )}

            {sug.food && <p className="rationale" style={{ marginTop: 8 }}>{sug.food}</p>}

            {sug.style && (
              <div style={{ marginTop: 8 }}>
                <p className="rationale">{sug.style}</p>
                {sug.styleLinks?.length > 0 && (
                  <div className="style-links">
                    {sug.styleLinks.map((link, li) => (
                      <a
                        key={li}
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="style-link-card"
                      >
                        {link.imageUrl && (
                          <img
                            src={link.imageUrl}
                            alt={link.label}
                            onError={(e) => {
                              e.currentTarget.style.display = "none";
                            }}
                          />
                        )}
                        <span>{link.label}</span>
                      </a>
                    ))}
                  </div>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export default function DiscoveryTab() {
  const [location, setLocation] = useState("");
  const [categories, setCategories] = useState(["all"]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  // Captured at search time, not read live from `location`/`categories` -
  // those stay editable for the next search while a saved place/search
  // still needs to record what was actually searched to produce it (same
  // formSnapshot idea as ContentTab.js).
  const [resultLocation, setResultLocation] = useState("");
  const [resultCategories, setResultCategories] = useState(["all"]);

  const [savedPlaces, setSavedPlaces] = useState([]);
  const [savedPlacesLoading, setSavedPlacesLoading] = useState(true);
  const [savedSearches, setSavedSearches] = useState([]);
  const [savedSearchesLoading, setSavedSearchesLoading] = useState(true);
  const [savingSearch, setSavingSearch] = useState(false);
  const [currentSavedSearchId, setCurrentSavedSearchId] = useState(null);
  // Keyed the same way as savedPlaceKeys (`${resultLocation}::${place.name}`)
  // - per-place, ad-hoc results from the Foodie/Explore Advice, Clothes to
  // Wear, and Suggest Both buttons. Nothing here runs automatically; each
  // entry only exists because that specific button was clicked for that
  // specific place.
  const [placeSuggestions, setPlaceSuggestions] = useState({});

  const placesHook = useCategorizedItems(savedPlaces, setSavedPlaces, "/api/places");
  const searchesHook = useCategorizedItems(savedSearches, setSavedSearches, "/api/discovery-searches");

  // Same location+name combo used when saving, so a place already saved
  // from this exact search shows "Saved" (disabled) instead of a second
  // "Save" that would just create a duplicate row.
  const savedPlaceKeys = new Set(savedPlaces.map((p) => `${p.search_location}::${p.name}`));

  useEffect(() => {
    loadSavedPlaces();
    loadSavedSearches();
  }, []);

  async function loadSavedPlaces() {
    setSavedPlacesLoading(true);
    try {
      const res = await fetch("/api/places");
      if (res.ok) {
        const data = await res.json();
        setSavedPlaces(data.places || []);
      }
    } catch {
      // List just stays empty/stale - searching still works.
    }
    setSavedPlacesLoading(false);
  }

  async function loadSavedSearches() {
    setSavedSearchesLoading(true);
    try {
      const res = await fetch("/api/discovery-searches");
      if (res.ok) {
        const data = await res.json();
        setSavedSearches(data.searches || []);
      }
    } catch {
      // Same as above.
    }
    setSavedSearchesLoading(false);
  }

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
    setCurrentSavedSearchId(null);
    try {
      const res = await fetch("/api/discovery", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ location: location.trim(), categories }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't find things to do there.");
      setResult(data.discoveryIdeas);
      setResultLocation(location.trim());
      setResultCategories(categories);
    } catch (err) {
      setError(err.message || "Couldn't find things to do there.");
    }
    setLoading(false);
  }

  async function savePlace(place, bucket) {
    // Whichever ad-hoc suggestions already exist for this place ride along
    // into the saved record - see the comment on food_suggestion in
    // app/api/places/route.js. Nothing is generated here; only carried.
    const sug = placeSuggestions[`${resultLocation}::${place.name}`] || {};
    try {
      const res = await fetch("/api/places", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: place.name,
          placeCategory: place.category || null,
          area: place.area || null,
          why: place.why || null,
          angle: place.angle || null,
          bucket,
          searchLocation: resultLocation,
          foodSuggestion: sug.food || null,
          styleSuggestion: sug.style || null,
          styleLinks: sug.styleLinks?.length ? sug.styleLinks : null,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setSavedPlaces((list) => [data.savedPlace, ...list]);
      }
    } catch {
      // Leaves the Save button active so they can just try again.
    }
  }

  // mode: "food" | "style" | "both". Fires only on click, never
  // automatically - see the comment on placeSuggestions above.
  async function fetchPlaceSuggestion(place, mode) {
    const key = `${resultLocation}::${place.name}`;
    setPlaceSuggestions((s) => ({ ...s, [key]: { ...(s[key] || {}), loadingMode: mode, error: null } }));
    try {
      const res = await fetch("/api/place-suggestion", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: place.name,
          placeCategory: place.category || null,
          area: place.area || null,
          searchLocation: resultLocation,
          mode,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't get a suggestion for this place.");
      setPlaceSuggestions((s) => {
        const prev = s[key] || {};
        return {
          ...s,
          [key]: {
            loadingMode: null,
            error: null,
            food: data.suggestion.foodSuggestion ?? prev.food ?? null,
            style: data.suggestion.styleSuggestion ?? prev.style ?? null,
            styleLinks: data.suggestion.styleLinks?.length ? data.suggestion.styleLinks : prev.styleLinks || [],
          },
        };
      });
    } catch (err) {
      setPlaceSuggestions((s) => ({
        ...s,
        [key]: { ...(s[key] || {}), loadingMode: null, error: err.message || "Couldn't get a suggestion for this place." },
      }));
    }
  }

  async function deleteSavedPlace(id) {
    setSavedPlaces((list) => list.filter((p) => p.id !== id));
    try {
      await fetch(`/api/places/${id}`, { method: "DELETE" });
    } catch {
      // Already removed from the visible list; a failed delete just means
      // it'll reappear next time the sidebar reloads, not silently lost.
    }
  }

  async function saveCurrentSearch() {
    if (!result || savingSearch) return;
    setSavingSearch(true);
    try {
      const res = await fetch("/api/discovery-searches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ location: resultLocation, categories: resultCategories, results: result }),
      });
      if (res.ok) {
        const data = await res.json();
        setSavedSearches((list) => [data.savedSearch, ...list]);
        setCurrentSavedSearchId(data.savedSearch.id);
      }
    } catch {
      // Leaves the Save button active so they can just try again.
    }
    setSavingSearch(false);
  }

  function loadSavedSearch(saved) {
    setLocation(saved.location);
    setCategories(saved.categories?.length ? saved.categories : ["all"]);
    setResult(saved.results);
    setResultLocation(saved.location);
    setResultCategories(saved.categories || ["all"]);
    setCurrentSavedSearchId(saved.id);
    setError("");
  }

  async function deleteSavedSearch(id) {
    setSavedSearches((list) => list.filter((s) => s.id !== id));
    setCurrentSavedSearchId((current) => (current === id ? null : current));
    try {
      await fetch(`/api/discovery-searches/${id}`, { method: "DELETE" });
    } catch {
      // Same as deleteSavedPlace's own catch.
    }
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
              <button className="btn-ghost" onClick={saveCurrentSearch} disabled={savingSearch || !!currentSavedSearchId}>
                {currentSavedSearchId ? "Saved" : savingSearch ? "Saving…" : "Save this search"}
              </button>
            </div>

            <div style={{ marginBottom: 20 }}>
              <p className="hint" style={{ marginBottom: 8, fontWeight: 600 }}>
                🔥 Popular
              </p>
              <PlaceList
                places={result.popular}
                emptyHint="Nothing with real proof of popularity turned up for this category — try &quot;All categories&quot; or a broader location."
                bucket="popular"
                resultLocation={resultLocation}
                savedKeys={savedPlaceKeys}
                onSave={savePlace}
                suggestions={placeSuggestions}
                onSuggest={fetchPlaceSuggestion}
              />
            </div>

            <div style={{ marginBottom: 20 }}>
              <p className="hint" style={{ marginBottom: 8, fontWeight: 600 }}>
                ✨ Interesting / unique
              </p>
              <PlaceList
                places={result.interesting}
                emptyHint="Nothing genuinely stood out as a unique find for this category right now."
                bucket="interesting"
                resultLocation={resultLocation}
                savedKeys={savedPlaceKeys}
                onSave={savePlace}
                suggestions={placeSuggestions}
                onSuggest={fetchPlaceSuggestion}
              />
            </div>

            <div>
              <p className="hint" style={{ marginBottom: 8, fontWeight: 600 }}>
                💎 Hidden gems
              </p>
              <PlaceList
                places={result.hidden}
                emptyHint="Nothing overlooked genuinely stood out for this category right now."
                bucket="hidden"
                resultLocation={resultLocation}
                savedKeys={savedPlaceKeys}
                onSave={savePlace}
                suggestions={placeSuggestions}
                onSuggest={fetchPlaceSuggestion}
              />
            </div>

            <p className="hint" style={{ marginTop: 16 }}>
              Areas/towns are whatever a search result happens to state — sanity-check before building a trip
              around one, same as everywhere else in this app that relies on live search instead of a maps API.
            </p>
          </div>
        )}
      </div>

      <aside className="sidebar">
        <h3 style={{ fontSize: 14, marginBottom: 12 }}>Saved places</h3>
        <CategoryFilterRow
          allCategories={placesHook.allCategories}
          categoryFilter={placesHook.categoryFilter}
          onFilter={placesHook.setCategoryFilter}
        />
        {savedPlacesLoading && <p className="hint">Loading…</p>}
        {!savedPlacesLoading && savedPlaces.length === 0 && (
          <p className="hint">Nothing saved yet — hit "Save" next to a place above.</p>
        )}
        {!savedPlacesLoading && savedPlaces.length > 0 && placesHook.filteredItems.length === 0 && (
          <p className="hint">Nothing saved under "{placesHook.categoryFilter}" yet.</p>
        )}
        <div className="saved-list">
          {placesHook.filteredItems.map((p) => (
            <div key={p.id} className="saved-item">
              <div className="saved-item-row">
                <div className="saved-item-main" style={{ cursor: "default" }}>
                  <div className="saved-item-idea">{p.name}</div>
                  <div className="saved-item-meta">{p.area || p.search_location}</div>
                  <div className="saved-item-chips">
                    {p.category && <span className="saved-chip category-chip">{p.category}</span>}
                    <span className="saved-chip">{p.bucket}</span>
                  </div>
                </div>
                <div className="saved-item-actions">
                  <button type="button" className="saved-item-categorize" onClick={() => placesHook.toggleCategorize(p.id)}>
                    Categorize
                  </button>
                  <button
                    type="button"
                    className="saved-item-delete"
                    onClick={() => deleteSavedPlace(p.id)}
                    aria-label="Delete saved place"
                  >
                    ×
                  </button>
                </div>
              </div>
              {placesHook.categorizingId === p.id && (
                <CategorizePanel
                  item={p}
                  allCategories={placesHook.allCategories}
                  newCategoryDraft={placesHook.newCategoryDraft}
                  onDraftChange={placesHook.setNewCategoryDraft}
                  onApply={placesHook.applyCategory}
                  onSubmitNew={placesHook.submitNewCategory}
                />
              )}
            </div>
          ))}
        </div>

        <h3 style={{ fontSize: 14, margin: "20px 0 12px" }}>Saved searches</h3>
        <CategoryFilterRow
          allCategories={searchesHook.allCategories}
          categoryFilter={searchesHook.categoryFilter}
          onFilter={searchesHook.setCategoryFilter}
        />
        {savedSearchesLoading && <p className="hint">Loading…</p>}
        {!savedSearchesLoading && savedSearches.length === 0 && (
          <p className="hint">Nothing saved yet — hit "Save this search" after searching a location.</p>
        )}
        {!savedSearchesLoading && savedSearches.length > 0 && searchesHook.filteredItems.length === 0 && (
          <p className="hint">Nothing saved under "{searchesHook.categoryFilter}" yet.</p>
        )}
        <div className="saved-list">
          {searchesHook.filteredItems.map((s) => {
            const placeCount =
              (s.results?.popular?.length || 0) + (s.results?.interesting?.length || 0) + (s.results?.hidden?.length || 0);
            return (
              <div key={s.id} className={`saved-item ${currentSavedSearchId === s.id ? "active" : ""}`}>
                <div className="saved-item-row">
                  <button type="button" className="saved-item-main" onClick={() => loadSavedSearch(s)}>
                    <div className="saved-item-idea">{s.location}</div>
                    <div className="saved-item-meta">
                      {placeCount} place{placeCount === 1 ? "" : "s"}
                    </div>
                    <div className="saved-item-chips">
                      {s.category && <span className="saved-chip category-chip">{s.category}</span>}
                    </div>
                  </button>
                  <div className="saved-item-actions">
                    <button
                      type="button"
                      className="saved-item-categorize"
                      onClick={() => searchesHook.toggleCategorize(s.id)}
                    >
                      Categorize
                    </button>
                    <button
                      type="button"
                      className="saved-item-delete"
                      onClick={() => deleteSavedSearch(s.id)}
                      aria-label="Delete saved search"
                    >
                      ×
                    </button>
                  </div>
                </div>
                {searchesHook.categorizingId === s.id && (
                  <CategorizePanel
                    item={s}
                    allCategories={searchesHook.allCategories}
                    newCategoryDraft={searchesHook.newCategoryDraft}
                    onDraftChange={searchesHook.setNewCategoryDraft}
                    onApply={searchesHook.applyCategory}
                    onSubmitNew={searchesHook.submitNewCategory}
                  />
                )}
              </div>
            );
          })}
        </div>
      </aside>
    </div>
  );
}
