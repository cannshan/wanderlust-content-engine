import { NextResponse } from "next/server";
import { imageForPlace } from "../../../lib/placeImage";

// Card photos for places (Discovery, Planning, Collab Search) - see
// lib/placeImage.js for where each photo comes from (all free, no Claude
// call). Small batches: a place not yet on a map can need a few
// rate-limited OpenStreetMap lookups (about a second each) the first
// time. usePlaceImages caches the answers in the browser, and this keeps
// a short per-server cache too.
export const maxDuration = 120;

const MAX_PLACES = 6;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map();

function clean(p) {
  const str = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  const website = str(p?.website, 300);
  return {
    name: str(p?.name, 200),
    area: str(p?.area, 200),
    near: str(p?.near, 200),
    address: str(p?.address, 200),
    website: website && /^https?:\/\//i.test(website) ? website : null,
  };
}

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const places = (Array.isArray(body?.places) ? body.places : []).map(clean);
  if (places.length === 0 || places.length > MAX_PLACES || places.some((p) => !p.name)) {
    return NextResponse.json({ error: `Send between 1 and ${MAX_PLACES} named places.` }, { status: 400 });
  }

  // All at once: website and Wikipedia fetches overlap, and any
  // OpenStreetMap lookups queue themselves at one per second anyway.
  const images = await Promise.all(
    places.map(async (place) => {
      const key = JSON.stringify(place);
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.image;
      const image = await imageForPlace(place).catch(() => null);
      cache.set(key, { image, at: Date.now() });
      return image;
    })
  );

  return NextResponse.json({ images });
}
