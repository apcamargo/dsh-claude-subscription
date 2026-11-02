/**
 * The composer's quota indicator with its panel open: the mark at the model
 * seat and the popover it opens.
 *
 * @module scripts/images/indicator
 */

import { MOCK, SHADOW, SPARK_PATH, page } from "./kit.mjs";

/**
 * Deleted at hand-off: the seat (8px above the trigger), the trigger's hover wash
 * (it is the clicked state), and a panel that is opaque without a backdrop to
 * blur. The host's 0.5px elevation ring reads as a light halo on transparency, so
 * the set's one shadow replaces it.
 */
const DEMO = `
.stage { display: inline-flex; flex-direction: column; align-items: flex-end; gap: 8px; }
.trigger { padding-right: 8px; }
.dsh-cs-pieBtn {
  background-image: linear-gradient(var(--dsw-alias-interactive-bg-hover), var(--dsw-alias-interactive-bg-hover)),
    linear-gradient(var(--dsw-alias-bg-layer-1), var(--dsw-alias-bg-layer-1));
}
.dsh-cs-sPanel {
  --dsw-elevation-stroke-color: transparent;
  background: linear-gradient(var(--dsw-specific-menu), var(--dsw-specific-menu)),
    linear-gradient(var(--dsw-alias-bg-layer-1), var(--dsw-alias-bg-layer-1));
  backdrop-filter: none;
  box-shadow: ${SHADOW};
}
`;

const spark = (size) =>
  `<svg class="dsh-cs-spark" viewBox="0 0 100 100" width="${size}" height="${size}" aria-hidden="true"><path d="${SPARK_PATH}"/></svg>`;

const windowRow = (label, percent) =>
  `<div class="dsh-cs-sWindow"><dt>${label}</dt><dd>${percent}%</dd><div class="dsh-cs-sBar"><div class="dsh-cs-sFill" style="width:${percent}%"></div></div></div>`;

/** The mark: the neutral base with the clay layer clipped to the bottom (100 − used)%. */
const mark = (used) =>
  `<svg viewBox="0 0 100 100" width="14" height="14" aria-hidden="true"><path d="${SPARK_PATH}" class="dsh-cs-pieDepleted dsh-cs-pieTrack"/><svg x="0" y="${used}" width="100" height="${100 - used}" viewBox="0 0 100 100" preserveAspectRatio="xMinYMax slice" overflow="hidden"><path d="${SPARK_PATH}" class="dsh-cs-spark"/></svg></svg>`;

export const slug = "claude-usage-indicator";
export const viewport = { width: 560, height: 440 };

/** @param {"light" | "dark"} theme */
export function build(theme) {
  const body = `<div class="stage">
<div class="dsh-cs-sPanel" role="dialog" aria-label="Usage quota">
<div class="dsh-cs-sTitle"><span class="dsh-cs-sTitleLabel">${spark(16)}Usage quota &middot; ${MOCK.email}</span><span class="dsh-cs-sTitleValue">${MOCK.plan}</span></div>
<div class="dsh-cs-sRule"></div>
<dl class="dsh-cs-sDetails">${windowRow("5-hour &middot; resets in 2h 14m", MOCK.used5h)}${windowRow("Weekly &middot; resets in 4d 6h", MOCK.usedWeekly)}</dl>
</div>
<div class="trigger"><button class="dsh-cs-pieBtn" type="button" aria-label="${MOCK.used5h}% of the 5-hour quota was used">${mark(MOCK.used5h)}</button></div>
</div>`;
  return page({ theme, demo: DEMO }) + body + "</body></html>";
}
