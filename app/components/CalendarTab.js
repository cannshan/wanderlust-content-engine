"use client";

import { useState, useEffect } from "react";
import PlanningCalendar from "./PlanningCalendar";

// Zero-padded "YYYY-MM-DD" for an <input type="date">, built from y/m/d
// numbers rather than toISOString() - that converts to UTC first and can
// hand back yesterday's date depending on the viewer's timezone. Same
// reasoning as dateKey() in PlanningCalendar.js.
function todayValue() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Backs two separate top-level tabs (see page.js) rather than one Calendar
// tab with a toggle - `kind` picks which, fixed for the component's whole
// life (page.js mounts one instance per kind, both always mounted, same
// as every other tab).
//
// **Content Calendar** (kind: "content", placed after Content): a **saved
// idea** with a planned_date is a full generated package that also
// happens to be scheduled - it belongs to the Content tab, and is
// read-only here. A **note** is just a title and a day: content that's
// already made and only needs a post date, where there's nothing for the
// app to generate or store. Those are created, edited and removed right
// here, which is the whole point - scheduling something shouldn't require
// inventing a content record to hang the date on.
//
// **Trip Calendar** (kind: "trip", placed after Planning): every Planning
// tab item with a planned date, shown on its own so a trip's places don't
// clutter (or get cluttered by) the content schedule. It's read-only in
// the sense that what a place *is* only changes on the Planning tab - but
// its date can still be dragged to a different day right here, same as
// everything else.
export default function CalendarTab({ kind, active }) {
  const isTrip = kind === "trip";
  const [ideas, setIdeas] = useState([]);
  const [notes, setNotes] = useState([]);
  const [planningItems, setPlanningItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(todayValue);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [calendarDate, setCalendarDate] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });

  // The note currently open for editing (title/date/completed), or null.
  // Holds a plain draft copy - { id, title, plannedDate, completed } -
  // rather than the note object itself, so typing in the form doesn't
  // touch `notes` until Save actually succeeds. Content Calendar only -
  // Trip Calendar never sets this.
  const [editingNote, setEditingNote] = useState(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState("");

  // Same idea, for a Trip Calendar item - { id, name, plannedDate }, no
  // completed flag (a planning item is never marked done from here). Kept
  // as its own state rather than reusing editingNote, since it saves
  // through a different route (planning-items, not calendar-items) and
  // has no completed toggle - a shared shape would just mean checking
  // which fields actually apply on every use.
  const [editingPlanningItem, setEditingPlanningItem] = useState(null);
  const [planningEditSaving, setPlanningEditSaving] = useState(false);
  const [planningEditError, setPlanningEditError] = useState("");

  useEffect(() => {
    if (!editingNote && !editingPlanningItem) return;
    const onKeyDown = (e) => {
      if (e.key !== "Escape") return;
      setEditingNote(null);
      setEditingPlanningItem(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editingNote, editingPlanningItem]);

  // Refetched every time the tab is opened, not just on mount. Every tab
  // stays mounted for the whole session (see the comment in page.js), so
  // a mount-only fetch would show whatever was scheduled when the app
  // first loaded and never notice a date set on Content or Planning
  // since. Only fetches what this instance's own calendar actually shows.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    (async () => {
      try {
        if (isTrip) {
          const res = await fetch("/api/planning-items");
          if (res.ok) {
            const data = await res.json();
            if (!cancelled) setPlanningItems(data.items || []);
          }
        } else {
          const [ideasRes, notesRes] = await Promise.all([fetch("/api/ideas"), fetch("/api/calendar-items")]);
          if (ideasRes.ok) {
            const data = await ideasRes.json();
            if (!cancelled) setIdeas(data.ideas || []);
          }
          if (notesRes.ok) {
            const data = await notesRes.json();
            if (!cancelled) setNotes(data.items || []);
          }
        }
      } catch {
        // Same quiet degrade as the Content sidebar's own load - an empty
        // or stale calendar, never a broken tab.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [active, isTrip]);

  function jumpToMonth(isoDate) {
    const [y, m] = isoDate.split("-").map(Number);
    setCalendarDate({ year: y, month: m - 1 });
  }

  async function addNote(e) {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || !date || adding) return;

    setAdding(true);
    setError("");
    try {
      const res = await fetch("/api/calendar-items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: trimmed, plannedDate: date }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't add that.");
      setNotes((list) => [...list, data.item]);
      // Only the title clears. The date stays put, since planning a week
      // usually means adding several things to the same day or stepping
      // forward from it - retyping the date every time would be the
      // annoying part.
      setTitle("");
      // Jump the visible month to where the thing just landed, so adding
      // something in November while looking at September doesn't look
      // like nothing happened.
      jumpToMonth(date);
    } catch (err) {
      setError(err.message);
    } finally {
      setAdding(false);
    }
  }

  async function removeNote(item) {
    const before = notes;
    setNotes((list) => list.filter((n) => n.id !== item.id));
    try {
      const res = await fetch(`/api/calendar-items/${item.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
    } catch {
      // Put it back rather than leaving the screen disagreeing with the
      // database - a vanished entry she didn't actually manage to delete
      // is worse than a failed delete she can retry.
      setNotes(before);
      setError("Couldn't remove that one - it's still there.");
    }
  }

  function openEditNote(item) {
    setEditingNote({
      id: item.id,
      title: item.title,
      plannedDate: item.planned_date,
      completed: !!item.completed,
    });
    setEditError("");
  }

  async function saveEditNote(e) {
    e.preventDefault();
    if (!editingNote || editSaving) return;
    const trimmedTitle = editingNote.title.trim();
    if (!trimmedTitle || !editingNote.plannedDate) return;

    setEditSaving(true);
    setEditError("");
    try {
      const res = await fetch(`/api/calendar-items/${editingNote.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: trimmedTitle,
          plannedDate: editingNote.plannedDate,
          completed: editingNote.completed,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't save that.");
      setNotes((list) => list.map((n) => (n.id === data.item.id ? data.item : n)));
      jumpToMonth(data.item.planned_date);
      setEditingNote(null);
    } catch (err) {
      setEditError(err.message || "Couldn't save that.");
    } finally {
      setEditSaving(false);
    }
  }

  async function deleteEditingNote() {
    if (!editingNote || editSaving) return;
    setEditSaving(true);
    setEditError("");
    try {
      const res = await fetch(`/api/calendar-items/${editingNote.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      setNotes((list) => list.filter((n) => n.id !== editingNote.id));
      setEditingNote(null);
    } catch {
      setEditError("Couldn't delete that one - try again.");
    } finally {
      setEditSaving(false);
    }
  }

  function openEditPlanningItem(item) {
    setEditingPlanningItem({ id: item.id, name: item.name, plannedDate: item.planned_date });
    setPlanningEditError("");
  }

  async function savePlanningItemEdit(e) {
    e.preventDefault();
    if (!editingPlanningItem || planningEditSaving) return;
    const trimmedName = editingPlanningItem.name.trim();
    if (!trimmedName || !editingPlanningItem.plannedDate) return;

    setPlanningEditSaving(true);
    setPlanningEditError("");
    try {
      const res = await fetch(`/api/planning-items/${editingPlanningItem.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmedName, plannedDate: editingPlanningItem.plannedDate }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't save that.");
      setPlanningItems((list) => list.map((p) => (p.id === data.item.id ? data.item : p)));
      jumpToMonth(data.item.planned_date);
      setEditingPlanningItem(null);
    } catch (err) {
      setPlanningEditError(err.message || "Couldn't save that.");
    } finally {
      setPlanningEditSaving(false);
    }
  }

  // The Trip Calendar's equivalent of a note's Delete - but a planning
  // item is a real researched place that lives on the Planning tab too,
  // so removing it from view here only clears its date (unscheduling it)
  // rather than deleting the item itself. A genuine delete still only
  // happens from the Planning tab, where the full context of what's being
  // removed is actually visible.
  async function removePlanningItemFromCalendar() {
    if (!editingPlanningItem || planningEditSaving) return;
    setPlanningEditSaving(true);
    setPlanningEditError("");
    try {
      const res = await fetch(`/api/planning-items/${editingPlanningItem.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plannedDate: null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't remove that from the calendar.");
      setPlanningItems((list) => list.map((p) => (p.id === data.item.id ? data.item : p)));
      setEditingPlanningItem(null);
    } catch (err) {
      setPlanningEditError(err.message || "Couldn't remove that from the calendar.");
    } finally {
      setPlanningEditSaving(false);
    }
  }

  // Optimistic drag-to-reschedule, same pattern as removeNote above: move
  // it immediately, put it back if the save actually fails. Split by
  // which list the dropped item actually lives in, since a note and a
  // saved idea each save their date through a different route.
  async function moveNoteDate(item, newDate) {
    const before = notes;
    setNotes((list) => list.map((n) => (n.id === item.id ? { ...n, planned_date: newDate } : n)));
    try {
      const res = await fetch(`/api/calendar-items/${item.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plannedDate: newDate }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setNotes(before);
      setError("Couldn't move that one - it's back where it was.");
    }
  }

  async function moveIdeaDate(item, newDate) {
    const before = ideas;
    setIdeas((list) => list.map((i) => (i.id === item.id ? { ...i, planned_date: newDate } : i)));
    try {
      const res = await fetch(`/api/ideas/${item.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plannedDate: newDate }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setIdeas(before);
      setError("Couldn't move that one - it's back where it was.");
    }
  }

  async function movePlanningDate(item, newDate) {
    const before = planningItems;
    setPlanningItems((list) => list.map((p) => (p.id === item.id ? { ...p, planned_date: newDate } : p)));
    try {
      const res = await fetch(`/api/planning-items/${item.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plannedDate: newDate }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setPlanningItems(before);
      setError("Couldn't move that one - it's back where it was.");
    }
  }

  function handleDropContentItem(item, newDate) {
    if (item.kind === "note") moveNoteDate(item, newDate);
    else moveIdeaDate(item, newDate);
  }

  function prevMonth() {
    setCalendarDate((d) => (d.month === 0 ? { year: d.year - 1, month: 11 } : { year: d.year, month: d.month - 1 }));
  }

  function nextMonth() {
    setCalendarDate((d) => (d.month === 11 ? { year: d.year + 1, month: 0 } : { year: d.year, month: d.month + 1 }));
  }

  // PlanningCalendar renders `name`; a saved idea's title lives on `idea`,
  // a note's on `title`, a planning item's on `name` already. Notes are
  // marked kind: "note" (editable/removable here) and planning items
  // kind: "planning" (read-only content, draggable date only) so the
  // calendar knows what each pill can do.
  const items = isTrip
    ? planningItems.filter((p) => p.planned_date).map((p) => ({ ...p, kind: "planning" }))
    : [
        ...ideas.map((i) => ({ ...i, name: i.idea })),
        ...notes.map((n) => ({ ...n, name: n.title, kind: "note" })),
      ];
  const scheduledCount = items.filter((i) => i.planned_date).length;

  return (
    <>
      {!isTrip && (
        <form onSubmit={addNote} className="card calendar-add-row">
          <div className="field" style={{ marginBottom: 0, flex: 1 }}>
            <label htmlFor="calendarNoteTitle">Add to the calendar</label>
            <input
              id="calendarNoteTitle"
              placeholder="Already-made reel, a repost, anything to put out that day"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={120}
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="calendarNoteDate">Date</label>
            <input id="calendarNoteDate" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <button className="btn-primary" disabled={!title.trim() || !date || adding}>
            {adding ? "Adding…" : "Add"}
          </button>
        </form>
      )}

      {error && <p className="hint" style={{ color: "var(--bad)", marginBottom: 10 }}>{error}</p>}

      <PlanningCalendar
        items={items}
        year={calendarDate.year}
        month={calendarDate.month}
        onPrevMonth={prevMonth}
        onNextMonth={nextMonth}
        onRemoveItem={isTrip ? undefined : removeNote}
        onEditItem={isTrip ? openEditPlanningItem : openEditNote}
        onDropItem={isTrip ? movePlanningDate : handleDropContentItem}
      />

      {isTrip
        ? !loading && scheduledCount === 0 && (
            <p className="hint" style={{ textAlign: "center", marginTop: 12 }}>
              Nothing planned yet - give a Planning tab item a date and it'll show up here.
            </p>
          )
        : !loading && scheduledCount === 0 && (
            <p className="hint" style={{ textAlign: "center", marginTop: 12 }}>
              Nothing scheduled yet. Add something above, or give a saved idea a planned date on the Content tab.
            </p>
          )}

      {editingNote && (
        <div className="calendar-edit-overlay" onClick={() => !editSaving && setEditingNote(null)}>
          <div className="calendar-edit-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Edit calendar note</h3>
            <form onSubmit={saveEditNote}>
              <div className="field">
                <label htmlFor="editNoteTitle">Title</label>
                <input
                  id="editNoteTitle"
                  value={editingNote.title}
                  onChange={(e) => setEditingNote((n) => ({ ...n, title: e.target.value }))}
                  maxLength={120}
                  autoFocus
                />
              </div>
              <div className="field">
                <label htmlFor="editNoteDate">Date</label>
                <input
                  id="editNoteDate"
                  type="date"
                  value={editingNote.plannedDate}
                  onChange={(e) => setEditingNote((n) => ({ ...n, plannedDate: e.target.value }))}
                />
              </div>
              <div className="calendar-edit-complete-row">
                <input
                  id="editNoteCompleted"
                  type="checkbox"
                  checked={editingNote.completed}
                  onChange={(e) => setEditingNote((n) => ({ ...n, completed: e.target.checked }))}
                />
                <label htmlFor="editNoteCompleted">Mark as completed</label>
              </div>

              {editError && <p className="hint" style={{ color: "var(--bad)" }}>{editError}</p>}

              <div className="calendar-edit-actions">
                <button
                  type="button"
                  className="btn-ghost"
                  style={{ color: "var(--bad)" }}
                  disabled={editSaving}
                  onClick={deleteEditingNote}
                >
                  Delete
                </button>
                <div className="calendar-edit-actions-right">
                  <button type="button" className="btn-ghost" disabled={editSaving} onClick={() => setEditingNote(null)}>
                    Cancel
                  </button>
                  <button
                    className="btn-primary"
                    style={{ width: "auto" }}
                    disabled={editSaving || !editingNote.title.trim() || !editingNote.plannedDate}
                  >
                    {editSaving ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {editingPlanningItem && (
        <div className="calendar-edit-overlay" onClick={() => !planningEditSaving && setEditingPlanningItem(null)}>
          <div className="calendar-edit-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Edit Trip Calendar item</h3>
            <form onSubmit={savePlanningItemEdit}>
              <div className="field">
                <label htmlFor="editPlanningName">Name</label>
                <input
                  id="editPlanningName"
                  value={editingPlanningItem.name}
                  onChange={(e) => setEditingPlanningItem((p) => ({ ...p, name: e.target.value }))}
                  maxLength={200}
                  autoFocus
                />
              </div>
              <div className="field">
                <label htmlFor="editPlanningDate">Date</label>
                <input
                  id="editPlanningDate"
                  type="date"
                  value={editingPlanningItem.plannedDate}
                  onChange={(e) => setEditingPlanningItem((p) => ({ ...p, plannedDate: e.target.value }))}
                />
              </div>
              <p className="hint" style={{ marginTop: -4 }}>
                Category, research and everything else about this place still only change on the Planning tab.
              </p>

              {planningEditError && <p className="hint" style={{ color: "var(--bad)" }}>{planningEditError}</p>}

              <div className="calendar-edit-actions">
                <button
                  type="button"
                  className="btn-ghost"
                  style={{ color: "var(--bad)" }}
                  disabled={planningEditSaving}
                  onClick={removePlanningItemFromCalendar}
                >
                  Remove from calendar
                </button>
                <div className="calendar-edit-actions-right">
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={planningEditSaving}
                    onClick={() => setEditingPlanningItem(null)}
                  >
                    Cancel
                  </button>
                  <button
                    className="btn-primary"
                    style={{ width: "auto" }}
                    disabled={planningEditSaving || !editingPlanningItem.name.trim() || !editingPlanningItem.plannedDate}
                  >
                    {planningEditSaving ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
