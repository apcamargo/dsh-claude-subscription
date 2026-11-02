/**
 * The host-side model-catalog engine: one reading per signed-in account plus
 * one shared reading of the anonymous published catalog.
 *
 * Mirrors the usage engine's shape (lib/usage.js): a route-scoped state machine,
 * a TTL instead of a hover cadence, single-flight, last-known-good, and a
 * serialized publish through the injected settings writer. It never throws to
 * its callers and never blocks a model request: a stale reading beats a missing
 * one, and the published catalog covers the rest.
 *
 * @module @apcamargo/dsh-claude-subscription/model-catalog
 */

import {
  CATALOG_RETRY_MS,
  CATALOG_TTL_MS,
  fetchPublishedCatalog,
  fetchServedCatalog,
} from "./catalog-source.js";
import { catalogOfRoute, publishedCatalogOf } from "./accounts.js";
import { claudeCodeVersion } from "./fingerprint.js";

/** Whether `version` is numerically newer than `base` (dotted components). */
function isNewerVersion(version, base) {
  const left = String(version)
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  const right = String(base)
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = Number.isFinite(left[index]) ? left[index] : 0;
    const b = Number.isFinite(right[index]) ? right[index] : 0;
    if (a !== b) return a > b;
  }
  return false;
}

/**
 * @param {object} deps
 * @param {object} deps.config - the live plugin config (volatile reads).
 * @param {object} deps.grants - the grant manager.
 * @param {(path: string[], value: unknown) => Promise<void>} deps.publish - one change-gated settings set.
 * @param {(path: string[]) => Promise<void>} deps.unset - one settings unset.
 * @param {(route: string) => boolean} deps.isLive - whether the route is a live account right now.
 * @param {(message: string) => void} deps.debug
 * @param {AbortSignal} [deps.signal]
 * @param {(work: Promise<unknown>) => Promise<unknown>} [deps.track]
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {() => number} [deps.now]
 */
export function createModelCatalog({
  config,
  grants,
  publish,
  unset,
  isLive,
  debug,
  signal,
  track = (work) => work,
  fetchImpl,
  now = Date.now,
}) {
  /** One state per route: a queued run, a running one, and its retry clock. */
  const routes = new Map();
  const published = {
    timer: null,
    fetching: false,
    attempt: 0,
    nextAt: 0,
    checkedAt: 0,
    generation: 0,
  };
  let disposed = false;

  const stateOf = (route) => {
    let state = routes.get(route);
    if (state === undefined) {
      state = { timer: null, fetching: false, attempt: 0, nextAt: 0, checkedAt: 0, generation: 0 };
      routes.set(route, state);
    }
    return state;
  };

  const fresh = (snapshot, state) =>
    Number.isFinite(snapshot?.fetchedAt) &&
    now() - Math.max(snapshot.fetchedAt, state.checkedAt) < CATALOG_TTL_MS;

  const retryDelay = (attempt) => CATALOG_RETRY_MS[Math.min(attempt, CATALOG_RETRY_MS.length - 1)];

  const schedule = (state, work, delay = 0) => {
    if (state.timer !== null) return;
    const expected = state.generation;
    state.timer = setTimeout(() => {
      state.timer = null;
      if (disposed || state.generation !== expected) return;
      void track(work());
    }, delay);
    state.timer.unref?.();
  };

  async function refreshRoute(route) {
    const state = stateOf(route);
    if (state.fetching || disposed || !isLive(route)) return;
    // The TTL and backoff gates live in `requestRefresh`; reaching here means a
    // run was authorised (an immediate refresh bypasses both).
    state.fetching = true;
    const generation = state.generation;
    try {
      const credential = await grants.resolve({ route, signal });
      if (generation !== state.generation || disposed) return;
      if (credential === undefined || !credential.oauth) return;
      const previous = catalogOfRoute(config, route);
      const answer = await fetchServedCatalog(credential, {
        fetchImpl,
        signal,
        etag: typeof previous?.etag === "string" ? previous.etag : undefined,
      });
      if (generation !== state.generation || disposed || !isLive(route)) return;
      state.attempt = 0;
      state.nextAt = 0;
      state.checkedAt = now();
      if (answer.status === "not-modified") return;
      const newer = answer.models.filter(
        (model) =>
          typeof model.minVersion === "string" &&
          isNewerVersion(model.minVersion, claudeCodeVersion),
      );
      if (newer.length > 0) {
        // Advisory: hiding these would silently drop a model this account may
        // already be able to use. The catalog's floor is a Claude Code build fact,
        // not a plugin contract.
        debug(
          `${newer.length} model(s) in ${route}'s catalog ask for claude-code > ${claudeCodeVersion}: ${newer
            .map((model) => model.id)
            .join(", ")}`,
        );
      }
      await publish(["catalog", "accounts", route], {
        fetchedAt: now(),
        etag: answer.etag ?? null,
        models: answer.models,
      });
    } catch (error) {
      if (generation !== state.generation || disposed) return;
      state.attempt += 1;
      state.nextAt = now() + retryDelay(state.attempt - 1);
      debug(`model catalog refresh failed for ${route}: ${error?.message ?? String(error)}`);
    } finally {
      if (generation === state.generation) state.fetching = false;
    }
  }

  async function refreshPublished() {
    if (published.fetching || disposed) return;
    if (fresh(publishedCatalogOf(config), published)) return;
    if (published.nextAt > now()) return;
    published.fetching = true;
    const generation = published.generation;
    try {
      const previous = publishedCatalogOf(config);
      const answer = await fetchPublishedCatalog({
        fetchImpl,
        signal,
        etag: typeof previous?.etag === "string" ? previous.etag : undefined,
      });
      if (generation !== published.generation || disposed) return;
      published.attempt = 0;
      published.nextAt = 0;
      published.checkedAt = now();
      if (answer.status === "not-modified") return;
      await publish(["catalog", "published"], {
        fetchedAt: now(),
        version: answer.version ?? null,
        expiresAt: answer.expiresAt ?? null,
        etag: answer.etag ?? null,
        models: answer.models,
      });
    } catch (error) {
      if (generation !== published.generation || disposed) return;
      published.attempt += 1;
      published.nextAt = now() + retryDelay(published.attempt - 1);
      debug(`published model catalog refresh failed: ${error?.message ?? String(error)}`);
    } finally {
      if (generation === published.generation) published.fetching = false;
    }
  }

  return {
    /**
     * Queue one account reading. TTL-gated unless `immediate`; single-flight;
     * coalesced through a zero-delay timer so a burst costs one fetch.
     */
    requestRefresh(route, { immediate = false } = {}) {
      if (disposed || typeof route !== "string" || route.length === 0) return;
      const state = stateOf(route);
      if (state.fetching) return;
      if (!immediate && fresh(catalogOfRoute(config, route), state)) return;
      if (!immediate && state.nextAt > now()) return;
      if (immediate) state.nextAt = 0;
      schedule(state, () => refreshRoute(route));
    },
    /** Queue the shared published reading. */
    requestPublished({ immediate = false } = {}) {
      if (disposed) return;
      if (!immediate && fresh(publishedCatalogOf(config), published)) return;
      if (!immediate && published.nextAt > now()) return;
      if (immediate) published.nextAt = 0;
      schedule(published, () => refreshPublished());
    },
    /**
     * Drop one account's reading after the account was removed. The generation
     * advance makes a queued or in-flight run stand down instead of republishing
     * the removed route.
     */
    clear(route) {
      const state = stateOf(route);
      state.generation += 1;
      state.fetching = false;
      state.nextAt = 0;
      if (state.timer !== null) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      return unset(["catalog", "accounts", route]).finally(() => {
        if (routes.get(route) === state) routes.delete(route);
      });
    },
    dispose() {
      disposed = true;
      published.generation += 1;
      if (published.timer !== null) {
        clearTimeout(published.timer);
        published.timer = null;
      }
      for (const state of routes.values()) {
        state.generation += 1;
        if (state.timer !== null) {
          clearTimeout(state.timer);
          state.timer = null;
        }
      }
    },
  };
}
