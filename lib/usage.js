/**
 * Claude plan-usage queries, rendering, and the composer indicator's host-side
 * engine.
 *
 * Two OAuth endpoints the Messages API does not cover: `/api/oauth/usage`
 * (per-window quota utilization, extra usage) and `/api/oauth/profile` (the plan
 * name). Both take the messages bearer token plus the OAuth API beta, with the
 * pinned Cowork user-agent (the credential's identity).
 *
 * Rendering follows upstream (pi-anthropic-oauth 0.3.6) minus its TUI theme.
 * Command output is plain text. `formatUsage` never throws: a malformed payload
 * renders its readable fragments. `usageSnapshot` shapes the same payload for the
 * composer indicator, and `createUsageEngine` publishes it into the volatile
 * `usage` settings section (see lib/index.js).
 *
 * @module @apcamargo/dsh-claude-subscription/usage
 */

import { coworkUserAgent } from "./fingerprint.js";
import { EXTRA_LABEL, FIVE_HOUR_LABEL, PLAN_PREFIX, countdownDuration } from "./client-models.js";
import { isOAuthToken } from "./wire.js";
import { PROFILE_URL, planOf, words } from "./plan.js";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
/** The OAuth API beta gates the usage/profile endpoints (see lib/oauth.js). */
const USAGE_BETA = "oauth-2025-04-20";
const TIMEOUT_MS = 10_000;

/**
 * The headers the plan endpoints expect.
 * @param {string} apiKey - the stored OAuth access token.
 * @returns {Record<string, string>}
 */
export function usageHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "anthropic-beta": USAGE_BETA,
    "User-Agent": coworkUserAgent,
    Accept: "application/json",
  };
}

/** The caller's signal composed with this command's own 10s budget. */
function requestSignal(signal) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Flat-key label. `undefined` for keys that are not usage windows. */
function usageLabel(key) {
  if (key === "five_hour") return FIVE_HOUR_LABEL;
  if (key === "seven_day") return "Weekly";
  if (key === "iguana_necktie") return "Weekly (Fable only)";
  if (key.startsWith("seven_day_")) return `Weekly (${words(key.slice("seven_day_".length))} only)`;
  return undefined;
}

/** A 20-cell bar. The bar clamps but the reported percent does not. */
function formatPercent(percent) {
  const width = 20;
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  return `[${bar}] ${Math.round(percent * 10) / 10}% used`;
}

/**
 * " · resets in 2d 3h"-style suffix. "" when absent or unparseable.
 */
function formatReset(resetsAt, now) {
  if (typeof resetsAt !== "string" || !resetsAt) return "";
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at)) return "";
  if (at <= now) return " · resets now";
  return ` · resets in ${countdownDuration(at - now)}`;
}

/** 5-hour, Weekly, scoped weeklies, everything else, Extra usage last. */
function rowRank(label) {
  if (label === FIVE_HOUR_LABEL || label.startsWith(`${FIVE_HOUR_LABEL} (`)) return 0;
  if (label === "Weekly") return 1;
  if (label.startsWith("Weekly (")) return 2;
  if (label === EXTRA_LABEL) return 4;
  return 3;
}

/**
 * Fetch the plan-usage payload. Throws plain `Error`s; the command's guarded
 * wrapper reports them verbatim.
 * @param {Record<string, string>} headers - from {@link usageHeaders}.
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] - injectable for tests.
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function fetchUsage(headers, { fetchImpl, signal } = {}) {
  let response;
  try {
    response = await (fetchImpl ?? fetch)(USAGE_URL, { headers, signal: requestSignal(signal) });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new Error(
      timedOut
        ? "Anthropic usage request timed out."
        : "Could not reach Anthropic usage API. Check your connection.",
    );
  }
  if (!response.ok) {
    const hint =
      response.status === 401 || response.status === 403 ? " Try /claude-login again." : "";
    // The status rides on the error so the engine can tell an account whose
    // token the endpoint refuses (it needs a fresh sign-in) from an outage.
    throw Object.assign(
      new Error(`Anthropic usage request failed (HTTP ${response.status}).${hint}`),
      { status: response.status },
    );
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("Could not parse Anthropic usage response.");
  }
  if (!isPlainObject(data)) throw new Error("Invalid Anthropic usage response.");
  return data;
}

/**
 * Fetch the plan name. Cosmetic for the rendering, so failures degrade to an
 * "unavailable" line rather than masking the usage data with an error.
 * @param {Record<string, string>} headers
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] - injectable for tests.
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<string>}
 */
export async function fetchPlan(headers, { fetchImpl, signal } = {}) {
  try {
    const response = await (fetchImpl ?? fetch)(PROFILE_URL, {
      headers,
      signal: requestSignal(signal),
    });
    if (!response.ok) return `${PLAN_PREFIX}unavailable (HTTP ${response.status})`;
    const name = planOf(await response.json());
    return `${PLAN_PREFIX}${name ?? "unavailable (no plan details returned)"}`;
  } catch {
    // Profile failures must not hide usage. Don't expose profile payloads.
    return `${PLAN_PREFIX}unavailable (could not fetch profile)`;
  }
}

/**
 * The quota windows of one usage payload, rank-ordered. The wire payload's
 * `limits[]` are collected first, so the flat keys dedupe against them (first
 * writer wins). Each window keeps the wire's ISO `resets_at` verbatim. The shared
 * core of {@link formatUsage} and {@link usageSnapshot}.
 * @param {unknown} usage - the parsed `/api/oauth/usage` payload.
 * @returns {{ label: string, percent: number, resetsAt: string | undefined }[]}
 */
export function collectWindows(usage) {
  const collected = [];
  const addWindow = (label, percent, resetsAt) => {
    if (
      typeof percent !== "number" ||
      !Number.isFinite(percent) ||
      collected.some((window) => window.label === label)
    )
      return;
    collected.push({
      label,
      percent,
      resetsAt: typeof resetsAt === "string" && resetsAt ? resetsAt : undefined,
    });
  };

  if (Array.isArray(usage.limits)) {
    for (const entry of usage.limits) {
      if (!isPlainObject(entry)) continue;
      const kind = typeof entry.kind === "string" ? entry.kind : "";
      const group = typeof entry.group === "string" ? entry.group : "";
      const name = entry.scope?.model?.display_name;
      const model = typeof name === "string" ? name : "";
      const surface = typeof entry.scope?.surface === "string" ? entry.scope.surface : "";
      const scopes = [];
      if (model) scopes.push(`${model} only`);
      else if (kind === "weekly_scoped") scopes.push("model only");
      if (surface) scopes.push(words(surface));
      const scope = scopes.join(" · ");
      let base = words(kind || group || "quota");
      if (kind === "session") base = FIVE_HOUR_LABEL;
      else if (group === "weekly" || kind.startsWith("weekly")) base = "Weekly";
      const value = entry.percent ?? entry.utilization;
      // A scoped weekly with no value reads as unused, not missing.
      const percent = value == null && model && kind === "weekly_scoped" ? 0 : value;
      addWindow(scope ? `${base} (${scope})` : base, percent, entry.resets_at);
    }
  }

  for (const [key, value] of Object.entries(usage)) {
    const label = usageLabel(key);
    if (!label || !isPlainObject(value)) continue;
    addWindow(label, value.utilization, value.resets_at);
  }

  return collected.sort((a, b) => rowRank(a.label) - rowRank(b.label));
}

/**
 * The extra-usage credit pool's detail string ("8% used · enabled · spent 2.50
 * USD · monthly cap 10.00 USD"), or undefined when the payload names no pool. A
 * pool that is switched off and has spent nothing is undefined too: "disabled"
 * is a setting, not a reading, so an account that never opted in carries no row on
 * the command card or in the composer popover rather than a permanent line saying
 * nothing. Money that already landed still reports, so turning the pool off can
 * never hide a charge. The shared core of {@link formatUsage} and
 * {@link usageSnapshot}.
 * @param {unknown} extra - the payload's `extra_usage` object.
 * @returns {string | undefined}
 */
export function formatExtra(extra) {
  if (!extra) return undefined;
  const spent =
    typeof extra.used_credits === "number" && Number.isFinite(extra.used_credits)
      ? extra.used_credits
      : 0;
  if (extra.is_enabled === false && spent === 0) return undefined;
  let status = "status unknown";
  if (extra.is_enabled === true) status = "enabled";
  if (extra.is_enabled === false) status = "disabled";
  const details = [];
  if (typeof extra.utilization === "number" && Number.isFinite(extra.utilization)) {
    details.push(formatPercent(extra.utilization));
  }
  details.push(status);
  const currency = typeof extra.currency === "string" ? extra.currency.trim() : "";
  const places =
    typeof extra.decimal_places === "number" &&
    Number.isInteger(extra.decimal_places) &&
    extra.decimal_places >= 0 &&
    extra.decimal_places <= 4
      ? extra.decimal_places
      : 2;
  const money = (minor) => `${(minor / 10 ** places).toFixed(places)} ${currency || "USD"}`;
  if (typeof extra.used_credits === "number" && Number.isFinite(extra.used_credits)) {
    details.push(`spent ${money(extra.used_credits)}`);
  }
  if (typeof extra.monthly_limit === "number" && Number.isFinite(extra.monthly_limit)) {
    // "Cap", not the wire field's "monthly_limit": a ceiling on the
    // extra-usage credit pool, kept distinct from the plan-quota windows.
    details.push(`monthly cap ${money(extra.monthly_limit)}`);
  }
  return details.join(" · ");
}

/**
 * Render the usage payload as aligned plain-text lines, rank-ordered.
 * @param {unknown} usage - the parsed `/api/oauth/usage` payload.
 * @returns {string[]}
 */
export function formatUsage(usage) {
  if (!isPlainObject(usage)) return [];
  const now = Date.now();
  const rows = collectWindows(usage).map(({ label, percent, resetsAt }) => [
    label,
    `${formatPercent(percent)}${formatReset(resetsAt, now)}`,
  ]);
  const extraValue = formatExtra(usage.extra_usage);
  // The extra-usage line wins over a window that happens to carry the same label
  // (the window map's last writer). Build the final list rather than mutating `rows`.
  const finalRows =
    extraValue === undefined
      ? rows
      : [...rows.filter(([label]) => label !== EXTRA_LABEL), [EXTRA_LABEL, extraValue]];
  finalRows.sort(([a], [b]) => rowRank(a) - rowRank(b));
  const labelWidth = Math.max(0, ...finalRows.map(([label]) => label.length));
  return finalRows.map(
    ([label, value]) => `${label}:${" ".repeat(labelWidth - label.length + 1)}${value}`,
  );
}

/**
 * The settings path of one account's plugin-maintained usage snapshot, relative
 * to the plugin's settings namespace. Host-maintained like the account mirror
 * (lib/accounts.js): the browser has no OAuth token, so it cannot fetch usage.
 * The engine writes each account's snapshot under its route and the composer
 * indicator reads the selected model's account back through `settings.describe`.
 * @param {string} route
 * @returns {string[]}
 */
export function usagePath(route) {
  return ["usage", "snapshots", route];
}

/**
 * Shape one fetched usage payload + profile into the snapshot the composer
 * indicator consumes. Full shape with explicit nulls on purpose: the settings
 * document's merge persists keys absent from a new value, so an omitted
 * `plan`/`extra` would let the previous fetch's values linger forever. The client
 * reads null as absent. `resetsAt` becomes epoch milliseconds when the wire's ISO
 * stamp parses, and is omitted otherwise.
 * @param {unknown} usage - the parsed `/api/oauth/usage` payload.
 * @param {unknown} profile - the parsed `/api/oauth/profile` payload.
 * @param {number} now - the fetch's observation time (epoch ms).
 * @returns {{ observedAt: number, plan: string | null, windows: { label: string, percent: number, resetsAt?: number }[], extra: string | null } | undefined}
 */
export function usageSnapshot(usage, profile, now) {
  if (!isPlainObject(usage)) return undefined;
  const plan = planOf(profile);
  return {
    observedAt: now,
    plan: typeof plan === "string" ? plan : null,
    windows: collectWindows(usage).map(({ label, percent, resetsAt }) => {
      const at = typeof resetsAt === "string" ? Date.parse(resetsAt) : Number.NaN;
      const window = { label, percent };
      if (Number.isFinite(at)) window.resetsAt = at;
      return window;
    }),
    extra: formatExtra(usage.extra_usage) ?? null,
  };
}

/**
 * The settings-mutate operation that moves one account's stored usage snapshot to
 * `next`: a set on {@link usagePath}, or undefined when the stored section already
 * carries the same content. The engine writes only on a real change, so a
 * no-news fetch (and a restart's first sync) never bumps the document revision.
 * `observedAt` is excluded from the comparison, because only content moves what
 * the indicator shows (countdowns are recomputed client-side).
 * @param {{ observedAt: number, plan: string | null, windows: unknown[], extra: string | null } | undefined} next
 * @param {unknown} current - the stored snapshot, when one exists.
 * @param {string} route - the account.
 * @returns {{ op: "set", path: string[], value: object } | undefined}
 */
export function usageOp(next, current, route) {
  if (typeof route !== "string" || route.length === 0)
    throw new Error("usageOp needs an account route");
  const stored = current !== null && typeof current === "object";
  const same =
    stored &&
    JSON.stringify([next?.plan ?? null, next?.windows ?? [], next?.extra ?? null]) ===
      JSON.stringify([current.plan ?? null, current.windows ?? [], current.extra ?? null]);
  if (same) return undefined;
  return { op: "set", path: usagePath(route), value: next };
}

/**
 * The parsed profile payload for the snapshot's plan name, or undefined on any
 * failure: the engine's degraded fetchPlan. A profile failure must not hide usage,
 * it only drops the plan line. (fetchPlan keeps the command's distinct failure
 * strings; the snapshot needs the payload itself.)
 * @param {Record<string, string>} headers
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] - injectable for tests.
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<unknown>}
 */
async function fetchProfilePayload(headers, { fetchImpl, signal } = {}) {
  try {
    const response = await (fetchImpl ?? fetch)(PROFILE_URL, {
      headers,
      signal: requestSignal(signal),
    });
    return response.ok ? await response.json() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The host-side engine behind the composer indicator's self-refresh: fetches the
 * plan endpoints through one account's stored subscription credential and
 * publishes each changed snapshot into the plugin's volatile `usage` settings
 * section under that account's route, which reaches every open page through the
 * forwarded `settings/document-updated` event.
 *
 * State is per account: triggers call {@link requestRefresh} with the route the
 * indicator's selected model belongs to, coalesced to at most one fetch per route
 * per min-interval (a trigger during an in-flight fetch or inside the cooldown is
 * dropped; later triggers self-heal). Only routes somebody asks about are ever
 * fetched, so an idle account generates no traffic. Publish failures are retried
 * with a growing delay, because right after mount the settings service does not
 * project this entry yet and the first write is refused ("Plugin entry … is no
 * longer configurable"). Same retry shape as the account mirror.
 *
 * @param {object} deps
 * @param {object} deps.grants - the grant manager (lib/credentials.js).
 * @param {(message: string) => void} [deps.debug] - plugin logger (never credentials).
 * @param {object} [deps.settings] - the settings service. Absent when the harness
 *   runs without one, in which case the engine idle-loops harmlessly.
 * @param {string} [deps.settingsNs] - the plugin's settings namespace.
 * @param {AbortSignal} [deps.signal] - the plugin lifecycle's abort signal.
 * @param {<T>(work: Promise<T>) => Promise<T>} [deps.track] - lifecycle tracking.
 * @param {number} [deps.minIntervalMs] - the per-account fetch floor. Injectable for tests.
 * @param {number} [deps.retryBaseMs] - the publish-retry base delay. Injectable for tests.
 * @param {typeof fetch} [deps.fetchImpl] - injectable for tests.
 * @returns {{ requestRefresh: (route?: string, options?: { immediate?: boolean }) => void, clear: (route: string) => Promise<void>, dispose: () => void }}
 */
export function createUsageEngine({
  grants,
  debug = () => {},
  settings,
  settingsNs,
  signal,
  track = (work) => work,
  minIntervalMs = 30_000,
  retryBaseMs = 1_000,
  fetchImpl,
} = {}) {
  const cooldownMs = Math.max(0, minIntervalMs);
  const retryMs = Math.max(0, retryBaseMs);
  const PUBLISH_RETRY_MAX = 5;
  /** @type {Map<string, { fetching: boolean, timer: ReturnType<typeof setTimeout> | null, lastFinishedAt: number, emptied: boolean, generation: number }>} */
  const routes = new Map();
  const stateOf = (route) => {
    let state = routes.get(route);
    if (state === undefined) {
      state = { fetching: false, timer: null, lastFinishedAt: 0, emptied: false, generation: 0 };
      routes.set(route, state);
    }
    return state;
  };

  /** The snapshot published when the route has no plan quota to show. */
  const emptySnapshot = (now) => ({ observedAt: now, plan: null, windows: [], extra: null });

  /** The stored snapshot of one route, from the host-synchronous describe. */
  const storedSnapshot = (route) =>
    settings.describe().find((row) => row.ns === settingsNs)?.value?.usage?.snapshots?.[route];

  /**
   * Apply one operation, retrying the mount-refusal window. Never rejects: an
   * exhausted retry chain logs and stands down (the timer-spawned attempts have
   * no awaiter to catch).
   * @param {() => object | undefined} makeOp - evaluated per attempt against the then-stored value.
   * @param {number} [attempt]
   */
  const apply = (makeOp, attempt = 0) => {
    if (settings === undefined || !settingsNs) return Promise.resolve();
    return (async () => {
      try {
        const op = makeOp();
        if (op !== undefined) await settings.mutate(settingsNs, [op]);
      } catch (error) {
        if (attempt + 1 < PUBLISH_RETRY_MAX && signal?.aborted !== true) {
          const retry = setTimeout(() => apply(makeOp, attempt + 1), retryMs * (attempt + 1));
          retry.unref?.();
          return;
        }
        debug(`the usage snapshot could not be published: ${error?.message ?? String(error)}`);
      }
    })();
  };

  /**
   * Publish one snapshot, standing down when the route moved on while the fetch
   * ran: a `clear` (logout) advanced its generation, and a disposed lifecycle
   * aborted the signal. The check re-runs per retry, so a clear during the
   * mount-window retry chain also wins over the stale publish.
   * @param {string} route
   * @param {object} snapshot
   * @param {number} generation - the route generation this snapshot was fetched under.
   */
  const publish = (route, snapshot, generation) =>
    apply(() =>
      signal?.aborted === true || stateOf(route).generation !== generation
        ? undefined
        : usageOp(snapshot, storedSnapshot(route), route),
    );

  async function refreshOnce(route) {
    const state = stateOf(route);
    // The route generation the fetch below belongs to. A `clear` (logout, account
    // removed) advances it, and nothing this run produces may land afterwards.
    const generation = state.generation;
    const credential = await grants.resolve({ route, signal });
    if (state.generation !== generation) return;
    if (credential === undefined || !credential.oauth || !isOAuthToken(credential.apiKey)) {
      // No plan quota on this route's credential (none stored, or a stored API
      // key): publish the empty snapshot once so the indicator hides instead of
      // lingering on a stale snapshot. The change gate keeps an already-emptied
      // document untouched.
      const hadEmpty = state.emptied;
      state.emptied = true;
      if (!hadEmpty) await publish(route, emptySnapshot(Date.now()), generation);
      return;
    }
    state.emptied = false;
    const headers = usageHeaders(credential.apiKey);
    const [profile, usage] = await Promise.all([
      fetchProfilePayload(headers, { signal, fetchImpl }),
      fetchUsage(headers, { signal, fetchImpl }),
    ]);
    const snapshot = usageSnapshot(usage, profile, Date.now());
    if (snapshot === undefined) throw new Error("Could not parse the Anthropic usage response.");
    // The route may have been removed while the two fetches were in flight (a
    // logout clears its snapshot). Never write against the removed account;
    // `publish` repeats this check inside each retry.
    if (state.generation !== generation) return;
    grants.markReauth?.(route, false);
    // Keep the stored plan (the picker heading's source) current.
    if (typeof snapshot.plan === "string")
      await grants.setPlan?.(route, snapshot.plan).catch(() => {});
    await publish(route, snapshot, generation);
  }

  function run(route) {
    const state = stateOf(route);
    state.fetching = true;
    const work = refreshOnce(route)
      .catch((error) => {
        if (signal?.aborted) return;
        // The endpoint refusing this account's token: it needs a fresh sign-in
        // (the command's own hint names 401/403). Anything else (offline, 5xx,
        // parse) is transient.
        if (error?.status === 401 || error?.status === 403) grants.markReauth?.(route, true);
        // A failed fetch publishes nothing: the last snapshot survives and the
        // next trigger retries.
        debug(`usage refresh failed for ${route}: ${error?.message ?? String(error)}`);
      })
      .finally(() => {
        state.fetching = false;
        state.lastFinishedAt = Date.now();
      });
    track(work);
  }

  return {
    /** Schedule one coalesced fetch for one account. Safe to call from any trigger cadence. */
    requestRefresh(route, { immediate = false } = {}) {
      if (typeof route !== "string" || route.length === 0)
        throw new Error("requestRefresh needs an account route");
      const state = stateOf(route);
      if (state.fetching) return;
      if (state.timer !== null) {
        if (!immediate) return;
        // A model selection overrides the cooldown wait.
        clearTimeout(state.timer);
        state.timer = null;
      }
      const wait = immediate ? 0 : Math.max(0, cooldownMs - (Date.now() - state.lastFinishedAt));
      state.timer = setTimeout(() => {
        state.timer = null;
        run(route);
      }, wait);
      state.timer.unref?.();
    },
    /**
     * Drop an account's snapshot after the account was removed. The record change
     * that caused this already scheduled a refresh; its timer is withdrawn and its
     * generation advanced, so a run still queued or in flight stands down instead
     * of re-publishing (empty or full) after the clear. The emptied flag keeps a
     * later trigger for a credential-less route silent. A later sign-in clears it
     * on the OAuth path and publishes again.
     */
    clear(route) {
      const state = stateOf(route);
      state.generation += 1;
      if (state.timer !== null) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      state.emptied = true;
      return apply(() =>
        storedSnapshot(route) === undefined ? undefined : { op: "unset", path: usagePath(route) },
      );
    },
    dispose() {
      for (const state of routes.values()) {
        if (state.timer !== null) {
          clearTimeout(state.timer);
          state.timer = null;
        }
      }
    },
  };
}
