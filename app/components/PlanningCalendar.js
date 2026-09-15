"use client";

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

// Renders as its own full-width block above the Planning tab's two-column
// layout (see PlanningTab.js) rather than inside the sidebar - a real
// month grid needs more width than the 280px sidebar has room for, and
// showing it above keeps it visible without competing for space with
// whatever's selected in the main panel.
export default function PlanningCalendar({ items, year, month, onPrevMonth, onNextMonth, onSelectItem, onHide }) {
  // Keyed by "YYYY-MM-DD" - every item that's been given a planned_date,
  // grouped so a day with more than one thing planned shows all of them,
  // not just the first.
  const itemsByDate = {};
  for (const item of items) {
    if (!item.planned_date) continue;
    (itemsByDate[item.planned_date] ||= []).push(item);
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
          back in the Planning heading below it - once the calendar is open
          it's the thing the eye is on, so that's where the way out belongs. */}
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
            <div key={i} className={`planning-calendar-cell ${key === todayKey ? "today" : ""}`}>
              <span className="planning-calendar-daynum">{day}</span>
              {dayItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="planning-calendar-pill"
                  onClick={() => onSelectItem(item.id)}
                  title={item.name}
                >
                  {item.name}
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
