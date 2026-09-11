"use client";

import { useState } from "react";

// Shared "categorize + filter" behavior for any saved-item list backed by a
// PATCH /<patchPath>/<id> endpoint that accepts { category }. Used by
// ContentTab (saved ideas), and DiscoveryTab (saved places, saved
// searches) - three lists with different card content but identical
// tagging/filtering behavior, so this (plus CategoryFilterRow/
// CategorizePanel in CategoryUI.js) is the one place that behavior lives.
//
// There's no separate categories table anywhere this is used - a category
// exists simply because at least one item in the list currently carries
// that string, the same "create it by using it" model as most tagging
// tools (Gmail labels, etc.).
export function useCategorizedItems(items, setItems, patchPath) {
  const [categorizingId, setCategorizingId] = useState(null);
  const [newCategoryDraft, setNewCategoryDraft] = useState("");
  const [categoryFilter, setCategoryFilter] = useState(null);

  const allCategories = Array.from(new Set(items.map((i) => i.category).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b)
  );
  const filteredItems = categoryFilter ? items.filter((i) => i.category === categoryFilter) : items;

  function toggleCategorize(id) {
    setCategorizingId((current) => (current === id ? null : id));
    setNewCategoryDraft("");
  }

  // category: null clears it. Optimistic update - the picker closes and
  // the chip updates immediately, since this is low-stakes enough not to
  // need a loading state. If the PATCH fails, the next reload of the list
  // shows the real state rather than the UI silently drifting forever.
  async function applyCategory(id, category) {
    setItems((list) => list.map((i) => (i.id === id ? { ...i, category } : i)));
    setCategorizingId(null);
    setNewCategoryDraft("");
    try {
      await fetch(`${patchPath}/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ category }),
      });
    } catch {
      // Degrades the same way every other best-effort write in this app does.
    }
  }

  function submitNewCategory(id) {
    const name = newCategoryDraft.trim();
    if (!name) return;
    applyCategory(id, name);
  }

  return {
    categorizingId,
    newCategoryDraft,
    setNewCategoryDraft,
    categoryFilter,
    setCategoryFilter,
    allCategories,
    filteredItems,
    toggleCategorize,
    applyCategory,
    submitNewCategory,
  };
}
