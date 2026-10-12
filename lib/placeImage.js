import { fetchOgImage } from "./ogImage";
import { geocodePlaces } from "./geocode";
import { getSupabase } from "./supabase";

// One photo for a place's card, from free sources only - no Claude call,
// no paid API. In order:
// 1. its own website's preview image (og:image), when a search reported
//    the site (Discovery/Planning/"Find exact spot") or the place came
//    with one (Collab Search leads)
// 2. its Wikimedia photo, via the Wikidata id OpenStreetMap lists for it
//    (the Wikidata image, else its Wikipedia article's lead image) -
//    landmarks, parks, museums
// 3. the preview image of the website OpenStreetMap lists for it - many
//    restaurants and bars are mapped with their site
// 4. a Wikipedia article whose title IS the place's name (Ruby Falls) -
//    for well-known places OpenStreetMap doesn't link to Wikidata. A
//    near-miss title (a restaurant -> the article on its city) never
//    counts, so this can't attach a photo of the wrong thing.
// Steps 2-3 reuse the map's own geocoding lookups (lib/geocode.js), which
// are cached, so a place already on a map costs no new lookups here.

const WIKI_USER_AGENT = "WanderHQ/1.0 (private trip-planning app for one travel creator; low volume)";
const FETCH_TIMEOUT_MS = 8000;
// Wikimedia only serves thumbnails at its standard widths (500 and 960
// work; 640 and 800 return 400) - 500 is sharp enough for a phone card.
const COMMONS_WIDTH = 500;
const wikiCache = new Map();

async function getJson(url) {
  const res = await fetch(url, {
    headers: { "user-agent": WIKI_USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return res.ok ? res.json() : null;
}

async function cached(key, fn) {
  if (wikiCache.has(key)) return wikiCache.get(key);
  const value = await fn().catch(() => null);
  wikiCache.set(key, value);
  return value;
}

// An English Wikipedia article's lead image, by exact title.
function wikipediaImage(title) {
  return cached(`wp:${title}`, async () => {
    const data = await getJson(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`
    );
    if (!data || data.type === "disambiguation") return null;
    // The summary's thumbnail is 330px wide - too small for a card banner.
    // Commons serves other sizes from the same path, so ask for 500px
    // (a standard width, see COMMONS_WIDTH) rather than the original,
    // which can be many megabytes.
    const thumb = data.thumbnail?.source?.replace(/\/\d+px-/, `/${COMMONS_WIDTH}px-`);
    return thumb || data.originalimage?.source || null;
  });
}

function wikidataImage(qid) {
  if (!/^Q\d+$/.test(qid || "")) return null;
  return cached(`wd:${qid}`, async () => {
    const data = await getJson(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`);
    const entity = data?.entities?.[qid];
    // P18 = the entity's main image, a Commons file name.
    const file = entity?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
    if (typeof file === "string" && file) {
      return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=${COMMONS_WIDTH}`;
    }
    const article = entity?.sitelinks?.enwiki?.title;
    return article ? wikipediaImage(article) : null;
  });
}

function normalizeName(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/^the\s+/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Step 4: search Wikipedia for "<name> <town>" and take the top article
// only if its title (minus a "(disambiguator)") equals the place's name.
function wikipediaByName(name, area) {
  const wanted = normalizeName(name);
  if (wanted.length < 4) return null;
  return cached(`wps:${wanted}|${area || ""}`, async () => {
    const params = new URLSearchParams({
      action: "query",
      list: "search",
      srsearch: [name, area].filter(Boolean).join(" "),
      srlimit: "3",
      format: "json",
    });
    const data = await getJson(`https://en.wikipedia.org/w/api.php?${params}`);
    const match = (data?.query?.search || []).find((r) => normalizeName(r.title) === wanted);
    return match ? wikipediaImage(match.title) : null;
  });
}

// Which photo each place resolved to is remembered in the geocode_cache
// table (README) when it exists, under an "image|" key - so a place is
// only ever worked out once, not once per server instance (Vercel starts
// fresh instances often, and each would otherwise redo the lookups).
const PHOTO_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NO_PHOTO_TTL_MS = 7 * 24 * 60 * 60 * 1000;
let dbUsable = true;

function cacheKey(place) {
  return `image|${[place.name, place.area, place.near, place.address, place.website]
    .map((v) => (v || "").toLowerCase())
    .join("|")}`;
}

async function readStored(key) {
  const supabase = dbUsable ? getSupabase() : null;
  if (!supabase) return undefined;
  const { data, error } = await supabase.from("geocode_cache").select("extra, created_at").eq("query", key).maybeSingle();
  if (error) {
    dbUsable = false;
    return undefined;
  }
  if (!data) return undefined;
  const image = data.extra?.image || null;
  const age = Date.now() - new Date(data.created_at).getTime();
  return age < (image ? PHOTO_TTL_MS : NO_PHOTO_TTL_MS) ? image : undefined;
}

async function store(key, image) {
  const supabase = dbUsable ? getSupabase() : null;
  if (!supabase) return;
  const { error } = await supabase
    .from("geocode_cache")
    .upsert({ query: key, lat: null, lon: null, extra: { image }, created_at: new Date().toISOString() });
  if (error) dbUsable = false;
}

// place: { name, area, near, address, website } - returns an image URL or null.
export async function imageForPlace(place) {
  const key = cacheKey(place);
  const stored = await readStored(key);
  if (stored !== undefined) return stored;
  const image = await findImage(place);
  if (image === undefined) return null;
  await store(key, image);
  return image;
}

async function findImage(place) {
  if (place.website) {
    const image = await fetchOgImage(place.website);
    if (image) return image;
  }

  // Places with no area to search around can't be looked up safely (a
  // same-named place elsewhere) - geocodePlaces returns null for those.
  const [geo] = await geocodePlaces([place]);
  // OpenStreetMap itself failed - say nothing rather than "no photo", so
  // this isn't remembered as a miss (see imageForPlace).
  if (geo === "error") return undefined;
  const exact = geo && !geo.approximate ? geo : null;

  if (exact?.wikidata) {
    const image = await wikidataImage(exact.wikidata);
    if (image) return image;
  }

  if (exact?.website && exact.website !== place.website) {
    try {
      const site = new URL(/^https?:\/\//i.test(exact.website) ? exact.website : `https://${exact.website}`).toString();
      const image = await fetchOgImage(site);
      if (image) return image;
    } catch {
      // Malformed website tag - fall through.
    }
  }

  const town = (place.area || place.near || "").split(",")[0].replace(/\([^)]*\)/g, "").trim();
  return wikipediaByName(place.name, town);
}
