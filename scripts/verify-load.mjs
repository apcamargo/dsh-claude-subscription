/**
 * Loads the plugin through the real cordis runtime with mock DSH services and
 * exercises the whole mount: inject resolution, Config parsing, per-route adapter
 * registration, the staging authorization flow against a stubbed token endpoint,
 * the account mirror and route set, command handler invocation on an accountless
 * install, the usage and catalog engines, and disposal. Network-free: no browser
 * opens (openBrowser: false) and the token endpoint is stubbed.
 * Run: node scripts/verify-load.mjs
 */

import { Context } from "@deepseek-ai/cordis";
import * as plugin from "../lib/index.js";
import { hashRoute, identityOf } from "../lib/credentials.js";
import { ALLOWANCE_429_BODY } from "../test/fixtures.mjs";
import { applyPathOp } from "../test/apply-path-op.mjs";

/** Records what the plugin registered, with call-through where cheap. */
function makeServices() {
  const registered = {
    published: new Map(),
    adapters: [],
    flows: [],
    commands: [],
    disposed: [],
    disposers: [],
    directory: [],
    discovery: [],
    beginRequests: [],
    replaces: [],
    liveAdapters: new Set(),
  };

  const llm = {
    registerAdapter(routes, adapter) {
      registered.adapters.push({ routes, adapter });
      // The real registry snapshots providerInfo at registration and at every
      // replace; the picker shows THAT name, not the live one.
      for (const route of routes) registered.published.set(route, adapter.providerInfo(route).name);
      for (const route of routes) registered.liveAdapters.add(route);
      const label = `adapter:${routes.join(",")}`;
      const disposer = () => {
        registered.disposed.push(label);
        for (const route of routes) registered.liveAdapters.delete(route);
      };
      // The real handle carries `replace(next)`, which re-asserts the route set
      // (a changed picker heading publishes through it).
      disposer.replace = (next) => {
        registered.replaces.push({ routes: next });
        for (const route of next) registered.published.set(route, adapter.providerInfo(route).name);
      };
      registered.disposers.push(disposer);
      return disposer;
    },
    registerConfigurableProviders(entries) {
      registered.directory.push(entries);
      return {
        replace: (next) => {
          registered.directory[registered.directory.length - 1] = next;
        },
      };
    },
    registerModelDiscovery(ns, handler) {
      registered.discovery.push({ ns, handler });
      const disposer = () => registered.disposed.push("discovery");
      registered.disposers.push(disposer);
      return disposer;
    },
  };

  const records = new Map();
  const credentials = {
    async readRecord(key) {
      return records.get(key);
    },
    async describeRecord(key) {
      const record = records.get(key);
      return record === undefined
        ? { key, configured: false }
        : { key, configured: true, kind: record.kind };
    },
    async listRecords() {
      return [...records].map(([key, record]) => ({ key, kind: record.kind }));
    },
    async modifyRecord(key, mutate) {
      // Match the real store: returning undefined from the mutation DECLINES the
      // write and leaves the entry untouched.
      const current = records.get(key);
      const next = await mutate(current);
      if (next === undefined) return current;
      records.set(key, next);
      return next;
    },
    async deleteRecord(key) {
      records.delete(key);
    },
    async resolve(ref) {
      return undefined;
    },
  };

  const authorization = {
    registerFlow(flow) {
      registered.flows.push(flow);
      const disposer = () => registered.disposed.push("flow");
      registered.disposers.push(disposer);
      return disposer;
    },
    // The handlers under test must not drive the OAuth flow (that is section 5's
    // job, against a stubbed endpoint): begin records the request and reports a
    // cancelled attempt.
    async begin(request) {
      registered.beginRequests.push(request);
      return { status: "cancelled" };
    },
  };

  const commands = {
    register(definition) {
      registered.commands.push(definition);
    },
  };

  const userQuestions = {
    // Configurable per section: the default dismissal path (askOrDecline maps this
    // to its Declined stop, so the confirm-asking commands exit without touching
    // the store), and an answering mode for the sections that drive a confirm through.
    answer: undefined,
    async ask(request) {
      if (this.answer === undefined) {
        throw Object.assign(new Error("The question was dismissed"), { code: "ASK_CANCELLED" });
      }
      return this.answer(request);
    },
  };

  // The settings service face the plugin's inner inject resolves. describe() is
  // host-synchronous and answers the projected section. mutate() applies path ops
  // of any depth (the real applyPathOp creates intermediate objects and honours
  // dict fields). `hideEntry` models the real service's active-fiber filter: an
  // entry whose fiber is still starting is absent from describe(), and its writes
  // are refused.
  const settingsState = { hideEntry: false };
  const sections = new Map();
  const revisions = new Map();
  const settings = {
    mutates: [],
    configure() {
      return () => {};
    },
    describe() {
      return [...sections.entries()]
        .filter(([ns]) => !(settingsState.hideEntry && ns === "claude-subscription"))
        .map(([ns, value]) => ({ ns, value, revision: revisions.get(ns) ?? 0 }));
    },
    async mutate(ns, ops) {
      if (settingsState.hideEntry && ns === "claude-subscription") {
        throw new Error(`Plugin entry "${ns}" is no longer configurable`);
      }
      this.mutates.push({ ns, ops });
      let section = sections.get(ns) ?? {};
      for (const op of ops) section = applyPathOp(section, op.path, op);
      sections.set(ns, section);
      revisions.set(ns, (revisions.get(ns) ?? 0) + 1);
    },
  };

  return {
    registered,
    settings,
    settingsState,
    userQuestions,
    services: { llm, credentials, authorization, commands, userQuestions, settings },
  };
}

const { registered, settings, settingsState, userQuestions, services } = makeServices();

const ctx = new Context();
for (const [name, service] of Object.entries(services)) ctx.provide(name, service);

const assert = (await import("node:assert/strict")).default;

/** The route each fixture account is stored on: the hash of its identity. */
const FIRST_ROUTE = hashRoute(identityOf({ accountId: "a-1", orgId: "o-1" }));
const SECOND_ROUTE = hashRoute(identityOf({ accountId: "a-2", orgId: "o-2" }));
const STALE_ROUTE = hashRoute(identityOf({ accountId: "a-3", orgId: "o-3" }));
const HIDDEN_ROUTE = hashRoute(identityOf({ accountId: "a-5", orgId: "o-5" }));
const OTHER_ROUTE = hashRoute(identityOf({ accountId: "a-6", orgId: "o-6" }));
const CATALOG_ROUTE = OTHER_ROUTE;
const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

// The plan endpoints and the model selector answer with one fixture for the
// whole run: no code path here may touch the network.
const jsonResponse = (payload) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const USAGE_FIXTURE = {
  limits: [
    { kind: "session", percent: 42, resets_at: new Date(Date.now() + 3 * 3_600_000).toISOString() },
    { group: "weekly", kind: "weekly", percent: 71 },
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 12,
      scope: { model: { display_name: "Fable" } },
    },
  ],
  extra_usage: {
    is_enabled: true,
    utilization: 8,
    used_credits: 250,
    monthly_limit: 1000,
    currency: "USD",
    decimal_places: 2,
  },
};
const PROFILE_FIXTURE = {
  organization: { organization_type: "claude_max", rate_limit_tier: "claude_max_standard" },
};
const CATALOG_FIXTURE = {
  model_selector_config: [
    {
      models: [
        {
          id: "claude-fable-5-1",
          name: "Fable 5.1",
          runtime: {
            max_input_tokens: 1_000_000,
            max_output_tokens: 128_000,
            effort_levels: ["low", "medium", "high", "xhigh", "max"],
            default_effort: "high",
            family: "fable",
          },
        },
        {
          id: "claude-opus-5-5",
          name: "Opus 5.5",
          runtime: {
            max_input_tokens: 1_000_000,
            max_output_tokens: 128_000,
            effort_levels: ["low", "medium", "high", "xhigh", "max"],
            default_effort: "medium",
            family: "opus",
          },
        },
        {
          id: "claude-sonnet-5",
          name: "Sonnet 5",
          runtime: {
            max_input_tokens: 1_000_000,
            max_output_tokens: 128_000,
            effort_levels: ["low", "high"],
            default_effort: "high",
            family: "sonnet",
          },
        },
        {
          id: "claude-haiku-4-5-20251001",
          name: "Haiku 4.5",
          runtime: { max_input_tokens: 200_000, max_output_tokens: 64_000, family: "haiku" },
        },
      ],
    },
  ],
};
globalThis.fetch = async (url) => {
  const target = String(url);
  if (target === "https://api.anthropic.com/api/oauth/usage") return jsonResponse(USAGE_FIXTURE);
  if (target === "https://api.anthropic.com/api/oauth/profile")
    return jsonResponse(PROFILE_FIXTURE);
  if (target === "https://api.anthropic.com/api/model_selector/cc")
    return jsonResponse(CATALOG_FIXTURE);
  // Fail closed: this run claims to be network-free, so anything beyond the stubbed
  // endpoints is a fault that must fail the run, not reach the real network.
  throw new Error(`unexpected fetch ${target}`);
};

/** One fetched row as the normalized entry the engine stores. */
const catalogEntry = (row) => ({
  id: row.id,
  name: row.name,
  contextWindow: row.runtime.max_input_tokens,
  maxTokens: row.runtime.max_output_tokens,
  input: ["text", "image"],
  ...(row.runtime.effort_levels === undefined ? {} : { effortLevels: row.runtime.effort_levels }),
  ...(row.runtime.default_effort === undefined
    ? {}
    : { defaultEffort: row.runtime.default_effort }),
  ...(row.runtime.family === undefined ? {} : { family: row.runtime.family }),
});
const CATALOG_ENTRIES = CATALOG_FIXTURE.model_selector_config[0].models.map(catalogEntry);
const seededCatalog = {
  accounts: Object.fromEntries(
    [FIRST_ROUTE, OTHER_ROUTE].map((route) => [
      route,
      { fetchedAt: Date.now(), etag: null, models: CATALOG_ENTRIES },
    ]),
  ),
};

// Mount the plugin as a loader would: config parsed through its own schema, with
// the RAW object (cordis resolves it through the plugin's Config itself; passing an
// already-parsed value would hand the volatile wrapper back into validation and
// fail). openBrowser: false, so this harness never opens a browser. The seeded
// catalog reading stands in for a previous run's snapshot, since this mock settings
// service does not push volatile writes back into the mounted plugin's config.
const rawConfig = {
  debug: true,
  extraBetas: ["test-beta-0001"],
  openBrowser: false,
  catalog: seededCatalog,
};
const pluginFiber = ctx.plugin(plugin, rawConfig);
await pluginFiber;
// ctx.inject registrations settle on their own fibers. Give them a tick.
await new Promise((resolve) => setTimeout(resolve, 20));

const settingsOf = () => settings.describe().find((row) => row.ns === "claude-subscription")?.value;

// 1. Mount-time surfaces: the plugin joins no configurable-provider directory
// row (the built-in editor stubs third-party namespaces), and its config
// defaults parse.
assert.equal(
  registered.directory.length,
  0,
  "no configurable-provider row (the built-in editor stubs third-party namespaces)",
);
// The kill switch is a parsed config default, on unless an operator opts out.
assert.equal(plugin.Config({}).systemPromptUpdates, true);
assert.equal(plugin.Config({ systemPromptUpdates: false }).systemPromptUpdates, false);

// 1b. Model discovery is registered for the settings namespace and serves the
// built-in catalog for the browser card's "Fetch models". A discovery call
// without the `ping:` prefix refreshes no account.
{
  const discovery = registered.discovery.find(
    (candidate) => candidate.ns === "claude-subscription",
  );
  assert.ok(discovery, "model discovery is registered for the settings namespace");
  const found = await discovery.handler({ provider: "claude-subscription" });
  assert.equal(found.length, 0, "no reading exists before an account signs in");
  // No account exists yet: a ping for the route it will claim publishes no
  // snapshot.
  await discovery.handler({ provider: `ping:${FIRST_ROUTE}` });
  await settle(30);
  assert.equal(
    settings.mutates.some(
      (call) => call.ops[0]?.op === "set" && call.ops[0]?.path?.[0] === "usage",
    ),
    false,
    "a ping for a route that is not an account publishes no snapshot",
  );
}

// 2. The authorization flow is registered under the login staging key: the
// account's real route depends on its identity, which is only known after the
// OAuth exchange, and the seam confirms the commit it observed on the flow's
// own key.
assert.equal(registered.flows.length, 1);
assert.equal(registered.flows[0].key, "claude-subscription/login-staging");
assert.equal(registered.flows[0].methods[0].id, "oauth");

// 3. Every command handler runs on an accountless install: the handlers reach
// their dependencies without a stored credential.
{
  for (const command of registered.commands) {
    const outcome = await command.handler({
      agent: { name: "verify-load" },
      signal: new AbortController().signal,
    });
    assert.equal(outcome.kind, "success", `${command.name} runs with no credential stored`);
    if (command.name === "claude-account") {
      const lines = outcome.text.split("\n");
      assert.equal(lines[0], "Claude account");
      assert.equal(lines[1], "Auth: Not signed in");
      assert.match(lines[2], /^Note: No Claude credential stored\./);
    }
  }
  assert.equal(registered.beginRequests.length, 1, "login begins the authorization flow");
  assert.equal(
    registered.beginRequests[0].key,
    registered.flows[0].key,
    "the command drives the plugin's own flow",
  );
  // The cancelled login's finally retired the staging record.
  assert.equal(
    await services.credentials.readRecord("claude-subscription/login-staging"),
    undefined,
    "a cancelled login leaves no staging record",
  );
}

// 4. The flow runs end-to-end against a stubbed token endpoint: the grant is
// committed through the flow's session to the staging key (satisfying the
// seam's commit observation), and the flow then stores the account on the hash
// route its identity picks.
const flow = registered.flows[0];
const committed = [];
{
  const tokenRequests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://api.anthropic.com/v1/oauth/token")) {
      tokenRequests.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({
          access_token: "sk-ant-oat01-verify",
          refresh_token: "r-verify",
          expires_in: 3600,
          account: { uuid: "a-1", email_address: "verify@example.com" },
          organization: { uuid: "o-1", name: "Verify Org" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    await flow.run({
      method: "oauth",
      signal: new AbortController().signal,
      notify() {},
      prompt: async () => "verify-code",
      commit: async (record) => {
        committed.push(record);
        // The real seam writes the record through credentials and fires
        // the store's event. This harness does both by hand.
        await services.credentials.modifyRecord(flow.key, () => record);
        ctx.emit("credentials/record-updated", flow.key);
      },
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(tokenRequests.length, 1, "exactly one token exchange");
  assert.equal(tokenRequests[0].grant_type, "authorization_code");
  assert.equal(tokenRequests[0].code, "verify-code");
  assert.equal(committed.length, 1, "the flow commits the grant through the session");
  assert.equal(committed[0].kind, "grant");
  assert.equal(committed[0].payload.access, "sk-ant-oat01-verify");
  assert.equal(committed[0].payload.email, "verify@example.com");
  assert.deepEqual(
    JSON.parse(JSON.stringify(committed[0].payload)),
    committed[0].payload,
    "the payload survives the store's strict JSON validation",
  );
  // The adoption: the account record exists on the identity's hash route,
  // carrying the sign-in order stamp.
  const stored = await services.credentials.readRecord(`claude-subscription/${FIRST_ROUTE}`);
  assert.equal(stored.kind, "grant");
  assert.equal(stored.payload.email, "verify@example.com");
  assert.ok(Number.isFinite(stored.payload.addedAt), "the adopted grant carries its sign-in order");
  // The staging record is still there: the flow must not delete it (the
  // seam's post-attempt check). The command's finally does.
  assert.ok(
    await services.credentials.readRecord("claude-subscription/login-staging"),
    "the flow leaves the staging record for the command to retire",
  );
}

// 4b. The adopted account's record event re-synced the route set and wrote the
// display mirror. The real store fires `credentials/record-updated`; this fake
// store does not, so the harness emits it for the adopted record.
ctx.emit("credentials/record-updated", `claude-subscription/${FIRST_ROUTE}`);
await settle(150);
{
  const mirrorOp = settings.mutates
    .filter((call) => call.ops[0]?.path?.[0] === "accounts")
    .map((call) => call.ops[0])
    .filter((op) => op.path[1] === "mirror")
    .at(-1);
  assert.ok(mirrorOp, "the account mirror was written");
  assert.deepEqual(mirrorOp.path, ["accounts", "mirror"]);
  assert.deepEqual(
    mirrorOp.value.accounts.map((account) => [account.route, account.email, account.status]),
    [[FIRST_ROUTE, "verify@example.com", "signedIn"]],
  );
  assert.equal(registered.liveAdapters.has(FIRST_ROUTE), true, "the account's route is registered");
  assert.equal(registered.adapters.length, 1, "one adapter, one route");
  assert.deepEqual(registered.adapters[0].routes, [FIRST_ROUTE]);
}
const adapter = registered.adapters[0].adapter;
// The picker heading names the plan once the background lookup lands, and the
// unknown state is not a guess.
assert.match(adapter.providerInfo(FIRST_ROUTE).name, /^Claude (subscription|Max)$/);

// 5. The catalog and the OAuth capability declaration, through this route.
{
  // The record event fetched the fixture selector; give the background run
  // time to publish it before the picker is asked.
  await settle(400);
  const models = await adapter.listModels(FIRST_ROUTE);
  assert.equal(models.length, 4);
  assert.equal(models[0].id, "claude-fable-5-1");
  const info = await adapter.resolveModel(FIRST_ROUTE, "claude-opus-5-5", undefined);
  assert.equal(info.context.contextWindow, 1000000);
  assert.equal(info.reasoning.defaultEffort, "medium");
  // The catalog does not decide the prompt-update capability; prepareCall
  // declares it for every model on this OAuth route.
  assert.equal(info.systemPromptUpdate, undefined);
}
// 6. Credential round-trip: the stored grant serves prepareCall.
const prepared = await adapter.prepareCall(FIRST_ROUTE, "claude-haiku-4-5-20251001", undefined);
assert.equal(prepared.model.id, "claude-haiku-4-5-20251001");
assert.equal(typeof prepared.stream, "function");
assert.equal(prepared.model.systemPromptUpdate, "in-history");

// 6b. With an account stored, the handlers run their guarded paths. The
// confirm asks are dismissed (ASK_CANCELLED), so login and logout stop without
// touching the stored grant. /claude-usage fetches the plan endpoints with the
// stored token (stubbed above).
{
  let usageOutcome;
  let accountOutcome;
  for (const command of registered.commands) {
    const outcome = await command.handler({
      agent: { name: "verify-load" },
      signal: new AbortController().signal,
    });
    assert.equal(outcome.kind, "success", `${command.name} runs with a credential stored`);
    if (command.name === "claude-usage") usageOutcome = outcome;
    if (command.name === "claude-account") accountOutcome = outcome;
  }
  const accountLines = accountOutcome.text.split("\n");
  assert.equal(accountLines[0], "Claude account");
  assert.equal(accountLines[1], "Auth: Subscription (OAuth)");
  assert.equal(accountLines[2], "Account: verify@example.com");
  assert.equal(accountLines[3], "Organization: Verify Org");
  assert.equal(accountLines[4], "Plan: Max");
  assert.ok(accountLines.includes(`Route: ${FIRST_ROUTE}`), "the account text names its route");
  const lines = usageOutcome.text.split("\n");
  assert.equal(lines[0], "Claude usage");
  assert.equal(lines[1], "Account: verify@example.com");
  assert.equal(lines[2], `Route: ${FIRST_ROUTE}`);
  assert.equal(lines[3], "Plan: Max");
  assert.match(lines.at(-1), /^Observed: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.ok(
    !Number.isNaN(Date.parse(lines.at(-1).slice("Observed: ".length))),
    "Observed stamps a parseable ISO time",
  );
  assert.match(usageOutcome.text, /\[████████░░░░░░░░░░░░\] 42% used/);
}
assert.ok(
  await services.credentials.readRecord(`claude-subscription/${FIRST_ROUTE}`),
  "a dismissed logout keeps the stored credential",
);

// 6c. A second account: storing its record re-syncs the route set (a second
// adapter, named for its account), and the targeted commands reach it.
{
  await services.credentials.modifyRecord(`claude-subscription/${SECOND_ROUTE}`, () => ({
    kind: "grant",
    payload: {
      access: "sk-ant-oat01-second",
      refresh: "r2",
      expires: Date.now() + 3600_000,
      email: "other@example.com",
      accountId: "a-2",
      orgId: "o-2",
      plan: "Ultra",
      addedAt: Date.now(),
    },
  }));
  ctx.emit("credentials/record-updated", `claude-subscription/${SECOND_ROUTE}`);
  await settle(150);
  const second = registered.adapters.find((entry) => entry.routes[0] === SECOND_ROUTE);
  assert.ok(second, "the second account's adapter is registered");
  assert.equal(second.adapter.providerInfo(SECOND_ROUTE).name, "Claude Ultra (other@example.com)");
  assert.equal(
    registered.adapters
      .find((entry) => entry.routes[0] === FIRST_ROUTE)
      .adapter.providerInfo(FIRST_ROUTE).name,
    "Claude Max (verify@example.com)",
    "the first account gains the email once a second account exists, and its refreshed plan",
  );
  assert.equal(
    registered.published.get(SECOND_ROUTE),
    "Claude Ultra (other@example.com)",
    "the registry was handed the final heading, not the previous one",
  );
  assert.equal(
    registered.published.get(FIRST_ROUTE),
    "Claude Max (verify@example.com)",
    "the first route's published heading gains the email",
  );
  const mirrorOp = settings.mutates.filter((call) => call.ops[0]?.path?.[1] === "mirror").at(-1)
    .ops[0];
  assert.equal(mirrorOp.value.accounts.length, 2, "the mirror lists both accounts");
  // The targeted usage command reaches the second account without asking.
  let secondUsage;
  for (const command of registered.commands) {
    if (command.name !== "claude-usage") continue;
    const outcome = await command.handler({
      agent: { name: "verify-load" },
      rawInput: "other@example.com",
      signal: new AbortController().signal,
    });
    assert.equal(outcome.kind, "success");
    secondUsage = outcome;
  }
  assert.equal(
    secondUsage.text.split("\n")[2],
    `Route: ${SECOND_ROUTE}`,
    "the argument selected the second account",
  );
  // Seed the account's saved model list so logout's unset is observable.
  await settings.mutate("claude-subscription", [
    { op: "set", path: ["accounts", "models", SECOND_ROUTE], value: [{ id: "claude-haiku-4-5" }] },
  ]);
  // Signing the second account out (the confirm answers "Sign out") deletes
  // its record, removes its route, and drops its usage snapshot.
  userQuestions.answer = (request) => ({
    answers: request.questions.map((question) => ({ id: question.id, selected: ["Sign out"] })),
  });
  try {
    const logout = registered.commands.find((command) => command.name === "claude-logout");
    const outcome = await logout.handler({
      agent: { name: "verify-load" },
      rawInput: "other@example.com",
      signal: new AbortController().signal,
    });
    assert.equal(outcome.kind, "success");
    assert.match(outcome.text, /Removed other@example\.com/);
    assert.match(
      outcome.text,
      /removed from this machine only/,
      "the text says the removal is local",
    );
  } finally {
    userQuestions.answer = undefined;
  }
  assert.equal(
    await services.credentials.readRecord(`claude-subscription/${SECOND_ROUTE}`),
    undefined,
    "the removed record is deleted",
  );
  await settle(200);
  assert.equal(
    registered.liveAdapters.has(SECOND_ROUTE),
    false,
    "the removed route is no longer registered",
  );
  assert.equal(
    registered.disposed.includes(`adapter:${SECOND_ROUTE}`),
    true,
    "the adapter was disposed",
  );
  assert.equal(registered.liveAdapters.has(FIRST_ROUTE), true, "the first account is unaffected");
  assert.ok(
    settings.mutates.some((call) =>
      call.ops.some(
        (op) => op.op === "unset" && op.path[0] === "usage" && op.path[2] === SECOND_ROUTE,
      ),
    ),
    "the removed account's usage snapshot is dropped",
  );
  assert.ok(
    settings.mutates.some((call) =>
      call.ops.some(
        (op) => op.op === "unset" && op.path.join("/") === `accounts/models/${SECOND_ROUTE}`,
      ),
    ),
    "the removed account's saved model list is dropped",
  );
  const latestMirror = settings.mutates.filter((call) => call.ops[0]?.path?.[1] === "mirror").at(-1)
    .ops[0];
  assert.deepEqual(
    latestMirror.value.accounts.map((account) => account.route),
    [FIRST_ROUTE],
    "the mirror drops the removed account",
  );
}

// 6d. The mirror survives the mount-time race with the plugin's own fiber: the
// real settings service only projects active fibers, so a sync right after a
// fresh mount is refused ("no longer configurable") and must retry until the
// entry becomes describable.
{
  const untouched = settings.mutates.length;
  settingsState.hideEntry = true;
  ctx.emit("credentials/record-updated", `claude-subscription/${FIRST_ROUTE}`);
  await settle(400);
  assert.equal(settings.mutates.length, untouched, "a refused write records nothing");
  settingsState.hideEntry = false;
  await settle(3600);
  assert.ok(settings.mutates.length > untouched, "the retry lands the refused sync");
}

// 6e. The usage engine: a ping for the signed-in account publishes its
// snapshot into the per-account section. An immediate re-ping is
// cooldown-blocked. And the recorded sections parse through the plugin's
// Config schema, the round-trip a volatile update performs at mount, whose
// silent rejection is exactly what this proves cannot happen.
{
  const discovery = registered.discovery.find(
    (candidate) => candidate.ns === "claude-subscription",
  );
  const usageWrites = () =>
    settings.mutates.filter(
      (call) => call.ops[0]?.path?.[0] === "usage" && call.ops[0].op === "set",
    );
  const accountSnapshot = () =>
    usageWrites().filter(
      (call) => call.ops[0].path[2] === FIRST_ROUTE && call.ops[0].value.plan !== null,
    );
  // The logout above drove this account's engine (its record event), so the
  // ping lands inside the per-account fetch floor: the fetch is scheduled,
  // not immediate. Wait it out.
  await discovery.handler({ provider: `ping:${FIRST_ROUTE}` });
  const deadline = Date.now() + 35_000;
  while (accountSnapshot().length === 0 && Date.now() < deadline) await settle(250);
  assert.ok(accountSnapshot().length >= 1, "the engine published the pinged account's snapshot");
  const snapshotOp = accountSnapshot().at(-1).ops[0];
  assert.deepEqual(snapshotOp.path, ["usage", "snapshots", FIRST_ROUTE]);
  const snapshot = snapshotOp.value;
  assert.equal(snapshot.plan, "Max", "the publish carries the fixture plan");
  assert.deepEqual(
    snapshot.windows.map((window) => [window.label, window.percent]),
    [
      ["5-hour", 42],
      ["Weekly", 71],
      ["Weekly (Fable only)", 12],
    ],
  );
  assert.ok(Number.isFinite(snapshot.windows[0].resetsAt), "the reset stamp is an epoch");
  // The immediate re-ping is cooldown-blocked: no fetch, no write.
  const writes = accountSnapshot().length;
  await discovery.handler({ provider: `ping:${FIRST_ROUTE}` });
  await settle(150);
  assert.equal(accountSnapshot().length, writes, "the cooldown-blocked ping writes nothing");
  // The persisted sections survive the config parse a volatile update
  // performs at mount, the silent-swallow failure mode.
  const persisted = settingsOf();
  const parsed = plugin.Config({
    debug: true,
    extraBetas: [],
    openBrowser: false,
    accounts: { mirror: persisted.accounts.mirror, models: persisted.accounts.models ?? {} },
    usage: { snapshots: persisted.usage.snapshots },
  });
  const unwrap = (field) => (typeof field?.get === "function" ? field.get() : field);
  assert.deepEqual(
    unwrap(parsed.usage).snapshots,
    persisted.usage.snapshots,
    "the usage snapshots survive the mount parse unchanged",
  );
  assert.deepEqual(
    unwrap(parsed.accounts).mirror,
    persisted.accounts.mirror,
    "the account mirror survives the mount parse unchanged",
  );
}

// 6f. A retry scheduled before the mount window closed must not overwrite a
// newer sync's write: the section's generation moved on, so the stale replay
// stands down and the mirror keeps the route the newer sync added.
{
  settingsState.hideEntry = true;
  ctx.emit("credentials/record-updated", `claude-subscription/${FIRST_ROUTE}`);
  await settle(400); // sync A was refused; its retry is due in about a second
  settingsState.hideEntry = false;
  await services.credentials.modifyRecord(`claude-subscription/${STALE_ROUTE}`, () => ({
    kind: "grant",
    payload: {
      access: "sk-ant-oat01-stale",
      refresh: "r3",
      expires: Date.now() + 3600_000,
      email: "stale@example.com",
      accountId: "a-3",
      orgId: "o-3",
      plan: "Pro",
      addedAt: Date.now(),
    },
  }));
  ctx.emit("credentials/record-updated", `claude-subscription/${STALE_ROUTE}`);
  await settle(300); // sync B wrote the mirror (with the new route) before A's retry
  await settle(2500); // past A's 1 s retry: it must not have replayed its older value
  const routes = settingsOf().accounts.mirror.accounts.map((account) => account.route);
  assert.ok(routes.includes(STALE_ROUTE), "a stale retry does not drop the newer sync's route");
  assert.ok(routes.includes(FIRST_ROUTE), "the older account is still mirrored");
}

// 6f2. An OAuth request that runs out of quota stores its marker and refreshes
// usage when Retry-After is long.
{
  const allowFetch = globalThis.fetch;
  const exhaustedUsage = {
    ...USAGE_FIXTURE,
    limits: [{ ...USAGE_FIXTURE.limits[0], percent: 100 }],
  };
  const messagesResponse = () =>
    new Response(ALLOWANCE_429_BODY, {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "7200" },
    });
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.endsWith("/v1/messages")) return messagesResponse();
    if (target === "https://api.anthropic.com/api/oauth/usage") return jsonResponse(exhaustedUsage);
    return allowFetch(url);
  };
  try {
    await assert.rejects(
      async () => {
        for await (const chunk of adapter.stream({
          provider: FIRST_ROUTE,
          model: "claude-haiku-4-5-20251001",
          messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        })) {
          // The failure throws before the first chunk.
        }
      },
      (error) => {
        assert.equal(error.code, "QUOTA", "the long-floor allowance 429 is terminal");
        assert.equal(error.failure.providerRetryAfterMs, 7_200_000);
        return true;
      },
    );
    await settle(200); // the marker write and the immediate usage refresh settle
    const markerOp = settings.mutates.find(
      (call) => call.ops[0]?.path?.[0] === "usage" && call.ops[0]?.path?.[1] === "lastQuotaFailure",
    )?.ops[0];
    assert.ok(markerOp, "the quota failure recorded the marker");
    assert.deepEqual(markerOp.path, ["usage", "lastQuotaFailure"]);
    assert.equal(markerOp.value.route, FIRST_ROUTE);
    assert.ok(Number.isFinite(markerOp.value.at), "the marker carries its timestamp");
    const refreshed = settings.mutates
      .filter((call) => call.ops[0]?.path?.[0] === "usage" && call.ops[0].op === "set")
      .map((call) => call.ops[0])
      .filter((op) => op.path[2] === FIRST_ROUTE)
      .at(-1);
    assert.ok(refreshed, "the failure refreshed the account's usage snapshot");
    assert.equal(
      refreshed.value.windows[0].percent,
      100,
      "the refresh published the exhausted reading",
    );
  } finally {
    globalThis.fetch = allowFetch;
  }
}

// 6g. `--all` removes every stored account and is not combined with an
// explicit account.
{
  const logout = registered.commands.find((command) => command.name === "claude-logout");
  const before = (await services.credentials.listRecords()).length;
  const invalid = await logout.handler({
    agent: { name: "verify-load" },
    rawInput: "--all stale@example.com",
    signal: new AbortController().signal,
  });
  assert.equal(invalid.kind, "error");
  assert.match(invalid.text, /either an account or --all/);
  assert.equal(
    (await services.credentials.listRecords()).length,
    before,
    "the rejected combination changes nothing",
  );
  assert.equal(before, 2, "both stored accounts are still signed in");
  userQuestions.answer = (request) => ({
    answers: request.questions.map((question) => ({ id: question.id, selected: ["Sign out"] })),
  });
  try {
    const outcome = await logout.handler({
      agent: { name: "verify-load" },
      rawInput: "--all",
      signal: new AbortController().signal,
    });
    assert.equal(outcome.kind, "success");
    assert.match(outcome.text, /Removed 2 accounts/);
  } finally {
    userQuestions.answer = undefined;
  }
  assert.equal(
    (await services.credentials.listRecords()).length,
    0,
    "every stored record is deleted",
  );
  await settle(200);
  assert.deepEqual(
    settingsOf().accounts.mirror.accounts,
    [],
    "the mirror lists no removed accounts",
  );
  assert.equal(
    registered.liveAdapters.size,
    0,
    "no route remains: the plugin registers nothing without an account",
  );
}

// 6h. A post-logout ping for a removed route must not recreate a usage
// snapshot. The guarded discovery callback clears instead of fetching.
{
  const discovery = registered.discovery.find(
    (candidate) => candidate.ns === "claude-subscription",
  );
  const writesForRemovedRoute = () =>
    settings.mutates.filter(
      (call) =>
        call.ops[0]?.op === "set" &&
        call.ops[0]?.path?.[0] === "usage" &&
        call.ops[0]?.path?.[2] === STALE_ROUTE,
    ).length;
  const before = writesForRemovedRoute();
  await discovery.handler({ provider: `ping:${STALE_ROUTE}` });
  await settle(100);
  assert.equal(writesForRemovedRoute(), before, "a removed route's ping publishes no snapshot");
}

// 6h2. A settings service refusing writes must not prevent logout from
// removing the target route. The route set is credential-derived.
{
  await services.credentials.modifyRecord(`claude-subscription/${OTHER_ROUTE}`, () => ({
    kind: "grant",
    payload: {
      access: "sk-ant-oat01-other",
      refresh: "r-other",
      expires: Date.now() + 3600_000,
      email: "other@example.com",
      accountId: "a-6",
      orgId: "o-6",
      plan: "Pro",
      addedAt: Date.now(),
    },
  }));
  await services.credentials.modifyRecord(`claude-subscription/${HIDDEN_ROUTE}`, () => ({
    kind: "grant",
    payload: {
      access: "sk-ant-oat01-hide",
      refresh: "r-hide",
      expires: Date.now() + 3600_000,
      email: "hide@example.com",
      accountId: "a-5",
      orgId: "o-5",
      plan: "Pro",
      addedAt: Date.now() + 1,
    },
  }));
  ctx.emit("credentials/record-updated", `claude-subscription/${HIDDEN_ROUTE}`);
  ctx.emit("credentials/record-updated", `claude-subscription/${OTHER_ROUTE}`);
  await settle(200);
  assert.equal(registered.liveAdapters.has(HIDDEN_ROUTE), true);
  settingsState.hideEntry = true;
  userQuestions.answer = (request) => ({
    answers: request.questions.map((question) => ({ id: question.id, selected: ["Sign out"] })),
  });
  try {
    const logout = registered.commands.find((command) => command.name === "claude-logout");
    const outcome = await logout.handler({
      agent: { name: "verify-load" },
      rawInput: "hide@example.com",
      signal: new AbortController().signal,
    });
    assert.equal(outcome.kind, "success");
  } finally {
    userQuestions.answer = undefined;
    settingsState.hideEntry = false;
  }
  await settle(300);
  assert.equal(
    registered.liveAdapters.has(HIDDEN_ROUTE),
    false,
    "the route is removed even while settings writes are refused",
  );
  assert.equal(registered.liveAdapters.has(OTHER_ROUTE), true, "the other account is unaffected");
}

// 6i. The single-account usage field and an orphan snapshot are removed even
// when the cleaner first runs inside the mount window. An entry the service
// does not project yet is not "nothing to remove": the unset is attempted and
// the retry lands once the entry is describable. (`hideEntry` models that
// window, absent from describe(), writes refused, so this mounts a second,
// isolated instance with a profile patch carrying the removed fields.)
{
  const windowHarness = makeServices();
  await windowHarness.settings.mutate("claude-subscription", [
    {
      op: "set",
      path: ["usage", "snapshot"],
      value: { observedAt: 1, plan: null, windows: [], extra: null },
    },
    {
      op: "set",
      path: ["usage", "snapshots", "claude-subscription-444444444444"],
      value: { observedAt: 1, plan: null, windows: [], extra: null },
    },
  ]);
  const seeded = windowHarness.settings
    .describe()
    .find((row) => row.ns === "claude-subscription").value;
  assert.ok(seeded.usage.snapshot !== undefined);
  assert.ok(seeded.usage.snapshots["claude-subscription-444444444444"] !== undefined);
  windowHarness.settingsState.hideEntry = true;
  const mountCtx = new Context();
  for (const [name, service] of Object.entries(windowHarness.services))
    mountCtx.provide(name, service);
  await mountCtx.plugin(plugin, { ...rawConfig });
  await settle(20);
  assert.equal(
    windowHarness.settings.mutates.some((call) => call.ops.some((op) => op.op === "unset")),
    false,
    "the first cleanup attempt is refused by the mount window",
  );
  windowHarness.settingsState.hideEntry = false;
  mountCtx.emit("credentials/record-updated", "claude-subscription/claude-subscription");
  const removableFieldsPresent = () => {
    const section = windowHarness.settings
      .describe()
      .find((row) => row.ns === "claude-subscription")?.value;
    return (
      section?.usage?.snapshot !== undefined ||
      section?.usage?.snapshots?.["claude-subscription-444444444444"] !== undefined
    );
  };
  const deadline = Date.now() + 8_000;
  while (removableFieldsPresent() && Date.now() < deadline) await settle(100);
  assert.equal(
    removableFieldsPresent(),
    false,
    "the single-account field and the stale usage snapshot are removed through the mount window",
  );
  assert.ok(
    windowHarness.settings.mutates.some((call) =>
      call.ops.some((op) => op.op === "unset" && op.path.join("/") === "usage/snapshot"),
    ),
    "the single-account usage field unset landed",
  );
  assert.ok(
    windowHarness.settings.mutates.some((call) =>
      call.ops.some(
        (op) =>
          op.op === "unset" &&
          op.path.join("/") === "usage/snapshots/claude-subscription-444444444444",
      ),
    ),
    "the orphan usage snapshot was cleared",
  );
  for (const disposer of windowHarness.registered.disposers) disposer();
}

// 6g. The model catalog: the account selector is read on demand, published
// per route, projected by discovery, and re-parsed through Config at mount.
{
  const discovery = registered.discovery.find(
    (candidate) => candidate.ns === "claude-subscription",
  );
  const SERVED_CATALOG_FIXTURE = {
    model_selector_config: [
      {
        models: [
          {
            id: "claude-opus-5-5",
            name: "Opus 5.5",
            section: "main",
            runtime: {
              max_input_tokens: 1_000_000,
              max_output_tokens: 128_000,
              effort_levels: ["low", "medium", "high", "xhigh", "max"],
              default_effort: "medium",
              family: "opus",
            },
          },
        ],
      },
    ],
  };
  const PUBLISHED_CATALOG_FIXTURE = {
    schema_version: 1,
    version: 1,
    expires_at: "2030-01-01T00:00:00Z",
    surfaces: {
      cc: {
        model_selector_config: [
          {
            models: [
              {
                id: "claude-sonnet-5-5",
                name: "Sonnet 5.5",
                runtime: {
                  max_input_tokens: 1_000_000,
                  max_output_tokens: 128_000,
                  effort_levels: ["low", "high"],
                  default_effort: "high",
                },
              },
            ],
          },
        ],
      },
    },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target === "https://api.anthropic.com/api/model_selector/cc")
      return jsonResponse(SERVED_CATALOG_FIXTURE);
    if (target === "https://downloads.claude.ai/model-catalog/v1/catalog.json")
      return jsonResponse(PUBLISHED_CATALOG_FIXTURE);
    if (target === "https://api.anthropic.com/api/oauth/usage") return jsonResponse(USAGE_FIXTURE);
    if (target === "https://api.anthropic.com/api/oauth/profile")
      return jsonResponse(PROFILE_FIXTURE);
    throw new Error(`unexpected fetch ${target}`);
  };
  try {
    // A refresh asks the host to fetch this route's selector. The reply is
    // the reading as it stands now; the published write lands asynchronously.
    await discovery.handler({ provider: `catalog:${CATALOG_ROUTE}#refresh` });
    const deadline = Date.now() + 5_000;
    const currentReading = () => settingsOf()?.catalog?.accounts?.[CATALOG_ROUTE];
    while (currentReading()?.models?.[0]?.id !== "claude-opus-5-5" && Date.now() < deadline)
      await settle(50);
    const reading = currentReading();
    assert.ok(reading, "the account selector reading was published");
    assert.equal(reading.models[0].id, "claude-opus-5-5");
    assert.equal(reading.models[0].contextWindow, 1_000_000);
    assert.ok(Number.isFinite(reading.fetchedAt));
    // A discovery call answers a list (this harness's mock settings service
    // does not push volatile updates back into the plugin's config, so the
    // projection is exercised by the unit tests, not here).
    const served = await discovery.handler({ provider: `catalog:${CATALOG_ROUTE}` });
    assert.ok(Array.isArray(served) && served.length > 0);
    // The shared published reading is fetched by an explicit refresh for a
    // route that is not a live account (the published fallback path).
    await discovery.handler({ provider: "catalog:claude-subscription-000000000000#refresh" });
    const publishedDeadline = Date.now() + 5_000;
    while (settingsOf()?.catalog?.published === undefined && Date.now() < publishedDeadline)
      await settle(50);
    assert.equal(settingsOf()?.catalog?.published?.models?.[0]?.id, "claude-sonnet-5-5");
    // The stored section survives the mount-time Config parse.
    assert.doesNotThrow(() => plugin.Config({ catalog: settingsOf().catalog }));
    // An account removed outside /claude-logout drops its reading and saved
    // list through the route reconciliation, not only on an explicit sign-out.
    await settings.mutate("claude-subscription", [
      {
        op: "set",
        path: ["accounts", "models", CATALOG_ROUTE],
        value: [{ id: "claude-opus-5-5" }],
      },
    ]);
    await services.credentials.deleteRecord(`claude-subscription/${CATALOG_ROUTE}`);
    ctx.emit("credentials/record-updated", `claude-subscription/${CATALOG_ROUTE}`);
    const clearDeadline = Date.now() + 5_000;
    while (
      settingsOf()?.catalog?.accounts?.[CATALOG_ROUTE] !== undefined &&
      Date.now() < clearDeadline
    )
      await settle(100);
    assert.equal(
      settingsOf()?.catalog?.accounts?.[CATALOG_ROUTE],
      undefined,
      "an externally removed account's reading is dropped",
    );
    assert.equal(
      settingsOf()?.accounts?.models?.[CATALOG_ROUTE],
      undefined,
      "and its saved list is dropped",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

// 7. Disposal is driven by the host lifecycle (cordis host runner), which this
// harness does not replicate. The plugin never disposes registrations on its
// own, except a route whose account is gone; the account sync disposes that
// route (the logout tests' routes).
assert.ok(
  registered.disposed.includes(`adapter:${SECOND_ROUTE}`),
  "the removed route was disposed by the account sync",
);
const routeCount = registered.adapters.length;
assert.equal(registered.disposers.length, routeCount + 2, "every registration returned a disposer");
for (const disposer of registered.disposers) disposer();
assert.equal(
  new Set(registered.disposed.filter((label) => label.startsWith("adapter:"))).size,
  routeCount,
  "every route's adapter is disposed",
);
assert.ok(
  registered.disposed.includes("discovery") && registered.disposed.includes("flow"),
  "discovery and the flow are disposed",
);

console.log("PLUGIN LOAD VERIFIED");
console.log(`  adapter routes: ${registered.adapters.map((entry) => entry.routes[0]).join(", ")}`);
console.log(`  flow key: ${registered.flows[0].key}`);
console.log(`  commands: ${registered.commands.map((c) => "/" + c.name).join(", ")}`);
console.log(`  handlers verified: ${registered.commands.length} (empty and two-account stores)`);
console.log(`  network-free: yes (browser: no, token endpoint: stubbed)`);
