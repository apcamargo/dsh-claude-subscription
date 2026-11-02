/**
 * The "Claude subscription" section of the Models page: one signed-in account,
 * its model list state, and the card's own save row.
 *
 * @module scripts/images/models-card
 */

import { MOCK, SHADOW, page } from "./kit.mjs";

/** Deleted at hand-off: the host's row card has no shadow, the set has one. */
const DEMO = `
.dsh-cs-card { box-shadow: ${SHADOW}; }
`;

const button = (className, label, disabled = false) =>
  `<button type="button" class="${className}"${disabled ? " disabled" : ""}>${label}</button>`;

export const slug = "claude-models-card";
export const viewport = { width: 900, height: 620 };

/** @param {"light" | "dark"} theme */
export function build(theme) {
  const body = `<section class="dsh-cs-card" aria-label="Claude subscription">
  <div class="dsh-cs-header">
    <h6 class="dsh-cs-title">Claude subscription</h6>
    <div class="dsh-cs-headerActions">
      ${button("dsh-cs-linkButton", "Refresh models")}
      ${button("dsh-cs-smallButton dsh-cs-accent", "Add account")}
    </div>
  </div>
  <section class="dsh-cs-panel" role="group" aria-label="${MOCK.email}">
    <div class="dsh-cs-sectionHead">
      <div class="dsh-cs-heading">
        <span class="dsh-cs-panelTitle" title="${MOCK.email}">${MOCK.email}</span>
        <p class="dsh-cs-meta">${MOCK.organization} &middot; ${MOCK.plan}</p>
      </div>
      <div class="dsh-cs-panelActions">${button("dsh-cs-smallButton dsh-cs-danger", "Sign out")}</div>
    </div>
    <section class="dsh-cs-section" aria-label="Models">
      <div class="dsh-cs-sectionHead">
        <div class="dsh-cs-heading">
          <span class="dsh-cs-headingTitle">Models</span>
          <p class="dsh-cs-meta" role="status" aria-live="polite">All 14 available models are in use.</p>
          <p class="dsh-cs-meta">Updated 2 h ago</p>
        </div>
        <div class="dsh-cs-headActions">${button("dsh-cs-smallButton", "Customize models")}</div>
      </div>
    </section>
    <div class="dsh-cs-footer">
      <span></span>
      <div class="dsh-cs-actions">${button("dsh-cs-secondaryButton", "Discard", true)}${button("dsh-cs-primaryButton", "Save", true)}</div>
    </div>
  </section>
</section>`;
  return page({ theme, demo: DEMO }) + body + "</body></html>";
}
