"use client";

import { useState, useEffect } from "react";
import { useCategorizedItems } from "../../lib/useCategorizedItems";
import { useDraftAutosave, useWarnBeforeLeaving } from "../../lib/useDraftAutosave";
import { CategoryFilterRow, CategorizePanel } from "./CategoryUI";

// Browser-only autosave, same as Discovery - bump the version if the saved
// shape changes in a way an older draft can't be read into.
const COLLAB_DRAFT_STORAGE_KEY = "wwwCollabDraft";
const COLLAB_DRAFT_VERSION = 1;

// Keys match COLLAB_TYPE_PHRASES in lib/claude.js.
const COLLAB_TYPE_OPTIONS = [
  { key: "stays", label: "Stays" },
  { key: "restaurants", label: "Restaurants" },
  { key: "bars", label: "Bars & Wineries" },
  { key: "experiences", label: "Experiences" },
  { key: "tourism", label: "Tourism Boards" },
  { key: "brands", label: "Local Brands" },
];

const LEAD_TYPE_LABELS = {
  stay: "Stay",
  restaurant: "Restaurant",
  bar: "Bar / winery",
  experience: "Experience",
  tourism_board: "Tourism board",
  brand: "Brand",
  other: "Other",
};

// How each lead's collab link was confirmed server-side (see
// findCollabOpportunities in lib/claude.js).
const PROOF_LABELS = {
  official_site: { text: "Linked from their website", className: "live" },
  page_checked: { text: "Collab page checked", className: "live" },
  in_search: { text: "Found in search", className: "estimated" },
  // Only TikTok bios can be read server-side; Instagram's are behind a login.
  bio_checked: { text: "TikTok bio invites collabs", className: "live" },
  bio_unchecked: { text: "Bio not checked", className: "estimated" },
};

const NETWORK_LABELS = { instagram: "Instagram", tiktok: "TikTok" };

const OUTREACH_STATUSES = [
  { key: "new", label: "Not contacted" },
  { key: "pitched", label: "Pitched" },
  { key: "replied", label: "Replied" },
  { key: "booked", label: "Booked" },
  { key: "pass", label: "Not a fit" },
];

function mapsSearchUrl(name, area) {
  const query = [name, area].filter(Boolean).join(", ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

export default function CollabSearchTab() {
  const [location, setLocation] = useState("");
  const [types, setTypes] = useState(["all"]);
  const [focus, setFocus] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  // What was actually searched to produce `result` - the form stays
  // editable for the next search (same idea as DiscoveryTab).
  const [resultLocation, setResultLocation] = useState("");
  const [resultTypes, setResultTypes] = useState(["all"]);
  const [resultFocus, setResultFocus] = useState("");

  const [savedSearches, setSavedSearches] = useState([]);
  const [savedSearchesLoading, setSavedSearchesLoading] = useState(true);
  const [savingSearch, setSavingSearch] = useState(false);
  const [currentSavedSearchId, setCurrentSavedSearchId] = useState(null);

  const searchesHook = useCategorizedItems(savedSearches, setSavedSearches, "/api/collab-searches");

  useEffect(() => {
    loadSavedSearches();
  }, []);

  useDraftAutosave(
    COLLAB_DRAFT_STORAGE_KEY,
    {
      version: COLLAB_DRAFT_VERSION,
      location,
      types,
      focus,
      result,
      resultLocation,
      resultTypes,
      resultFocus,
      currentSavedSearchId,
    },
    (draft) => {
      if (draft.version !== COLLAB_DRAFT_VERSION) return;
      setLocation(draft.location || "");
      if (Array.isArray(draft.types) && draft.types.length) setTypes(draft.types);
      setFocus(draft.focus || "");
      if (draft.result) {
        setResult(draft.result);
        setResultLocation(draft.resultLocation || "");
        setResultTypes(draft.resultTypes || ["all"]);
        setResultFocus(draft.resultFocus || "");
        setCurrentSavedSearchId(draft.currentSavedSearchId || null);
      }
    }
  );
  useWarnBeforeLeaving(loading);

  async function loadSavedSearches() {
    setSavedSearchesLoading(true);
    try {
      const res = await fetch("/api/collab-searches");
      if (res.ok) {
        const data = await res.json();
        const searches = data.searches || [];
        setSavedSearches(searches);
        setCurrentSavedSearchId((id) => (id && !searches.some((s) => s.id === id) ? null : id));
      }
    } catch {
      // List just stays empty - searching still works.
    }
    setSavedSearchesLoading(false);
  }

  function toggleType(key) {
    setTypes((current) => {
      if (key === "all") return ["all"];
      const withoutAll = current.filter((t) => t !== "all");
      const next = withoutAll.includes(key) ? withoutAll.filter((t) => t !== key) : [...withoutAll, key];
      return next.length === 0 ? ["all"] : next;
    });
  }

  // Parsed as text first, same reason as DiscoveryTab: a non-JSON body means
  // the platform killed the request (a timeout), not an app error.
  async function runSearch(body) {
    const res = await fetch("/api/collab-search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error("Request timed out or failed before completing. Try again, or pick fewer business types.");
    }
    if (!res.ok) throw new Error(data.error || "Couldn't search for collabs.");
    return data.collabResults;
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (!location.trim() || loading) return;

    setLoading(true);
    setError("");
    setResult(null);
    setCurrentSavedSearchId(null);
    try {
      const found = await runSearch({ location: location.trim(), types, focus: focus.trim() });
      setResult({ ...found, leads: found.leads.map((l) => ({ ...l, status: "new" })) });
      setResultLocation(location.trim());
      setResultTypes(types);
      setResultFocus(focus.trim());
    } catch (err) {
      setError(err.message || "Couldn't search for collabs.");
    }
    setLoading(false);
  }

  // Keeps a saved search in step with a lead's status change. Best-effort,
  // like every other write here.
  async function persistResults(nextResult) {
    if (!currentSavedSearchId) return;
    const id = currentSavedSearchId;
    setSavedSearches((list) => list.map((s) => (s.id === id ? { ...s, results: nextResult } : s)));
    try {
      await fetch(`/api/collab-searches/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ results: nextResult }),
      });
    } catch {
      // Still correct on screen and in the autosave.
    }
  }

  function setLeadStatus(index, status) {
    const next = { ...result, leads: result.leads.map((l, i) => (i === index ? { ...l, status } : l)) };
    setResult(next);
    persistResults(next);
  }

  async function saveCurrentSearch() {
    if (!result || savingSearch) return;
    setSavingSearch(true);
    try {
      const res = await fetch("/api/collab-searches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ location: resultLocation, types: resultTypes, focus: resultFocus, results: result }),
      });
      if (res.ok) {
        const data = await res.json();
        setSavedSearches((list) => [data.savedSearch, ...list]);
        setCurrentSavedSearchId(data.savedSearch.id);
      }
    } catch {
      // Leaves the Save button active so they can try again.
    }
    setSavingSearch(false);
  }

  function loadSavedSearch(saved) {
    setLocation(saved.location);
    setTypes(saved.types?.length ? saved.types : ["all"]);
    setFocus(saved.focus || "");
    setResult(saved.results);
    setResultLocation(saved.location);
    setResultTypes(saved.types || ["all"]);
    setResultFocus(saved.focus || "");
    setCurrentSavedSearchId(saved.id);
    setError("");
  }

  async function deleteSavedSearch(id) {
    setSavedSearches((list) => list.filter((s) => s.id !== id));
    setCurrentSavedSearchId((current) => (current === id ? null : current));
    try {
      await fetch(`/api/collab-searches/${id}`, { method: "DELETE" });
    } catch {
      // Already gone from view; a failed delete just reappears next reload.
    }
  }

  const leads = result?.leads || [];

  return (
    <div className="layout">
      <div className="main">
        <form onSubmit={onSubmit} className="card">
          <div className="field">
            <label htmlFor="collabLocation">Area to search</label>
            <input
              id="collabLocation"
              required
              placeholder="Québec City, or the White Mountains, NH"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="collabFocus">Anything specific? (optional)</label>
            <input
              id="collabFocus"
              placeholder="Glamping, wineries, dog-friendly"
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
            />
          </div>

          <div className="field">
            <label>Type of business</label>
            <div className="platform-toggle">
              <button
                type="button"
                className={`goal-option ${types.includes("all") ? "active" : ""}`}
                onClick={() => toggleType("all")}
                aria-pressed={types.includes("all")}
              >
                <span className="goal-title">All types</span>
              </button>
              {COLLAB_TYPE_OPTIONS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className={`goal-option ${types.includes(t.key) ? "active" : ""}`}
                  onClick={() => toggleType(t.key)}
                  aria-pressed={types.includes(t.key)}
                >
                  <span className="goal-title">{t.label}</span>
                </button>
              ))}
            </div>
            <p className="hint" style={{ marginTop: 6 }}>
              Finds places publicly asking creators to collab — a form or page on their site, a creator program, or an
              Instagram/TikTok bio inviting collabs.
            </p>
          </div>

          {error && <div className="error-banner">{error}</div>}

          <button className="btn-primary" disabled={loading || !location.trim()}>
            {loading ? "Searching… (about a minute)" : "Find collabs"}
          </button>
        </form>

        {result && (
          <div className="result card">
            <div className="result-head">
              <h3 style={{ fontSize: 16 }}>
                {leads.length} lead{leads.length === 1 ? "" : "s"} in {resultLocation}
              </h3>
              <button className="btn-ghost" onClick={saveCurrentSearch} disabled={savingSearch || !!currentSavedSearchId}>
                {currentSavedSearchId ? "Saved" : savingSearch ? "Saving…" : "Save this search"}
              </button>
            </div>

            {resultFocus && (
              <p className="hint" style={{ marginBottom: 12 }}>
                Focused on: <strong>{resultFocus}</strong>
              </p>
            )}
            {result.note && <p className="rationale" style={{ marginBottom: 14 }}>{result.note}</p>}

            {leads.length === 0 && (
              <p className="hint">
                Nothing turned up with a collab invite that could be confirmed. Try a bigger area or a different type.
              </p>
            )}

            <div className="tag-list">
              {leads.map((l, i) => {
                const proof = PROOF_LABELS[l.apply?.status];
                const applyUrl = l.apply?.url;
                const isEmail = applyUrl?.startsWith("mailto:");
                const bioNetwork = NETWORK_LABELS[l.apply?.network];
                return (
                  <div className={`tag-account collab-lead ${l.status === "pass" ? "collab-lead-pass" : ""}`} key={`${l.name}-${i}`}>
                    <div className="tag-account-head">
                      <strong>
                        {l.website ? (
                          <a href={l.website} target="_blank" rel="noopener noreferrer" className="place-link">
                            {l.name}
                          </a>
                        ) : (
                          l.name
                        )}
                      </strong>
                      <span className="saved-chip">{LEAD_TYPE_LABELS[l.type] || "Other"}</span>
                      {proof && <span className={`badge ${proof.className}`}>{proof.text}</span>}
                    </div>
                    {l.town && (
                      <p className="hint" style={{ margin: "0 0 6px" }}>
                        <a href={mapsSearchUrl(l.name, l.town)} target="_blank" rel="noopener noreferrer" className="place-link">
                          📍 {l.town}
                        </a>
                      </p>
                    )}
                    {l.evidence && <p className="tag-why">{l.evidence}</p>}
                    {l.apply?.linkText && (
                      <p className="hint" style={{ margin: "4px 0" }}>
                        Their site links: <strong>“{l.apply.linkText}”</strong>
                      </p>
                    )}
                    {l.apply?.bioText && (
                      <p className="hint" style={{ margin: "4px 0" }}>
                        Their bio: <strong>“{l.apply.bioText}”</strong>
                      </p>
                    )}
                    {l.apply?.status === "bio_unchecked" && (
                      <p className="hint" style={{ margin: "4px 0" }}>
                        Seen in search, but {bioNetwork} doesn't let the app open their bio to confirm it. Take a look
                        before messaging.
                      </p>
                    )}
                    {(l.offer || l.requirements) && (
                      <p className="hint" style={{ margin: "4px 0" }}>
                        {l.offer && (
                          <>
                            <strong>Offers:</strong> {l.offer}
                          </>
                        )}
                        {l.offer && l.requirements && " · "}
                        {l.requirements && (
                          <>
                            <strong>Asks for:</strong> {l.requirements}
                          </>
                        )}
                      </p>
                    )}
                    {l.fit && <p className="hint" style={{ margin: "4px 0 10px" }}>{l.fit}</p>}

                    <div className="collab-actions">
                      {applyUrl && (
                        <a className="btn-primary collab-apply" href={applyUrl} target="_blank" rel="noopener noreferrer">
                          {isEmail ? `Email ${applyUrl.slice(7)}` : bioNetwork ? `DM on ${bioNetwork}` : "Open collab page"}
                        </a>
                      )}
                      {l.evidenceUrl && l.evidenceUrl !== applyUrl && (
                        <a className="btn-ghost collab-apply" href={l.evidenceUrl} target="_blank" rel="noopener noreferrer">
                          Source
                        </a>
                      )}
                      {l.instagram && l.apply?.network !== "instagram" && (
                        <a
                          className="btn-ghost collab-apply"
                          href={`https://www.instagram.com/${l.instagram}/`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          @{l.instagram}
                        </a>
                      )}
                      {l.tiktok && l.apply?.network !== "tiktok" && (
                        <a
                          className="btn-ghost collab-apply"
                          href={`https://www.tiktok.com/@${l.tiktok}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          TikTok @{l.tiktok}
                        </a>
                      )}
                      <select
                        className="collab-status"
                        value={l.status || "new"}
                        onChange={(e) => setLeadStatus(i, e.target.value)}
                        aria-label={`Outreach status for ${l.name}`}
                      >
                        {OUTREACH_STATUSES.map((s) => (
                          <option key={s.key} value={s.key}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                );
              })}
            </div>

            <p className="hint" style={{ marginTop: 16 }}>
              Only places whose collab invite could be checked are listed.
            </p>
          </div>
        )}
      </div>

      <aside className="sidebar">
        <h3 style={{ fontSize: 14, marginBottom: 12 }}>Saved collab searches</h3>
        <CategoryFilterRow
          allCategories={searchesHook.allCategories}
          categoryFilter={searchesHook.categoryFilter}
          onFilter={searchesHook.setCategoryFilter}
        />
        {savedSearchesLoading && <p className="hint">Loading…</p>}
        {!savedSearchesLoading && savedSearches.length === 0 && (
          <p className="hint">Nothing saved yet — hit "Save this search" after searching an area.</p>
        )}
        {!savedSearchesLoading && savedSearches.length > 0 && searchesHook.filteredItems.length === 0 && (
          <p className="hint">Nothing saved under "{searchesHook.categoryFilter}" yet.</p>
        )}
        <div className="saved-list">
          {searchesHook.filteredItems.map((s) => {
            const savedLeads = s.results?.leads || [];
            const pitched = savedLeads.filter((l) => l.status && l.status !== "new" && l.status !== "pass").length;
            return (
              <div key={s.id} className={`saved-item ${currentSavedSearchId === s.id ? "active" : ""}`}>
                <div className="saved-item-row">
                  <button type="button" className="saved-item-main" onClick={() => loadSavedSearch(s)}>
                    <div className="saved-item-idea">{s.location}</div>
                    <div className="saved-item-meta">
                      {savedLeads.length} lead{savedLeads.length === 1 ? "" : "s"}
                      {pitched ? ` · ${pitched} in progress` : ""}
                      {s.focus ? ` · ${s.focus}` : ""}
                    </div>
                    {s.category && (
                      <div className="saved-item-chips">
                        <span className="saved-chip category-chip">{s.category}</span>
                      </div>
                    )}
                  </button>
                  <div className="saved-item-actions">
                    <button type="button" className="saved-item-categorize" onClick={() => searchesHook.toggleCategorize(s.id)}>
                      Categorize
                    </button>
                    <button
                      type="button"
                      className="saved-item-delete"
                      onClick={() => deleteSavedSearch(s.id)}
                      aria-label="Delete saved collab search"
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
