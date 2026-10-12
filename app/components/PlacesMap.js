"use client";

import { useEffect, useRef, useState } from "react";
import "maplibre-gl/dist/maplibre-gl.css";

// Shared map view for Discovery results and the Planning list. Free all
// the way down: OpenFreeMap tiles (no key, no usage limits, commercial use
// allowed - attribution is added by MapLibre automatically) and
// /api/geocode for coordinates (OpenStreetMap's Nominatim, also free).
// No Claude call anywhere in here.
//
// places: [{ key, name, area, near, why, color, onOpen? }]
// legend: [{ label, color }] (optional)

const STYLE_URL = "https://tiles.openfreemap.org/styles/positron";
const WORKER_PATH = "/maplibre/maplibre-gl-worker.mjs";
const GEOCODE_BATCH = 8;
// How far below center a tapped pin is moved, leaving room above it for
// its popup (the map is 360-420px tall).
const POPUP_ROOM_PX = 110;
// Bumped whenever the server's lookup logic changes what a place
// resolves to, so old per-browser answers (and cached misses) are dropped.
const CACHE_PREFIX = "wwwGeo3:";
// New England-ish starting view, only visible for the moment before the
// first pins land and the map fits to them.
const DEFAULT_CENTER = [-71.5, 43.5];
const DEFAULT_ZOOM = 5;

function cacheKey(p) {
  return `${CACHE_PREFIX}${p.name}|${p.area || ""}|${p.near || ""}|${p.address || ""}`.toLowerCase();
}

// Per-browser cache on top of the server's own, so reopening a map is
// instant. Storage can be blocked (private mode) - every access is
// guarded and a miss just means asking the server again. "Not found"
// answers expire, so a place OpenStreetMap adds later still shows up.
const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function readCache(p) {
  try {
    const raw = localStorage.getItem(cacheKey(p));
    if (raw === null) return undefined;
    const value = JSON.parse(raw);
    if (value?.miss) return Date.now() - value.miss < MISS_TTL_MS ? null : undefined;
    return value;
  } catch {
    return undefined;
  }
}

function writeCache(p, value) {
  try {
    localStorage.setItem(cacheKey(p), JSON.stringify(value || { miss: Date.now() }));
  } catch {
    // Storage full or blocked - the server cache still covers it.
  }
}

function mapsSearchUrl(name, area) {
  const query = [name, area].filter(Boolean).join(", ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

// Built with DOM calls rather than an HTML string: name/why come from
// model output and must never be parsed as markup.
// coord: { lat, lon, approximate?, approxArea? } from /api/geocode.
function popupContent(place, coord) {
  const root = document.createElement("div");
  root.className = "map-popup";

  const title = document.createElement("strong");
  title.textContent = place.name;
  root.appendChild(title);

  if (place.area) {
    const area = document.createElement("div");
    area.className = "map-popup-area";
    area.textContent = place.area;
    root.appendChild(area);
  }

  if (coord.approximate) {
    const approx = document.createElement("div");
    approx.className = "map-popup-approx";
    approx.textContent =
      coord.approxKind === "street"
        ? `Approximate - pinned on its street (${coord.approxArea}); the exact building isn't on the free map.`
        : `Approximate - pinned at ${coord.approxArea}, since the exact spot isn't on the free map yet.`;
    root.appendChild(approx);
  }

  if (place.why) {
    const why = document.createElement("p");
    why.textContent = place.why.length > 130 ? `${place.why.slice(0, 127)}…` : place.why;
    root.appendChild(why);
  }

  const actions = document.createElement("div");
  actions.className = "map-popup-actions";
  const link = document.createElement("a");
  link.href = mapsSearchUrl(place.name, place.address || place.area);
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "Google Maps ↗";
  actions.appendChild(link);

  // Approximate pins can look up the place's street address (one paid
  // search, a few cents) - the parent saves it, which re-pins the place.
  if (coord.approximate && place.onFindAddress) {
    const find = document.createElement("button");
    find.type = "button";
    find.textContent = "Find exact spot";
    find.addEventListener("click", async () => {
      find.disabled = true;
      find.textContent = "Searching…";
      let address = null;
      try {
        address = await place.onFindAddress();
      } catch {
        // Shown below, same as finding nothing.
      }
      // On success the pin is redrawn (closing this popup); this text
      // only stays visible when nothing was found.
      find.textContent = address ? "Found - updating…" : "No address found";
    });
    actions.appendChild(find);
  }

  if (place.onOpen) {
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = "Open details";
    open.addEventListener("click", () => place.onOpen());
    actions.appendChild(open);
  }
  root.appendChild(actions);
  return root;
}

export default function PlacesMap({ places, legend }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const libRef = useRef(null);
  const markersRef = useRef([]);
  // Once she pans or zooms herself, stop re-fitting the view every time
  // another batch of pins lands.
  const userMovedRef = useRef(false);
  // Latest props for the effects below, which key off placesSignature
  // rather than the array itself (see the geocoding effect).
  const placesRef = useRef(places);
  placesRef.current = places;
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState("");
  // key -> { lat, lon } | null (couldn't be placed). Absent = still looking.
  const [coords, setCoords] = useState({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mod = await import("maplibre-gl");
        const maplibregl = mod.default ?? mod;
        if (cancelled || !containerRef.current) return;
        // The bundler doesn't emit MapLibre's worker file, so it's served
        // from public/ instead (scripts/copy-maplibre-worker.mjs).
        maplibregl.setWorkerUrl(new URL(WORKER_PATH, window.location.origin).href);
        libRef.current = maplibregl;
        const map = new maplibregl.Map({
          container: containerRef.current,
          style: STYLE_URL,
          center: DEFAULT_CENTER,
          zoom: DEFAULT_ZOOM,
          attributionControl: { compact: true },
          cooperativeGestures: false,
        });
        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
        const markUserMoved = (e) => {
          if (e.originalEvent) userMovedRef.current = true;
        };
        map.on("dragstart", markUserMoved);
        map.on("zoomstart", markUserMoved);
        map.on("load", () => {
          if (cancelled) return;
          // Compact attribution starts expanded, which covers a third of
          // a phone-sized map; it stays one tap away on the (i) button.
          map.getContainer().querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
        });
        map.on("error", (e) => console.error("[PlacesMap]", e?.error || e));
        mapRef.current = map;
        // Markers and fitBounds work before "load" (which waits for the
        // first full render of tiles), so pins go up right away instead of
        // waiting on a slow connection.
        setMapReady(true);
      } catch (err) {
        console.error("[PlacesMap] failed to load map:", err);
        if (!cancelled) setMapError("Couldn't load the map - check your connection and try again.");
      }
    })();
    return () => {
      cancelled = true;
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  // Geocode whatever isn't cached yet, in small batches so pins appear as
  // they're found rather than all at once after a long wait.
  // Includes each address, so a newly found one re-pins that place (the
  // rest come straight from the cache).
  const placesSignature = places.map((p) => `${p.key}|${p.address || ""}`).join("\n");
  const keysSignature = places.map((p) => p.key).join("\n");
  const lastKeysRef = useRef(null);
  useEffect(() => {
    let cancelled = false;
    const known = {};
    const pending = [];
    for (const p of places) {
      const cached = readCache(p);
      if (cached !== undefined) known[p.key] = cached;
      else pending.push(p);
    }
    setCoords(known);
    // A different set of places re-fits the view; the same places with
    // one newly found address leave it where she was looking.
    if (lastKeysRef.current !== keysSignature) {
      userMovedRef.current = false;
      lastKeysRef.current = keysSignature;
    }

    (async () => {
      for (let i = 0; i < pending.length; i += GEOCODE_BATCH) {
        const batch = pending.slice(i, i + GEOCODE_BATCH);
        let results = null;
        try {
          const res = await fetch("/api/geocode", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              places: batch.map((p) => ({ name: p.name, area: p.area, near: p.near, address: p.address })),
            }),
          });
          if (res.ok) results = (await res.json()).results;
        } catch {
          // Network failure - mark this batch unplaced (not cached, so a
          // later open retries it).
        }
        if (cancelled) return;
        const found = {};
        batch.forEach((p, j) => {
          const hit = results?.[j] ?? null;
          // "error" = the lookup failed, not "not on the map" - shown as
          // unplaced for now, but not remembered, so the next open retries.
          found[p.key] = hit === "error" ? null : hit;
          if (results && hit !== "error") writeCache(p, hit);
        });
        setCoords((c) => ({ ...c, ...found }));
      }
    })();

    return () => {
      cancelled = true;
    };
    // placesSignature stands in for `places`: a new array with the same
    // places (every parent re-render) shouldn't restart the lookups.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placesSignature]);

  // Redraw pins whenever coordinates arrive or a pin's place/color
  // changes - not on every parent re-render, which would close whatever
  // popup she has open.
  const pinSignature = places.map((p) => `${p.key}|${p.name}|${p.color}`).join("\n");
  useEffect(() => {
    const places = placesRef.current;
    const map = mapRef.current;
    const maplibregl = libRef.current;
    if (!mapReady || !map || !maplibregl) return;

    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    const placed = places.filter((p) => coords[p.key]);
    for (const p of placed) {
      const coord = coords[p.key];
      const { lat, lon } = coord;
      const color = p.color || "var(--pin-teal)";
      const el = document.createElement("button");
      el.type = "button";
      // Approximate pins are hollow - same color, so the category still
      // reads, but visibly "somewhere around here", not a real location.
      el.className = coord.approximate ? "map-pin map-pin-approx" : "map-pin";
      if (coord.approximate) el.style.borderColor = color;
      else el.style.background = color;
      el.setAttribute("aria-label", coord.approximate ? `${p.name} (approximate)` : p.name);
      // Popups always open above their pin, so move the tapped pin into
      // the lower part of the frame first - near the edge of a phone-
      // sized map the popup would otherwise be clipped.
      el.addEventListener("click", () => {
        userMovedRef.current = true;
        map.easeTo({ center: [lon, lat], offset: [0, POPUP_ROOM_PX], duration: 300 });
      });
      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([lon, lat])
        .setPopup(new maplibregl.Popup({ anchor: "bottom", offset: 14, maxWidth: "260px" }).setDOMContent(popupContent(p, coord)))
        .addTo(map);
      markersRef.current.push(marker);
    }

    if (placed.length > 0 && !userMovedRef.current) {
      const bounds = new maplibregl.LngLatBounds();
      placed.forEach((p) => bounds.extend([coords[p.key].lon, coords[p.key].lat]));
      map.fitBounds(bounds, { padding: 48, maxZoom: 14, duration: 400 });
    }
  }, [mapReady, coords, pinSignature]);

  const lookingCount = places.filter((p) => coords[p.key] === undefined).length;
  const unplaced = places.filter((p) => coords[p.key] === null);
  const anyApproximate = places.some((p) => coords[p.key]?.approximate);

  return (
    <div className="places-map">
      {legend?.length > 0 && (
        <div className="map-legend">
          {legend.map((l) => (
            <span key={l.label} className="map-legend-item">
              <span className="map-legend-dot" style={{ background: l.color }} />
              {l.label}
            </span>
          ))}
          {anyApproximate && (
            <span className="map-legend-item">
              <span className="map-legend-dot map-legend-dot-approx" />
              Approximate spot
            </span>
          )}
        </div>
      )}

      <div className="map-frame">
        <div ref={containerRef} className="map-canvas" />
        {lookingCount > 0 && !mapError && (
          <div className="map-status">
            Placing pins… {places.length - lookingCount} of {places.length}
          </div>
        )}
        {mapError && <div className="map-status map-status-error">{mapError}</div>}
      </div>

      {unplaced.length > 0 && (
        <p className="hint map-unplaced">
          Couldn&apos;t find {unplaced.length === 1 ? "this one" : `these ${unplaced.length}`} on the map - tap to
          check in Google Maps:{" "}
          {unplaced.map((p, i) => (
            <span key={p.key}>
              {i > 0 && ", "}
              <a href={mapsSearchUrl(p.name, p.area)} target="_blank" rel="noopener noreferrer" className="place-link">
                {p.name}
              </a>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
