"use client";

import { useState } from "react";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_LABELS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// Zero-padded "YYYY-MM-DD", matching exactly what Postgres returns for a
// `date` column (and what an <input type="date"> both reads and writes) -
// built from separate y/m/d numbers rather than new Date(...).toISOString()
// on purpose, since toISOString() converts to UTC first and can silently
// shift the date by a day depending on the viewer's timezone.
function dateKey(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Renders as its own full-width block above a tab's two-column layout
// rather than inside the sidebar - a real month grid needs more width
// than the 280px sidebar has room for, and showing it above keeps it
// visible without competing for space with whatever's selected in the
// main panel.
//
// Named for the Planning tab it was built for, but driven from the
// Content, Calendar and Planning-backed "Trip" calendars now: scheduling
// when a saved idea goes out is what actually wants a month view, while a
// planning item's planned_date grounds its research instead. Deliberately
// generic about what it's given - any { id, name, planned_date } does, so
// callers map their own title field onto `name` on the way in.
//
// An item may also carry kind: "note" (a plain scheduling entry with no
// detail to open into - see the Calendar tab) or kind: "planning" (a Trip
// Calendar entry - its research/category/etc. still only change on the
// Planning tab, but its own name and date can be edited right here). Both
// open their own edit form on click when onEditItem is given - a note's
// caller and a planning item's caller pass different handlers, since they
// save through different routes. completed: true renders struck-through
// rather than disappearing - "done" isn't "gone" (notes only; a planning
// item is never marked completed here).
//
// Any item is draggable to a new day when onDropItem is given, regardless
// of kind - moving a date is a lower-stakes action than editing content,
// so it's offered even where the pill itself is otherwise read-only.
export default function PlanningCalendar({
  items,
  year,
  month,
  onPrevMonth,
  onNextMonth,
  onSelectItem,
  onRemoveItem,
  onEditItem,
  onDropItem,
  onHide,
}) {
  // Which day cell is currently being dragged over, for a drop-target
  // highlight - cleared on drop/dragleave rather than left to whatever the
  // last dragover event happened to be, so the highlight never sticks
  // around after the drag actually ends elsewhere.
  const [dragOverKey, setDragOverKey] = useState(null);

  // Keyed by "YYYY-MM-DD" - every item that's been given a planned_date,
  // grouped so a day with more than one thing planned shows all of them,
  // not just the first.
  const itemsByDate = {};
  // All items by id, regardless of date - a dropped item is looked up here
  // rather than re-reading dataTransfer's payload beyond the bare id, so
  // the caller always gets the same object shape it originally handed in.
  const itemsById = {};
  // Same per-day grouping, summed instead of listed - only a Trip
  // Calendar item (a planning_items row) ever carries
  // estimated_cost_usd (see "Estimate cost" in PlanningTab.js), so this
  // naturally stays empty for the Content Calendar's saved ideas/notes
  // without needing a separate flag to say which calendar this is.
  const costByDate = {};
  for (const item of items) {
    itemsById[item.id] = item;
    if (!item.planned_date) continue;
    (itemsByDate[item.planned_date] ||= []).push(item);
    if (typeof item.estimated_cost_usd === "number") {
      costByDate[item.planned_date] = (costByDate[item.planned_date] || 0) + item.estimated_cost_usd;
    }
  }

  function handleDragStart(e, item) {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(item.id));
  }

  function handleDrop(e, key) {
    e.preventDefault();
    setDragOverKey(null);
    if (!onDropItem) return;
    const id = e.dataTransfer.getData("text/plain");
    const item = itemsById[id];
    if (item && item.planned_date !== key) onDropItem(item, key);
  }

  const firstOfMonth = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const leadingBlanks = firstOfMonth.getDay();
  // Padded to a full multiple of 7 (leading blanks before day 1, trailing
  // blanks after the last day) purely so every month renders as a clean
  // rectangular grid instead of a ragged final row.
  const totalCells = Math.ceil((leadingBlanks + daysInMonth) / 7) * 7;

  const now = new Date();
  const todayKey = dateKey(now.getFullYear(), now.getMonth(), now.getDate());

  return (
    <div className="planning-calendar">
      {/* Dismiss lives here, at the top of the calendar itself, rather than
          back in the tab heading below it - once the calendar is open it's
          the thing the eye is on, so that's where the way out belongs. */}
      {onHide && (
        <div className="planning-calendar-topbar">
          <button type="button" className="btn-ghost" onClick={onHide}>
            📅 Hide calendar
          </button>
        </div>
      )}

      <div className="planning-calendar-header">
        <button type="button" className="btn-ghost" onClick={onPrevMonth} aria-label="Previous month">
          ‹
        </button>
        <h3 style={{ margin: 0 }}>
          {MONTH_LABELS[month]} {year}
        </h3>
        <button type="button" className="btn-ghost" onClick={onNextMonth} aria-label="Next month">
          ›
        </button>
      </div>

      <div className="planning-calendar-grid">
        {WEEKDAY_LABELS.map((w) => (
          <div key={w} className="planning-calendar-weekday">
            {w}
          </div>
        ))}

        {Array.from({ length: totalCells }, (_, i) => {
          const day = i - leadingBlanks + 1;
          if (day < 1 || day > daysInMonth) {
            return <div key={i} className="planning-calendar-cell empty" />;
          }
          const key = dateKey(year, month, day);
          const dayItems = itemsByDate[key] || [];
          return (
            <div
              key={i}
              className={`planning-calendar-cell ${key === todayKey ? "today" : ""} ${dragOverKey === key ? "drag-over" : ""}`}
              onDragOver={(e) => {
                if (!onDropItem) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
              }}
              onDragEnter={(e) => {
                if (!onDropItem) return;
                e.preventDefault();
                setDragOverKey(key);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget)) {
                  setDragOverKey((k) => (k === key ? null : k));
                }
              }}
              onDrop={(e) => handleDrop(e, key)}
            >
              <div className="planning-calendar-daynum-row">
                <span className="planning-calendar-daynum">{day}</span>
                {/* Every costed item that day summed together, still for
                    two people - see the comment on costByDate above.
                    Never shown as $0.00 for a day with no costed items;
                    that would look like a real answer rather than
                    "nothing to add up here". */}
                {costByDate[key] != null && (
                  <span className="planning-calendar-day-cost" title={`Estimated for ${itemsByDate[key].length > 1 ? "everything" : "this"} planned that day, for two`}>
                    💰 ${costByDate[key].toFixed(2)}
                  </span>
                )}
              </div>
              {/* Three shapes, decided per item rather than per calendar:
                  a real record with somewhere to open into is a button; a
                  plain scheduling note gets an edit affordance (and a
                  remove one) where the caller offers them; anything else
                  is a label. A pill only looks clickable where clicking it
                  actually does something - dragging is offered
                  independently of that, via the `draggable` attribute. */}
              {dayItems.map((item) => {
                const draggable = !!onDropItem;
                const dragProps = draggable
                  ? { draggable: true, onDragStart: (e) => handleDragStart(e, item) }
                  : {};
                const completed = !!item.completed;

                if (item.kind !== "note" && onSelectItem) {
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`planning-calendar-pill ${completed ? "completed" : ""}`}
                      onClick={() => onSelectItem(item.id)}
                      title={item.name}
                      {...dragProps}
                    >
                      {item.name}
                    </button>
                  );
                }
                return (
                  <span
                    key={item.id}
                    className={`planning-calendar-pill static ${item.kind === "note" ? "note" : ""} ${completed ? "completed" : ""}`}
                    title={item.name}
                    {...dragProps}
                  >
                    {(item.kind === "note" || item.kind === "planning") && onEditItem ? (
                      <button
                        type="button"
                        className="planning-calendar-pill-label planning-calendar-pill-label-btn"
                        onClick={() => onEditItem(item)}
                      >
                        {completed ? "✓ " : ""}
                        {item.name}
                      </button>
                    ) : (
                      <span className="planning-calendar-pill-label">
                        {completed ? "✓ " : ""}
                        {item.name}
                      </span>
                    )}
                    {item.kind === "note" && onRemoveItem && (
                      <button
                        type="button"
                        className="planning-calendar-pill-remove"
                        onClick={() => onRemoveItem(item)}
                        aria-label={`Remove ${item.name}`}
                        title="Remove"
                      >
                        ×
                      </button>
                    )}
                  </span>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
