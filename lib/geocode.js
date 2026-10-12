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
  return data.lat == null ? null : { lat: data.lat, lon: data.lon, box: data.bounding_box || null };
}

async function writeDbCache(key, result) {
  const supabase = dbCacheUsable ? getSupabase() : null;
  if (!supabase) return;
  const { error } = await supabase.from("geocode_cache").upsert({
    query: key,
    lat: result?.lat ?? null,
    lon: result?.lon ?? null,
    bounding_box: result?.box ?? null,
    created_at: new Date().toISOString(),
  });
  if (error) {
    console.error("[geocode] couldn't write geocode_cache:", error.message);
    dbCacheUsable = false;
  }
}

// box: [west, south, east, north] - limits matches to that rectangle, so
// "The Lobster Shack" near Boothbay can't resolve to one in Oregon.
async function lookup(q, box) {
  const key = `${q.trim().toLowerCase()}|${box ? box.map((n) => n.toFixed(2)).join(",") : "any"}`;
  if (memoryCache.has(key)) return memoryCache.get(key);

  const cached = await readDbCache(key);
  if (cached !== undefined) {
    memoryCache.set(key, cached);
    return cached;
  }

  const params = new URLSearchParams({ q, format: "jsonv2", limit: "1" });
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
    // A box-limited query can still come back as the town/region itself
    // (Nominatim matching just the place-name words) - a pin at the town
    // center would look like a real location, so those count as misses
    // for place lookups. Area lookups (box === null) want exactly these.
    if (hit && (!box || !AREA_TYPES.has(hit.addresstype))) {
      // Nominatim's boundingbox is [south, north, west, east] as strings.
      const [s, n, w, e] = (hit.boundingbox || []).map(Number);
      result = {
        lat: Number(hit.lat),
        lon: Number(hit.lon),
        box: [w, s, e, n].every(Number.isFinite) ? [w, s, e, n] : null,
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

// places: [{ name, area, near }] - `near` is the location that was
// searched (Discovery's location box, or a planning item's
// search_location), used to keep matches local. Returns one entry per
// place, in order: { lat, lon }, null (not on OpenStreetMap), or
// "error" (the lookup itself failed - worth retrying later, so callers
// mustn't remember it as a miss).
export async function geocodePlaces(places) {
  const results = [];
  for (const place of places) {
    // The searched location first, then the place's own area - a typo'd
    // search ("chatoonaga, tennessee") shouldn't leave a place unpinned
    // when its own area ("Lookout Mountain, near Chattanooga") is fine.
    let nearHit = null;
    let areaFailed = false;
    for (const candidate of new Set([usableArea(place.near), usableArea(place.area)].filter(Boolean))) {
      const res = await lookup(candidate, null);
      if (res === LOOKUP_FAILED) areaFailed = true;
      else if (res) {
        nearHit = res;
        break;
      }
    }
    if (!nearHit && areaFailed) {
      results.push("error");
      continue;
    }
    const box = searchBox(nearHit);

    // No box means no way to keep a match local - better unplaced than a
    // same-named spot in another state.
    let hit = null;
    let failed = false;
    if (box) {
      for (const variant of nameVariants(place.name)) {
        const res = await lookup(variant, box);
        if (res === LOOKUP_FAILED) failed = true;
        else if (res) {
          hit = res;
          break;
        }
      }
    }
    results.push(hit ? { lat: hit.lat, lon: hit.lon } : failed ? "error" : null);
  }
  return results;
}
