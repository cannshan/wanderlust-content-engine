"use client";

import { useEffect, useState } from "react";

// Card photos for a list of places. places: [{ key, name, area, near,
// address, website }] -> { [key]: imageUrl | null }. Asks
// /api/place-images (free sources only - see lib/placeImage.js) for the
// places it hasn't seen, a few at a time so photos appear as they're
// found, and remembers the answers in this browser so reopening a list
// doesn't ask again. A place with no entry yet, or null, shows its
// category tile (PlaceThumb).

const CACHE_PREFIX = "wwwImg2:";
// "No photo" answers are retried after a while, in case one turns up.
const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BATCH = 6;

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
    // Storage full or blocked - the server keeps its own short cache.
  }
}

export function usePlaceImages(places) {
  const [images, setImages] = useState({});
  const list = (places || []).filter((p) => p?.key && p?.name);
  const signature = list.map((p) => `${p.key}=${identity(p)}`).join("\n");

  useEffect(() => {
    let cancelled = false;
    const known = {};
    const pending = [];
    for (const p of list) {
      const cached = readCache(p);
      if (cached === undefined) pending.push(p);
      else known[p.key] = cached;
    }
    setImages((m) => ({ ...m, ...known }));

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
          if (!res.ok) continue;
          const { images: found } = await res.json();
          if (cancelled) return;
          const next = {};
          batch.forEach((p, j) => {
            next[p.key] = found[j] || null;
            writeCache(p, found[j] || null);
          });
          setImages((m) => ({ ...m, ...next }));
        } catch {
          // Offline or the request failed - cards keep their tiles, and
          // the next open asks again (nothing was cached).
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // signature stands in for `list` (a new array every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return images;
}
