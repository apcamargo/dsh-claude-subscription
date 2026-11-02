/**
 * The subscription plan of one account ("Pro", "Max", "Ultra", "Team", ...),
 * read from `/api/oauth/profile`. Fetched at sign-in (lib/oauth.js stores it on
 * the grant so the picker can name it at registration), refreshed once per mount
 * (lib/index.js), and kept current by the usage engine (lib/usage.js). Never on
 * the token-refresh path, which runs while a model request waits.
 *
 * The plan is the endpoint's own words (`organization.plan_display_name` when
 * present, else `organization_type` / `rate_limit_tier`), so a plan Anthropic
 * adds later is shown as reported.
 *
 * @module @apcamargo/dsh-claude-subscription/plan
 */

import { coworkUserAgent } from "./fingerprint.js";

export const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const PROFILE_BETA = "oauth-2025-04-20";
const PROFILE_TIMEOUT_MS = 10_000;

/** Display-casing for snake_case words ("seven_day_oberon" -> "Seven Day Oberon"). */
export function words(text) {
  return text
    .split("_")
    .map((word) => (word === "oauth" ? "OAuth" : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

/** Tier tokens recognized in `rate_limit_tier` when `organization_type` names no plan. */
const TIER_PLANS = ["ultra", "max", "pro", "team", "enterprise", "free"];

/**
 * The plan display name from one profile payload ("Ultra", "Max", "Pro"), or
 * undefined when the payload names no plan. The server's
 * `organization.plan_display_name` wins when present: it is the only field that
 * names Ultra (claude-code 2.1.316 reads it from this same endpoint). Otherwise
 * the plan comes from `organization_type` / `rate_limit_tier`.
 *
 * @param {unknown} profile - the parsed `/api/oauth/profile` payload.
 * @returns {string | undefined}
 */
export function planOf(profile) {
  const organization =
    typeof profile === "object" && profile !== null && !Array.isArray(profile)
      ? profile.organization
      : undefined;
  const orgType =
    typeof organization?.organization_type === "string" ? organization.organization_type : "";
  const tier =
    typeof organization?.rate_limit_tier === "string" ? organization.rate_limit_tier : "";
  const display =
    typeof organization?.plan_display_name === "string"
      ? organization.plan_display_name.trim()
      : "";
  if (display) return display;
  const type =
    orgType.replace(/^claude_/, "") || TIER_PLANS.find((plan) => tier.split("_").includes(plan));
  if (!type) return undefined;
  return words(type);
}

/**
 * Best-effort plan lookup through an access token. Never throws: the plan is
 * cosmetic, so any failure (offline, non-2xx, unreadable body) is "unknown".
 * @param {string} accessToken
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] - injectable for tests.
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<string | undefined>}
 */
export async function fetchPlanName(accessToken, { fetchImpl, signal } = {}) {
  try {
    const timeout = AbortSignal.timeout(PROFILE_TIMEOUT_MS);
    const response = await (fetchImpl ?? fetch)(PROFILE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": PROFILE_BETA,
        "User-Agent": coworkUserAgent,
        Accept: "application/json",
      },
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
    return response.ok ? planOf(await response.json()) : undefined;
  } catch {
    return undefined;
  }
}
