"use client";

import { useState, useEffect } from "react";

const initialCaptionForm = { platform: "", stats: "", tier: "baseline", why: "", caption: "" };

// No stored title for a caption - just the hook line it already opens
// with (this app's captions are always written hook-first, blank line,
// then body), trimmed to a card-friendly length. Good enough as a "what
// is this one about" label without needing a real title field/migration.
function captionTitle(caption) {
  if (!caption) return "";
  const firstLine = caption.split("\n")[0].trim();
  return firstLine.length > 70 ? firstLine.slice(0, 70).trim() + "…" : firstLine;
}

export default function ProfileTab() {
  const [instructions, setInstructions] = useState([]);
  const [instructionsLoading, setInstructionsLoading] = useState(true);
  const [newInstruction, setNewInstruction] = useState("");
  const [savingInstruction, setSavingInstruction] = useState(false);
  // Editing happens inline, in place of the instruction's own row - kept
  // as its own draft (separate from newInstruction, the "add a new one"
  // field below the list) so editing one doesn't touch or get confused
  // with whatever's currently typed into Add.
  const [editingInstructionId, setEditingInstructionId] = useState(null);
  const [editingInstructionDraft, setEditingInstructionDraft] = useState("");
  const [savingInstructionEdit, setSavingInstructionEdit] = useState(false);
  // Trello-style drag reorder - id (not index) of the row currently being
  // dragged, or null when nothing is. See handleInstructionDragOver below.
  const [draggedInstructionId, setDraggedInstructionId] = useState(null);

  const [captions, setCaptions] = useState([]);
  const [captionsLoading, setCaptionsLoading] = useState(true);
  const [captionForm, setCaptionForm] = useState(initialCaptionForm);
  const [savingCaption, setSavingCaption] = useState(false);
  const [editingCaptionId, setEditingCaptionId] = useState(null);
  // Collapsed by default - one caption's full text open at a time, since
  // 18+ full captions all expanded at once was the whole problem being
  // fixed here.
  const [expandedCaptionId, setExpandedCaptionId] = useState(null);

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

  async function submitInstruction(e) {
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

  function editInstruction(i) {
    setEditingInstructionId(i.id);
    setEditingInstructionDraft(i.text);
  }

  function cancelEditInstruction() {
    setEditingInstructionId(null);
    setEditingInstructionDraft("");
  }

  async function saveInstructionEdit(id) {
    const text = editingInstructionDraft.trim();
    if (!text || savingInstructionEdit) return;
    setSavingInstructionEdit(true);
    try {
      const res = await fetch(`/api/profile-instructions/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (res.ok) {
        const data = await res.json();
        setInstructions((list) => list.map((i) => (i.id === id ? data.instruction : i)));
        cancelEditInstruction();
      }
    } catch {
      // Leaves the inline editor open with the draft intact so they can retry.
    }
    setSavingInstructionEdit(false);
  }

  async function deleteInstruction(id) {
    setInstructions((list) => list.filter((i) => i.id !== id));
    if (editingInstructionId === id) cancelEditInstruction();
    try {
      await fetch(`/api/profile-instructions/${id}`, { method: "DELETE" });
    } catch {
      // Already removed from view; a failed delete just means it reappears next reload.
    }
  }

  // The list itself reorders live as the dragged row crosses another one,
  // so by the time the drag ends the on-screen order already IS the new
  // order - dragEnd just has to persist it.
  function handleInstructionDragOver(e, overId) {
    e.preventDefault();
    if (draggedInstructionId === null || draggedInstructionId === overId) return;
    setInstructions((list) => {
      const fromIndex = list.findIndex((i) => i.id === draggedInstructionId);
      const toIndex = list.findIndex((i) => i.id === overId);
      if (fromIndex === -1 || toIndex === -1) return list;
      const reordered = [...list];
      const [moved] = reordered.splice(fromIndex, 1);
      reordered.splice(toIndex, 0, moved);
      return reordered;
    });
  }

  async function handleInstructionDragEnd() {
    setDraggedInstructionId(null);
    try {
      await fetch("/api/profile-instructions/reorder", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: instructions.map((i) => i.id) }),
      });
    } catch {
      // Already reordered on screen; a failed save just means it reverts next reload.
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
          <p className="hint">Instructions the app follows on every generation.</p>
          <form onSubmit={submitInstruction} style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <input
              placeholder='e.g. "No double hyphens (--) or em dashes in captions"'
              value={newInstruction}
              onChange={(e) => setNewInstruction(e.target.value)}
              style={{ flex: 1 }}
            />
            <button type="submit" className="btn-ghost" disabled={savingInstruction || !newInstruction.trim()}>
              {savingInstruction ? "Saving…" : "Add"}
            </button>
          </form>
          {instructionsLoading && <p className="hint">Loading…</p>}
          {!instructionsLoading && instructions.length === 0 && <p className="hint">Nothing added yet.</p>}
          <div className="saved-list">
            {instructions.map((i) => {
              const isEditing = editingInstructionId === i.id;
              return (
                <div
                  key={i.id}
                  className="saved-item"
                  draggable={!isEditing}
                  onDragStart={() => setDraggedInstructionId(i.id)}
                  onDragOver={(e) => handleInstructionDragOver(e, i.id)}
                  onDragEnd={handleInstructionDragEnd}
                  style={{
                    opacity: draggedInstructionId === i.id ? 0.4 : 1,
                    cursor: isEditing ? "default" : "grab",
                  }}
                >
                  <div className="saved-item-row">
                    {!isEditing && (
                      <span
                        aria-hidden="true"
                        style={{ padding: "0 4px", color: "var(--ink-faint)", flexShrink: 0 }}
                      >
                        ⠿
                      </span>
                    )}
                    {isEditing ? (
                      <div style={{ display: "flex", gap: 8, flex: 1, padding: "6px 10px" }}>
                        <input
                          autoFocus
                          value={editingInstructionDraft}
                          onChange={(e) => setEditingInstructionDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              saveInstructionEdit(i.id);
                            } else if (e.key === "Escape") {
                              cancelEditInstruction();
                            }
                          }}
                          style={{ flex: 1 }}
                        />
                      </div>
                    ) : (
                      <div className="saved-item-main" style={{ cursor: "default" }}>
                        {i.text}
                      </div>
                    )}
                    <div className="saved-item-actions">
                      {isEditing ? (
                        <>
                          <button
                            type="button"
                            className="saved-item-categorize"
                            disabled={savingInstructionEdit || !editingInstructionDraft.trim()}
                            onClick={() => saveInstructionEdit(i.id)}
                          >
                            {savingInstructionEdit ? "Saving…" : "Save"}
                          </button>
                          <button type="button" className="saved-item-categorize" onClick={cancelEditInstruction}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button type="button" className="saved-item-categorize" onClick={() => editInstruction(i)}>
                          Edit
                        </button>
                      )}
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
              );
            })}
          </div>
        </div>

        <div className="card" style={{ marginTop: 20 }}>
          <h3 style={{ marginTop: 0 }}>Voice examples (sample captions)</h3>
          <p className="hint">Real captions the app studies to sound like Leah and repeat what's actually worked. Add, edit, or remove them any time.</p>
          {captionsLoading && <p className="hint">Loading…</p>}
          {!captionsLoading && captions.length === 0 && (
            <p className="hint">Nothing added yet - the app is using its built-in defaults until you add some here.</p>
          )}
          <div className="saved-list">
            {captions.map((c) => {
              const isExpanded = expandedCaptionId === c.id;
              return (
                <div key={c.id} className="saved-item">
                  <div className="saved-item-row">
                    <button
                      type="button"
                      className="saved-item-main"
                      onClick={() => setExpandedCaptionId((id) => (id === c.id ? null : c.id))}
                    >
                      <div className="saved-item-idea">{captionTitle(c.caption)}</div>
                      <div className="saved-item-chips">
                        <span className="saved-chip">{c.platform}</span>
                        <span className={`saved-chip ${c.tier === "outlier" ? "category-chip" : ""}`}>{c.tier}</span>
                      </div>
                    </button>
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
                  {isExpanded && (
                    <div style={{ padding: "0 10px 10px" }}>
                      {c.stats && <div className="saved-item-meta">{c.stats}</div>}
                      {c.why && <div className="saved-item-meta">{c.why}</div>}
                      <p style={{ fontSize: 13, marginTop: 6, marginBottom: 0, whiteSpace: "pre-wrap" }}>{c.caption}</p>
                    </div>
                  )}
                </div>
              );
            })}
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
