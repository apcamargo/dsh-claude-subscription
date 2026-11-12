/**
 * The Models-page card's pure logic: route ids, row normalization, and the
 * settings-mutate operations.
 * @module test/client-models.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  isAccountRoute,
  normalizeRow,
  normalizeUsageView,
  readAccounts,
  readQuotaMarker,
  resetDetail,
  rowsDiffer,
  setModelsOp,
  splitExtra,
  unsetModelsOp,
} from "../lib/client-models.js";
import { isAccountRoute as hostIsAccountRoute } from "../lib/credentials.js";

test("splitExtra lifts the percent out of the host's extra-usage string", () => {
  // Pinned host-shaped text keeps the parser's expected inputs independent.
  assert.deepEqual(
    splitExtra(
      "[█████████░░░░░░░░░░░] 43.2% used · enabled · spent 17.26 BRL · monthly cap 40.00 BRL",
    ),
    {
      percent: 43.2,
      detail: "enabled · spent 17.26 BRL · monthly cap 40.00 BRL",
    },
  );
  // No utilization on the wire: details only, no meter.
  assert.deepEqual(splitExtra("disabled · spent 2.50 USD"), {
    detail: "disabled · spent 2.50 USD",
  });
  assert.deepEqual(splitExtra("[░░░░] 0% used"), { percent: 0, detail: "" });
  // The command text pads values to the label column; the padding is layout.
  assert.deepEqual(
    splitExtra("         [██░░░░░░░░░░░░░░░░░░] 97.6% used · enabled · spent 39.02 BRL"),
    { percent: 97.6, detail: "enabled · spent 39.02 BRL" },
  );
  assert.equal(splitExtra(""), undefined);
  assert.equal(splitExtra(null), undefined);
});

test("isAccountRoute accepts exactly the prefix plus 12 hex", () => {
  // The one route-id contract both halves share: the browser keys the
  // composer indicator on it, the host decides what is a credential record.
  for (const route of ["claude-subscription-0123456789ab", "claude-subscription-ffffffffffff"]) {
    assert.equal(isAccountRoute(route), true, `${route} is an account route`);
  }
  for (const route of [
    "claude-subscription-0123456789a", // 11 hex
    "claude-subscription-0123456789abc", // 13 hex
    "claude-subscription-0123456789AB", // uppercase is not the minted form
    "claude-subscription-",
    "claude-subscriptionx",
    "claude-subscription/login-staging",
    "claude-subscription-0123456789ab-extra",
    "anthropic",
    "",
    undefined,
    null,
    42,
  ]) {
    assert.equal(isAccountRoute(route), false, `${String(route)} is not an account route`);
  }
  // lib/credentials.js re-exports this very function (it is the host half's
  // import site), so the two halves cannot drift into separate spellings.
  assert.equal(hostIsAccountRoute, isAccountRoute);
});

test("normalizeRow keeps schema-declared fields and drops empties", () => {
  assert.deepEqual(
    normalizeRow({ id: " claude-opus-5-5 ", name: " Opus ", contextWindow: 500000, maxTokens: 1 }),
    {
      id: "claude-opus-5-5",
      name: "Opus",
      contextWindow: 500000,
      maxTokens: 1,
    },
  );
  // Empty capacity fields are dropped so the built-in capacity applies.
  assert.deepEqual(
    normalizeRow({ id: "claude-haiku-4-5", name: "  ", contextWindow: "", maxTokens: 0 }),
    {
      id: "claude-haiku-4-5",
    },
  );
  // Modalities keep only known values, and only when non-empty.
  assert.deepEqual(normalizeRow({ id: "x", input: ["text", "voice", "image"] }).input, [
    "text",
    "image",
  ]);
  assert.equal(normalizeRow({ id: "x", input: [] }).input, undefined);
  // A row without an id is unusable.
  assert.equal(normalizeRow({ name: "no id" }), undefined);
  assert.equal(normalizeRow({ id: "   " }), undefined);
});

test("the op builders target the account's strict settings path", () => {
  // The gateway's ops codec is a strict JSON union, so the builders' exact
  // shapes are the wire contract.
  const route = "claude-subscription-111111111111";
  assert.deepEqual(setModelsOp([{ id: "claude-opus-5-5", name: "Opus" }, { bogus: true }], route), {
    op: "set",
    path: ["accounts", "models", route],
    value: [{ id: "claude-opus-5-5", name: "Opus" }],
  });
  assert.deepEqual(unsetModelsOp(route), { op: "unset", path: ["accounts", "models", route] });
});

test("readAccounts reads the per-account view: mirror, lists, and snapshots", () => {
  const mirror = {
    accounts: [
      {
        route: "claude-subscription-111111111111",
        email: "a@x.com",
        orgName: null,
        status: "signedIn",
        addedAt: 1,
      },
      {
        route: "claude-subscription-222222222222",
        email: "b@x.com",
        orgName: "Team",
        status: "needsReauth",
        addedAt: 2,
      },
    ],
  };
  const view = [
    { ns: "other-plugin", revision: 9, value: {} },
    {
      ns: "claude-subscription",
      revision: 7,
      value: {
        accounts: {
          mirror,
          models: { "claude-subscription-111111111111": [{ id: "claude-haiku-4-5" }] },
        },
        usage: {
          snapshots: { "claude-subscription-111111111111": { observedAt: 5, windows: [] } },
        },
      },
    },
  ];
  const accounts = readAccounts(view);
  assert.equal(accounts.revision, 7);
  assert.deepEqual(accounts.mirror.accounts[1], {
    route: "claude-subscription-222222222222",
    email: "b@x.com",
    orgName: "Team",
    status: "needsReauth",
  });
  assert.deepEqual(accounts.models, {
    "claude-subscription-111111111111": [{ id: "claude-haiku-4-5" }],
  });
  assert.deepEqual(accounts.snapshots, {
    "claude-subscription-111111111111": { observedAt: 5, windows: [] },
  });
  // Absent or malformed sections read as empty, never as a crash.
  const empty = readAccounts(undefined);
  assert.deepEqual(empty.mirror, { accounts: [] });
  assert.deepEqual(empty.models, {});
  assert.deepEqual(empty.snapshots, {});
  assert.deepEqual(
    readAccounts([
      {
        ns: "claude-subscription",
        revision: 1,
        value: { accounts: { mirror: { accounts: [{ bogus: true }, null, { route: "" }] } } },
      },
    ]).mirror,
    {
      accounts: [],
    },
  );
});

test("rowsDiffer compares normalized rows, ignoring field order", () => {
  assert.equal(rowsDiffer([{ id: "a", name: "x" }], [{ name: "x", id: "a" }]), false);
  assert.equal(rowsDiffer([{ id: "a" }], [{ id: "a" }, { id: "b" }]), true);
  assert.equal(rowsDiffer([{ id: "a", contextWindow: 5 }], [{ id: "a", contextWindow: 6 }]), true);
  assert.equal(rowsDiffer([], []), false);
});

const MARKER_ROUTE = "claude-subscription-111111111111";
const OTHER_ACCOUNT_ROUTE = "claude-subscription-222222222222";

test("readAccounts surfaces the quota marker alongside the snapshots", () => {
  const marker = { route: MARKER_ROUTE, at: 500 };
  const view = [
    {
      ns: "claude-subscription",
      revision: 7,
      value: { usage: { snapshots: {}, lastQuotaFailure: marker } },
    },
  ];
  assert.deepEqual(readAccounts(view).lastQuotaFailure, marker);
  // Absent sections read as null, never undefined-as-value ambiguity.
  assert.equal(readAccounts(undefined).lastQuotaFailure, null);
  assert.equal(
    readAccounts([{ ns: "claude-subscription", revision: 1, value: { usage: {} } }])
      .lastQuotaFailure,
    null,
  );
});

test("readQuotaMarker reads a fresh marker on a signed-in route", () => {
  const now = 1_000_000;
  assert.deepEqual(
    readQuotaMarker(
      { route: MARKER_ROUTE, at: now - 60_000 },
      [{ route: MARKER_ROUTE, email: "a@x.com", status: "signedIn" }],
      now,
    ),
    { route: MARKER_ROUTE, at: now - 60_000, email: "a@x.com", others: false },
  );
  // A mirror row without an email still resolves: the modal degrades to the
  // generic account copy.
  assert.deepEqual(
    readQuotaMarker(
      { route: MARKER_ROUTE, at: now - 60_000 },
      [{ route: MARKER_ROUTE, status: "signedIn" }],
      now,
    ),
    { route: MARKER_ROUTE, at: now - 60_000, others: false },
  );
});

test("a stale or future marker reads as absent", () => {
  const now = 1_000_000;
  const rows = [{ route: MARKER_ROUTE, email: "a@x.com", status: "signedIn" }];
  // The marker persists in the settings document across restarts, so the TTL
  // is what keeps an already-reset exhaustion from popping a modal later.
  assert.equal(
    readQuotaMarker({ route: MARKER_ROUTE, at: now - 16 * 60_000 }, rows, now),
    undefined,
  );
  // A stamp in the future (clock skew, a hostile write) is not a fresh marker.
  assert.equal(readQuotaMarker({ route: MARKER_ROUTE, at: now + 60_000 }, rows, now), undefined);
});

test("a malformed marker reads as absent", () => {
  const now = 1_000_000;
  const rows = [{ route: MARKER_ROUTE, email: "a@x.com", status: "signedIn" }];
  for (const raw of [
    null,
    undefined,
    "marker",
    5,
    [],
    {},
    { route: "" },
    { route: MARKER_ROUTE },
    { route: MARKER_ROUTE, at: "now" },
  ]) {
    assert.equal(readQuotaMarker(raw, rows, now), undefined, JSON.stringify(raw) ?? String(raw));
  }
});

test("a marker for a route that is not signed in reads as absent", () => {
  const now = 1_000_000;
  const signedOut = { route: MARKER_ROUTE, at: now - 60_000 };
  // Unknown route.
  assert.equal(readQuotaMarker(signedOut, [], now), undefined);
  // Signed-out and stale-token rows cannot have just served the failed request.
  assert.equal(
    readQuotaMarker(signedOut, [{ route: MARKER_ROUTE, status: "signedOut" }], now),
    undefined,
  );
  assert.equal(
    readQuotaMarker(signedOut, [{ route: MARKER_ROUTE, status: "needsReauth" }], now),
    undefined,
  );
  // An API-key mirror row has no allowance window to point at.
  assert.equal(
    readQuotaMarker(signedOut, [{ route: MARKER_ROUTE, status: "apiKey" }], now),
    undefined,
  );
});

test("a fresh marker with several signed-in accounts flags the others hint", () => {
  const now = 1_000_000;
  assert.equal(
    readQuotaMarker(
      { route: MARKER_ROUTE, at: now - 60_000 },
      [
        { route: MARKER_ROUTE, email: "a@x.com", status: "signedIn" },
        { route: OTHER_ACCOUNT_ROUTE, email: "b@x.com", status: "signedIn" },
        // A signed-out third must not flip the hint on its own.
        { route: "claude-subscription-333333333333", email: "c@x.com", status: "signedOut" },
      ],
      now,
    ).others,
    true,
  );
});

test("normalizeUsageView gates on a real observation and reads nulls as absent", () => {
  const view = normalizeUsageView({
    observedAt: 5000,
    plan: "Max",
    windows: [
      { label: "5-hour", percent: 34, resetsAt: 9000 },
      { label: "Weekly", percent: 5 },
      { label: "junk", percent: "x" },
      null,
      { percent: 7 },
    ],
    extra: null,
  });
  assert.deepEqual(view, {
    observedAt: 5000,
    plan: "Max",
    windows: [
      { label: "5-hour", percent: 34, resetsAt: 9000 },
      { label: "Weekly", percent: 5 },
    ],
    extra: undefined,
  });
  // The parsed-but-never-published section (and every non-snapshot value)
  // reads as absent: the finite observedAt is the gate.
  assert.equal(normalizeUsageView({}), undefined);
  assert.equal(normalizeUsageView({ windows: [] }), undefined);
  assert.equal(normalizeUsageView({ observedAt: "x", windows: [] }), undefined);
  assert.equal(normalizeUsageView({ observedAt: 1, windows: "junk" }), undefined);
  assert.equal(normalizeUsageView(null), undefined);
  assert.equal(normalizeUsageView(undefined), undefined);
  assert.equal(normalizeUsageView("snapshot"), undefined);
  // An empty snapshot: empty windows, no plan, no extra.
  assert.deepEqual(normalizeUsageView({ observedAt: 7, plan: null, windows: [], extra: null }), {
    observedAt: 7,
    plan: undefined,
    windows: [],
    extra: undefined,
  });
});

test("resetDetail recomputes the countdown from either cache shape", () => {
  const now = 1_000_000;
  // The host-published epoch shape ticks live.
  assert.equal(resetDetail({ resetsAt: now + 90 * 60_000 }, now - 1000, now), "resets in 1h 30m");
  assert.equal(resetDetail({ resetsAt: now + 30 * 60_000 }, now, now), "resets in 30m");
  assert.equal(
    resetDetail({ resetsAt: now + 3 * 86_400_000 + 7 * 3_600_000 }, now, now),
    "resets in 3d 7h",
  );
  assert.equal(resetDetail({ resetsAt: now - 1 }, now, now), "resets now");
  assert.equal(resetDetail({ resetsAt: "x" }, now, now), "", "a non-numeric epoch is not an epoch");

  // A string reset is anchored at the observation time, so it keeps ticking
  // between fetches instead of freezing on the stored text.
  assert.equal(
    resetDetail({ reset: "resets in 3h 19m" }, now - 10 * 60_000, now),
    "resets in 3h 9m",
  );
  assert.equal(resetDetail({ reset: "resets in 3h 19m" }, now, now), "resets in 3h 19m");
  assert.equal(resetDetail({ reset: "resets in 1m" }, now - 5 * 60_000, now), "resets now");
  // The absolute-clock suffix is stripped before anchoring.
  assert.equal(
    resetDetail({ reset: "resets in 3h 19m · at 11:10 AM" }, now, now),
    "resets in 3h 19m",
  );
  assert.equal(resetDetail({ reset: "resets now" }, now, now), "resets now");
  // Without an anchor, the stored text is returned as-is.
  assert.equal(resetDetail({ reset: "resets in 3h 19m" }, undefined, now), "resets in 3h 19m");
  assert.equal(resetDetail({ reset: "resets in" }, now, now), "resets in");
  assert.equal(resetDetail({ reset: "" }, now, now), "");
  assert.equal(resetDetail(null, now, now), "");
  assert.equal(resetDetail(undefined, now, now), "");
  // The epoch shape wins over a stale string.
  assert.equal(
    resetDetail({ resetsAt: now + 60_000, reset: "resets in 9h" }, now, now),
    "resets in 1m",
  );
});
