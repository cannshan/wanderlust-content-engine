"use client";

import { useState, useEffect } from "react";
import { CATEGORY_OPTIONS } from "../../lib/constants";
import { useCategorizedItems } from "../../lib/useCategorizedItems";
import { CategoryFilterRow, CategorizePanel } from "./CategoryUI";
import { AddToPlanningPicker } from "./PlanningPicker";

function PlaceList({
  places,
  emptyHint,
  bucket,
  resultLocation,
  planningKeys,
  planningCategories,
  pickerKey,
  onTogglePicker,
  newCategoryDraft,
  onDraftChange,
  onAddToPlanning,
}) {
  if (places.length === 0) {
    return <p className="hint">{emptyHint}</p>;
  }
  return (
    <ul className="shotlist">
      {places.map((place, i) => {
        const key = `${resultLocation}::${place.name}`;
        const inPlanning = planningKeys.has(key);
        return (
          <li key={i}>
            <div className="place-row">
              <div className="place-info">
                <strong>{place.name}</strong>
                {place.category ? ` — ${place.category}` : ""}
                {place.area ? ` (${place.area})` : ""}
                <br />
                {place.why}
              </div>
              <button
                type="button"
                className="btn-ghost place-save-btn"
                disabled={inPlanning}
                onClick={() => onTogglePicker(key)}
              >
                {inPlanning ? "In Planning" : "Add to Planning"}
              </button>
            </div>

            {pickerKey === key && (
              <AddToPlanningPicker
                planningCategories={planningCategories}
                draft={newCategoryDraft}
                onDraftChange={onDraftChange}
                onPick={(category) => onAddToPlanning(place, bucket, category)}
                onCancel={() => onTogglePicker(null)}
              />
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
  // those stay editable for the next search while a saved search still
  // needs to record what was actually searched to produce it (same
  // formSnapshot idea as ContentTab.js).
  const [resultLocation, setResultLocation] = useState("");
  const [resultCategories, setResultCategories] = useState(["all"]);

  const [savedSearches, setSavedSearches] = useState([]);
  const [savedSearchesLoading, setSavedSearchesLoading] = useState(true);
  const [savingSearch, setSavingSearch] = useState(false);
  const [currentSavedSearchId, setCurrentSavedSearchId] = useState(null);

  const [planningItems, setPlanningItems] = useState([]);
  // Which place's "Add to Planning" category picker is currently open -
  // keyed the same way as planningKeys (`${resultLocation}::${place.name}`),
  // one open at a time.
  const [pickerKey, setPickerKey] = useState(null);
  const [newCategoryDraft, setNewCategoryDraft] = useState("");

  const searchesHook = useCategorizedItems(savedSearches, setSavedSearches, "/api/discovery-searches");

  // A place already sent to Planning from this exact search shows "In
  // Planning" (disabled) instead of a second "Add to Planning" that would
  // just create a duplicate row.
  const planningKeys = new Set(planningItems.map((p) => `${p.search_location}::${p.name}`));
  // Every category already in use across Planning items - offered as
  // quick-pick chips in the Add to Planning picker, same "create it by
  // using it" list any category filter row in this app builds.
  const planningCategories = Array.from(new Set(planningItems.map((p) => p.category).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b)
  );

  useEffect(() => {
    loadSavedSearches();
    loadPlanningItems();
  }, []);

  async function loadSavedSearches() {
    setSavedSearchesLoading(true);
    try {
      const res = await fetch("/api/discovery-searches");
      if (res.ok) {
        const data = await res.json();
        setSavedSearches(data.searches || []);
      }
    } catch {
      // List just stays empty/stale - searching still works.
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

  async function loadPlanningItems() {
    try {
      const res = await fetch("/api/planning-items");
      if (res.ok) {
        const data = await res.json();
        setPlanningItems(data.items || []);
      }
    } catch {
      // List just stays empty/stale - "Add to Planning" still works, it'll
      // just show as an active button instead of "In Planning" until the
      // next reload.
    }
  }

  function togglePicker(key) {
    setPickerKey((current) => (current === key ? null : key));
    setNewCategoryDraft("");
  }

  async function addToPlanning(place, bucket, category) {
    try {
      const res = await fetch("/api/planning-items", {
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
          category: category || null,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setPlanningItems((list) => [data.item, ...list]);
      }
    } catch {
      // Leaves the button active so they can just try again.
    }
    setPickerKey(null);
    setNewCategoryDraft("");
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
      // Already removed from view; a failed delete just means it
      // reappears next reload.
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
                planningKeys={planningKeys}
                planningCategories={planningCategories}
                pickerKey={pickerKey}
                onTogglePicker={togglePicker}
                newCategoryDraft={newCategoryDraft}
                onDraftChange={setNewCategoryDraft}
                onAddToPlanning={addToPlanning}
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
                planningKeys={planningKeys}
                planningCategories={planningCategories}
                pickerKey={pickerKey}
                onTogglePicker={togglePicker}
                newCategoryDraft={newCategoryDraft}
                onDraftChange={setNewCategoryDraft}
                onAddToPlanning={addToPlanning}
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
                planningKeys={planningKeys}
                planningCategories={planningCategories}
                pickerKey={pickerKey}
                onTogglePicker={togglePicker}
                newCategoryDraft={newCategoryDraft}
                onDraftChange={setNewCategoryDraft}
                onAddToPlanning={addToPlanning}
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
        <h3 style={{ fontSize: 14, marginBottom: 12 }}>Saved searches</h3>
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
