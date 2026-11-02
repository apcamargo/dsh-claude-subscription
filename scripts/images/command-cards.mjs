/**
 * The `/claude-account` and `/claude-usage` result cards, one chat's width
 * apart, as the transcript stacks them.
 *
 * @module scripts/images/command-cards
 */

import { MOCK, SHADOW, SPARK_PATH, page } from "./kit.mjs";

/** Deleted at hand-off: the cards are 680px wide, 24px apart, one shadow. */
const DEMO = `
.mock { display: grid; gap: 24px; width: 680px; }
.mock .dsh-cs-uroot { box-shadow: ${SHADOW}; }
`;

const spark = `<svg class="dsh-cs-spark" viewBox="0 0 100 100" width="20" height="20" aria-hidden="true"><path d="${SPARK_PATH}"/></svg>`;

const row = (label, value) =>
  `<div class="dsh-cs-uitem"><div class="dsh-cs-urow"><span class="dsh-cs-ulabel">${label}</span><span class="dsh-cs-upct dsh-cs-uextraVal">${value}</span></div></div>`;

const windowRow = (label, percent) =>
  `<div class="dsh-cs-uitem"><div class="dsh-cs-urow"><span class="dsh-cs-ulabel">${label}</span><span class="dsh-cs-upct">${percent}%</span></div><div class="dsh-cs-utrack"><div class="dsh-cs-ufill" style="width:${percent}%"></div></div></div>`;

const panel = (title, subtitle, rows) =>
  `<div class="dsh-cs-uroot"><div class="dsh-cs-uhead"><span class="dsh-cs-utile">${spark}</span><span class="dsh-cs-utitles"><span class="dsh-cs-utitle">${title}</span><span class="dsh-cs-uplan">${subtitle}</span></span></div><div class="dsh-cs-ulist">${rows}</div></div>`;

export const slug = "claude-account-usage";
export const viewport = { width: 800, height: 860 };

/** @param {"light" | "dark"} theme */
export function build(theme) {
  const subtitle = `${MOCK.email} &middot; ${MOCK.plan}`;
  const body = `<div class="mock">
${panel("Claude account", subtitle, row("Organization", MOCK.organization) + row("OAuth token", "expires in 5h 16m"))}
${panel("Usage quota", subtitle, windowRow("5-hour &middot; resets in 2h 14m", MOCK.used5h) + windowRow("Weekly &middot; resets in 4d 6h", MOCK.usedWeekly))}
</div>`;
  return page({ theme, demo: DEMO }) + body + "</body></html>";
}
