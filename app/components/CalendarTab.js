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

// The standalone Calendar tab: the same month view the Content tab's
// 📅 Calendar button opens, over the same saved ideas, plus its own
// plain scheduling notes.
//
// Two kinds of thing live on this calendar. A **saved idea** with a
// planned_date is a full generated package that also happens to be
// scheduled - it belongs to the Content tab, and is read-only here. A
// **note** is just a title and a day: content that's already made and
// only needs a post date, where there's nothing for the app to generate
// or store. Those are created and removed right here, which is the whole
// point - scheduling something shouldn't require inventing a content
// record to hang the date on.
export default function CalendarTab({ active }) {
  const [ideas, setIdeas] = useState([]);
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(todayValue);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [calendarDate, setCalendarDate] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });

  // Refetched every time the tab is opened, not just on mount. Every tab
  // stays mounted for the whole session (see the comment in page.js), so
  // a mount-only fetch would show whatever was scheduled when the app
  // first loaded and never notice a date set on Content since.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    (async () => {
      try {
        const [ideasRes, notesRes] = await Promise.all([fetch("/api/ideas"), fetch("/api/calendar-items")]);
        if (ideasRes.ok) {
          const data = await ideasRes.json();
          if (!cancelled) setIdeas(data.ideas || []);
        }
        if (notesRes.ok) {
          const data = await notesRes.json();
          if (!cancelled) setNotes(data.items || []);
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
  }, [active]);

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
      const [y, m] = date.split("-").map(Number);
      setCalendarDate({ year: y, month: m - 1 });
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

  function prevMonth() {
    setCalendarDate((d) => (d.month === 0 ? { year: d.year - 1, month: 11 } : { year: d.year, month: d.month - 1 }));
  }

  function nextMonth() {
    setCalendarDate((d) => (d.month === 11 ? { year: d.year + 1, month: 0 } : { year: d.year, month: d.month + 1 }));
  }

  // PlanningCalendar renders `name`; a saved idea's title lives on `idea`
  // and a note's on `title`. Notes are marked kind: "note" so the
  // calendar knows they don't open into anything and can be removed.
  const items = [
    ...ideas.map((i) => ({ ...i, name: i.idea })),
    ...notes.map((n) => ({ ...n, name: n.title, kind: "note" })),
  ];
  const scheduledCount = items.filter((i) => i.planned_date).length;

  return (
    <>
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

      {error && <p className="hint" style={{ color: "var(--bad)", marginBottom: 10 }}>{error}</p>}

      <PlanningCalendar
        items={items}
        year={calendarDate.year}
        month={calendarDate.month}
        onPrevMonth={prevMonth}
        onNextMonth={nextMonth}
        onRemoveItem={removeNote}
      />

      <p className="hint" style={{ textAlign: "center", marginTop: 12 }}>
        {!loading && scheduledCount === 0
          ? "Nothing scheduled yet. Add something above, or give a saved idea a planned date on the Content tab."
          : "Tinted entries are saved ideas from the Content tab - open those there. Plain ones are scheduling notes, removable here."}
      </p>
    </>
  );
}
