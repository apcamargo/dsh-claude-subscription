#!/usr/bin/env node
/**
 * Re-derives tokens.css from the installed dsh build: the web frontend's
 * stylesheet carries the theme's variables, one `body` block per mode. Run it when
 * the `engines.dsh` pin moves, then regenerate the figures.
 *
 *   node scripts/images/extract-tokens.mjs [path/to/app.asar]
 *
 * The default path is the macOS desktop install; DSH_ASAR overrides it.
 *
 * @module scripts/images/extract-tokens
 */

import { readFileSync, writeFileSync } from "node:fs";

const ASAR =
  process.argv[2] ??
  process.env.DSH_ASAR ??
  "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar";

/** The asar container: a pickle-wrapped JSON header, then the file payloads. */
function readArchive(path) {
  const buffer = readFileSync(path);
  const headerSize = buffer.readUInt32LE(4);
  // The header is a pickle (a length, then JSON). The exact start/size pair
  // varies by one or two padding words between packers, so probe it.
  let header;
  let start = 8;
  let length = 0;
  for (let offset = 8; offset <= 16 && header === undefined; offset++) {
    for (let trim = 0; trim <= 24 && header === undefined; trim++) {
      try {
        const candidate = JSON.parse(
          buffer.subarray(offset, offset + headerSize - trim).toString("utf8"),
        );
        if (candidate?.files !== undefined) {
          header = candidate;
          start = offset;
          length = headerSize - trim;
        }
      } catch {
        // try the next alignment
      }
    }
  }
  if (header === undefined) throw new Error(`${path}: no asar header found (${start}+${length})`);
  const base = 8 + headerSize;
  const files = [];
  const walk = (node, at) => {
    if (node.files !== undefined) {
      for (const [name, child] of Object.entries(node.files)) walk(child, `${at}/${name}`);
      return;
    }
    if (node.link !== undefined || node.offset === undefined) return;
    files.push({ path: at, offset: Number(node.offset), size: Number(node.size) });
  };
  walk(header, "");
  return {
    files,
    read: (entry) => buffer.subarray(base + entry.offset, base + entry.offset + entry.size),
  };
}

const archive = readArchive(ASAR);
const stylesheets = archive.files
  .filter((entry) => entry.path.endsWith(".css"))
  .sort((a, b) => b.size - a.size);

/** Every custom property of one selector in one stylesheet, later blocks winning. */
function variables(css, selector) {
  const seen = new Map();
  for (let i = 0; i < css.length;) {
    const open = css.indexOf("{", i);
    if (open < 0) break;
    let depth = 1;
    let end = open + 1;
    while (end < css.length && depth > 0) {
      if (css[end] === "{") depth++;
      else if (css[end] === "}") depth--;
      end++;
    }
    if (css.slice(i, open).trim().replace(/\s+/g, "") === selector) {
      for (const match of css.slice(open + 1, end - 1).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g))
        seen.set(match[1], match[2].trim());
    }
    i = end;
  }
  return seen;
}

let found;
for (const entry of stylesheets) {
  const css = archive.read(entry).toString("utf8");
  if (!css.includes("--dsw-alias-label-primary")) continue;
  const light = variables(css, "body");
  const dark = variables(css, "body[data-ds-dark-theme]");
  if (light.size > 0 && dark.size > 0) {
    found = { entry, light, dark };
    break;
  }
}
if (found === undefined) throw new Error(`${ASAR}: no stylesheet carries the theme variables`);

const declaration = (map) => [...map].map(([name, value]) => `${name}:${value}`).join(";");
const output = `/* The host theme's variables, light then dark, extracted from the installed
   dsh build (${found.entry.path}). Regenerate with scripts/images/extract-tokens.mjs
   when the \`engines.dsh\` pin moves. Committed so the figures can be rendered
   without the app installed. */
body{${declaration(found.light)}}
body[data-ds-dark-theme]{${declaration(found.dark)}}
`;

writeFileSync(new URL("./tokens.css", import.meta.url), output);
console.log(
  `tokens.css: ${found.light.size} light variables, ${found.dark.size} dark overrides, from ${found.entry.path}`,
);
