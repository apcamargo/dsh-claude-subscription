/**
 * The Models-page editor's pure logic: row normalization and the
 * settings-mutate operations that persist an edit, plus the cross-half
 * constants host and browser must spell identically (the command-text contract
 * and the account-route id pattern). Free of React and of the ModuleLoader
 * wrapper, so it is unit-testable under plain Node.
 *
 * @module @apcamargo/dsh-claude-subscription/client-models
 */

/** The prefix every account route (and credential id) carries. The ONE
 * definition: the host re-exports it (lib/credentials.js) and the browser
 * bundle inlines it, so neither side can drift. An account's route is this
 * prefix plus 12 hex of its identity hash (lib/credentials.js `hashRoute`). */
export const ACCOUNT_ROUTE_PREFIX = "claude-subscription";

/** The discovery-provider prefix the card uses to name one account's catalog.
 * The host answers `catalog:<route>` with that route's available models (never
 * the saved list, which would empty the add picker). A `#<marker>` after the
 * route is the host's cue to act. */
export const CATALOG_PREFIX = "catalog:";
/** The marker asking the host to fetch that account's catalog again. */
export const CATALOG_REFRESH_SUFFIX = "refresh";

/** Whether a string is a route this plugin serves an account on: the prefix plus
 * its 12-hex identity-hash (or random) tail. Exactly one route shape; the bare
 * prefix is not an account route. The browser indicator keys its cache and
 * visibility on this and the host decides what is a credential record with it,
 * so a changed route-id shape cannot silently hide a surface on one side only.
 *
 * Deliberately no module-level RegExp: scripts/build-client.mjs inlines values
 * with JSON.stringify, which would turn a RegExp into `{}`.
 * @param {string} route
 * @returns {boolean}
 */
export function isAccountRoute(route) {
  return (
    typeof route === "string" && new RegExp(`^${ACCOUNT_ROUTE_PREFIX}-[0-9a-f]{12}$`).test(route)
  );
}

/** The settings namespace this plugin's Models-page card edits. Must equal the
 * namespace the host resolves in lib/index.js (`settingsNs`, keyed by the
 * cordis.patch.yml entry id, same fallback): a drift makes every describe/mutate
 * from this card miss the plugin's document (the write fails with
 * `No configurable plugin entry "…"`). The host warns on a mismatch. */
export const SETTINGS_NS = "claude-subscription";

/** The settings path of one account's editable model list:
 * `accounts.models.<route>`. The host never writes it and the card never writes
 * the host-owned `accounts.mirror`, so a card Save can never clobber host state
 * or the reverse. @param {string} route @returns {string[]} */
export function modelsPathFor(route) {
  return ["accounts", "models", route];
}

/** Normalize one configured row to exactly the fields the config schema
 * declares, dropping empties so the entry inherits the catalog values.
 * @param {object} row
 * @returns {object | undefined} the normalized row, or undefined when unusable.
 */
export function normalizeRow(row) {
  if (typeof row?.id !== "string" || row.id.trim().length === 0) return undefined;
  const out = { id: row.id.trim() };
  if (typeof row.name === "string" && row.name.trim().length > 0) out.name = row.name.trim();
  for (const field of ["contextWindow", "maxTokens"]) {
    const value = Number(row[field]);
    if (Number.isInteger(value) && value > 0) out[field] = value;
  }
  if (Array.isArray(row.input) && row.input.length > 0) {
    const modalities = row.input.filter((m) => m === "text" || m === "image");
    if (modalities.length > 0) out.input = modalities;
  }
  return out;
}

/** The add picker's option ids: the catalog entries the list does not carry
 * yet, in catalog order. The plugin serves only what the catalog reading lists,
 * so an outside id is not offered, and a listed one is not an option either.
 * Empty/absent/duplicate catalog entries are skipped, never rendered blank.
 * @param {string[] | null | undefined} catalogIds
 * @param {{ id?: string }[] | null | undefined} rows
 * @returns {string[]}
 */
export function availableModelIds(catalogIds, rows) {
  const taken = new Set((rows ?? []).map((row) => row?.id).filter((id) => typeof id === "string"));
  const out = [];
  for (const id of catalogIds ?? []) {
    if (typeof id !== "string" || id.length === 0 || taken.has(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/**
 * The settings-mutate operation that persists one account's list value.
 * @param {object[]} rows
 * @param {string} route - the account.
 * @returns {{ op: "set", path: string[], value: object[] }}
 */
export function setModelsOp(rows, route) {
  const normalized = rows.map(normalizeRow).filter(Boolean);
  return { op: "set", path: modelsPathFor(route), value: normalized };
}

/**
 * The settings-mutate operation that restores an account's full available catalog.
 * @param {string} route - the account.
 * @returns {{ op: "unset", path: string[] }}
 */
export function unsetModelsOp(route) {
  return { op: "unset", path: modelsPathFor(route) };
}

/** @param {unknown} value @returns {value is string} */
export function nonEmpty(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * Normalize the host-maintained account mirror (lib/accounts.js writes it
 * wholesale) into the rows the card renders, dropping anything malformed: a
 * shape this build does not know renders as absent, never as a crash.
 * @param {unknown} raw
 * @returns {{ accounts: { route: string, email?: string, orgName?: string, plan?: string, status: string }[] }}
 */
export function readMirror(raw) {
  const readRow = (entry) => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      typeof entry.route !== "string" ||
      entry.route.length === 0
    )
      return undefined;
    return {
      route: entry.route,
      ...(nonEmpty(entry.email) ? { email: entry.email } : {}),
      ...(nonEmpty(entry.orgName) ? { orgName: entry.orgName } : {}),
      ...(nonEmpty(entry.plan) ? { plan: entry.plan } : {}),
      ...(nonEmpty(entry.status) ? { status: entry.status } : {}),
    };
  };
  // Only accounts are mirrored; unknown extra fields are ignored.
  return {
    accounts: Array.isArray(raw?.accounts) ? raw.accounts.map(readRow).filter(Boolean) : [],
  };
}

/** @param {unknown} raw @returns {Record<string, object[]>} */
export function readModelLists(raw) {
  const lists = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return lists;
  for (const [route, rows] of Object.entries(raw)) if (Array.isArray(rows)) lists[route] = rows;
  return lists;
}

/**
 * One catalog snapshot as the card uses it: the timestamp and the model ids.
 * Shape-validated here because the host stores it as `Schema.any()`.
 * @param {unknown} raw
 * @returns {{ fetchedAt?: number, version?: number, models: { id: string, name?: string }[] } | undefined}
 */
export function readCatalogSnapshot(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const models = Array.isArray(raw.models)
    ? raw.models
        .filter(
          (entry) =>
            entry !== null &&
            typeof entry === "object" &&
            typeof entry.id === "string" &&
            entry.id.length > 0,
        )
        .map((entry) => ({
          id: entry.id,
          ...(typeof entry.name === "string" ? { name: entry.name } : {}),
        }))
    : [];
  return {
    ...(Number.isFinite(raw.fetchedAt) ? { fetchedAt: raw.fetchedAt } : {}),
    ...(Number.isFinite(raw.version) ? { version: raw.version } : {}),
    models,
  };
}

/** The `catalog` section projected for the card: per route, plus the shared published one. */
export function readCatalog(raw) {
  const accounts = {};
  const source = raw?.accounts;
  if (source !== null && typeof source === "object" && !Array.isArray(source)) {
    for (const [route, snapshot] of Object.entries(source)) {
      const parsed = readCatalogSnapshot(snapshot);
      if (parsed !== undefined) accounts[route] = parsed;
    }
  }
  const published = readCatalogSnapshot(raw?.published);
  return { accounts, ...(published === undefined ? {} : { published }) };
}

/**
 * Read the whole per-account view from one settings describe view: every
 * account's mirror row and editable list, the usage snapshots the composer
 * indicator pulls, and the one-shot quota marker the quota modal reads.
 * @param {{ ns: string, revision?: number, value?: object }[]} descriptors
 * @returns {{ revision: number | undefined,
 *   mirror: ReturnType<readMirror>, models: Record<string, object[]>, snapshots: Record<string, unknown>, lastQuotaFailure: unknown, catalog: ReturnType<readCatalog> }}
 */
export function readAccounts(descriptors) {
  const view = descriptors?.find?.((descriptor) => descriptor.ns === SETTINGS_NS);
  const value = view?.value ?? {};
  return {
    revision: view?.revision,
    mirror: readMirror(value.accounts?.mirror),
    models: readModelLists(value.accounts?.models),
    snapshots:
      value.usage?.snapshots !== null &&
      typeof value.usage?.snapshots === "object" &&
      !Array.isArray(value.usage?.snapshots)
        ? value.usage.snapshots
        : {},
    lastQuotaFailure: value.usage?.lastQuotaFailure ?? null,
    catalog: readCatalog(value.catalog),
  };
}

/** The volatile settings path of the one-shot quota marker, spelled once for
 * both halves: lib/index.js sets it, lib/client-app.js consumes it.
 * @type {string[]} */
export const QUOTA_MARKER_PATH = ["usage", "lastQuotaFailure"];

/**
 * The settings-mutate operation that records the quota marker.
 * @param {{ route: string, at: number }} marker
 * @returns {{ op: "set", path: string[], value: { route: string, at: number } }}
 */
export function setQuotaMarkerOp(marker) {
  return { op: "set", path: QUOTA_MARKER_PATH, value: marker };
}

/**
 * The settings-mutate operation that consumes the quota marker.
 * @returns {{ op: "unset", path: string[] }}
 */
export function unsetQuotaMarkerOp() {
  return { op: "unset", path: QUOTA_MARKER_PATH };
}

/** Do not reuse old markers after a reload; the notice has a tighter age check.
 * @type {number} */
export const QUOTA_MARKER_FRESH_MS = 15 * 60_000;

/** How far into the future a marker's stamp may sit (clock skew, a hostile
 * write). @type {number} */
export const QUOTA_MARKER_SKEW_MS = 5_000;

/**
 * Accept only a recent marker for a signed-in account. Ignore malformed
 * markers, bad timestamps, and routes that are unknown or no longer signed in.
 * @param {unknown} raw - the stored marker.
 * @param {{ route: string, email?: string, status?: string }[]} accounts - the mirror rows.
 * @param {number} now - the decision instant.
 * @returns {{ route: string, at: number, email?: string, others: boolean } | undefined}
 */
export function readQuotaMarker(raw, accounts, now) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  if (typeof raw.route !== "string" || raw.route.length === 0) return undefined;
  if (
    !Number.isFinite(raw.at) ||
    raw.at > now + QUOTA_MARKER_SKEW_MS ||
    now - raw.at > QUOTA_MARKER_FRESH_MS
  )
    return undefined;
  if (!Array.isArray(accounts)) return undefined;
  const row = accounts.find(
    (entry) => entry !== null && typeof entry === "object" && entry.route === raw.route,
  );
  if (row === undefined || row.status !== "signedIn") return undefined;
  const signedIn = accounts.filter((entry) => entry?.status === "signedIn").length;
  return {
    route: raw.route,
    at: raw.at,
    ...(nonEmpty(row.email) ? { email: row.email } : {}),
    others: signedIn > 1,
  };
}

/**
 * Whether two row lists differ field by field (staged-change detection).
 * @param {object[]} a
 * @param {object[]} b
 * @returns {boolean}
 */
export function rowsDiffer(a, b) {
  const left = JSON.stringify(a?.map(normalizeRow));
  const right = JSON.stringify(b?.map(normalizeRow));
  return left !== right;
}

// ---- the command text contract -----------------------------------------------
//
// The command texts are the browser cards' parse contract, and the host half
// composes them from this same vocabulary: these constants are the single
// spelling of every tag line and `Key: ` row prefix (imported by lib/commands.js
// and lib/usage.js for emission, matched by the parsers below). A label renamed
// on one side only would silently drop a card into its raw-text fallback.
// Plain words, free of regex metacharacters, so parsers compose matchers from them.

export const USAGE_TAG = "Claude usage";
/** The `/claude-account` result's first line. Also the account card's title. */
export const ACCOUNT_TAG = "Claude account";
/** The signed-in account's email row: the header subtitle's identity field. */
export const ACCOUNT_PREFIX = "Account: ";
/** The plan-name row: the header subtitle's plan field (lib/usage.js emits it). */
export const PLAN_PREFIX = "Plan: ";
export const AUTH_PREFIX = "Auth: ";
export const ORGANIZATION_PREFIX = "Organization: ";
export const TOKEN_PREFIX = "OAuth token: ";
export const NOTE_PREFIX = "Note: ";
export const OBSERVED_PREFIX = "Observed: ";
/** The usage text's empty-data line (rendered as the panel's note). */
export const NO_USAGE_DATA = "No Claude usage data available.";
/** The account-route row: keys the composer indicator's per-account cache. */
export const ROUTE_PREFIX = "Route: ";

/** The window labels that cross modules: lib/usage.js renders them, the
 * parsers match the extra-usage row, the composer indicator keys its band on
 * the 5-hour family. Renaming one side only would silently lose the row/band. */
export const EXTRA_LABEL = "Extra usage";
export const FIVE_HOUR_LABEL = "5-hour";

/** Keep this hint shared by the failure message and modal, and free of words
 * that would change error classification. */
export const OTHER_ACCOUNTS_HINT =
  "Other signed-in accounts have separate allowances. Try selecting a model from one of them.";

/** Parse the `/claude-usage` result text into card data. The format is this
 * plugin's own (lib/commands.js emits it, lib/usage.js renders the window
 * lines), versioned with the plugin: guidance reads as a `Note:` line, the
 * trailing `Observed:` line carries the run's ISO timestamp for the composer
 * pie's cache ordering, an `Account:` line the account's email for the card
 * header's "email · plan" subtitle. Every matcher composes from the shared
 * contract prefixes, so emitters and parser cannot drift. Anything unexpected
 * returns undefined so the card falls back to the raw text.
 * @param {string} text - the command result's `outcome.text`.
 * @returns {{ plan?: string, account?: string, route?: string, windows: { label: string, percent: number, reset?: string }[],
 *   extra?: string, note?: string, observed?: string } | undefined}
 */
export function parseUsageText(text) {
  if (typeof text !== "string" || text.split("\n")[0] !== USAGE_TAG) return undefined;
  const planLine = new RegExp(`^${PLAN_PREFIX}(.+)$`);
  const accountLine = new RegExp(`^${ACCOUNT_PREFIX}(.+)$`);
  const extraLine = new RegExp(`^${EXTRA_LABEL}: (.+)$`);
  const noteLine = new RegExp(`^${NOTE_PREFIX}(.+)$`);
  const routeLine = new RegExp(`^${ROUTE_PREFIX}(.+)$`);
  const observedLine = new RegExp(`^${OBSERVED_PREFIX}(\\S+)$`);
  let plan;
  let account;
  let route;
  const windows = [];
  let extra;
  let note;
  let observed;
  for (const line of text.split("\n").slice(1)) {
    if (line === "") continue;
    const planMatch = planLine.exec(line);
    if (planMatch !== null) {
      plan = planMatch[1];
      continue;
    }
    const accountMatch = accountLine.exec(line);
    if (accountMatch !== null) {
      account = accountMatch[1];
      continue;
    }
    const routeMatch = routeLine.exec(line);
    if (routeMatch !== null) {
      route = routeMatch[1];
      continue;
    }
    const windowMatch =
      /^(.+?):\s+\[[^\]]*\] (-?(?:\d+\.?\d*|\.\d+))% used(?: · (resets .*))?$/.exec(line);
    if (windowMatch !== null) {
      windows.push({
        label: windowMatch[1].trim(),
        percent: Number(windowMatch[2]),
        reset: windowMatch[3],
      });
      continue;
    }
    const extraMatch = extraLine.exec(line);
    if (extraMatch !== null) {
      // Padding to the shared label column is layout, not content.
      extra = extraMatch[1].trim();
      continue;
    }
    const noteMatch = noteLine.exec(line);
    if (noteMatch !== null) {
      note = noteMatch[1];
      continue;
    }
    if (line === NO_USAGE_DATA) {
      note = line;
      continue;
    }
    const observedMatch = observedLine.exec(line);
    if (observedMatch !== null) {
      observed = observedMatch[1];
      continue;
    }
    return undefined;
  }
  if (plan === undefined && windows.length === 0 && extra === undefined && note === undefined)
    return undefined;
  return { plan, account, route, windows, extra, note, observed };
}

/** Split the meter's percentage from the extra-usage details. If there is no
 * bar, the whole string is the detail.
 * @param {unknown} extra
 * @returns {{ percent?: number, detail: string } | undefined}
 */
export function splitExtra(extra) {
  if (typeof extra !== "string" || extra.length === 0) return undefined;
  // The command text pads values to the label column; the padding is layout.
  const match =
    /^\s*\[[^\]]*\]\s+(-?(?:\d+\.?\d*|\.\d+))% used(?:\s*·\s*(.*?))?\s*$/.exec(extra);
  if (match === null) return { detail: extra };
  return { percent: Number(match[1]), detail: match[2] ?? "" };
}

/** Parse the `/claude-account` result text into card data. Same grammar as
 * `/claude-usage`'s (lib/commands.js emits it): a leading tag line, `Key: value`
 * rows, guidance as a `Note:` line. The `Auth:` row names the credential path
 * and is the card header's fallback when neither identity nor plan is known.
 * Other rows are simply absent when unknown. Anything unexpected returns
 * undefined so the card falls back to the raw text.
 * @param {string} text - the command result's `outcome.text`.
 * @returns {{ auth?: string, account?: string, organization?: string,
 *   plan?: string, route?: string, tokenExpires?: string, note?: string } | undefined}
 */
export function parseAccountText(text) {
  if (typeof text !== "string" || text.split("\n")[0] !== ACCOUNT_TAG) return undefined;
  const authLine = new RegExp(`^${AUTH_PREFIX}(.+)$`);
  const accountLine = new RegExp(`^${ACCOUNT_PREFIX}(.+)$`);
  const organizationLine = new RegExp(`^${ORGANIZATION_PREFIX}(.+)$`);
  const planLine = new RegExp(`^${PLAN_PREFIX}(.+)$`);
  const routeLine = new RegExp(`^${ROUTE_PREFIX}(.+)$`);
  const expiresLine = new RegExp(`^${TOKEN_PREFIX}(.+)$`);
  const noteLine = new RegExp(`^${NOTE_PREFIX}(.+)$`);
  let auth;
  let account;
  let organization;
  let plan;
  let route;
  let tokenExpires;
  let note;
  for (const line of text.split("\n").slice(1)) {
    if (line === "") continue;
    const authMatch = authLine.exec(line);
    if (authMatch !== null) {
      auth = authMatch[1];
      continue;
    }
    const accountMatch = accountLine.exec(line);
    if (accountMatch !== null) {
      account = accountMatch[1];
      continue;
    }
    const organizationMatch = organizationLine.exec(line);
    if (organizationMatch !== null) {
      organization = organizationMatch[1];
      continue;
    }
    const planMatch = planLine.exec(line);
    if (planMatch !== null) {
      plan = planMatch[1];
      continue;
    }
    const routeMatch = routeLine.exec(line);
    if (routeMatch !== null) {
      route = routeMatch[1];
      continue;
    }
    const expiresMatch = expiresLine.exec(line);
    if (expiresMatch !== null) {
      tokenExpires = expiresMatch[1];
      continue;
    }
    const noteMatch = noteLine.exec(line);
    if (noteMatch !== null) {
      note = noteMatch[1];
      continue;
    }
    return undefined;
  }
  if (auth === undefined && note === undefined) return undefined;
  return { auth, account, organization, plan, route, tokenExpires, note };
}

/** Normalize one host-published usage snapshot (the volatile `usage.snapshots`
 * section lib/usage.js's engine writes) into the composer indicator's cache
 * shape, or undefined when absent/not a real snapshot. A parsed-but-never-
 * published section reads as an empty object, so a finite `observedAt` is the
 * gate. The host's explicit nulls read as absent.
 * @param {unknown} usage - the stored snapshot value from a describe view.
 * @returns {{ observedAt: number, plan?: string, windows: { label: string, percent: number, resetsAt?: number }[], extra?: string } | undefined}
 */
export function normalizeUsageView(usage) {
  if (usage === null || typeof usage !== "object" || !Number.isFinite(usage.observedAt))
    return undefined;
  if (!Array.isArray(usage.windows)) return undefined;
  const windows = usage.windows
    .filter(
      (window) =>
        window !== null &&
        typeof window === "object" &&
        typeof window.label === "string" &&
        Number.isFinite(window.percent),
    )
    .map((window) => {
      const out = { label: window.label, percent: window.percent };
      if (Number.isFinite(window.resetsAt)) out.resetsAt = window.resetsAt;
      return out;
    });
  return {
    observedAt: usage.observedAt,
    plan: typeof usage.plan === "string" && usage.plan.length > 0 ? usage.plan : undefined,
    windows,
    extra: typeof usage.extra === "string" && usage.extra.length > 0 ? usage.extra : undefined,
  };
}

/** The countdown grammar ("2d 3h", "3h 19m", "45m") shared by lib/usage.js's
 * `formatReset` and the indicator's {@link resetDetail}. The browser bundle
 * inlines this function (it serializes by source); the host imports it. */
export function countdownDuration(remainingMs) {
  const minutes = Math.ceil(remainingMs / 60_000);
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor(minutes / 60) % 24;
  const mins = minutes % 60;
  if (days) return `${days}d${hours ? ` ${hours}h` : ""}`;
  if (hours) return `${hours}h${mins ? ` ${mins}m` : ""}`;
  return `${minutes}m`;
}

/** The relative half of a cached reset stamp ("resets in 3h 19m · at 11:10 AM"
 * → "resets in 3h 19m"): the wall-clock half stripped. One spelling for both the
 * countdown recomputation ({@link resetDetail}) and the usage card's rows; the
 * browser bundle inlines this function.
 * @param {unknown} stamp
 * @returns {string}
 */
export function withoutClock(stamp) {
  return typeof stamp === "string" ? stamp.split(" · at ")[0] : "";
}

/** The live relative countdown for one cached window: "resets in 3h 19m" or
 * "resets now", or "" when unknown. An epoch `resetsAt` (the host-published
 * shape) wins; otherwise the string reset is anchored at the cache's observation
 * time to derive an absolute target, so the countdown keeps ticking between
 * fetches instead of freezing on the stored text. Separate bundles, so the
 * client cannot import it.
 * @param {{ label?: string, percent?: number, resetsAt?: number, reset?: string } | null | undefined} window
 *   one cached window (either cache shape).
 * @param {number | undefined} observedAt - when the cached data was observed.
 * @param {number} now
 * @returns {string}
 */
export function resetDetail(window, observedAt, now) {
  if (window === null || typeof window !== "object") return "";
  if (Number.isFinite(window.resetsAt)) {
    return window.resetsAt <= now
      ? "resets now"
      : `resets in ${countdownDuration(window.resetsAt - now)}`;
  }
  const relative = withoutClock(window.reset);
  if (relative === "" || relative === "resets now") return relative;
  const match = /^resets in ((\d+)d)? ?((\d+)h)? ?((\d+)m)?$/.exec(relative);
  if (
    match === null ||
    (match[2] === undefined && match[4] === undefined && match[6] === undefined)
  )
    return relative;
  if (!Number.isFinite(observedAt)) return relative;
  const minutes = (Number(match[2] ?? 0) * 24 + Number(match[4] ?? 0)) * 60 + Number(match[6] ?? 0);
  const target = observedAt + minutes * 60_000;
  return target <= now ? "resets now" : `resets in ${countdownDuration(target - now)}`;
}

/** The shared `useAnchoredPosition` primitive's `align` for a trigger-anchored
 * panel: "end" hangs it off the button's right edge (opening leftward), "start"
 * off its left edge (rightward). Left wins ties and when the right side runs out
 * of window first (the indicator sits left of the model seat); when neither side
 * fits, the roomier side keeps the panel hugging the button under the primitive's
 * viewport clamp.
 * @param {{ anchorLeft: number, anchorRight: number, width: number, viewportWidth: number, margin?: number }} geometry
 *   the button's box edges, the panel's rendered width, the window's inner width,
 *   and the clamp margin (the vanilla stat dialog's 12px PANEL_MARGIN).
 * @returns {"end" | "start"} the primitive's align value.
 */
export function popoverAlign({ anchorLeft, anchorRight, width, viewportWidth, margin = 12 }) {
  const leftRoom = anchorRight - margin;
  const rightRoom = viewportWidth - margin - anchorLeft;
  return leftRoom >= width || rightRoom <= leftRoom ? "end" : "start";
}
