"use client";

import { useEffect, useRef, useState } from "react";

// Card photos for a list of places. places: [{ key, name, area, near,
// address, website }] -> { [key]: imageUrl | null }. Asks
// /api/place-images (free sources only - see lib/placeImage.js) for the
// places it hasn't seen, a few at a time so photos appear as they're
// found, and remembers the answers in this browser so reopening a list
// doesn't ask again. A place with no entry yet, or null, shows its
// category tile (PlaceThumb).
//
// `enabled`: every tab stays mounted (see page.js), so without this all
// of them would look up photos at once when the app opens - queuing
// behind each other at OpenStreetMap's one-lookup-per-second limit, so
// the tab she's actually looking at waited on the others. Answers already
// cached in the browser still show right away; new lookups only start
// for the visible tab.

const CACHE_PREFIX = "wwwImg2:";
// "No photo" answers are retried after a while, in case one turns up.
const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Small, so the first few photos show up quickly instead of waiting on a
// whole list's lookups.
const BATCH = 3;

function identity(p) {
  return [p.name, p.area, p.near, p.address, p.website].map((v) => v || "").join("|").toLowerCase();
}

function readCache(p) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + identity(p));
    if (raw === null) return undefined;
    const value = JSON.parse(raw);
    if (value.miss) return Date.now() - value.miss < MISS_TTL_MS ? null : undefined;
    return value.image;
  } catch {
    return undefined;
  }
}

function writeCache(p, image) {
  try {
    localStorage.setItem(CACHE_PREFIX + identity(p), JSON.stringify(image ? { image } : { miss: Date.now() }));
  } catch {
    // Storage full or blocked - the server keeps its own cache.
  }
}

export function usePlaceImages(places, { enabled = true } = {}) {
  const [images, setImages] = useState({});
  // Places with a request already out - so switching tabs away and back
  // mid-lookup doesn't ask for the same place twice.
  const inFlight = useRef(new Set());
  const list = (places || []).filter((p) => p?.key && p?.name);
  const signature = list.map((p) => `${p.key}=${identity(p)}`).join("\n");

  useEffect(() => {
    const known = {};
    const pending = [];
    for (const p of list) {
      const cached = readCache(p);
      if (cached !== undefined) known[p.key] = cached;
      else if (!inFlight.current.has(identity(p))) pending.push(p);
    }
    if (Object.keys(known).length) setImages((m) => ({ ...m, ...known }));
    if (!enabled || pending.length === 0) return;

    pending.forEach((p) => inFlight.current.add(identity(p)));
    (async () => {
      for (let i = 0; i < pending.length; i += BATCH) {
        const batch = pending.slice(i, i + BATCH);
        try {
          const res = await fetch("/api/place-images", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              places: batch.map(({ name, area, near, address, website }) => ({ name, area, near, address, website })),
            }),
          });
          if (res.ok) {
            const { images: found } = await res.json();
            const next = {};
            batch.forEach((p, j) => {
              next[p.key] = found[j] || null;
              writeCache(p, found[j] || null);
            });
            // Applied even if the list changed meanwhile - answers are
            // keyed by place, so a stale one is just unused.
            setImages((m) => ({ ...m, ...next }));
          }
        } catch {
          // Offline or the request failed - cards keep their tiles, and
          // the next open asks again (nothing was cached).
        } finally {
          batch.forEach((p) => inFlight.current.delete(identity(p)));
        }
      }
    })();
    // signature stands in for `list` (a new array every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, enabled]);

  return images;
}
