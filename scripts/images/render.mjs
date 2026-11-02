#!/usr/bin/env node
/**
 * Regenerates the README figures into images/: one PNG per figure per theme,
 * rendered by headless Chromium at 2x from the plugin's own stylesheet, then
 * trimmed to the figure plus a 24px margin.
 *
 *   npm run images                 # every figure
 *   npm run images -- indicator    # one figure, by slug
 *
 * @module scripts/images/render
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { findBrowser } from "./browser.mjs";
import { alphaBox, crop, decode, encode } from "./png.mjs";

import * as commandCards from "./command-cards.mjs";
import * as indicator from "./indicator.mjs";
import * as modelsCard from "./models-card.mjs";

const FIGURES = [commandCards, indicator, modelsCard];
const THEMES = ["light", "dark"];
/** 24 CSS pixels of clear space around the figure, at the 2x capture scale. */
const MARGIN = 48;
/** Capture scale: 2x pixels for a 1x layout, so text stays sharp on retina. */
const SCALE = 2;

const outDir = new URL("../../images/", import.meta.url);
mkdirSync(outDir, { recursive: true });

const wanted = process.argv.slice(2);
for (const name of wanted) {
  if (!FIGURES.some((figure) => figure.slug === name)) {
    throw new Error(
      `unknown figure "${name}": try ${FIGURES.map((figure) => figure.slug).join(", ")}`,
    );
  }
}

const { path: browser, flags } = findBrowser();
const workspace = mkdtempSync(join(tmpdir(), "dsh-claude-subscription-images-"));

for (const figure of FIGURES) {
  if (wanted.length > 0 && !wanted.includes(figure.slug)) continue;
  for (const theme of THEMES) {
    const html = join(workspace, `${figure.slug}-${theme}.html`);
    const raw = join(workspace, `${figure.slug}-${theme}.png`);
    writeFileSync(html, figure.build(theme));
    execFileSync(
      browser,
      [
        ...flags,
        "--no-sandbox",
        "--disable-gpu",
        "--hide-scrollbars",
        "--default-background-color=00000000",
        `--force-device-scale-factor=${SCALE}`,
        `--window-size=${figure.viewport.width},${figure.viewport.height}`,
        `--screenshot=${raw}`,
        pathToFileURL(html).href,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const image = decode(readFileSync(raw));
    const box = alphaBox(image, 2);
    if (box === undefined) throw new Error(`${figure.slug} ${theme}: nothing was drawn`);
    const trimmed = crop(
      image,
      Math.max(0, box.left - MARGIN),
      Math.max(0, box.top - MARGIN),
      Math.min(image.width, box.right + MARGIN),
      Math.min(image.height, box.bottom + MARGIN),
    );
    const target = new URL(`${figure.slug}-${theme}.png`, outDir);
    writeFileSync(target, encode(trimmed));
    console.log(`${figure.slug}-${theme}.png  ${trimmed.width}×${trimmed.height}`);
  }
}
