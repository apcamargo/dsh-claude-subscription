/**
 * Plan-usage queries and rendering for /claude-usage, driven entirely by an
 * injected fetch implementation (no network, no credentials).
 * @module test/usage.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";
import { coworkUserAgent } from "../lib/fingerprint.js";
import {
  collectWindows,
  createUsageEngine,
  fetchPlan,
  fetchUsage,
  formatExtra,
  formatUsage,
  usageHeaders,
  usageOp,
  usagePath,
  usageSnapshot,
} from "../lib/usage.js";

/** A JSON Response the way the real endpoints answer. */
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The rendered line for one window label. */
function windowLine(lines, label) {
  return lines.find((line) => line.startsWith(`${label}:`));
}

// ---- request surface --------------------------------------------------------

test("fetchUsage GETs the usage endpoint with the plan-request headers", async () => {
  const observed = {};
  const payload = { five_hour: { utilization: 10 } };
  const data = await fetchUsage(usageHeaders("sk-ant-oat01-example"), {
    fetchImpl: async (url, init) => {
      observed.url = String(url);
      observed.init = init;
      return jsonResponse(payload);
    },
  });
  assert.deepEqual(data, payload);
  assert.equal(observed.url, "https://api.anthropic.com/api/oauth/usage");
  assert.equal(observed.init.method, undefined, "GET is the fetch default");
  assert.ok(observed.init.signal, "the request carries a signal");
  // The full header contract rides on the same request.
  assert.equal(observed.init.headers.Authorization, "Bearer sk-ant-oat01-example");
  assert.equal(observed.init.headers["anthropic-beta"], "oauth-2025-04-20");
  assert.equal(observed.init.headers["User-Agent"], coworkUserAgent);
  assert.equal(observed.init.headers.Accept, "application/json");
});

// ---- fetchUsage error mapping ----------------------------------------------

test("fetchUsage maps failures onto readable messages", async () => {
  await assert.rejects(
    fetchUsage({}, { fetchImpl: async () => jsonResponse({ message: "bad" }, 401) }),
    /HTTP 401\)\. Try \/claude-login again\.$/,
  );
  await assert.rejects(
    fetchUsage({}, { fetchImpl: async () => jsonResponse({ message: "bad" }, 403) }),
    /HTTP 403\)\. Try \/claude-login again\.$/,
  );
  await assert.rejects(
    fetchUsage({}, { fetchImpl: async () => jsonResponse({}, 500) }),
    (error) => /HTTP 500\)\.$/.test(error.message) && !error.message.includes("claude-login"),
  );
  const timeout = new Error("The operation was aborted due to timeout");
  timeout.name = "TimeoutError";
  await assert.rejects(
    fetchUsage(
      {},
      {
        fetchImpl: async () => {
          throw timeout;
        },
      },
    ),
    /Anthropic usage request timed out\.$/,
  );
  await assert.rejects(
    fetchUsage(
      {},
      {
        fetchImpl: async () => {
          throw new Error("ECONNREFUSED");
        },
      },
    ),
    /Could not reach Anthropic usage API\. Check your connection\.$/,
  );
  await assert.rejects(
    fetchUsage({}, { fetchImpl: async () => new Response("not json", { status: 200 }) }),
    /Could not parse Anthropic usage response\.$/,
  );
  await assert.rejects(
    fetchUsage(
      {},
      {
        fetchImpl: async () =>
          new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
      },
    ),
    /Invalid Anthropic usage response\.$/,
  );
  await assert.rejects(
    fetchUsage(
      {},
      {
        fetchImpl: async () =>
          new Response('"a string"', {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
    ),
    /Invalid Anthropic usage response\.$/,
  );
});

// ---- fetchPlan --------------------------------------------------------------

test("fetchPlan renders the plan from the profile", async () => {
  assert.equal(
    await fetchPlan(
      {},
      {
        fetchImpl: async () =>
          jsonResponse({
            organization: {
              organization_type: "claude_max",
              rate_limit_tier: "claude_max_standard",
            },
          }),
      },
    ),
    "Plan: Max",
  );
  // An unusable organization_type falls back to scanning the tier tokens.
  assert.equal(
    await fetchPlan(
      {},
      {
        fetchImpl: async () =>
          jsonResponse({
            organization: { organization_type: "", rate_limit_tier: "claude_pro_standard" },
          }),
      },
    ),
    "Plan: Pro",
  );
  assert.equal(
    await fetchPlan(
      {},
      {
        fetchImpl: async () =>
          jsonResponse({ organization: { organization_type: "claude_team", rate_limit_tier: "" } }),
      },
    ),
    "Plan: Team",
  );
});

test("fetchPlan degrades to an unavailable line instead of throwing", async () => {
  assert.equal(
    await fetchPlan({}, { fetchImpl: async () => new Response("", { status: 503 }) }),
    "Plan: unavailable (HTTP 503)",
  );
  assert.equal(
    await fetchPlan({}, { fetchImpl: async () => jsonResponse({}) }),
    "Plan: unavailable (no plan details returned)",
  );
  assert.equal(
    await fetchPlan(
      {},
      {
        fetchImpl: async () => {
          throw new Error("down");
        },
      },
    ),
    "Plan: unavailable (could not fetch profile)",
  );
});

// ---- formatUsage ------------------------------------------------------------

test("formatUsage renders the quota windows, flat keys, and extra usage in rank order", () => {
  const lines = formatUsage({
    limits: [
      { kind: "session", percent: 42 },
      { group: "weekly", kind: "weekly", percent: 71 },
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 12,
        scope: { model: { display_name: "Fable" } },
      },
    ],
    // Flat keys dedupe against `limits[]` windows: first writer wins.
    five_hour: { utilization: 99 },
    iguana_necktie: { utilization: 30 },
    extra_usage: {
      is_enabled: true,
      utilization: 8,
      used_credits: 250,
      monthly_limit: 1000,
      currency: "USD",
      decimal_places: 2,
    },
  });
  assert.deepEqual(
    lines.map((line) => line.slice(0, line.indexOf(":"))),
    ["5-hour", "Weekly", "Weekly (Fable only)", "Extra usage"],
  );
  assert.match(windowLine(lines, "5-hour"), /\[████████░░░░░░░░░░░░\] 42% used/);
  assert.match(windowLine(lines, "Weekly"), /\[██████████████░░░░░░\] 71% used/);
  assert.match(windowLine(lines, "Weekly (Fable only)"), /\[██░░░░░░░░░░░░░░░░░░\] 12% used/);
  assert.match(
    windowLine(lines, "Extra usage"),
    /\[██░░░░░░░░░░░░░░░░░░\] 8% used · enabled · spent 2\.50 USD · monthly cap 10\.00 USD/,
  );

  // The flat keys (a payload without `limits[]`) map onto the same labels,
  // in rank order.
  const legacy = formatUsage({
    five_hour: { utilization: 10 },
    seven_day: { utilization: 20 },
    seven_day_oberon: { utilization: 30 },
  });
  assert.deepEqual(
    legacy.map((line) => line.slice(0, line.indexOf(":"))),
    ["5-hour", "Weekly", "Weekly (Oberon only)"],
  );
});

test("a plan without a session window reports no 5-hour row", () => {
  // A verified Ultra account: weekly windows, no five_hour / session limit.
  const payload = {
    limits: [{ kind: "weekly", group: "weekly", percent: 23 }],
    five_hour: null,
    seven_day: { utilization: 23 },
  };
  const snapshot = usageSnapshot(payload, { organization: { plan_display_name: "Ultra" } }, 7);
  assert.deepEqual(snapshot, {
    observedAt: 7,
    plan: "Ultra",
    windows: [{ label: "Weekly", percent: 23 }],
    extra: null,
  });
  const lines = formatUsage(payload);
  assert.deepEqual(
    lines.map((line) => line.slice(0, line.indexOf(":"))),
    ["Weekly"],
  );
  assert.equal(
    lines.some((line) => line.startsWith("5-hour:")),
    false,
    "no 5-hour row is synthesized",
  );
});

test("scoped weeklies name their model and surface", () => {
  const lines = formatUsage({
    limits: [
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 5,
        scope: { model: { display_name: "Fable" }, surface: "claude_code" },
      },
    ],
  });
  assert.match(windowLine(lines, "Weekly (Fable only · Claude Code)"), /5% used/);

  // A scoped weekly with no reported value reads as unused, not missing.
  const unused = formatUsage({
    limits: [
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: null,
        scope: { model: { display_name: "Fable" } },
      },
    ],
  });
  assert.match(windowLine(unused, "Weekly (Fable only)"), /\[░░░░░░░░░░░░░░░░░░░░\] 0% used/);

  // A model-less scoped weekly says so.
  const modelOnly = formatUsage({
    limits: [{ kind: "weekly_scoped", group: "weekly", percent: 3 }],
  });
  assert.match(windowLine(modelOnly, "Weekly (model only)"), /3% used/);
});

test("reset times render as relative countdowns", () => {
  const ahead = (ms) => new Date(Date.now() + ms).toISOString();
  const minutes = 30 * 60_000;
  const hours = 90 * 60_000;
  const days = 3 * 86_400_000 + 7 * 3_600_000;
  const weeks = 7 * 86_400_000;

  assert.doesNotMatch(
    windowLine(formatUsage({ five_hour: { utilization: 1 } }), "5-hour"),
    /resets/,
    "no resets_at means no suffix",
  );
  const halfHour = windowLine(
    formatUsage({ five_hour: { utilization: 1, resets_at: ahead(minutes) } }),
    "5-hour",
  );
  assert.match(
    halfHour,
    /resets in 30m$/,
    "the countdown stands alone — no absolute clock is appended",
  );
  assert.match(
    windowLine(formatUsage({ five_hour: { utilization: 1, resets_at: ahead(hours) } }), "5-hour"),
    /resets in 1h 30m$/,
  );
  assert.match(
    windowLine(formatUsage({ five_hour: { utilization: 1, resets_at: ahead(days) } }), "5-hour"),
    /resets in 3d 7h$/,
  );
  assert.match(
    windowLine(formatUsage({ five_hour: { utilization: 1, resets_at: ahead(weeks) } }), "5-hour"),
    /resets in 7d$/,
  );
  assert.match(
    windowLine(
      formatUsage({
        five_hour: { utilization: 1, resets_at: new Date(Date.now() - 1000).toISOString() },
      }),
      "5-hour",
    ),
    /resets now$/,
    "elapsed windows render the bare reset",
  );
  assert.match(
    windowLine(formatUsage({ five_hour: { utilization: 1, resets_at: "not-a-date" } }), "5-hour"),
    /1% used$/,
    "unparseable resets render no suffix",
  );
});

test("the usage bar clamps but the reported percent does not", () => {
  const low = windowLine(formatUsage({ five_hour: { utilization: -5 } }), "5-hour");
  assert.match(low, /\[░░░░░░░░░░░░░░░░░░░░\] -5% used/);
  const high = windowLine(formatUsage({ five_hour: { utilization: 125 } }), "5-hour");
  assert.match(high, /\[████████████████████\] 125% used/);
});

test("a disabled extra-usage pool renders no row, while spend still reports", () => {
  // "disabled" is a setting, not a reading: an account that never opted in
  // carries no row at all, and a zero utilization does not resurrect one.
  for (const extra_usage of [{ is_enabled: false }, { is_enabled: false, utilization: 0 }]) {
    assert.deepEqual(
      formatUsage({ five_hour: { utilization: 1 }, extra_usage }).filter((line) =>
        line.startsWith("Extra usage"),
      ),
      [],
    );
  }
  // A pool that reports no flag still says so: the payload named one.
  assert.match(windowLine(formatUsage({ extra_usage: {} }), "Extra usage"), /status unknown$/);
  // Money that already landed is never hidden by switching the pool off.
  assert.match(
    windowLine(
      formatUsage({ extra_usage: { is_enabled: false, used_credits: 250, currency: "USD" } }),
      "Extra usage",
    ),
    /^Extra usage:\s+disabled · spent 2\.50 USD$/,
  );
  assert.match(
    windowLine(
      formatUsage({
        extra_usage: { is_enabled: true, used_credits: 5, currency: "EUR", decimal_places: 0 },
      }),
      "Extra usage",
    ),
    /spent 5 EUR$/,
  );
});

test("formatUsage never throws on malformed payloads", () => {
  assert.deepEqual(formatUsage(undefined), []);
  assert.deepEqual(formatUsage(null), []);
  assert.deepEqual(formatUsage("x"), []);
  assert.deepEqual(formatUsage([]), []);
  let lines;
  assert.doesNotThrow(() => {
    lines = formatUsage({
      limits: [null, 5, "x", { percent: "50" }, { kind: "session", percent: 7 }],
      five_hour: "junk",
      seven_day: { utilization: Number.NaN },
      extra_usage: "on",
    });
  });
  assert.deepEqual(
    lines.map((line) => line.slice(0, line.indexOf(":"))),
    ["5-hour", "Extra usage"],
    "only the readable fragments render",
  );
});

// ---- the composer indicator's snapshot --------------------------------------

const ENGINE_PAYLOAD = {
  usage: {
    limits: [
      { kind: "session", percent: 42, resets_at: "2026-10-30T20:00:00.000Z" },
      { group: "weekly", kind: "weekly", percent: 71 },
    ],
    extra_usage: {
      is_enabled: true,
      utilization: 8,
      used_credits: 250,
      monthly_limit: 1000,
      currency: "USD",
      decimal_places: 2,
    },
  },
  profile: {
    organization: { organization_type: "claude_max", rate_limit_tier: "claude_max_standard" },
  },
};

test("usageSnapshot shapes the payload with epochs and explicit nulls", () => {
  const snapshot = usageSnapshot(ENGINE_PAYLOAD.usage, ENGINE_PAYLOAD.profile, 5000);
  assert.equal(snapshot.observedAt, 5000);
  assert.equal(snapshot.plan, "Max");
  assert.deepEqual(
    snapshot.windows.map(({ label, percent }) => ({ label, percent })),
    [
      { label: "5-hour", percent: 42 },
      { label: "Weekly", percent: 71 },
    ],
  );
  assert.equal(
    snapshot.windows[0].resetsAt,
    Date.parse("2026-10-30T20:00:00.000Z"),
    "the ISO stamp becomes an epoch",
  );
  assert.equal(snapshot.windows[1].resetsAt, undefined, "no resets_at stays absent, not NaN");
  // The explicit nulls are the merge contract: an omitted key would let the
  // previous fetch's value linger in the settings document forever.
  assert.equal(snapshot.extra, formatExtra(ENGINE_PAYLOAD.usage.extra_usage));
  const bare = usageSnapshot({ five_hour: { utilization: 3 } }, {}, 7);
  assert.deepEqual(bare, {
    observedAt: 7,
    plan: null,
    windows: [{ label: "5-hour", percent: 3 }],
    extra: null,
  });
  assert.equal(usageSnapshot("junk", ENGINE_PAYLOAD.profile, 1), undefined);
  // The shared window core keeps the wire's ISO stamp verbatim. The snapshot
  // converts it on the way out.
  const windows = collectWindows(ENGINE_PAYLOAD.usage);
  assert.equal(windows[0].resetsAt, "2026-10-30T20:00:00.000Z");
  assert.equal(windows[1].resetsAt, undefined);
});

test("usageOp writes on content change and skips no-news fetches", () => {
  const snapshot = usageSnapshot(ENGINE_PAYLOAD.usage, ENGINE_PAYLOAD.profile, 5000);
  // A never-published section always writes.
  const fresh = usageOp(snapshot, undefined, ROUTE);
  assert.equal(fresh?.op, "set");
  assert.deepEqual(
    fresh?.path,
    usagePath(ROUTE),
    "the unprefixed account's snapshot lives at usage.snapshots.<route>",
  );
  // An identity-hashed account publishes under its own route.
  const other = usageOp(snapshot, undefined, "claude-subscription-222222222222");
  assert.deepEqual(other?.path, ["usage", "snapshots", "claude-subscription-222222222222"]);
  assert.equal(fresh?.value.observedAt, 5000);
  // The identical snapshot writes nothing…
  const stored = JSON.parse(JSON.stringify(snapshot));
  assert.equal(usageOp(snapshot, stored, ROUTE), undefined);
  // …and so does a refetch whose only movement is the observation clock.
  // Content is what the indicator shows. The countdowns recompute client-side.
  const later = { ...stored, observedAt: stored.observedAt + 60_000 };
  assert.equal(usageOp(later, stored, ROUTE), undefined);
  // Moved content writes, carrying the full next snapshot.
  const moved = JSON.parse(JSON.stringify(snapshot));
  moved.windows[0].percent = 43;
  const op = usageOp(moved, stored, ROUTE);
  assert.equal(op?.op, "set");
  assert.deepEqual(op?.value.windows[0], {
    label: "5-hour",
    percent: 43,
    resetsAt: stored.windows[0].resetsAt,
  });
  // Stored junk reads as absent, and plan/extra nulls are content too.
  assert.equal(usageOp(snapshot, "junk", ROUTE)?.op, "set");
  const cleared = { ...snapshot, extra: null };
  assert.equal(usageOp({ ...snapshot, extra: "disabled" }, cleared, ROUTE)?.op, "set");
});

// ---- the engine -------------------------------------------------------------

/**
 * The engine's harness: a verify-load-shaped settings double, a credential
 * stub, and a controllable fetch that honors abort signals like the real
 * fetch. The fetch counter tracks refresh rounds (usage-endpoint calls. The
 * profile call rides the same round). `minIntervalMs`/`retryBaseMs` default
 * to 0 so tests run on immediate timers.
 */
function engineHarness({
  payload = ENGINE_PAYLOAD,
  grants,
  credential = { oauth: true, apiKey: "sk-ant-oat01-engine" },
  minIntervalMs = 0,
  retryBaseMs = 0,
  mutate,
} = {}) {
  const sections = new Map();
  const mutates = [];
  const settings = {
    describe: () => [...sections.entries()].map(([ns, value]) => ({ ns, value })),
    mutate:
      mutate ??
      (async (ns, ops) => {
        mutates.push({ ns, ops });
        for (const op of ops) {
          const current = sections.get(ns) ?? {};
          const snapshots = { ...(current.usage?.snapshots ?? {}) };
          if (op.op === "set") snapshots[op.path.at(-1)] = op.value;
          else if (op.op === "unset") delete snapshots[op.path.at(-1)];
          sections.set(ns, { ...current, usage: { snapshots } });
        }
      }),
  };
  let fetchCalls = 0;
  const fetchImpl = async (url, init) => {
    if (init?.signal?.aborted) throw new Error("This operation was aborted");
    const target = String(url);
    if (target !== "https://api.anthropic.com/api/oauth/usage")
      return jsonResponse(payload.profile);
    fetchCalls += 1;
    return jsonResponse(payload.usage);
  };
  const debugs = [];
  const engine = createUsageEngine({
    grants: grants ?? { resolve: async () => credential },
    debug: (message) => debugs.push(message),
    settings,
    settingsNs: "claude-subscription",
    signal: new AbortController().signal,
    minIntervalMs,
    retryBaseMs,
    fetchImpl,
  });
  return { engine, mutates, sections, debugs, fetchCalls: () => fetchCalls };
}

/** The account route these engine tests serve. */
const ROUTE = "claude-subscription-111111111111";

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

test("the engine publishes changed content and skips no-news refetches", async () => {
  const payload = JSON.parse(JSON.stringify(ENGINE_PAYLOAD));
  const { engine, mutates } = engineHarness({ payload });
  engine.requestRefresh(ROUTE);
  await settle();
  assert.equal(mutates.length, 1, "the first fetch publishes");
  const [call] = mutates;
  assert.equal(call.ns, "claude-subscription");
  assert.deepEqual(call.ops[0].path, usagePath(ROUTE));
  assert.ok(Number.isFinite(call.ops[0].value.observedAt));
  assert.equal(call.ops[0].value.plan, "Max");
  assert.equal(call.ops[0].value.windows[0].percent, 42);
  // A refetch with unchanged content writes nothing.
  engine.requestRefresh(ROUTE);
  await settle();
  assert.equal(mutates.length, 1, "content, not the observation clock, moves the document");

  // Moved content publishes the full snapshot again, not a delta.
  payload.usage.limits[0].percent = 43;
  engine.requestRefresh(ROUTE);
  await settle();
  assert.equal(mutates.length, 2);
  assert.equal(mutates[1].ops[0].value.windows[0].percent, 43);
  assert.equal(mutates[1].ops[0].value.windows[1].percent, 71);
});

test("a failed fetch publishes nothing and the next trigger recovers", async () => {
  const payload = JSON.parse(JSON.stringify(ENGINE_PAYLOAD));
  const { engine, mutates, debugs, fetchCalls } = engineHarness({ payload });
  const realUsage = payload.usage;
  payload.usage = "junk";
  engine.requestRefresh(ROUTE);
  await settle();
  assert.equal(fetchCalls(), 1, "the fetch ran");
  assert.equal(mutates.length, 0, "a broken payload publishes nothing");
  assert.equal(debugs.length, 1, "the failure is logged, never thrown");
  payload.usage = realUsage;
  engine.requestRefresh(ROUTE);
  await settle();
  assert.equal(mutates.length, 1, "the next trigger recovers");
  assert.equal(debugs.length, 1);
});

test("no credential and the API-key fallback publish the empty snapshot once", async () => {
  for (const grants of [
    { resolve: async () => undefined },
    { resolve: async () => ({ oauth: false, apiKey: "sk-ant-api-example" }) },
  ]) {
    const { engine, mutates } = engineHarness({ grants });
    engine.requestRefresh(ROUTE);
    await settle();
    assert.deepEqual(
      mutates.at(-1)?.ops[0]?.value,
      {
        observedAt: mutates.at(-1)?.ops[0]?.value.observedAt,
        plan: null,
        windows: [],
        extra: null,
      },
      "the empty snapshot empties the section so the indicator hides",
    );
    engine.requestRefresh(ROUTE);
    await settle();
    assert.equal(mutates.length, 1, "the empty snapshot is not rewritten on every trigger");
  }
});

test("a refusing settings write retries, and an exhaustively refused one stays contained", async () => {
  const retried = [];
  let refusals = 2;
  const recovering = engineHarness({
    mutate: async (ns, ops) => {
      if (refusals > 0) {
        refusals -= 1;
        throw new Error(`Plugin entry "${ns}" is no longer configurable`);
      }
      retried.push({ ns, ops });
    },
  });
  recovering.engine.requestRefresh(ROUTE);
  await settle(60);
  assert.equal(retried.length, 1, "the retried publish lands once the refusal passes");

  // A service that never recovers logs and stands down instead of throwing.
  const givingUp = engineHarness({
    mutate: async () => {
      throw new Error("no longer configurable");
    },
  });
  givingUp.engine.requestRefresh(ROUTE);
  await settle(60);
  assert.equal(givingUp.mutates.length, 0);
  assert.ok(
    givingUp.debugs.some((message) => message.includes("could not be published")),
    "the give-up surfaces as a debug line",
  );
});

test("triggers coalesce to one fetch per interval, and dispose withdraws the rest", async () => {
  const { engine, mutates, fetchCalls } = engineHarness({ minIntervalMs: 200 });
  for (let at = 0; at < 5; at += 1) engine.requestRefresh(ROUTE);
  await settle(40);
  assert.equal(fetchCalls(), 1, "a trigger storm is one fetch");
  assert.equal(mutates.length, 1);
  // A trigger inside the cooldown schedules, not fetches. The floor passes
  // and exactly one more fetch runs.
  engine.requestRefresh(ROUTE);
  await settle(40);
  assert.equal(fetchCalls(), 1, "the cooldown holds");
  await settle(250);
  assert.equal(fetchCalls(), 2, "the scheduled refresh fires when the floor passes");
  // Disposal clears a pending cooldown timer. Nothing fetches after it.
  engine.requestRefresh(ROUTE);
  engine.dispose();
  await settle(280);
  assert.equal(fetchCalls(), 2, "the disposed timer never runs");
});

test("an immediate request overrides the cooldown wait, but never an in-flight fetch", async () => {
  const { engine, fetchCalls } = engineHarness({ minIntervalMs: 500 });
  engine.requestRefresh(ROUTE);
  await settle(40);
  assert.equal(fetchCalls(), 1);
  engine.requestRefresh(ROUTE);
  await settle(20);
  assert.equal(fetchCalls(), 1, "the plain trigger waits out the floor");
  engine.requestRefresh(ROUTE, { immediate: true });
  await settle(40);
  assert.equal(fetchCalls(), 2, "a model selection fetches right away");
  engine.dispose();
});

test("each account fetches, cools down and publishes on its own", async () => {
  const routeA = ROUTE;
  const routeB = "claude-subscription-222222222222";
  const { engine, mutates, fetchCalls } = engineHarness({ minIntervalMs: 200 });
  // Two accounts in the same tick are two fetches: the floor is per account.
  engine.requestRefresh(routeA);
  engine.requestRefresh(routeB);
  await settle(40);
  assert.equal(fetchCalls(), 2);
  assert.deepEqual(
    mutates.map((call) => call.ops[0].path.at(-1)),
    [routeA, routeB],
  );
  // A second trigger for A inside A's cooldown schedules. B's floor is
  // independent of A's.
  engine.requestRefresh(routeB);
  engine.requestRefresh(routeA);
  await settle(40);
  assert.equal(fetchCalls(), 2, "B's cooldown holds");
  await settle(250);
  assert.equal(fetchCalls(), 4, "both scheduled refreshes fire when their floors pass");
});

test("clear drops an account's snapshot and stays a no-op when absent", async () => {
  const { engine, mutates } = engineHarness();
  engine.requestRefresh("claude-subscription-111111111111");
  await settle();
  assert.equal(mutates.length, 1);
  await engine.clear("claude-subscription-111111111111");
  assert.equal(mutates.length, 2);
  assert.equal(mutates[1].ops[0].op, "unset");
  assert.deepEqual(mutates[1].ops[0].path, [
    "usage",
    "snapshots",
    "claude-subscription-111111111111",
  ]);
  await engine.clear("claude-subscription-111111111111");
  assert.equal(mutates.length, 2, "clearing an already-cleared route writes nothing");
});

test("clear withdraws a scheduled refresh, and a re-login publishes again", async () => {
  // Sign-out order: the record change fires requestRefresh (scheduling a
  // fetch), then the command clears the snapshot. The scheduled run must stay
  // silent: no empty snapshot re-published after the clear.
  let credential;
  const grants = { resolve: async () => credential };
  const { engine, mutates, fetchCalls } = engineHarness({ minIntervalMs: 100, grants });
  const route = "claude-subscription-111111111111";
  engine.requestRefresh(route);
  await engine.clear(route);
  await settle(200);
  assert.equal(fetchCalls(), 0, "the withdrawn timer never runs");
  assert.equal(mutates.length, 0, "no empty snapshot is re-published after the clear");
  // A later sign-in clears the suppression on the OAuth path and publishes.
  credential = { oauth: true, apiKey: "sk-ant-oat01-engine" };
  engine.requestRefresh(route);
  await settle(200);
  assert.equal(fetchCalls(), 1, "the re-signed-in account fetches");
  assert.equal(mutates.length, 1);
  assert.equal(mutates[0].ops[0].op, "set");
  assert.deepEqual(mutates[0].ops[0].path, usagePath(route));
});

test("a clear during an in-flight fetch suppresses the completed publish", async () => {
  // Logout can land while the usage endpoints are still answering. The
  // snapshot that arrives afterwards belongs to a removed account and must
  // not resurrect usage.snapshots.<route>; a later sign-in must still publish.
  const route = "claude-subscription-111111111111";
  const sections = new Map();
  const mutates = [];
  const settings = {
    describe: () => [...sections.entries()].map(([ns, value]) => ({ ns, value })),
    mutate: async (ns, ops) => {
      mutates.push({ ns, ops });
      for (const op of ops) {
        const current = sections.get(ns) ?? {};
        const snapshots = { ...(current.usage?.snapshots ?? {}) };
        if (op.op === "set") snapshots[op.path.at(-1)] = op.value;
        else if (op.op === "unset") delete snapshots[op.path.at(-1)];
        sections.set(ns, { ...current, usage: { snapshots } });
      }
    },
  };
  let releaseFetch;
  const parked = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  let usageCalls = 0;
  const engine = createUsageEngine({
    grants: { resolve: async () => ({ oauth: true, apiKey: "sk-ant-oat01-engine" }) },
    debug: () => {},
    settings,
    settingsNs: "claude-subscription",
    signal: new AbortController().signal,
    minIntervalMs: 0,
    retryBaseMs: 0,
    fetchImpl: async (url) => {
      if (String(url).endsWith("/usage")) {
        usageCalls += 1;
        await parked;
        return jsonResponse(ENGINE_PAYLOAD.usage);
      }
      return jsonResponse(ENGINE_PAYLOAD.profile);
    },
  });
  engine.requestRefresh(route);
  await settle(20); // the usage fetch is parked in flight
  await engine.clear(route); // the account is removed (logout) mid-fetch
  releaseFetch();
  await settle(60);
  assert.equal(usageCalls, 1, "the parked fetch ran");
  assert.equal(
    mutates.some((call) => call.ops[0]?.op === "set" && call.ops[0]?.path?.[2] === route),
    false,
    "the completed fetch publishes nothing after the account was cleared",
  );
  // A later sign-in on the same route starts a new generation and publishes.
  engine.requestRefresh(route);
  await settle(40);
  assert.equal(usageCalls, 2, "the re-signed-in route fetches again");
  assert.equal(mutates.at(-1)?.ops[0]?.op, "set", "the fresh reading is published");
  engine.dispose();
});

test("an aborted lifecycle stops the refresh quietly", async () => {
  const controller = new AbortController();
  const sections = new Map();
  let fetchCalls = 0;
  const engine = createUsageEngine({
    grants: { resolve: async () => ({ oauth: true, apiKey: "sk-ant-oat01-engine" }) },
    debug: () => {},
    settings: { describe: () => [], mutate: async () => {} },
    settingsNs: "claude-subscription",
    signal: controller.signal,
    minIntervalMs: 0,
    fetchImpl: async (_url, init) => {
      if (init?.signal?.aborted) throw new Error("This operation was aborted");
      fetchCalls += 1;
      return jsonResponse(ENGINE_PAYLOAD.usage);
    },
  });
  controller.abort();
  engine.requestRefresh(ROUTE);
  await settle(30);
  assert.equal(fetchCalls, 0, "the aborted signal kills the request before it fetches");
  void sections;
});
