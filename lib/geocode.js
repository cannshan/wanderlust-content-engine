import { getSupabase } from "./supabase";

// Place name -> coordinates for the Discovery/Planning map views, via
// OpenStreetMap's free Nominatim geocoder (no key, no cost). Its usage
// policy (https://operations.osmfoundation.org/policies/nominatim/) is
// the reason for every constraint below:
// - max 1 request/second for the whole app -> every lookup goes through
//   one serialized queue spaced NOMINATIM_SPACING_MS apart
// - an identifying User-Agent, not a library default
// - results must be cached on our side -> an in-memory cache per server
//   instance, plus the geocode_cache table (README) when it exists, so a
//   place is only ever looked up once, not on every map open
// Small, user-triggered lookups (one search's worth of places) are the
// intended use; this is never run as a bulk job.

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "WanderHQ/1.0 (private trip-planning map for one travel creator; low volume)";
const NOMINATIM_SPACING_MS = 1100;
const FETCH_TIMEOUT_MS = 8000;
// A miss is cached too (so a place OSM doesn't know isn't re-asked on
// every map open), but retried after this long in case OSM has since
// added it.
const MISS_RETRY_MS = 30 * 24 * 60 * 60 * 1000;

// Nominatim addresstype values that mean "an area", not a specific spot.
const AREA_TYPES = new Set([
  "country", "state", "region", "province", "county", "municipality", "city", "town", "village",
  "hamlet", "borough", "suburb", "quarter", "neighbourhood", "city_district", "district", "postcode",
]);

// The subset an approximate pin can sit on: a town or neighborhood is
// close enough to be useful ("somewhere in Saint-Irénée"); a county,
// state or country isn't.
const LOCALITY_TYPES = new Set([
  "municipality", "city", "town", "village", "hamlet", "borough", "suburb", "quarter",
  "neighbourhood", "city_district", "district",
]);

// Returned (never cached) when Nominatim itself failed - distinct from
// null, which means it answered and the place isn't there.
const LOOKUP_FAILED = Symbol("lookup failed");

const memoryCache = new Map();
let queue = Promise.resolve();
let lastRequestAt = 0;
// Flipped off after the first failed read/write, so a missing
// geocode_cache table costs one logged error, not one per lookup.
let dbCacheUsable = true;

function rateLimited(fn) {
  const run = queue.then(async () => {
    const wait = lastRequestAt + NOMINATIM_SPACING_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    return fn();
  });
  // The queue itself must never reject, or one failed lookup would
  // poison every lookup queued after it.
  queue = run.catch(() => {});
  return run;
}

async function readDbCache(key) {
  const supabase = dbCacheUsable ? getSupabase() : null;
  if (!supabase) return undefined;
  const { data, error } = await supabase.from("geocode_cache").select("*").eq("query", key).maybeSingle();
  if (error) {
    console.error("[geocode] geocode_cache unavailable, using memory cache only:", error.message);
    dbCacheUsable = false;
    return undefined;
  }
  if (!data) return undefined;
  if (data.lat == null && Date.now() - new Date(data.created_at).getTime() > MISS_RETRY_MS) return undefined;
  return data.lat == null
    ? null
    : {
        lat: data.lat,
        lon: data.lon,
        box: data.bounding_box || null,
        type: data.place_type || null,
        website: data.extra?.website || null,
        wikidata: data.extra?.wikidata || null,
      };
}

async function writeDbCache(key, result) {
  const supabase = dbCacheUsable ? getSupabase() : null;
  if (!supabase) return;
  const { error } = await supabase.from("geocode_cache").upsert({
    query: key,
    lat: result?.lat ?? null,
    lon: result?.lon ?? null,
    bounding_box: result?.box ?? null,
    place_type: result?.type ?? null,
    extra: result && (result.website || result.wikidata) ? { website: result.website, wikidata: result.wikidata } : null,
    created_at: new Date().toISOString(),
  });
  if (error) {
    console.error("[geocode] couldn't write geocode_cache:", error.message);
    dbCacheUsable = false;
  }
}

// kind "place": a specific spot, limited to `box` ([west, south, east,
// north]) so "The Lobster Shack" near Boothbay can't resolve to one in
// Oregon - and a match that's just a town/region counts as a miss, since
// a pin at the town center would pass for the real location.
// kind "area": a town/region to search around - only area-type matches
// count, so a same-named street can't stand in for a town.
async function lookup(q, box, kind) {
  const key = `${kind}|${q.trim().toLowerCase()}|${box ? box.map((n) => n.toFixed(2)).join(",") : "any"}`;
  if (memoryCache.has(key)) return memoryCache.get(key);

  const cached = await readDbCache(key);
  if (cached !== undefined) {
    memoryCache.set(key, cached);
    return cached;
  }

  // extratags: OpenStreetMap's own tags for the place - its website and
  // Wikidata id, when mapped - used for card photos (lib/placeImage.js).
  const params = new URLSearchParams({ q, format: "jsonv2", limit: "1", extratags: "1" });
  if (box) {
    params.set("viewbox", box.join(","));
    params.set("bounded", "1");
  }

  let result = null;
  try {
    const res = await rateLimited(() =>
      fetch(`${NOMINATIM_URL}?${params}`, {
        headers: { "user-agent": USER_AGENT, "accept-language": "en" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    );
    if (!res.ok) {
      // Don't cache a server-side failure (429/5xx) as a miss - it says
      // nothing about whether the place exists.
      console.error(`[geocode] Nominatim ${res.status} for "${q}"`);
      return LOOKUP_FAILED;
    }
    const [hit] = await res.json();
    const isArea = AREA_TYPES.has(hit?.addresstype);
    if (hit && (kind === "area" ? isArea : !isArea)) {
      // Nominatim's boundingbox is [south, north, west, east] as strings.
      const [s, n, w, e] = (hit.boundingbox || []).map(Number);
      result = {
        lat: Number(hit.lat),
        lon: Number(hit.lon),
        box: [w, s, e, n].every(Number.isFinite) ? [w, s, e, n] : null,
        type: hit.addresstype || null,
        website: hit.extratags?.website || hit.extratags?.["contact:website"] || null,
        wikidata: hit.extratags?.wikidata || null,
      };
    }
  } catch (err) {
    console.error(`[geocode] lookup failed for "${q}":`, err.message);
    return LOOKUP_FAILED;
  }

  memoryCache.set(key, result);
  await writeDbCache(key, result);
  return result;
}

// The search area's own box, padded so places just outside town limits
// (a winery 10 minutes out) still count, and with a minimum size so a
// tiny village's box doesn't exclude its own neighbors.
function searchBox(area) {
  if (!area) return null;
  const MIN_HALF = 0.3;
  const PAD = 0.15;
  const [w, s, e, n] = area.box || [area.lon, area.lat, area.lon, area.lat];
  const cx = (w + e) / 2;
  const cy = (s + n) / 2;
  const halfW = Math.max((e - w) / 2 + PAD, MIN_HALF);
  const halfH = Math.max((n - s) / 2 + PAD, MIN_HALF);
  return [cx - halfW, cy - halfH, cx + halfW, cy + halfH];
}

// Model-written areas can carry asides - "Cape Elizabeth (about 15 min
// from downtown Portland)" - which no geocoder can match.
function usableArea(area) {
  if (!area || /not specified/i.test(area)) return null;
  const cleaned = area
    .replace(/\([^)]*\)/g, "")
    .replace(/\bnear\s+/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/,$/, "");
  return cleaned || null;
}

// Name-only queries inside the area's box match far more reliably than
// "name, area" (tested: "Duckfat" finds it, "Duckfat, Old Port, Portland"
// doesn't). Variants cover names written as "Fort Williams Park /
// Portland Head Light", "Fore River Sanctuary (Jewell Falls)", or with a
// "Company"/"Co." OpenStreetMap doesn't use. Capped so one place can't
// hold the rate-limited queue for long.
const MAX_NAME_VARIANTS = 4;
function nameVariants(name) {
  const variants = [name];
  const withoutParens = name.replace(/\([^)]*\)/g, "").trim();
  variants.push(withoutParens);
  for (const part of withoutParens.split(/\s+\/\s+/)) variants.push(part.trim());
  variants.push(withoutParens.replace(/\s+(company|co\.?)$/i, "").trim());
  // "Casco Bay Lines Mailboat" is "Casco Bay Lines" in OpenStreetMap -
  // still limited to the box, and town-center matches are still refused.
  const words = withoutParens.split(/\s+/);
  if (words.length >= 3) variants.push(words.slice(0, -1).join(" "));
  const inParens = name.match(/\(([^)]+)\)/)?.[1];
  if (inParens) variants.push(inParens.trim());
  return [...new Set(variants.filter((v) => v.length > 2))].slice(0, MAX_NAME_VARIANTS);
}

// "Lookout Mountain, Chattanooga" -> itself, then "Lookout Mountain",
// then "Chattanooga": the full string first (most specific), then its
// pieces, since Nominatim can miss a combination it knows each half of.
function areaCandidates(area) {
  const cleaned = usableArea(area);
  if (!cleaned) return [];
  const parts = cleaned.split(",").map((p) => p.trim()).filter(Boolean);
  return [...new Set([cleaned, parts[0], parts.slice(1).join(", ")].filter(Boolean))];
}

async function firstArea(candidates, accept = () => true) {
  let failed = false;
  for (const candidate of candidates) {
    const res = await lookup(candidate, null, "area");
    if (res === LOOKUP_FAILED) failed = true;
    else if (res && accept(res)) return { hit: res, name: candidate };
  }
  return failed ? LOOKUP_FAILED : null;
}

function inBox(point, box) {
  const [w, s, e, n] = box;
  return point.lon >= w && point.lon <= e && point.lat >= s && point.lat <= n;
}

// Nominatim types for a street rather than a building/address point -
// what an address query falls back to when the house number isn't
// mapped. Close (same street) but not exact, so pinned as approximate.
const STREET_TYPES = new Set(["road", "highway"]);

// places: [{ name, area, near, address }] - `near` is the location that
// was searched (Discovery's location box, or a planning item's
// search_location), used to keep matches local; `address` is a street
// address a search saw for the place, if any. Returns one entry per
// place, in order:
// - { lat, lon, website, wikidata } - the place itself (its street
//   address, or its name), plus its website/Wikidata id when OpenStreetMap
//   has them (used for card photos, lib/placeImage.js)
// - { lat, lon, approximate: true, approxKind, approxArea } - OpenStreetMap doesn't
//   have the place (small businesses often aren't), so it's pinned on its
//   street or in its town/neighborhood instead, and the map says so
// - null - not even its town could be placed
// - "error" - the lookup itself failed; worth retrying later, so callers
//   mustn't remember it as a miss
export async function geocodePlaces(places) {
  const results = [];
  for (const place of places) {
    const ownAreas = areaCandidates(place.area);
    const address = typeof place.address === "string" ? place.address.trim() : "";

    // The searched location first, then the place's own area - a typo'd
    // search ("chatoonaga, tennessee") shouldn't leave a place unpinned
    // when its own area ("Lookout Mountain, near Chattanooga") is fine.
    const boxArea = await firstArea([...new Set([...areaCandidates(place.near), ...ownAreas])]);
    if (boxArea === LOOKUP_FAILED) {
      results.push("error");
      continue;
    }
    // No area at all: a full street address is still specific enough to
    // look up on its own; a bare name isn't.
    if (!boxArea && !address) {
      results.push(null);
      continue;
    }
    const box = boxArea ? searchBox(boxArea.hit) : null;

    let hit = null;
    let streetHit = null;
    let failed = false;

    // 1. The street address - finds small places OpenStreetMap doesn't
    //    list by name (Le Sainti -> 150 Chemin des Bains).
    if (address) {
      const res = await lookup(address, box, "place");
      if (res === LOOKUP_FAILED) failed = true;
      else if (res && STREET_TYPES.has(res.type)) streetHit = res;
      else if (res) hit = res;
    }

    // 2. The place's name.
    if (!hit && box) {
      for (const variant of nameVariants(place.name)) {
        const res = await lookup(variant, box, "place");
        if (res === LOOKUP_FAILED) failed = true;
        else if (res) {
          hit = res;
          break;
        }
      }
    }
    if (hit) {
      results.push({ lat: hit.lat, lon: hit.lon, website: hit.website || null, wikidata: hit.wikidata || null });
      continue;
    }
    if (failed) {
      results.push("error");
      continue;
    }

    // 3. Its street, when the address only resolved that far.
    if (streetHit) {
      results.push({ lat: streetHit.lat, lon: streetHit.lon, approximate: true, approxKind: "street", approxArea: address });
      continue;
    }

    // 4. Its town or neighborhood, as long as that's inside the searched
    //    area (a same-named village elsewhere doesn't count).
    if (!box) {
      results.push(null);
      continue;
    }
    const locality = await firstArea(
      ownAreas.length ? ownAreas : areaCandidates(place.near),
      (res) => LOCALITY_TYPES.has(res.type) && inBox(res, box)
    );
    if (locality && locality !== LOOKUP_FAILED) {
      results.push({
        lat: locality.hit.lat,
        lon: locality.hit.lon,
        approximate: true,
        approxKind: "area",
        approxArea: locality.name,
      });
    } else {
      results.push(locality === LOOKUP_FAILED ? "error" : null);
    }
  }
  return results;
}
