// Builds a per-browser manifest by merging the shared base with a small per-target
// overlay. Shared fields + version live ONCE in manifest.base.json; only browser-specific
// keys (background, gecko settings) live in manifest.<target>.json. At release time the
// version can be overridden via the CARDTABLE_VERSION env var (see release.yml).
//   usage: node build-manifest.mjs <chromium|firefox> <outPath>
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [target, outPath] = process.argv.slice(2);
if (!target || !outPath) {
  console.error("usage: build-manifest.mjs <chromium|firefox> <outPath>");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => JSON.parse(readFileSync(join(here, name), "utf8"));

// Shallow top-level merge: the only differing keys (background, browser_specific_settings)
// are whole top-level objects the overlay supplies in full, so no deep merge is needed.
const manifest = { ...read("manifest.base.json"), ...read(`manifest.${target}.json`) };
// Release builds stamp the version from the git tag; local/CI builds keep base.json's.
if (process.env.CARDTABLE_VERSION) manifest.version = process.env.CARDTABLE_VERSION;
writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n");
