"use client";

import { useState, useEffect } from "react";
import { useCategorizedItems } from "../../lib/useCategorizedItems";
import { CategoryFilterRow, CategorizePanel } from "./CategoryUI";
import { AddToPlanningPicker } from "./PlanningPicker";

// The `area` field is free text from a live search, not a guaranteed
// clean "Town, State" - it can come back as a full descriptive aside, e.g.
// "Downtown Providence (docks at One Citizens Plaza, near Café Nuovo)".
// The sidebar card only has room for a short one-line subtext, so this
// keeps just the town/place name before any parenthetical detail - the
// full, un-trimmed area still shows in the expanded card once selected.
function shortArea(area) {
  if (!area) return "";
  const idx = area.indexOf("(");
  return (idx === -1 ? area : area.slice(0, idx)).trim();
}

// Same as DiscoveryTab's own version - a Google Maps search link rather
// than a model-cited source URL the app never verifies. Works for any
// real place name, no risk of a wrong or invented link.
function mapsSearchUrl(name, area) {
  const query = [name, area].filter(Boolean).join(", ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

// Same caps/helper as ContentTab's own restaurant-menu upload - kept
// separate rather than shared, since it's a few lines and this app
// doesn't otherwise share client-side helpers between tab components.
const MAX_MENU_FILES_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_MENU_FILES = 3;
const MAX_MENU_LINKS = 5;

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = String(reader.result).split(",")[1] || "";
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export default function PlanningTab() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  // Same "click a sidebar card to see it in full" pattern as ContentTab's
  // saved ideas - only the selected item's full detail (research/what to
  // wear/focus field) renders in the main panel; everything else is just a
  // compact card in the sidebar until clicked.
  const [selectedId, setSelectedId] = useState(null);

  // The Planning tab's own search bar - a direct free-text lookup for one
  // specific restaurant/hike/place, separate from browsing Discovery's
  // broader category search. Results are plain place objects (name/
  // category/area/why/angle), same shape Discovery's results use, so they
  // go through the exact same AddToPlanningPicker flow.
  const [searchQuery, setSearchQuery] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searchResults, setSearchResults] = useState(null);
  // Which search result's category picker is open - keyed by the result's
  // name (unique enough within one result set), one open at a time.
  const [searchPickerKey, setSearchPickerKey] = useState(null);
  const [searchNewCategoryDraft, setSearchNewCategoryDraft] = useState("");
  // Which not-yet-planned search result is mid-save from clicking Research
  // this place/What to Wear directly (see ensurePlannedItem) - just to
  // disable its buttons for the brief moment before it exists as a real
  // item and switches over to the normal planned-card loading state.
  const [pendingResultKey, setPendingResultKey] = useState(null);
  // Same idea as focusDrafts below, but for a not-yet-planned search
  // result - keyed by the place's name since there's no item.id yet.
  // Carried over into focusDrafts[item.id] once the item is actually
  // created (see researchSearchResult), so the field's contents survive
  // the transition into a real planning item.
  const [searchFocusDrafts, setSearchFocusDrafts] = useState({});
  // Keyed by item id - loadingId while a research call is in flight,
  // error holds a per-item message if it fails. Nothing here runs
  // automatically; research only ever fires from the button click below.
  const [researchState, setResearchState] = useState({});
  // Per-item free-text draft for "what are you looking for" - kept
  // separate from researchState since it's a live-typed input, not a
  // result of the research call itself.
  const [focusDrafts, setFocusDrafts] = useState({});
  // Same loading/error/result shape as researchState, for the "What to
  // Wear" button - a completely separate call (/api/place-suggestion,
  // mode: "style"), so it gets its own state rather than overloading
  // researchState with unrelated fields.
  const [styleState, setStyleState] = useState({});
  // Per-item menu link drafts, keyed by item id - initialized from
  // item.menu_links (persisted) the first time an item's inputs render,
  // then live-edited here same as focusDrafts. The uploaded files
  // themselves are never persisted - only ever sent inline with the next
  // research call, same "read once, never stored" rule as ContentTab's
  // own menu upload. menuFiles[item.id] is an array (up to
  // MAX_MENU_FILES), same as ContentTab's menuFiles state.
  const [menuLinksDrafts, setMenuLinksDrafts] = useState({});
  const [menuFiles, setMenuFiles] = useState({});
  const [menuFileErrors, setMenuFileErrors] = useState({});

  const categorizedHook = useCategorizedItems(items, setItems, "/api/planning-items");
  const selected = items.find((i) => i.id === selectedId) || null;

  useEffect(() => {
    loadItems();
  }, []);

  async function loadItems() {
    setLoading(true);
    try {
      const res = await fetch("/api/planning-items");
      if (res.ok) {
        const data = await res.json();
        setItems(data.items || []);
      }
    } catch {
      // List just stays empty/stale.
    }
    setLoading(false);
  }

  async function onSearchSubmit(e) {
    e.preventDefault();
    if (!searchQuery.trim() || searchLoading) return;
    setSearchLoading(true);
    setSearchError("");
    setSearchResults(null);
    // Searching for something new - clear whatever was selected so the
    // main panel shows just the fresh results, not an old selected card
    // sitting there alongside them.
    setSelectedId(null);
    try {
      const res = await fetch("/api/planning-search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: searchQuery.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't search for that.");
      setSearchResults(data.places || []);
    } catch (err) {
      setSearchError(err.message || "Couldn't search for that.");
    }
    setSearchLoading(false);
  }

  function toggleSearchPicker(key) {
    setSearchPickerKey((current) => (current === key ? null : key));
    setSearchNewCategoryDraft("");
  }

  async function createPlanningItem(place, category) {
    const res = await fetch("/api/planning-items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: place.name,
        placeCategory: place.category || null,
        area: place.area || null,
        why: place.why || null,
        angle: place.angle || null,
        bucket: null,
        searchLocation: `Search: ${searchQuery.trim()}`,
        category: category || null,
      }),
    });
    if (!res.ok) throw new Error("Couldn't save this place.");
    const data = await res.json();
    setItems((list) => [data.item, ...list]);
    return data.item;
  }

  async function addSearchResultToPlanning(place, category) {
    try {
      const item = await createPlanningItem(place, category);
      // Same "just did this, now show me" flow as ContentTab jumping to a
      // fresh generation - land on the newly added place immediately
      // instead of making them find it in the sidebar themselves.
      setSelectedId(item.id);
    } catch {
      // Leaves the button active so they can just try again.
    }
    setSearchPickerKey(null);
    setSearchNewCategoryDraft("");
  }

  // Research/What to Wear need a real planning_items row to save results
  // against, but the whole point of offering those buttons directly on a
  // not-yet-added search result is that the user shouldn't have to
  // deliberately "Add to Planning" first just to use them - clicking
  // either one saves it uncategorized behind the scenes (same as picking
  // "No category") and proceeds immediately. Once saved, this same result
  // renders as a normal planned card (see plannedItem below), category
  // still addable any time via Categorize.
  async function ensurePlannedItem(place) {
    const existing = items.find((it) => it.name.toLowerCase() === place.name.toLowerCase());
    if (existing) return existing;
    return createPlanningItem(place, null);
  }

  async function researchSearchResult(place) {
    const focus = searchFocusDrafts[place.name] || "";
    setPendingResultKey(`${place.name}:research`);
    try {
      const item = await ensurePlannedItem(place);
      setPendingResultKey(null);
      // Carry the typed draft over so it's still there if they hit
      // "Research again" later, then research immediately using it -
      // passed directly rather than relying on this same-tick state
      // update having flushed by the time research() reads it.
      setFocusDrafts((d) => ({ ...d, [item.id]: focus }));
      await research(item, focus);
    } catch {
      // research() surfaces its own errors once the item exists; if
      // creating the item itself failed, there's nowhere to show that yet
      // - the button just stays clickable so they can try again.
      setPendingResultKey(null);
    }
  }

  async function whatToWearSearchResult(place) {
    setPendingResultKey(`${place.name}:style`);
    try {
      const item = await ensurePlannedItem(place);
      setPendingResultKey(null);
      await whatToWear(item);
    } catch {
      // Same as researchSearchResult's catch above.
      setPendingResultKey(null);
    }
  }

  // focusOverride lets a caller pass a focus value directly instead of
  // reading focusDrafts[item.id] - needed for a not-yet-planned search
  // result, whose focus draft is typed against the place's name (there's
  // no item.id yet at typing time) and only becomes a real item right
  // before this call fires - reading focusDrafts[item.id] here would race
  // against that same-tick state update and likely read stale/empty.
  async function research(item, focusOverride) {
    const focus = focusOverride !== undefined ? focusOverride : focusDrafts[item.id] || "";
    const menuLinks = getMenuLinks(item).map((l) => l.trim()).filter(Boolean);
    const menuFilesData = await Promise.all(
      (menuFiles[item.id] || []).map(async (f) => ({ base64: await fileToBase64(f), mediaType: f.type }))
    );
    setResearchState((s) => ({ ...s, [item.id]: { loading: true, error: null } }));
    try {
      const res = await fetch(`/api/planning-items/${item.id}/research`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: item.name,
          placeCategory: item.place_category,
          area: item.area,
          searchLocation: item.search_location,
          focus,
          menuLinks,
          menuFiles: menuFilesData,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't research this place.");
      setItems((list) => list.map((i) => (i.id === item.id ? data.item : i)));
      setResearchState((s) => ({ ...s, [item.id]: { loading: false, error: null } }));
    } catch (err) {
      setResearchState((s) => ({
        ...s,
        [item.id]: { loading: false, error: err.message || "Couldn't research this place." },
      }));
    }
  }

  async function whatToWear(item) {
    setStyleState((s) => ({ ...s, [item.id]: { ...(s[item.id] || {}), loading: true, error: null } }));
    try {
      const res = await fetch("/api/place-suggestion", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: item.name,
          placeCategory: item.place_category,
          area: item.area,
          searchLocation: item.search_location,
          mode: "style",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't put together a look for this place.");
      setStyleState((s) => ({
        ...s,
        [item.id]: {
          loading: false,
          error: null,
          styleSuggestion: data.suggestion.styleSuggestion || null,
          styleLinks: data.suggestion.styleLinks || [],
        },
      }));
    } catch (err) {
      setStyleState((s) => ({
        ...s,
        [item.id]: { ...(s[item.id] || {}), loading: false, error: err.message || "Couldn't put together a look for this place." },
      }));
    }
  }

  // item.menu_links (persisted) seeds the draft the first time it's
  // needed; after that, whatever's actually been typed wins. Always at
  // least one (empty) input, same as ContentTab's own version.
  function getMenuLinks(item) {
    if (menuLinksDrafts[item.id]) return menuLinksDrafts[item.id];
    return item.menu_links?.length ? item.menu_links : [""];
  }

  function updateMenuLink(item, index, value) {
    const current = getMenuLinks(item);
    const next = current.map((l, i) => (i === index ? value : l));
    setMenuLinksDrafts((d) => ({ ...d, [item.id]: next }));
  }

  function addMenuLink(item) {
    const current = getMenuLinks(item);
    if (current.length >= MAX_MENU_LINKS) return;
    setMenuLinksDrafts((d) => ({ ...d, [item.id]: [...current, ""] }));
  }

  function removeMenuLink(item, index) {
    const current = getMenuLinks(item);
    const next = current.filter((_, i) => i !== index);
    setMenuLinksDrafts((d) => ({ ...d, [item.id]: next.length > 0 ? next : [""] }));
  }

  // Same accumulate-across-picks pattern as ContentTab's own version -
  // each pick's FileList replaces the native input's own selection, so
  // this app keeps its own per-item list instead and resets the input
  // each time so picking again (even the same file) still fires onChange.
  function handleMenuFilesChange(item, e) {
    const picked = Array.from(e.target.files || []);
    e.target.value = "";
    if (picked.length === 0) return;
    setMenuFiles((f) => {
      const current = f[item.id] || [];
      if (current.length >= MAX_MENU_FILES) {
        setMenuFileErrors((errs) => ({ ...errs, [item.id]: `Up to ${MAX_MENU_FILES} files - remove one first.` }));
        return f;
      }
      const combined = [...current, ...picked].slice(0, MAX_MENU_FILES);
      const totalBytes = combined.reduce((sum, file) => sum + file.size, 0);
      if (totalBytes > MAX_MENU_FILES_TOTAL_BYTES) {
        setMenuFileErrors((errs) => ({
          ...errs,
          [item.id]: "Those add up to more than 4MB total - try smaller photos, fewer files, or a PDF instead.",
        }));
        return f;
      }
      setMenuFileErrors((errs) => ({ ...errs, [item.id]: null }));
      return { ...f, [item.id]: combined };
    });
  }

  function removeMenuFile(item, index) {
    setMenuFiles((f) => ({ ...f, [item.id]: (f[item.id] || []).filter((_, i) => i !== index) }));
    setMenuFileErrors((errs) => ({ ...errs, [item.id]: null }));
  }

  async function deleteItem(id) {
    setItems((list) => list.filter((i) => i.id !== id));
    setSelectedId((current) => (current === id ? null : current));
    try {
      await fetch(`/api/planning-items/${id}`, { method: "DELETE" });
    } catch {
      // Already removed from view; a failed delete just means it
      // reappears next reload.
    }
  }

  // Shared full-detail treatment for one planning item - research/what to
  // wear/focus field/results. Used both for the sidebar-selected item AND
  // for a search result that turns out to already be planned (just added,
  // or found again on a later search) - same card either way, so a place
  // never shows two different, inconsistent representations of itself on
  // screen at once.
  function renderPlannedCard(item) {
    const state = researchState[item.id] || {};
    const style = styleState[item.id] || {};
    const r = item.research;
    return (
      <>
        <div className="place-row">
          <div className="place-info">
            <a href={mapsSearchUrl(item.name, item.area)} target="_blank" rel="noopener noreferrer" className="place-link">
              <strong>{item.name}</strong>
            </a>
            {item.area ? ` (${item.area})` : ""}
            {item.why && (
              <>
                <br />
                {item.why}
              </>
            )}
            <br />
            <span className="saved-item-meta">{item.search_location}</span>
            {item.category && (
              <div className="saved-item-chips">
                <span className="saved-chip category-chip">{item.category}</span>
              </div>
            )}
          </div>
          <button type="button" className="btn-ghost place-save-btn" disabled>
            In Planning
          </button>
        </div>

        <div className="field" style={{ marginTop: 12, marginBottom: 8 }}>
          <label htmlFor={`focus-${item.id}`}>What are you looking for? (optional)</label>
          <input
            id={`focus-${item.id}`}
            placeholder="Weird desserts, a hidden room, best time to visit"
            value={focusDrafts[item.id] || ""}
            onChange={(e) => setFocusDrafts((d) => ({ ...d, [item.id]: e.target.value }))}
          />
        </div>

        {(() => {
          const menuLinks = getMenuLinks(item);
          const itemMenuFiles = menuFiles[item.id] || [];
          const menuFileError = menuFileErrors[item.id];
          return (
            <div className="field" style={{ marginBottom: 8 }}>
              <label htmlFor={`menuLink0-${item.id}`}>
                Menu link{menuLinks.length > 1 ? "s" : ""} (optional)
              </label>
              {menuLinks.map((link, i) => (
                <div key={i} style={{ display: "flex", gap: 6, marginBottom: i < menuLinks.length - 1 ? 6 : 0 }}>
                  <input
                    id={i === 0 ? `menuLink0-${item.id}` : undefined}
                    placeholder="https://theirsite.com/menu"
                    value={link}
                    onChange={(e) => updateMenuLink(item, i, e.target.value)}
                  />
                  {menuLinks.length > 1 && (
                    <button
                      type="button"
                      className="btn-ghost"
                      style={{ flexShrink: 0 }}
                      onClick={() => removeMenuLink(item, i)}
                      aria-label="Remove this menu link"
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
              {menuLinks.length < MAX_MENU_LINKS && (
                <button type="button" className="btn-ghost" style={{ marginTop: 8 }} onClick={() => addMenuLink(item)}>
                  + Add another menu link
                </button>
              )}
              <p className="hint" style={{ marginTop: 6 }}>
                Give the app a real menu to ground "Research this place" in, instead of just what search turns up.
              </p>

              <label htmlFor={`menuFile-${item.id}`} style={{ marginTop: 10, display: "block" }}>
                Or upload menu photos/PDFs (optional)
              </label>
              <input
                id={`menuFile-${item.id}`}
                type="file"
                accept="image/*,application/pdf"
                multiple
                onChange={(e) => handleMenuFilesChange(item, e)}
              />
              {itemMenuFiles.length > 0 && (
                <div style={{ marginTop: 6 }}>
                  {itemMenuFiles.map((f, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <p className="hint" style={{ margin: 0, flex: 1 }}>{f.name}</p>
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => removeMenuFile(item, i)}
                        aria-label="Remove this file"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {menuFileError && (
                <p className="hint" style={{ marginTop: 6, color: "var(--bad)" }}>
                  {menuFileError}
                </p>
              )}
            </div>
          );
        })()}

        <div className="place-suggest-row">
          <button type="button" className="btn-ghost" disabled={!!state.loading} onClick={() => research(item)}>
            {state.loading ? "Researching…" : r ? "Research again" : "Research this place"}
          </button>
          <button type="button" className="btn-ghost" disabled={!!style.loading} onClick={() => whatToWear(item)}>
            {style.loading ? "Looking…" : style.styleSuggestion ? "What to Wear (again)" : "What to Wear"}
          </button>
        </div>

        {state.error && (
          <p className="hint" style={{ color: "var(--bad)", marginTop: 6 }}>
            {state.error}
          </p>
        )}
        {style.error && (
          <p className="hint" style={{ color: "var(--bad)", marginTop: 6 }}>
            {style.error}
          </p>
        )}

        {r && (
          <div style={{ marginTop: 12 }}>
            {r.summary && <p className="rationale">{r.summary}</p>}

            {r.wildFoodAndDrink?.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <p className="hint" style={{ fontWeight: 600, marginBottom: 6 }}>
                  {r.isFoodVenue ? "🍸 Wild food & drink ideas" : "🌟 Wild things to see & do"}
                </p>
                {r.wildFoodAndDrink.map((f, fi) => (
                  <div key={fi} style={{ marginBottom: 8 }}>
                    <strong>{f.name}</strong>
                    {f.source && <span className="food-item-source"> · {f.source}</span>}
                    <div style={{ fontSize: 13 }}>{f.description}</div>
                  </div>
                ))}
              </div>
            )}

            {r.secretTips?.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <p className="hint" style={{ fontWeight: 600, marginBottom: 6 }}>
                  🤫 Secret tips
                </p>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                  {r.secretTips.map((t, ti) => (
                    <li key={ti}>{t}</li>
                  ))}
                </ul>
              </div>
            )}

            {r.nearbyWorthGoing?.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <p className="hint" style={{ fontWeight: 600, marginBottom: 6 }}>
                  📍 Also worth going nearby
                </p>
                {r.nearbyWorthGoing.map((p, pi) => (
                  <div key={pi} style={{ marginBottom: 8 }}>
                    <a href={mapsSearchUrl(p.name, p.area)} target="_blank" rel="noopener noreferrer" className="place-link">
                      <strong>{p.name}</strong>
                    </a>
                    {p.area && <span className="food-item-source"> · {p.area}</span>}
                    <div style={{ fontSize: 13 }}>{p.why}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {style.styleSuggestion && (
          <div style={{ marginTop: 12 }}>
            <p className="hint" style={{ fontWeight: 600, marginBottom: 6 }}>
              👗 What to Wear
            </p>
            <p className="rationale">{style.styleSuggestion}</p>
            {style.styleLinks?.length > 0 && (
              <div className="style-links">
                {style.styleLinks.map((link, li) => (
                  <a key={li} href={link.url} target="_blank" rel="noopener noreferrer" className="style-link-card">
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
      </>
    );
  }

  // If the selected item is also one of the current search results, its
  // full card already renders inline in that list (see plannedItem above)
  // - don't render it a second time below.
  const selectedShownInResults =
    selected && searchResults?.some((p) => p.name.toLowerCase() === selected.name.toLowerCase());

  return (
    <div className="layout">
      <div className="main">
        <form onSubmit={onSearchSubmit} className="card">
          <h3 style={{ marginTop: 0 }}>Planning</h3>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="planningSearch">Search for any specific place or experience</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                id="planningSearch"
                autoComplete="off"
                placeholder="A restaurant, bar, hike, or landmark"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onSearchSubmit(e);
                  }
                }}
                style={{ flex: 1, fontSize: 16, padding: "12px 14px" }}
              />
              <button
                className="btn-primary"
                style={{ fontSize: 15, padding: "0 24px", width: "auto", flexShrink: 0 }}
                disabled={searchLoading || !searchQuery.trim()}
              >
                {searchLoading ? "Searching…" : "Search"}
              </button>
            </div>
          </div>

          {searchError && <div className="error-banner" style={{ marginTop: 12 }}>{searchError}</div>}

          {searchResults && searchResults.length === 0 && (
            <p className="hint" style={{ marginTop: 12 }}>Nothing genuine turned up for that search - try being more specific.</p>
          )}

          {searchResults && searchResults.length > 0 && (
            <ul className="shotlist" style={{ marginTop: 12 }}>
              {searchResults.map((place, i) => {
                const key = place.name;
                const plannedItem = items.find((it) => it.name.toLowerCase() === place.name.toLowerCase());

                // Already planned (just added, or found again on a later
                // search) - act exactly like an item that came over from
                // Discovery: the full card, Research/What to Wear ready to
                // use immediately, not a dead-end disabled button. This is
                // the ONLY place this place's card renders - see the
                // skipped duplicate check below the search form.
                if (plannedItem) {
                  return (
                    <li key={i} className="card">
                      {renderPlannedCard(plannedItem)}
                    </li>
                  );
                }

                return (
                  <li key={i}>
                    <div className="place-row">
                      <div className="place-info">
                        <a href={mapsSearchUrl(place.name, place.area)} target="_blank" rel="noopener noreferrer" className="place-link">
                          <strong>{place.name}</strong>
                        </a>
                        {place.area ? ` (${place.area})` : ""}
                        <br />
                        {place.why}
                      </div>
                      <button
                        type="button"
                        className="btn-ghost place-save-btn"
                        onClick={() => toggleSearchPicker(key)}
                      >
                        Add to Planning
                      </button>
                    </div>

                    <div className="field" style={{ marginTop: 12, marginBottom: 8 }}>
                      <label htmlFor={`search-focus-${key}`}>What are you looking for? (optional)</label>
                      <input
                        id={`search-focus-${key}`}
                        placeholder="Weird desserts, a hidden room, best time to visit"
                        value={searchFocusDrafts[key] || ""}
                        onChange={(e) => setSearchFocusDrafts((d) => ({ ...d, [key]: e.target.value }))}
                      />
                    </div>

                    <div className="place-suggest-row">
                      <button
                        type="button"
                        className="btn-ghost"
                        disabled={!!pendingResultKey}
                        onClick={() => researchSearchResult(place)}
                      >
                        {pendingResultKey === `${key}:research` ? "Researching…" : "Research this place"}
                      </button>
                      <button
                        type="button"
                        className="btn-ghost"
                        disabled={!!pendingResultKey}
                        onClick={() => whatToWearSearchResult(place)}
                      >
                        {pendingResultKey === `${key}:style` ? "Looking…" : "What to Wear"}
                      </button>
                    </div>

                    {searchPickerKey === key && (
                      <AddToPlanningPicker
                        planningCategories={categorizedHook.allCategories}
                        draft={searchNewCategoryDraft}
                        onDraftChange={setSearchNewCategoryDraft}
                        onPick={(category) => addSearchResultToPlanning(place, category)}
                        onCancel={() => toggleSearchPicker(null)}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </form>

        {selected && !selectedShownInResults && (
          <div className="card">{renderPlannedCard(selected)}</div>
        )}
      </div>

      <aside className="sidebar">
        <h3 style={{ fontSize: 14, marginBottom: 12 }}>Planning list</h3>

        <CategoryFilterRow
          allCategories={categorizedHook.allCategories}
          categoryFilter={categorizedHook.categoryFilter}
          onFilter={categorizedHook.setCategoryFilter}
        />

        {loading && <p className="hint">Loading…</p>}
        {!loading && items.length === 0 && (
          <p className="hint">Nothing here yet — search above, or hit "Add to Planning" on the Discovery tab.</p>
        )}
        {!loading && items.length > 0 && categorizedHook.filteredItems.length === 0 && (
          <p className="hint">Nothing under "{categorizedHook.categoryFilter}" yet.</p>
        )}

        <div className="saved-list">
          {categorizedHook.filteredItems.map((item) => (
            <div key={item.id} className={`saved-item ${selectedId === item.id ? "active" : ""}`}>
              <div className="saved-item-row">
                <button type="button" className="saved-item-main" onClick={() => setSelectedId(item.id)}>
                  <div className="saved-item-idea">{item.name}</div>
                  <div className="saved-item-meta">{shortArea(item.area) || item.search_location}</div>
                  <div className="saved-item-chips">
                    {item.category && <span className="saved-chip category-chip">{item.category}</span>}
                  </div>
                </button>
                <div className="saved-item-actions">
                  <button
                    type="button"
                    className="saved-item-categorize"
                    onClick={() => categorizedHook.toggleCategorize(item.id)}
                  >
                    Categorize
                  </button>
                  <button
                    type="button"
                    className="saved-item-delete"
                    onClick={() => deleteItem(item.id)}
                    aria-label="Remove from planning"
                  >
                    ×
                  </button>
                </div>
              </div>

              {categorizedHook.categorizingId === item.id && (
                <CategorizePanel
                  item={item}
                  allCategories={categorizedHook.allCategories}
                  newCategoryDraft={categorizedHook.newCategoryDraft}
                  onDraftChange={categorizedHook.setNewCategoryDraft}
                  onApply={categorizedHook.applyCategory}
                  onSubmitNew={categorizedHook.submitNewCategory}
                />
              )}
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
