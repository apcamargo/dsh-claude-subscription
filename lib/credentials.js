/**
 * Credential storage and refresh for the Claude subscription accounts.
 *
 * Every signed-in account is one `grant` record in the harness credential
 * plane, keyed `claude-subscription/<route>`: route id and credential id are
 * the same string, so the route a model is picked on names the credential that
 * serves it. Every account lives on `claude-subscription-<12 hex>`, a hash of
 * its identity. A plain `api-key` record selects the non-subscription path.
 *
 * Refreshes are read-decide-replace under the store's own lock, with a
 * per-record single-flight guard so concurrent streams on one account share
 * one network round trip.
 *
 * @module @apcamargo/dsh-claude-subscription/credentials
 */

import nodeCrypto from "node:crypto";
import { credentialKey, credentialKeyId, credentialKeyScope } from "@deepseek-ai/dsh-credentials";
import { ACCOUNT_ROUTE_PREFIX, isAccountRoute } from "./client-models.js";

const SCOPE = "claude-subscription";

// The route prefix/pattern are the cross-half contract lib/client-models.js owns
// (the browser bundle cannot import this module); the host half imports the route
// predicate from here, the one import site for the credential plane's addressing.
export { isAccountRoute };

/** The scratch record the login flow commits to, satisfying the authorization
 * seam (one flow, one key, commit observed on that key) before the account's
 * real route is known. Never an account: the account set ignores it. */
const STAGING_KEY = credentialKey(SCOPE, "login-staging");

/** Refresh this close to expiry even if the token would still work. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

/** Token-endpoint statuses that mean the refresh token no longer works. */
const REAUTH_STATUSES = new Set([400, 401, 403]);

/**
 * @typedef {object} GrantPayload
 * @property {string} access - the OAuth access token (`sk-ant-oat...`).
 * @property {string} refresh
 * @property {number} expires - epoch ms, already skew-adjusted.
 * @property {string} [accountId]
 * @property {string} [email]
 * @property {string} [orgId]
 * @property {string} [orgName]
 * @property {string} [plan] - the subscription plan display name ("Pro", "Max", "Ultra"). Best-effort.
 * @property {number} [addedAt] - epoch ms the account was first signed in. Orders accounts.
 */

/**
 * @typedef {object} AccountIdentity
 * @property {string} [accountId]
 * @property {string} [orgId]
 * @property {string} [email] - lowercased.
 */

/**
 * @typedef {object} AccountEntry
 * @property {string} route
 * @property {string} key
 * @property {"grant" | "api-key" | "invalid"} kind
 * @property {boolean} oauth
 * @property {string} [email]
 * @property {string} [orgName]
 * @property {string} [plan]
 * @property {string} [orgId]
 * @property {string} [accountId]
 * @property {number} [addedAt]
 * @property {number} [expires]
 * @property {boolean} [expired]
 * @property {boolean} needsReauth
 * @property {AccountIdentity} identity
 */

/** The credential key of one account route. @param {string} route */
export function keyOf(route) {
  if (typeof route !== "string" || route.length === 0) throw new Error("a route id is required");
  return credentialKey(SCOPE, route);
}

/** The account route a credential key belongs to, or undefined for keys this
 * plugin does not serve as accounts (foreign scopes, the staging record, hand-
 * added ids). @param {string} key @returns {string | undefined} */
export function routeOf(key) {
  if (typeof key !== "string" || credentialKeyScope(key) !== SCOPE) return undefined;
  const id = credentialKeyId(key);
  return isAccountRoute(id) ? id : undefined;
}

/**
 * The stored credential record, translated into what requests need.
 * @param {object | undefined} record
 * @returns {{ oauth: boolean, apiKey?: string, grant?: GrantPayload } | undefined}
 */
export function readStoredCredential(record) {
  if (record === undefined) return undefined;
  if (record.kind === "api-key") {
    const key = record.key ?? record.env?.key;
    return typeof key === "string" && key.length > 0 ? { oauth: false, apiKey: key } : undefined;
  }
  if (record.kind === "grant" && typeof record.payload === "object" && record.payload !== null) {
    const grant = record.payload;
    if (typeof grant.access !== "string" || grant.access.length === 0) return undefined;
    return { oauth: true, grant };
  }
  return undefined;
}

/**
 * Whether a grant needs a refresh before use.
 * @param {GrantPayload} grant
 * @returns {boolean}
 */
function needsRefresh(grant) {
  return (
    typeof grant.refresh !== "string" ||
    grant.refresh.length === 0 ||
    grant.expires - Date.now() < EXPIRY_SKEW_MS
  );
}

/** @param {unknown} value @returns {string | undefined} */
function text(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The comparable identity of a grant or a bare identity.
 * The email is lowercased: it is only ever the fallback key when a
 * grant carries no account id.
 * @param {{ accountId?: unknown, orgId?: unknown, email?: unknown } | undefined} source
 * @returns {AccountIdentity}
 */
export function identityOf(source) {
  const email = text(source?.email);
  return {
    accountId: text(source?.accountId),
    orgId: text(source?.orgId),
    email: email?.toLowerCase(),
  };
}

/** Whether two identities are the same account: the account id decides when
 * both sides have one, else the email. A personal plan and a Team seat share
 * both but sit in different organizations (the org is captured at login), so
 * two captured orgs that differ are two accounts; a side that never captured
 * an org matches on the person alone.
 * @param {AccountIdentity} a
 * @param {AccountIdentity} b
 * @returns {boolean}
 */
export function sameAccount(a, b) {
  if (a.accountId && b.accountId) {
    if (a.accountId !== b.accountId) return false;
  } else if (!a.email || !b.email || a.email !== b.email) {
    return false;
  }
  return !a.orgId || !b.orgId || a.orgId === b.orgId;
}

/** The deterministic route of an identity-hashed account: the first 12 hex of
 * the identity's SHA-256. Fixed width, no collision handling on purpose: a
 * route that depended on which other accounts exist would not be stable across
 * sessions, and sessions persist `provider/model`.
 * @param {AccountIdentity} identity - must carry an account id or an email.
 * @returns {string}
 */
export function hashRoute(identity) {
  const basis = identity.accountId ? `id:${identity.accountId}` : `email:${identity.email}`;
  const digest = nodeCrypto
    .createHash("sha256")
    .update(`${basis}|${identity.orgId ?? ""}`)
    .digest("hex");
  return `${ACCOUNT_ROUTE_PREFIX}-${digest.slice(0, 12)}`;
}

/** Which route a freshly signed-in account is stored on. Pure.
 *  1. An account that already has a record is refreshed in place (never a
 *     duplicate, never a sign-out).
 *  2. Every new account gets the hash route; an identity-less grant gets a
 *     fresh random one (nothing to dedupe on).
 * A removed account has no route, so a later sign-in is a new allocation.
 * Identity-bearing accounts still return to the same hash route.
 * @param {object} input
 * @param {AccountIdentity} input.identity - the new grant's identity.
 * @param {{ route: string, identity: AccountIdentity }[]} input.accounts - the stored records.
 * @returns {{ route: string, outcome: "refreshed" | "created" }}
 */
export function allocateRoute({ identity, accounts }) {
  const existing = accounts.find((account) => sameAccount(account.identity, identity));
  if (existing !== undefined) return { route: existing.route, outcome: "refreshed" };

  if (identity.accountId === undefined && identity.email === undefined) {
    return {
      route: `${ACCOUNT_ROUTE_PREFIX}-${nodeCrypto.randomBytes(6).toString("hex")}`,
      outcome: "created",
    };
  }
  return { route: hashRoute(identity), outcome: "created" };
}

/**
 * Create the grant manager bound to one host context.
 * @param {object} deps
 * @param {object} deps.ctx - host context. `ctx.get("credentials")` resolves the store.
 * @param {(message: string) => void} [deps.debug]
 * @param {(grant: GrantPayload) => Promise<GrantPayload>} deps.refresh - performs the network refresh.
 * @param {(route: string, needsReauth: boolean) => void} [deps.onReauthChange] - fired when an account flips between
 *   working and needing a fresh sign-in, so the host can mirror it for the cards.
 * @returns {object} manager with `listAccounts`, `describe`, `resolve`, `commit`, `deleteCredential`, `adopt`, ….
 */
export function createGrantManager({ ctx, debug = () => {}, refresh, onReauthChange = () => {} }) {
  /** @type {Map<string, Promise<{ oauth: boolean, apiKey: string } | undefined>>} one refresh per record */
  const refreshing = new Map();
  /** Routes whose refresh token the token endpoint refused (or whose usage call returned 401). */
  const reauth = new Set();
  /** Adoptions are serialized: allocation reads the record set it then extends. */
  let adoptChain = Promise.resolve();

  const store = () => ctx.get("credentials");

  /** @param {string} route @param {boolean} needs */
  function markReauth(route, needs) {
    if (reauth.has(route) === needs) return;
    if (needs) reauth.add(route);
    else reauth.delete(route);
    try {
      onReauthChange(route, needs);
    } catch (error) {
      debug(`reauth listener failed: ${error?.message ?? String(error)}`);
    }
  }

  /** @returns {Promise<object | undefined>} the raw stored record. */
  async function readRecord(route) {
    return store()?.readRecord(keyOf(route));
  }

  /** Every account record, in sign-in order (`addedAt`, then route). An
   * unreadable record is listed as an `invalid` account needing a fresh
   * sign-in, not vanished. @returns {Promise<AccountEntry[]>} */
  async function listAccounts() {
    const credentials = store();
    if (credentials === undefined) return [];
    const entries = [];
    for (const { key } of await credentials.listRecords()) {
      const route = routeOf(key);
      if (route === undefined) continue;
      const resolved = readStoredCredential(await credentials.readRecord(key));
      if (resolved === undefined) {
        entries.push({
          route,
          key,
          kind: "invalid",
          oauth: false,
          needsReauth: true,
          identity: {},
        });
      } else if (!resolved.oauth) {
        entries.push({
          route,
          key,
          kind: "api-key",
          oauth: false,
          needsReauth: false,
          identity: {},
        });
      } else {
        const grant = resolved.grant;
        entries.push({
          route,
          key,
          kind: "grant",
          oauth: true,
          email: text(grant.email),
          orgName: text(grant.orgName),
          plan: text(grant.plan),
          orgId: text(grant.orgId),
          accountId: text(grant.accountId),
          addedAt: Number.isFinite(grant.addedAt) ? grant.addedAt : undefined,
          expires: grant.expires,
          expired: needsRefresh(grant),
          needsReauth: reauth.has(route),
          identity: identityOf(grant),
        });
      }
    }
    return entries.sort(
      (a, b) =>
        (a.addedAt ?? 0) - (b.addedAt ?? 0) || (a.route < b.route ? -1 : a.route > b.route ? 1 : 0),
    );
  }

  async function describe(route) {
    const record = await readRecord(route);
    const resolved = readStoredCredential(record);
    if (resolved === undefined) return { configured: false, route };
    if (!resolved.oauth) return { configured: true, oauth: false, route };
    const grant = resolved.grant;
    return {
      configured: true,
      oauth: true,
      route,
      email: grant.email,
      orgName: grant.orgName,
      plan: text(grant.plan),
      orgId: grant.orgId,
      accountId: grant.accountId,
      expires: grant.expires,
      expired: needsRefresh(grant),
      needsReauth: reauth.has(route),
    };
  }

  /** Resolve one account's request credential, refreshing a stale grant first.
   *
   * Deliberately NOT an async function: it returns the single-flight work
   * promise itself, so a caller that drops the promise drops the one the orphan
   * guard below already handles (an async wrapper would hand out a fresh
   * promise whose rejection no one observes).
   * @param {object} [options]
   * @param {string} options.route - the account's route.
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<{ oauth: boolean, apiKey: string } | undefined>}
   */
  function resolve({ route, signal } = {}) {
    // An aborted caller must not spawn a refresh whose rejection no one would observe.
    try {
      signal?.throwIfAborted();
    } catch (error) {
      return Promise.reject(error);
    }
    const key = keyOf(route);
    const inFlight = refreshing.get(key);
    if (inFlight !== undefined) return inFlight;
    const work = (async () => {
      const record = await readRecord(route);
      const resolved = readStoredCredential(record);
      if (resolved !== undefined && resolved.oauth && !needsRefresh(resolved.grant)) {
        return { oauth: true, apiKey: resolved.grant.access };
      }
      if (resolved !== undefined && !resolved.oauth) {
        return { oauth: false, apiKey: resolved.apiKey };
      }
      // A stale stored grant: refresh it, never bypass it with another
      // credential source, so billing stays on the plan.
      if (resolved !== undefined && resolved.oauth) {
        let next;
        try {
          next = await refresh(resolved.grant);
        } catch (error) {
          // The token endpoint refusing the refresh token means a fresh
          // sign-in is needed; an offline failure does not. The status is
          // the stable identifier.
          if (REAUTH_STATUSES.has(error?.status)) markReauth(route, true);
          throw error;
        }
        markReauth(route, false);
        const stored = await commit(next, record, route);
        const usable = readStoredCredential(stored);
        if (usable !== undefined) {
          // Serve whatever the store now holds: normally the refreshed grant,
          // but a concurrent rotation (or an api-key switch) wins by design.
          debug("grant refreshed");
          return usable.oauth
            ? { oauth: true, apiKey: usable.grant.access }
            : { oauth: false, apiKey: usable.apiKey };
        }
        // The write was declined (record deleted mid-refresh, i.e. logout):
        // the fresh token still serves this request, nothing is resurrected.
        debug(
          "grant refreshed; the stored record moved on, serving the fresh token without committing",
        );
        return { oauth: true, apiKey: next.access };
      }
      return undefined;
    })().finally(() => {
      refreshing.delete(key);
    });
    refreshing.set(key, work);
    // A dropped promise must never become an unhandled rejection; real
    // awaiters still get it through `work` itself.
    work.catch(() => {});
    return work;
  }

  /** Commit one grant (or api-key) as an account's credential record.
   * Read-decide-replace: a record that moved on (concurrent rotation, logout)
   * wins over this write.
   * @param {GrantPayload | { key: string }} value
   * @param {object | undefined} [observed] - the raw record the decision was based
   *   on; the write is declined when the stored record no longer matches it.
   * @param {string} route - the account.
   * @returns {Promise<object | undefined>} the stored record after the write,
   *   or the current record when the write was declined.
   */
  async function commit(value, observed, route) {
    const record =
      "key" in value
        ? { kind: "api-key", key: value.key }
        : { kind: "grant", payload: jsonImage(value) };
    return writableStore().modifyRecord(keyOf(route), (current) =>
      isSafeToReplace(current, observed) ? record : undefined,
    );
  }

  /** Whether the observed record may still overwrite what is stored: records
   * are compared BY VALUE, because a cross-process store re-parses them from
   * disk, so object identity is meaningless.
   * @param {object | undefined} current - what the store holds now.
   * @param {object | undefined} observed - what this decision was based on.
   * @returns {boolean}
   */
  function isSafeToReplace(current, observed) {
    if (observed === undefined) return current === undefined;
    if (current === undefined) return false; // deleted concurrently (logout) wins
    if (current.kind !== observed.kind) return false;
    if (current.kind === "grant") return current.payload?.refresh === observed.payload?.refresh;
    return true;
  }

  /** Delete one account's stored credential. Absent records are a store-level no-op.
   * Real failures propagate so a failed logout is never reported as success. */
  async function deleteCredential(route) {
    const credentials = store();
    if (credentials === undefined) return;
    await credentials.deleteRecord(keyOf(route));
    markReauth(route, false);
  }

  /** Record an account's plan on its stored grant. Declined (like a refresh
   * commit) when the record moved on; no-op when already current.
   * @param {string} route
   * @param {string} plan
   * @returns {Promise<boolean>} whether the record changed.
   */
  async function setPlan(route, plan) {
    if (typeof plan !== "string" || plan.length === 0) return false;
    const record = await readRecord(route);
    const resolved = readStoredCredential(record);
    if (resolved === undefined || !resolved.oauth || resolved.grant.plan === plan) return false;
    const stored = await commit({ ...resolved.grant, plan }, record, route);
    return readStoredCredential(stored)?.grant?.plan === plan;
  }

  /** Store a freshly signed-in grant on the route {@link allocateRoute} picks.
   * Unconditional by design: a new sign-in supersedes whatever grant the same
   * account held. Serialized, because allocation reads the record set the write
   * extends.
   * @param {GrantPayload} grant
   * @returns {Promise<{ route: string, outcome: "refreshed" | "created", identity: AccountIdentity, previous?: AccountEntry }>}
   */
  function adopt(grant) {
    const run = adoptChain.then(async () => {
      const identity = identityOf(grant);
      const accounts = await listAccounts();
      const { route, outcome } = allocateRoute({ identity, accounts });
      const previous = accounts.find((account) => account.route === route);
      // A re-sign-in keeps the account's order place; only a new account is stamped.
      const addedAt =
        previous !== undefined
          ? previous.addedAt
          : Number.isFinite(grant.addedAt)
            ? grant.addedAt
            : Date.now();
      const payload = jsonImage({ ...grant, addedAt, plan: grant.plan ?? previous?.plan });
      await writableStore().modifyRecord(keyOf(route), () => ({ kind: "grant", payload }));
      markReauth(route, false);
      return { route, outcome, identity, previous };
    });
    adoptChain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /** The credential service, or the failure that names what is missing. */
  function writableStore() {
    const credentials = store();
    if (credentials === undefined) {
      throw new Error(
        "claude-subscription: this composition mounts no credentials service, so there is nowhere to store the sign-in credential; mount one (dsh-credentials-local) to sign in",
      );
    }
    return credentials;
  }

  return {
    stagingKey: STAGING_KEY,
    hasStore: () => store() !== undefined,
    listAccounts,
    describe,
    resolve,
    commit,
    deleteCredential,
    adopt,
    setPlan,
    isReauth: (route) => reauth.has(route),
    markReauth,
    /** Delete the login staging record. A no-op when absent. */
    async deleteStaging() {
      await store()?.deleteRecord(STAGING_KEY);
    },
  };
}

/** The JSON image of one grant payload: drops explicitly-undefined members, as
 * JSON.stringify would, which the store's strict validator requires.
 * @param {GrantPayload} value
 * @returns {GrantPayload}
 */
export function jsonImage(value) {
  if (Array.isArray(value))
    return value.map((entry) => (entry === undefined ? null : jsonImage(entry)));
  if (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const image = {};
    for (const [key, member] of Object.entries(value))
      if (member !== undefined) image[key] = jsonImage(member);
    return image;
  }
  return value;
}
