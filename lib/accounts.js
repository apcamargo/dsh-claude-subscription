/**
 * The account view: which provider routes exist, what each is called in the
 * model picker, and the display mirror the Models-page card reads. Pure
 * functions over the credential records (lib/credentials.js) and the live
 * config, so the route table is unit-testable.
 *
 * An account exists only while its credential record exists, and every route is
 * an account: a stored record (grant, API key, or unreadable one) is the only
 * thing that registers a provider. A session or default model still naming a
 * removed route therefore fails with `NO_ADAPTER` until the user picks another.
 *
 * @module @apcamargo/dsh-claude-subscription/accounts
 */

/** The picker heading of a route whose plan is unknown (or that has no account yet). */
const UNKNOWN_PLAN_TITLE = "Claude subscription";

/**
 * The picker heading base of one account: its plan ("Claude Ultra"), or a
 * neutral name while the plan is unknown. Never a guess.
 * @param {string | undefined} plan
 * @returns {string}
 */
export function providerTitle(plan) {
  return typeof plan === "string" && plan.length > 0 ? `Claude ${plan}` : UNKNOWN_PLAN_TITLE;
}

/** The picker heading of an API-key account: billed as API credits, so say it. */
const API_KEY_NAME = "Claude (API key)";

/** The longest email the picker heading carries before it is ellipsized (the menu is width-capped). */
const MAX_LABEL = 32;

/**
 * Unwrap one config field: schemastery wraps `.volatile()` fields in a live
 * reference with `.get()`, while tests and non-volatile compositions pass the
 * plain value.
 * @param {unknown} field
 * @returns {unknown}
 */
export function liveValue(field) {
  return typeof field?.get === "function" ? field.get() : field;
}

/**
 * The editable model list of one route, from `accounts.models.<route>`.
 * @param {object} config - the live plugin config.
 * @param {string} route
 * @returns {object[] | undefined}
 */
export function modelsOfRoute(config, route) {
  const models = liveValue(config?.accounts)?.models;
  return Array.isArray(models?.[route]) ? models[route] : undefined;
}

/**
 * One route's account reading from `catalog.accounts.<route>`.
 * @param {object} config - the live plugin config.
 * @param {string} route
 * @returns {{ fetchedAt?: number, etag?: string | null, models?: object[] } | undefined}
 */
export function catalogOfRoute(config, route) {
  const snapshot = liveValue(config?.catalog)?.accounts?.[route];
  return snapshot !== null && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? snapshot
    : undefined;
}

/** The shared published reading from `catalog.published`. */
export function publishedCatalogOf(config) {
  const snapshot = liveValue(config?.catalog)?.published;
  return snapshot !== null && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? snapshot
    : undefined;
}

function truncate(value) {
  return value.length > MAX_LABEL ? `${value.slice(0, MAX_LABEL - 1)}…` : value;
}

/** The short, stable tail of a route id for labels that have no email. */
function shortRoute(route) {
  return route.slice(-6);
}

/**
 * One registered route's state.
 * @typedef {object} RouteEntry
 * @property {string} route
 * @property {"account"} kind
 * @property {string} name - the picker group heading.
 * @property {string} [email]
 * @property {string} [orgName]
 * @property {string} [plan]
 * @property {"signedIn" | "needsReauth" | "apiKey"} [status]
 * @property {number} [addedAt]
 * @property {number} others - how many other signed-in accounts exist.
 */

/**
 * The route table: every route that must be registered, with its picker
 * heading. Deterministic order (sign-in order, then route id) so the registry's
 * listing is stable. No record means no route.
 * @param {object} input
 * @param {import("./credentials.js").AccountEntry[]} input.accounts - the stored records.
 * @returns {RouteEntry[]}
 */
export function buildRouteTable({ accounts }) {
  const entries = [];
  // The email joins the heading only once another signed-in account exists.
  const several = accounts.length > 1;
  const grants = accounts.filter((account) => account.kind === "grant");
  const emailCount = new Map();
  for (const account of grants) {
    const email = account.email?.toLowerCase();
    if (email !== undefined) emailCount.set(email, (emailCount.get(email) ?? 0) + 1);
  }

  for (const account of accounts) {
    const email = account.email;
    const orgName = account.orgName;
    const plan = account.plan;
    let name;
    let status;
    if (account.kind === "api-key") {
      name = API_KEY_NAME;
      status = "apiKey";
    } else {
      // Two accounts under one email (a personal plan and a Team seat) are
      // told apart by their organization, else by the route's tail.
      const shared = email !== undefined && (emailCount.get(email.toLowerCase()) ?? 0) > 1;
      const label = email ?? `account ${shortRoute(account.route)}`;
      const suffix = shared ? `, ${orgName ?? shortRoute(account.route)}` : "";
      name =
        several || shared
          ? `${providerTitle(plan)} (${truncate(label)}${suffix})`
          : providerTitle(plan);
      status = account.needsReauth ? "needsReauth" : "signedIn";
    }
    entries.push({
      route: account.route,
      kind: "account",
      name,
      email,
      orgName,
      plan,
      status,
      addedAt: account.addedAt,
      others: accounts.length - 1,
    });
  }

  return entries.sort(
    (a, b) =>
      (a.addedAt ?? 0) - (b.addedAt ?? 0) || (a.route < b.route ? -1 : a.route > b.route ? 1 : 0),
  );
}

/**
 * The display mirror the browser card reads (`accounts.mirror`): rewritten
 * wholesale on every change, explicit nulls so no key of an older value
 * lingers through the settings merge, never carrying user edits.
 * @param {RouteEntry[]} table
 * @returns {{ accounts: object[] }}
 */
export function buildMirror(table) {
  const row = (entry) => ({
    route: entry.route,
    email: entry.email ?? null,
    orgName: entry.orgName ?? null,
    plan: entry.plan ?? null,
  });
  return {
    accounts: table
      .filter((entry) => entry.kind === "account")
      .map((entry) => ({ ...row(entry), status: entry.status, addedAt: entry.addedAt ?? null })),
  };
}

/**
 * Whether two JSON values are equal regardless of object key order. The change
 * gate of every host write into the settings document.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function jsonEqual(a, b) {
  const canon = (value) =>
    Array.isArray(value)
      ? value.map(canon)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, canon(value[key])]),
          )
        : value;
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}
