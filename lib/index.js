/**
 * DeepSeek Harness plugin: Anthropic provider authenticated with Claude
 * subscriptions (OAuth). One provider route per signed-in account,
 * `claude-subscription-<hash>/<model>`. The account serving a request is the
 * selected model's route. There is no "active account" setting and no route
 * without an account. The wire request reproduces Claude Code's / Cowork's
 * fingerprint byte-for-byte, which is what makes the subscription credential
 * honoured (see lib/fingerprint.js). The built-in `anthropic` route is never
 * touched.
 *
 * @module @apcamargo/dsh-claude-subscription
 */

import Schema from "@deepseek-ai/schemastery";
import {
  buildMirror,
  buildRouteTable,
  catalogOfRoute,
  jsonEqual,
  liveValue,
  publishedCatalogOf,
} from "./accounts.js";
import { createAdapter, DEFAULT_BASE_URL } from "./adapter.js";
import { DEFAULT_INPUT, availableCatalog, discoveryModels } from "./catalog.js";
import { createGrantManager, isAccountRoute, jsonImage, routeOf } from "./credentials.js";
import { CATALOG_PREFIX, CATALOG_REFRESH_SUFFIX, SETTINGS_NS } from "./client-models.js";
import { registerCommands } from "./commands.js";
import { login as runLogin, refreshGrant } from "./oauth.js";
import { fetchPlanName } from "./plan.js";
import { createModelCatalog } from "./model-catalog.js";
import { createUsageEngine } from "./usage.js";

const name = "claude-subscription";

/** Adapter registry, credentials, the authorization seam (the login flow and
 * `/claude-login` both use it; declaring it also gates the mount on it),
 * commands, questions. */
const inject = ["llm", "credentials", "authorization", "commands", "userQuestions"];

const modelEntry = Schema.object({
  id: Schema.string()
    .required()
    .description("The model id sent on the wire, e.g. claude-opus-5-5."),
  name: Schema.string().description(
    "Display name shown in the picker. Defaults to the catalog name, or the id.",
  ),
  contextWindow: Schema.number()
    .step(1)
    .min(1)
    .description("Context window in tokens. Defaults to the catalog capacity."),
  maxTokens: Schema.number()
    .step(1)
    .min(1)
    .description("Output-token ceiling. Defaults to the catalog capacity."),
  input: Schema.array(Schema.union(["text", "image"])).description(
    `Request modalities. Defaults to ${DEFAULT_INPUT.join(" + ")}.`,
  ),
});

/** Plugin configuration. @typedef {object} Config */

export const Config = Schema.object({
  // Split by owner so a host write can never clobber a user edit and vice
  // versa: `mirror` is host-derived display state, `models` the user-owned
  // lists. Both persist in the profile patch and are re-parsed through this
  // schema at MOUNT, where a parse throw is fatal (a rejected volatile update
  // is only logged). So the evolving mirror shape is `Schema.any()`, while
  // `models` reuses the typed rows the card already normalizes.
  accounts: Schema.object({
    mirror: Schema.any(),
    models: Schema.dict(Schema.array(modelEntry)),
  })
    .volatile()
    .description(
      "Per-account state: the display mirror is maintained by the plugin and `models` holds each account's editable model list.",
    ),
  // The usage engine's per-account snapshots (lib/usage.js), published into
  // their own volatile section. `Schema.any()` on purpose: snapshots persist
  // in the profile patch and are re-parsed at MOUNT, where a parse throw is
  // fatal. A structured schema would brick the plugin after any shape change.
  // Host-maintained, shape-validated client-side.
  usage: Schema.object({
    snapshots: Schema.any(),
  })
    .volatile()
    .description(
      "Latest usage-quota snapshots the composer indicator reads, keyed by account route; maintained by the plugin, not meant for hand editing.",
    ),
  // The catalog readings: one per account route plus the shared published
  // fallback, kept out of `accounts` so the two writers cannot clobber each
  // other. `Schema.any()` for the same mount-parse reason as `usage`.
  catalog: Schema.object({
    published: Schema.any(),
    accounts: Schema.any(),
  })
    .volatile()
    .description(
      "Cached Claude model catalogs: the shared published reading and each account's selector reading, keyed by route. Maintained by the plugin, not meant for hand editing.",
    ),
  catalogRefresh: Schema.boolean()
    .default(true)
    .description(
      "Fetch the account and published model catalogs (cached for 24 h). Disable to stop the network reads; cached readings remain usable.",
    ),
  debug: Schema.boolean()
    .default(false)
    .description(
      "Log resolved request facts (never credentials) and credential refreshes to the plugin logger.",
    ),
  extraBetas: Schema.array(Schema.string())
    .default([])
    .description(
      "Extra anthropic-beta values appended to the beta header on every request (the OAuth Cowork profile, or the API-key path's empty base). Only for live-credential experiments.",
    ),
  cacheTtl: Schema.union(["auto", "5m", "1h"])
    .default("auto")
    .description(
      'Prompt-cache lifetime. "auto" uses 1h on a subscription (OAuth) and 5m on an API key; 1h writes cost more, so use "5m" for dense sessions or an account drawing on extra usage.',
    ),
  systemPromptUpdates: Schema.boolean()
    .default(true)
    .description(
      "Deliver a changed system prompt as an appended update instead of rewriting the prompt at the head, so the cached conversation prefix survives a mid-session change. On a subscription the update is a <system-reminder> user turn (every model); on an API key it is a mid-conversation system message (models that support one). Disable if a gateway rejects the appended update. Requires a restart.",
    ),
  openBrowser: Schema.boolean()
    .default(true)
    .description(
      "Best-effort open of the authorize URL in the default browser during /claude-login. The URL is always shown either way.",
    ),
  baseUrl: Schema.string().description(
    `API base URL override. Defaults to ${DEFAULT_BASE_URL}. For tests and gateways only — the subscription credential is honoured by Anthropic's own endpoint.`,
  ),
});

/** The settings namespace: the loader entry id when mounted through a profile
 * patch (the usual case), else this fallback. The browser card pins the same
 * string (SETTINGS_NS in lib/client-models.js, since no host->card channel
 * exists), so keep the two in sync. */
const FALLBACK_SETTINGS_NS = "claude-subscription";

/**
 * @param {object} ctx - host context carrying the injected services.
 * @param {Config} config
 */
function apply(ctx, config) {
  const debug = (message) => {
    if (config.debug) ctx.logger.info(`claude-subscription: ${message}`);
  };

  /** The login command reads the adoption the flow landed here (the seam's
   * `begin()` only reports a status). One login at a time: a second `begin()`
   * on the staging key is refused. */
  const loginState = { last: undefined };

  const grants = createGrantManager({
    ctx,
    debug,
    refresh: (grant) => refreshGrant(grant),
    onReauthChange: () => syncAccounts(),
  });

  /** The live `accounts` section: the settings projection once the service
   * projects this entry, else the volatile config reference (which carries
   * the persisted value from mount). Either may be stale by one write; every
   * consumer re-reads per operation. */
  let settings;
  const accountsValue = () => {
    try {
      const row = settings?.describe().find((candidate) => candidate.ns === settingsNs);
      if (row?.value?.accounts !== null && typeof row?.value?.accounts === "object")
        return row.value.accounts;
    } catch {
      // Not projected yet (mount window) or no service: use the config reference.
    }
    try {
      return liveValue(config.accounts) ?? {};
    } catch {
      return {}; // an unreadable volatile reference reads as empty
    }
  };

  /** The registered routes, one adapter instance per route. The route is
   * closure-bound and the host keeps replay state per adapter instance, so a
   * thinking signature minted under one account never reaches another's
   * request. `entry` is read live, so a heading change needs at most a
   * `replace` to publish the new name.
   * @type {Map<string, { state: { entry: object | undefined }, handle: Function, name: string | undefined }>}
   */
  const routeState = new Map();

  // A route exists only while its account record exists: nothing registers at mount.
  const registerRoute = (route) => {
    const state = { entry: undefined };
    const adapter = createAdapter({ route, grants, config, debug, ctx, entry: () => state.entry });
    const handle = ctx.llm.registerAdapter([route], adapter);
    routeState.set(route, { state, handle, name: undefined });
    return routeState.get(route);
  };
  /** Remove one registered route (account sync and logout share it). A missing
   * or already-disposed route is a no-op. @param {string} route */
  const dropRoute = (route) => {
    const registered = routeState.get(route);
    if (registered === undefined) return;
    try {
      registered.handle();
    } catch {
      // A disposed registration is already gone.
    }
    routeState.delete(route);
  };

  /** Reconcile the registered routes with the stored accounts and mirror the
   * result for the browser card. Calls chain onto a serialized promise (events
   * overlap; a burst costs a few cheap `listRecords` reads). Registrations
   * never wait on a settings write: a composition without a settings service
   * loses only the card's display, never a route. */
  /** Refresh every grant account's plan once per mount, in the background: the
   * token refresh must not wait on this cosmetic endpoint. The commit's
   * `credentials/record-updated` re-syncs the headings; the usage engine also
   * keeps the plan current. Never blocks or fails a sync. */
  const planLookups = new Set();
  function syncPlans(accounts) {
    for (const account of accounts) {
      if (account.kind !== "grant" || account.needsReauth || planLookups.has(account.route))
        continue;
      planLookups.add(account.route);
      const work = (async () => {
        const credential = await grants.resolve({ route: account.route, signal: lifetime.signal });
        if (credential === undefined || !credential.oauth) return;
        const plan = await fetchPlanName(credential.apiKey, { signal: lifetime.signal });
        if (plan !== undefined) await grants.setPlan(account.route, plan);
      })().catch((error) =>
        debug(`plan lookup failed for ${account.route}: ${error?.message ?? String(error)}`),
      );
      track(work);
    }
  }

  /** Refresh every live account's catalog reading plus the published one.
   * TTL-gated inside the engine, so a burst costs one fetch; an idle process
   * generates no traffic. */
  function syncCatalogs(accounts) {
    if (config.catalogRefresh === false) return;
    catalogEngine?.requestPublished();
    for (const account of accounts) {
      if (account.kind !== "grant" || account.needsReauth) continue;
      catalogEngine?.requestRefresh(account.route);
    }
  }

  let syncChain = Promise.resolve();
  function syncAccounts() {
    const run = syncChain.then(async () => {
      // A missing store must not make an empty read look like "every account
      // was removed": only a resolved read with the store present is authoritative.
      if (!grants.hasStore()) {
        debug("account sync skipped: the credentials service is unavailable");
        return;
      }
      const accounts = await grants.listAccounts();
      const table = buildRouteTable({ accounts });
      for (const entry of table) {
        try {
          const registered = routeState.get(entry.route) ?? registerRoute(entry.route);
          // The entry goes in BEFORE the re-assertion: `replace` reads
          // `providerInfo` (the heading) from this very state.
          registered.state.entry = entry;
          if (registered.name !== entry.name) {
            // `providerInfo` is read at registration time only, so a new heading
            // is published by re-asserting this one route.
            registered.handle.replace([entry.route]);
          }
          registered.name = entry.name;
        } catch (error) {
          // One route's failure must not strand the others or the writes below.
          ctx.logger.warn(
            `claude-subscription: route ${entry.route} could not be registered or renamed`,
          );
          ctx.logger.warn(error);
        }
      }
      // The table is credential-derived: a route missing from it belongs to a
      // gone account. Dispose it now; a session still naming it fails as
      // NO_ADAPTER until the user picks another model.
      for (const route of [...routeState.keys()]) {
        if (table.some((entry) => entry.route === route)) continue;
        dropRoute(route);
      }
      writeMirror(table);
      reconcileAccountState(table);
      syncPlans(accounts);
      syncCatalogs(accounts);
    });
    syncChain = run.then(
      () => {},
      (error) => {
        ctx.logger.warn("claude-subscription: the account routes could not be synchronized");
        ctx.logger.warn(error);
      },
    );
    return syncChain;
  }

  /** The settings-mutate writer shared by the mirror and the field cleanup:
   * change-gated, serialized, and retried through the mount window in which the
   * service does not project this entry yet (the first write is refused with
   * "Plugin entry … is no longer configurable"; the fiber activates within
   * moments). Retries replay the failed attempt's value, but every schedule
   * bumps the section's generation, so a newer write always wins over a stale
   * retry. */
  const MIRROR_RETRY_MAX = 5;
  let writeChain = Promise.resolve();
  /** @type {Map<string, number>} one generation per settings path. */
  const writeGenerations = new Map();
  const attemptWrite = (id, generation, path, next, attempt) => {
    const run = writeChain.then(async () => {
      try {
        if (attempt > 0 && (writeGenerations.get(id) ?? 0) !== generation) return;
        await settings.mutate(settingsNs, [{ op: "set", path, value: next }]);
      } catch (error) {
        if (attempt + 1 < MIRROR_RETRY_MAX) {
          const timer = setTimeout(
            () => attemptWrite(id, generation, path, next, attempt + 1),
            1000 * (attempt + 1),
          );
          timer.unref?.();
          return;
        }
        ctx.logger.warn(
          `claude-subscription: the ${path[0]} mirror could not be updated: ${error?.message ?? String(error)}`,
        );
      }
    });
    writeChain = run.then(
      () => {},
      () => {},
    );
    return run;
  };
  const writeSection = (path, next, read) => {
    if (settings === undefined) return Promise.resolve();
    const id = path.join("/");
    const generation = (writeGenerations.get(id) ?? 0) + 1;
    writeGenerations.set(id, generation);
    if (jsonEqual(next, read())) return Promise.resolve();
    return attemptWrite(id, generation, path, next, 0);
  };

  const writeMirror = (table) => {
    writeSection(["accounts", "mirror"], buildMirror(table), () => accountsValue().mirror);
  };

  /** One catalog field through the same serialized, change-gated writer. */
  const writeCatalog = (path, value) =>
    writeSection(path, value, () => {
      let current = { catalog: catalogView() };
      for (const key of path) current = current?.[key];
      return current;
    });

  /** Remove one settings path when present, through the same serialized,
   * retrying writer. An entry not yet projected is NOT "absent": the mount
   * window hides it from `describe()` while refusing writes, so the unset is
   * attempted and retried until the entry is describable. Only a projected
   * entry whose path is really unset stands down without a write, keeping an
   * ordinary mount from bumping the document revision. */
  const unsetSection = (path, attempt = 0) => {
    if (settings === undefined) return Promise.resolve();
    const run = writeChain.then(async () => {
      try {
        const descriptor = settings.describe().find((row) => row.ns === settingsNs);
        let present = descriptor?.value;
        for (const key of path) present = present?.[key];
        if (descriptor !== undefined && present === undefined) return;
        await settings.mutate(settingsNs, [{ op: "unset", path }]);
      } catch (error) {
        if (attempt + 1 < MIRROR_RETRY_MAX) {
          const timer = setTimeout(() => unsetSection(path, attempt + 1), 1000 * (attempt + 1));
          timer.unref?.();
          return;
        }
        debug(
          `the ${path.join(".")} field could not be removed: ${error?.message ?? String(error)}`,
        );
      }
    });
    writeChain = run.then(
      () => {},
      () => {},
    );
    return run;
  };

  /** Remove the settings a logged-out account owned: its `accounts.models.<route>`
   * list. Best-effort (retried by `unsetSection`); route disposal does not depend on it. */
  const removeAccount = (route) => {
    catalogEngine?.clear(route);
    unsetSection(["accounts", "models", route]);
  };

  // The usage and catalog engines, created inside the settings child below;
  // the commands reach the usage engine through `loginState.usage`.
  let usageEngine;
  let catalogEngine;

  const settingsNs = ctx.fiber?.entry?.options?.id ?? FALLBACK_SETTINGS_NS;
  // The browser card pins SETTINGS_NS (lib/client-models.js) and there is no
  // host->card channel, so a drift here leaves the card editing a document
  // this plugin never reads.
  if (settingsNs !== SETTINGS_NS) {
    ctx.logger.warn(
      `claude-subscription: the settings namespace "${settingsNs}" does not match the browser card's "${SETTINGS_NS}" — Models-page edits will not reach this plugin`,
    );
  }

  /** The stored usage snapshots: settings projection, else config reference. */
  const usageSnapshots = () => {
    let value;
    try {
      const row = settings?.describe().find((candidate) => candidate.ns === settingsNs);
      value = row?.value?.usage?.snapshots;
    } catch {}
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      try {
        value = liveValue(config.usage)?.snapshots;
      } catch {
        value = undefined;
      }
    }
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
  };

  /** The catalog readings: settings projection, else config reference. */
  const catalogView = () => {
    let value;
    try {
      const row = settings?.describe().find((candidate) => candidate.ns === settingsNs);
      value = row?.value?.catalog;
    } catch {}
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      try {
        value = liveValue(config.catalog);
      } catch {
        value = undefined;
      }
    }
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
  };

  /** Drop state belonging to no live account: usage snapshot, catalog reading,
   * saved model list. A route can disappear without `/claude-logout` (external
   * deletion, a re-login allocating a new identity hash), and those keys would
   * otherwise accumulate forever. @param {{ route: string }[]} table */
  const reconcileAccountState = (table) => {
    const live = new Set(table.map((entry) => entry.route));
    for (const route of Object.keys(usageSnapshots())) {
      if (!live.has(route)) usageEngine?.clear(route);
    }
    for (const route of Object.keys(catalogView().accounts ?? {})) {
      if (!live.has(route)) catalogEngine?.clear(route);
    }
    for (const route of Object.keys(accountsValue().models ?? {})) {
      if (!live.has(route)) unsetSection(["accounts", "models", route]);
    }
  };

  /** Run the orphan sweep once the settings service projects this entry: inside
   * the mount window `describe()` sees nothing, so the mount-time pass ran
   * blind. Retries use the writers' backoff. @param {number} [attempt] */
  const sweepOrphansWhenVisible = (attempt = 0) => {
    if (settings === undefined) return;
    let visible = false;
    try {
      visible = settings.describe().some((row) => row.ns === settingsNs);
    } catch {
      visible = false;
    }
    if (visible) {
      // Reconcile now that the service can see the entry. Must not re-sync (and
      // re-write the mirror): that later write would stand down a refused
      // mirror write's retry as an equal value.
      const table = [...routeState.entries()]
        .filter(([, registered]) => registered.state.entry !== undefined)
        .map(([route, registered]) => ({ ...registered.state.entry, route }));
      reconcileAccountState(table);
      return;
    }
    if (attempt + 1 >= MIRROR_RETRY_MAX) return;
    const timer = setTimeout(() => sweepOrphansWhenVisible(attempt + 1), 1000 * (attempt + 1));
    timer.unref?.();
  };

  // The plugin lifecycle, hoisted above the settings child so the usage
  // engine shares it (its fetches are tracked and aborted with the fiber).
  const lifetime = new AbortController();
  const inFlight = new Set();
  const track = (work) => {
    inFlight.add(work);
    const settle = () => inFlight.delete(work);
    work.then(settle, settle);
    return work;
  };

  // The browser card (settings.models.footer slot) is the whole editing
  // surface; the official configurable-provider directory is deliberately NOT
  // joined (the Models page's built-in editor stubs third-party namespaces,
  // so a dead-end Edit button would read as a broken plugin).
  //
  // The same discovery callback is the composer indicator's refresh ping: the
  // browser cannot fetch usage (the OAuth token never crosses the wire), but
  // this read-only RPC reaches plugin code and is projected to bare model
  // fields, so it carries no data. The indicator pings `ping:<route>`; the
  // Models page's own call refreshes nothing. The engine fetches in the
  // background and an engine fault must never fail "Fetch models".
  /** The models one route may offer: its reading, else the published one, else
   * nothing. Never the saved list. */
  function availableFor(route) {
    return availableCatalog(
      catalogOfRoute(config, route)?.models,
      publishedCatalogOf(config)?.models,
    );
  }

  /** The Models page's adoption list: every live route's availability. */
  function catalogUnion() {
    const specs = new Map();
    for (const [route, registered] of routeState) {
      if (registered.state.entry?.kind !== "account") continue;
      for (const spec of availableFor(route)) if (!specs.has(spec.id)) specs.set(spec.id, spec);
    }
    if (specs.size === 0) {
      for (const spec of availableCatalog(undefined, publishedCatalogOf(config)?.models)) {
        if (!specs.has(spec.id)) specs.set(spec.id, spec);
      }
    }
    return [...specs.values()];
  }

  function requestCatalog(route, immediate = false) {
    if (config.catalogRefresh === false) return;
    catalogEngine?.requestRefresh(route, { immediate });
  }

  ctx.llm.registerModelDiscovery(settingsNs, (request) => {
    const provider = typeof request?.provider === "string" ? request.provider : undefined;
    if (provider?.startsWith("ping:")) {
      // `ping:<route>#select` marks a model selection: refresh now.
      const [route, mark] = provider.slice("ping:".length).split("#");
      if (isAccountRoute(route)) {
        try {
          // A stale ping can arrive after logout: only a live account route
          // may fetch; anything else clears the removed route's snapshot.
          const entry = routeState.get(route)?.state.entry;
          if (entry?.kind === "account") {
            usageEngine?.requestRefresh(route, { immediate: mark === "select" });
            // The same cadence keeps the catalog fresh without a timer.
            if (config.catalogRefresh !== false) catalogEngine?.requestRefresh(route);
          } else {
            usageEngine?.clear(route);
          }
        } catch (error) {
          debug(`usage refresh could not be scheduled: ${error?.message ?? String(error)}`);
        }
      }
    }
    if (provider?.startsWith(CATALOG_PREFIX)) {
      // The card names one account's catalog; `#refresh` asks the host to
      // fetch it again. The reply is the list as it stands now, so a slow
      // fetch never holds the RPC; the result arrives via document-updated.
      const [route, mark] = provider.slice(CATALOG_PREFIX.length).split("#");
      const entry = isAccountRoute(route) ? routeState.get(route)?.state.entry : undefined;
      if (entry?.kind === "account") {
        requestCatalog(route, mark === CATALOG_REFRESH_SUFFIX);
        return discoveryModels(availableFor(route));
      }
      if (config.catalogRefresh !== false)
        catalogEngine?.requestPublished({ immediate: mark === CATALOG_REFRESH_SUFFIX });
      return discoveryModels(availableCatalog(undefined, publishedCatalogOf(config)?.models));
    }
    // A page-level call is TTL-gated (a 160 KB published document must not be
    // re-read per card open); the card's explicit Refresh uses `catalog:<route>#refresh`.
    if (config.catalogRefresh !== false) catalogEngine?.requestPublished();
    return discoveryModels(catalogUnion());
  });

  // Any committed record change (sign-in, sign-out, the refresh a model
  // request drove, an external deletion) re-syncs the route set and kicks
  // that account's usage refresh. The staging record is the login flow's own
  // business: touching it here would race the seam's commit confirmation.
  ctx.on("credentials/record-updated", (key) => {
    if (key === grants.stagingKey) return;
    const route = routeOf(key);
    if (route === undefined) return;
    const sync = syncAccounts();
    sync.then(
      () => {
        // A live account refreshes its indicator and catalog; a removed route
        // must not recreate either reading.
        const entry = routeState.get(route)?.state.entry;
        if (entry?.kind === "account") {
          usageEngine?.requestRefresh(route);
          if (config.catalogRefresh !== false)
            catalogEngine?.requestRefresh(route, { immediate: true });
        } else {
          usageEngine?.clear(route);
          catalogEngine?.clear(route);
        }
      },
      () => {},
    );
  });

  ctx.inject(["settings"], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
    settings = child.settings;
    usageEngine = createUsageEngine({
      grants,
      debug,
      settings: child.settings,
      settingsNs,
      signal: lifetime.signal,
      track,
    });
    loginState.usage = usageEngine;
    catalogEngine = createModelCatalog({
      config,
      grants,
      publish: writeCatalog,
      unset: unsetSection,
      isLive: (route) => routeState.get(route)?.state.entry?.kind === "account",
      debug,
      signal: lifetime.signal,
      track,
    });
    // Clear the single-account usage field so a stale value stops rendering;
    // the retrying writer means the mount window cannot strand the unset.
    unsetSection(["usage", "snapshot"]);
    sweepOrphansWhenVisible();
    // The first mirror write also happens through syncAccounts; this catches
    // the section up once the service can see the entry at all.
    syncAccounts();
  });

  // One login flow, on the staging key, from mount: the account's real route
  // depends on its identity, which is only known after the OAuth exchange, and
  // the seam confirms the commit it observed on the flow's own key.
  //
  // Inside `run`: sign in, commit the grant to the staging record (satisfying
  // the seam's commit observation), then store the account on its real route.
  // The staging record stays in place, because deleting it here would fail the
  // seam's post-attempt `describeRecord` check. The login command deletes it
  // in a finally, for every outcome.
  ctx.authorization.registerFlow({
    key: grants.stagingKey,
    label: "Claude subscription",
    methods: [{ id: "oauth", label: "Sign in with Claude" }],
    async run(session) {
      const grant = await runLogin({
        session,
        openBrowser: config.openBrowser !== false,
      });
      // The store's strict validator rejects explicitly-undefined members;
      // identity capture leaves them undefined when the token response omits
      // a field, and the adopt path applies the same normalization.
      await session.commit({ kind: "grant", payload: jsonImage(grant) });
      // The seam requires the flow's own record to exist when the attempt
      // settles, so the adoption happens after the commit, within `run`.
      const adoption = await grants.adopt(grant);
      loginState.last = { ...adoption, at: Date.now() };
      // The account record's `credentials/record-updated` event fires the route sync.
    },
  });

  ctx.effect(function* () {
    yield async () => {
      lifetime.abort();
      usageEngine?.dispose();
      catalogEngine?.dispose();
      await Promise.allSettled([...inFlight]);
    };
    registerCommands(
      ctx,
      {
        ctx,
        grants,
        ask: (request) => ctx.userQuestions.ask(request),
        login: loginState,
        syncAccounts,
        dropRoute,
        removeAccount,
        isAccountRoute,
      },
      { signal: lifetime.signal, track },
    );
  }, "claude-subscription lifecycle");

  // Register the stored accounts' routes as soon as the credential store answers.
  syncAccounts();
}

export { apply, inject, name };
