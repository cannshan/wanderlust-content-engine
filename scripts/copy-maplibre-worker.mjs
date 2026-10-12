// MapLibre GL 6 runs map rendering work in a Web Worker loaded from its
// own file (dist/maplibre-gl-worker.mjs, which imports
// maplibre-gl-shared.mjs). Next's bundler doesn't emit that file, so this
// copies both into public/maplibre/ before every dev/build run, and
// PlacesMap.js points MapLibre at them with setWorkerUrl. Copied from the
// installed package each time, so they always match its version.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "maplibre-gl", "dist");
const dest = join(root, "public", "maplibre");

mkdirSync(dest, { recursive: true });
for (const file of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) {
  copyFileSync(join(src, file), join(dest, file));
}
