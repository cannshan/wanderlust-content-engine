"use client";

import { useState, useEffect } from "react";

// Browser-only autosave for a tab's paid results, so a refresh or a closed
// tab doesn't throw away something that cost money to generate. Used by
// the Content, Discovery and Planning tabs.
//
// `snapshot` is whatever the tab wants kept (plain JSON - no File objects);
// `onRestore(saved)` puts it back. Restores once, after mount, same
// client-only pattern as page.js's remembered tab, so the server render
// still matches. Per-device on purpose: it's a safety net for "I lost it",
// not a replacement for each tab's own Save, which is what shares things.
export function useDraftAutosave(storageKey, snapshot, onRestore) {
  // State, not a ref: saving has to wait for the render AFTER the restore.
  // A ref would flip in the same commit as the restore, so the empty
  // initial values would be saved once - and under React's dev-mode double
  // effects, the restore's second run would then read that empty draft back.
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
      if (saved) onRestore(saved);
    } catch {
      // Nothing saved, storage blocked, or unreadable - start fresh.
    }
    setRestored(true);
    // Restore runs once per mount; onRestore is a fresh closure each render,
    // so it's deliberately not a dependency.
  }, [storageKey]);

  // Serialized here so the save effect only fires when the content
  // actually changed, not on every render.
  const serialized = restored ? JSON.stringify(snapshot) : null;
  useEffect(() => {
    if (serialized === null) return;
    try {
      localStorage.setItem(storageKey, serialized);
    } catch {
      // Storage full or blocked - what's on screen is unaffected.
    }
  }, [storageKey, serialized]);
}

// For each autosaving tab's Clear button, which resets the tab's state -
// the autosave then saves that empty state over the draft. Clearing only
// typed fields (or a result that's already been saved) just happens, but
// throwing away an unsaved paid result asks first.
export function confirmClear(losesUnsavedResult) {
  return (
    !losesUnsavedResult ||
    window.confirm("Clear this page? The result on screen hasn't been saved and will be lost.")
  );
}

// Autosave can only keep what has finished. A refresh while a request is
// still running drops that answer in the browser even though it's still
// billed, so while `active` is true the browser's own "Leave site?" prompt
// guards against it.
export function useWarnBeforeLeaving(active) {
  useEffect(() => {
    if (!active) return;
    function warn(e) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);
}
