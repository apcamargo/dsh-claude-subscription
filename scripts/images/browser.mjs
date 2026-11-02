/**
 * Finding a headless Chromium. The figures are photographs of the real card, so
 * they are rendered by the same engine the app runs on, not described.
 *
 * @module scripts/images/browser
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The Playwright browser caches, newest install first. */
function playwrightShells() {
  const roots = [
    join(homedir(), "Library/Caches/ms-playwright"),
    join(homedir(), ".cache/ms-playwright"),
  ];
  const found = [];
  for (const root of roots) {
    let entries;
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith("chromium_headless_shell-")) continue;
      for (const relative of [
        "chrome-headless-shell-mac-arm64/chrome-headless-shell",
        "chrome-headless-shell-mac-x64/chrome-headless-shell",
        "chrome-headless-shell-linux64/chrome-headless-shell",
      ]) {
        const candidate = join(root, entry, relative);
        if (existsSync(candidate)) found.push(candidate);
      }
    }
  }
  return found;
}

/**
 * A headless browser and the flags it needs. `CHROME` overrides the search, so a
 * plain Chrome install works too.
 * @returns {{ path: string, flags: string[] }}
 */
export function findBrowser() {
  const explicit = process.env.CHROME;
  if (explicit) return { path: explicit, flags: ["--headless=new"] };
  for (const path of playwrightShells()) return { path, flags: [] };
  for (const path of [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ]) {
    if (existsSync(path)) return { path, flags: ["--headless=new"] };
  }
  throw new Error(
    "no headless Chromium found: install one, or point CHROME at its binary (e.g. CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run images)",
  );
}
