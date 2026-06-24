// Guards against drift between the two copies of the entity Chart-of-Accounts.
//
// The per-entity account-number maps live in BOTH the worker and the renderer
// (there's no shared package between a Cloudflare Worker and a Vite app). The
// worker uses them to format the QuickBooks export; the renderer uses them for
// the GL dropdown + line display. If the two ever drift, the UI would show one
// account number while the export emits another — a silent financial-data bug.
//
// This script extracts ENTITY_COA / ENTITY_COA_LEGACY / ENTITY_COA_ALIAS from
// each constants file and deep-compares them. It runs in CI before the build,
// so a mismatch fails the release instead of shipping. Run locally with:
//   node scripts/check-coa-sync.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER = join(root, "worker/src/lib/constants.ts");
const RENDERER = join(root, "desktop/renderer/src/lib/constants.ts");
const CONSTS = ["ENTITY_COA", "ENTITY_COA_LEGACY", "ENTITY_COA_ALIAS"];

/** Extract the `{ ... }` object literal assigned to `export const <name>`. */
function extractLiteral(src, name) {
  const re = new RegExp(`export const ${name}\\b[^=]*=\\s*`);
  const m = re.exec(src);
  if (!m) throw new Error(`${name} not found in source`);
  let i = m.index + m[0].length;
  while (i < src.length && src[i] !== "{") i++;
  const start = i;
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) {
      i++;
      break;
    }
  }
  if (depth !== 0) throw new Error(`Unbalanced braces extracting ${name}`);
  return src.slice(start, i);
}

/** Parse the (TS-but-JS-compatible) object literal into a plain object. */
function parseLiteral(literal) {
  // The literals are plain string→string(/nested) maps with no TS syntax
  // inside the braces, so they evaluate as ordinary JS object literals.
  return Function(`"use strict";return (${literal});`)();
}

function load(path) {
  const src = readFileSync(path, "utf8");
  const out = {};
  for (const name of CONSTS) out[name] = parseLiteral(extractLiteral(src, name));
  return out;
}

const worker = load(WORKER);
const renderer = load(RENDERER);

const problems = [];
for (const name of CONSTS) {
  const a = JSON.stringify(worker[name], Object.keys(worker[name]).sort());
  const b = JSON.stringify(renderer[name], Object.keys(renderer[name]).sort());
  // Deep, order-independent compare: normalize by sorting keys recursively.
  const norm = (v) =>
    JSON.stringify(v, (_k, val) =>
      val && typeof val === "object" && !Array.isArray(val)
        ? Object.fromEntries(Object.entries(val).sort(([x], [y]) => (x < y ? -1 : 1)))
        : val,
    );
  if (norm(worker[name]) !== norm(renderer[name])) {
    problems.push(name);
    // Surface the specific entity/key differences to make fixes obvious.
    for (const entity of new Set([
      ...Object.keys(worker[name]),
      ...Object.keys(renderer[name]),
    ])) {
      const w = worker[name][entity];
      const r = renderer[name][entity];
      if (norm(w) !== norm(r)) {
        console.error(`  ${name}.${entity}: worker=${JSON.stringify(w)} renderer=${JSON.stringify(r)}`);
      }
    }
  }
  void a;
  void b;
}

if (problems.length) {
  console.error(
    `\n✗ COA drift detected in: ${problems.join(", ")}\n` +
      `  worker:   ${WORKER}\n  renderer: ${RENDERER}\n` +
      `  These maps MUST be identical. Sync the renderer mirror to the worker.\n`,
  );
  process.exit(1);
}

console.log("✓ ENTITY_COA / ENTITY_COA_LEGACY / ENTITY_COA_ALIAS are in sync (worker ↔ renderer).");
