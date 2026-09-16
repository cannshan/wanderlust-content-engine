"use client";

import { useState, useEffect } from "react";
import PlanningCalendar from "./PlanningCalendar";

// The standalone Calendar tab: the same month view the Content tab's
// 📅 Calendar button opens, over the same data (saved ideas with a
// planned_date), just given a permanent home instead of living inside
// the Content tab's own layout.
//
// It reads /api/ideas itself rather than sharing ContentTab's state.
// Lifting that state up to Shell would couple two tabs that otherwise
// know nothing about each other, for one list that's cheap to fetch -
// but it does mean this copy can go stale the moment a date is set over
// on Content, hence `active` below.
//
// Read-only on purpose: no onSelectItem (nothing here to open an idea
// into - the pills render as plain labels) and no onHide (a tab isn't
// something you dismiss). Scheduling still happens on the Content tab,
// where the idea itself is.
export default function CalendarTab({ active }) {
  const [ideas, setIdeas] = useState([]);
  const [loading, setLoading] = useState(true);
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
        const res = await fetch("/api/ideas");
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) setIdeas(data.ideas || []);
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

  function prevMonth() {
    setCalendarDate((d) => (d.month === 0 ? { year: d.year - 1, month: 11 } : { year: d.year, month: d.month - 1 }));
  }

  function nextMonth() {
    setCalendarDate((d) => (d.month === 11 ? { year: d.year + 1, month: 0 } : { year: d.year, month: d.month + 1 }));
  }

  // PlanningCalendar renders `name`; a saved idea's title lives on `idea`.
  // Same mapping ContentTab does for its own use of the calendar.
  const items = ideas.map((i) => ({ ...i, name: i.idea }));
  const scheduledCount = items.filter((i) => i.planned_date).length;

  return (
    <>
      <PlanningCalendar
        items={items}
        year={calendarDate.year}
        month={calendarDate.month}
        onPrevMonth={prevMonth}
        onNextMonth={nextMonth}
      />
      {!loading && scheduledCount === 0 && (
        <p className="hint" style={{ textAlign: "center", marginTop: 12 }}>
          Nothing scheduled yet. Give a saved idea a planned date on the Content tab and it shows up here.
        </p>
      )}
    </>
  );
}
