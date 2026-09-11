"use client";

import { useState, useEffect } from "react";

const initialCaptionForm = { platform: "", stats: "", tier: "baseline", why: "", caption: "" };

export default function ProfileTab() {
  const [instructions, setInstructions] = useState([]);
  const [instructionsLoading, setInstructionsLoading] = useState(true);
  const [newInstruction, setNewInstruction] = useState("");
  const [savingInstruction, setSavingInstruction] = useState(false);

  const [captions, setCaptions] = useState([]);
  const [captionsLoading, setCaptionsLoading] = useState(true);
  const [captionForm, setCaptionForm] = useState(initialCaptionForm);
  const [savingCaption, setSavingCaption] = useState(false);
  const [editingCaptionId, setEditingCaptionId] = useState(null);

  useEffect(() => {
    loadInstructions();
    loadCaptions();
  }, []);

  async function loadInstructions() {
    setInstructionsLoading(true);
    try {
      const res = await fetch("/api/profile-instructions");
      if (res.ok) {
        const data = await res.json();
        setInstructions(data.instructions || []);
      }
    } catch {
      // List just stays empty/stale.
    }
    setInstructionsLoading(false);
  }

  async function loadCaptions() {
    setCaptionsLoading(true);
    try {
      const res = await fetch("/api/profile-captions");
      if (res.ok) {
        const data = await res.json();
        setCaptions(data.captions || []);
      }
    } catch {
      // Same as above - generation still falls back to the built-in defaults either way.
    }
    setCaptionsLoading(false);
  }

  async function addInstruction(e) {
    e.preventDefault();
    const text = newInstruction.trim();
    if (!text || savingInstruction) return;
    setSavingInstruction(true);
    try {
      const res = await fetch("/api/profile-instructions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (res.ok) {
        const data = await res.json();
        setInstructions((list) => [...list, data.instruction]);
        setNewInstruction("");
      }
    } catch {
      // Leaves the draft text in place so they can just retry.
    }
    setSavingInstruction(false);
  }

  async function deleteInstruction(id) {
    setInstructions((list) => list.filter((i) => i.id !== id));
    try {
      await fetch(`/api/profile-instructions/${id}`, { method: "DELETE" });
    } catch {
      // Already removed from view; a failed delete just means it reappears next reload.
    }
  }

  function resetCaptionForm() {
    setCaptionForm(initialCaptionForm);
    setEditingCaptionId(null);
  }

  async function submitCaption(e) {
    e.preventDefault();
    if (!captionForm.platform.trim() || !captionForm.caption.trim() || savingCaption) return;
    setSavingCaption(true);
    try {
      const isEditing = !!editingCaptionId;
      const res = await fetch(isEditing ? `/api/profile-captions/${editingCaptionId}` : "/api/profile-captions", {
        method: isEditing ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(captionForm),
      });
      if (res.ok) {
        const data = await res.json();
        const saved = data.caption;
        setCaptions((list) => (isEditing ? list.map((c) => (c.id === saved.id ? saved : c)) : [...list, saved]));
        resetCaptionForm();
      }
    } catch {
      // Leaves the form filled in so they can just retry.
    }
    setSavingCaption(false);
  }

  function editCaption(c) {
    setEditingCaptionId(c.id);
    setCaptionForm({ platform: c.platform, stats: c.stats || "", tier: c.tier, why: c.why || "", caption: c.caption });
  }

  async function deleteCaption(id) {
    setCaptions((list) => list.filter((c) => c.id !== id));
    if (editingCaptionId === id) resetCaptionForm();
    try {
      await fetch(`/api/profile-captions/${id}`, { method: "DELETE" });
    } catch {
      // Same degrade-gracefully rule as deleteInstruction above.
    }
  }

  return (
    <div className="layout">
      <div className="main">
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Custom instructions</h3>
          <p className="hint">
            Free-text rules the app follows on every generation - a phrasing habit to avoid (e.g. "no double hyphens (--) or em
            dashes, that reads as AI-written"), a fact it should always get right, an example food/place it should know about, or
            anything else it should adhere to. These apply on top of the voice examples below and win if the two ever conflict.
          </p>
          {instructionsLoading && <p className="hint">Loading…</p>}
          {!instructionsLoading && instructions.length === 0 && <p className="hint">Nothing added yet.</p>}
          <div className="saved-list">
            {instructions.map((i) => (
              <div key={i.id} className="saved-item">
                <div className="saved-item-row">
                  <div className="saved-item-main" style={{ cursor: "default" }}>
                    {i.text}
                  </div>
                  <div className="saved-item-actions">
                    <button
                      type="button"
                      className="saved-item-delete"
                      onClick={() => deleteInstruction(i.id)}
                      aria-label="Delete instruction"
                    >
                      ×
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <form onSubmit={addInstruction} style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <input
              placeholder='e.g. "No double hyphens (--) or em dashes in captions"'
              value={newInstruction}
              onChange={(e) => setNewInstruction(e.target.value)}
              style={{ flex: 1 }}
            />
            <button type="submit" className="btn-ghost" disabled={savingInstruction || !newInstruction.trim()}>
              {savingInstruction ? "Adding…" : "Add"}
            </button>
          </form>
        </div>

        <div className="card" style={{ marginTop: 20 }}>
          <h3 style={{ marginTop: 0 }}>Voice examples (sample captions)</h3>
          <p className="hint">
            Real captions the app studies to sound like Leah and repeat what's actually worked - the same 15 that used to be
            hardcoded in the app's code now live here, editable. Add more of hers over time to keep this current; if this list is
            ever empty, the app falls back to its original built-in 15 rather than losing its voice entirely.
          </p>
          {captionsLoading && <p className="hint">Loading…</p>}
          {!captionsLoading && captions.length === 0 && (
            <p className="hint">Nothing added yet - the app is using its built-in defaults until you add some here.</p>
          )}
          <div className="saved-list">
            {captions.map((c) => (
              <div key={c.id} className="saved-item">
                <div className="saved-item-row">
                  <div className="saved-item-main" style={{ cursor: "default" }}>
                    <div className="saved-item-idea">
                      {c.platform}
                      {c.stats ? ` · ${c.stats}` : ""}
                    </div>
                    <div className="saved-item-chips">
                      <span className={`saved-chip ${c.tier === "outlier" ? "category-chip" : ""}`}>{c.tier}</span>
                    </div>
                    {c.why && <div className="saved-item-meta">{c.why}</div>}
                    <p style={{ fontSize: 13, marginTop: 6, marginBottom: 0, whiteSpace: "pre-wrap" }}>{c.caption}</p>
                  </div>
                  <div className="saved-item-actions">
                    <button type="button" className="saved-item-categorize" onClick={() => editCaption(c)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="saved-item-delete"
                      onClick={() => deleteCaption(c.id)}
                      aria-label="Delete caption"
                    >
                      ×
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <form onSubmit={submitCaption} className="card" style={{ marginTop: 16, background: "var(--bg-raised)" }}>
            <h4 style={{ marginTop: 0 }}>{editingCaptionId ? "Edit caption" : "Add a caption"}</h4>
            <div className="field">
              <label htmlFor="captionPlatform">Platform</label>
              <input
                id="captionPlatform"
                placeholder="Instagram, TikTok, Instagram + TikTok..."
                value={captionForm.platform}
                onChange={(e) => setCaptionForm((f) => ({ ...f, platform: e.target.value }))}
              />
            </div>
            <div className="field">
              <label htmlFor="captionStats">Stats (optional)</label>
              <input
                id="captionStats"
                placeholder="31K likes, 501 comments"
                value={captionForm.stats}
                onChange={(e) => setCaptionForm((f) => ({ ...f, stats: e.target.value }))}
              />
            </div>
            <div className="field">
              <label htmlFor="captionTier">Tier</label>
              <select
                id="captionTier"
                value={captionForm.tier}
                onChange={(e) => setCaptionForm((f) => ({ ...f, tier: e.target.value }))}
              >
                <option value="baseline">Baseline (normal reach)</option>
                <option value="outlier">Outlier (performed way above normal)</option>
              </select>
            </div>
            {captionForm.tier === "outlier" && (
              <div className="field">
                <label htmlFor="captionWhy">Why it outperformed (optional)</label>
                <input
                  id="captionWhy"
                  placeholder="Animal content + a specific number in line one..."
                  value={captionForm.why}
                  onChange={(e) => setCaptionForm((f) => ({ ...f, why: e.target.value }))}
                />
              </div>
            )}
            <div className="field">
              <label htmlFor="captionText">Caption text</label>
              <textarea
                id="captionText"
                rows={5}
                placeholder="Paste the real caption here..."
                value={captionForm.caption}
                onChange={(e) => setCaptionForm((f) => ({ ...f, caption: e.target.value }))}
              />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="submit"
                className="btn-primary"
                disabled={savingCaption || !captionForm.platform.trim() || !captionForm.caption.trim()}
              >
                {savingCaption ? "Saving…" : editingCaptionId ? "Save changes" : "Add caption"}
              </button>
              {editingCaptionId && (
                <button type="button" className="btn-ghost" onClick={resetCaptionForm}>
                  Cancel
                </button>
              )}
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
