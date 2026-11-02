/**
 * Shared machinery for the README figures: the card stylesheet from its shipped
 * source, the host theme variables, and the page each figure renders on. Nothing
 * here retypes a rule, so the figures cannot drift from what the plugin draws.
 *
 * @module scripts/images/kit
 */

import { readFileSync } from "node:fs";

/** The card stylesheet, sliced out of the browser card's source. */
function appCSS() {
  const source = readFileSync(new URL("../../lib/client-app.js", import.meta.url), "utf8");
  const marker = "const CSS = `";
  const start = source.indexOf(marker);
  const end = source.indexOf("`;\n\n\t/** Card copy.");
  if (start < 0 || end < 0) throw new Error("stylesheet block not found in lib/client-app.js");
  return source.slice(start + marker.length, end);
}

/** The host theme's variables, one `body` block per mode (see extract-tokens). */
const TOKENS = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

/** The host's own text stack (its `--dsh-font-family-text-default`). */
const FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif`;

/** The demonstration elevation every figure in the set shares. */
export const SHADOW = "0 1px 2px rgba(0, 0, 0, .06), 0 8px 24px rgba(0, 0, 0, .09)";

/**
 * The page a figure is drawn on: theme variables, the host tokens the card CSS
 * reads, nothing behind the figure, then the figure's own demo CSS last.
 * @param {{ theme: string, demo: string }} parts
 */
export function page({ theme, demo }) {
  const dark = theme === "dark" ? " data-ds-dark-theme" : "";
  return `<!doctype html><html lang="en" data-platform="darwin"><head><meta charset="utf-8"><title>Claude subscription</title><style>
${TOKENS}
html[data-platform="darwin"] body { --dsw-specific-menu: rgba(248, 249, 250, .94); }
html[data-platform="darwin"] body[data-ds-dark-theme] { --dsw-specific-menu: rgba(48, 49, 54, .94); }
:root {
  --dsw-radius-xs: 4px; --dsw-radius-sm: 8px; --dsw-radius-md: 12px;
  --dsw-radius-lg: 16px; --dsw-radius-xl: 20px;
}
html, body { margin: 0; padding: 0; }
body {
  /* A var() inside a custom property resolves against the element that
     declares it, and these layer tokens live on body. */
  --dsw-alias-settings-card-fill: var(--dsw-alias-bg-layer-2);
  --dsw-alias-settings-card-stroke: var(--dsw-alias-border-l4);
  padding: 60px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-family: ${FONT};
  -webkit-font-smoothing: antialiased;
}
${appCSS()}
${demo}
</style></head><body${dark}>
`;
}

/** The Claude spark, the mark every Claude surface carries. */
export const SPARK_PATH =
  "m19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z";

/** The placeholder identity every figure in the set shares. */
export const MOCK = {
  email: "ada.rivera@example.com",
  organization: "ada.rivera@example.com's Organization",
  plan: "Max plan",
  used5h: 26,
  usedWeekly: 58,
};
