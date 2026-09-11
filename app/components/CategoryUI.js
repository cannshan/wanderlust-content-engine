"use client";

// Renders above a saved-item list. Hidden entirely until a category
// actually exists (see useCategorizedItems) - no point showing an "All"
// filter with nothing else to filter by.
export function CategoryFilterRow({ allCategories, categoryFilter, onFilter }) {
  if (allCategories.length === 0) return null;
  return (
    <div className="category-filter-row">
      <button
        type="button"
        className={`category-filter-btn ${!categoryFilter ? "active" : ""}`}
        onClick={() => onFilter(null)}
      >
        All
      </button>
      {allCategories.map((c) => (
        <button
          key={c}
          type="button"
          className={`category-filter-btn ${categoryFilter === c ? "active" : ""}`}
          onClick={() => onFilter(c)}
        >
          {c}
        </button>
      ))}
    </div>
  );
}

// The expandable panel a "Categorize" button reveals for one item: quick-
// pick any category already in use elsewhere in the list, a field to type
// a brand new one, and a clear option when the item already has one.
export function CategorizePanel({ item, allCategories, newCategoryDraft, onDraftChange, onApply, onSubmitNew }) {
  return (
    <div className="category-picker">
      {allCategories.length > 0 && (
        <div className="category-picker-options">
          {allCategories.map((c) => (
            <button
              key={c}
              type="button"
              className={`category-chip-btn ${item.category === c ? "active" : ""}`}
              onClick={() => onApply(item.id, c)}
            >
              {c}
            </button>
          ))}
        </div>
      )}
      <div className="category-picker-new">
        <input
          autoFocus
          value={newCategoryDraft}
          onChange={(e) => onDraftChange(e.target.value)}
          placeholder="New category name"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onSubmitNew(item.id);
            }
          }}
        />
        <button type="button" className="btn-ghost" onClick={() => onSubmitNew(item.id)} disabled={!newCategoryDraft.trim()}>
          Add
        </button>
      </div>
      {item.category && (
        <button type="button" className="category-clear" onClick={() => onApply(item.id, null)}>
          Clear category
        </button>
      )}
    </div>
  );
}
