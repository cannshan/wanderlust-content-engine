"use client";

// The inline picker "Add to Planning" reveals for one place - pick a
// category already used elsewhere in Planning, or type a brand new one,
// same "create it by using it" model as every other category in this app
// (see CategorizePanel in CategoryUI.js), just happening at add-time
// instead of after the fact. Deliberately not CategorizePanel itself -
// that component expects an already-saved item with a real id to PATCH;
// this one hasn't been created yet, so picking (or typing) a category here
// is what actually triggers the POST. Shared between DiscoveryTab (Add to
// Planning on a search result) and PlanningTab (Add to Planning on a
// direct free-text search result) - same picker, same behavior, two
// different sources for the place being added.
export function AddToPlanningPicker({ planningCategories, draft, onDraftChange, onPick, onCancel }) {
  return (
    <div className="category-picker">
      {planningCategories.length > 0 && (
        <div className="category-picker-options">
          {planningCategories.map((c) => (
            <button key={c} type="button" className="category-chip-btn" onClick={() => onPick(c)}>
              {c}
            </button>
          ))}
        </div>
      )}
      <div className="category-picker-new">
        <input
          autoFocus
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          placeholder="New category name"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (draft.trim()) onPick(draft.trim());
            }
          }}
        />
        <button type="button" className="btn-ghost" onClick={() => draft.trim() && onPick(draft.trim())} disabled={!draft.trim()}>
          Add
        </button>
      </div>
      <div style={{ display: "flex", gap: 14 }}>
        <button type="button" className="category-clear" onClick={() => onPick(null)}>
          No category
        </button>
        <button type="button" className="category-clear" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
