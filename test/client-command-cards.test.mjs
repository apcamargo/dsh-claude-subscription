/**
 * The two command cards: their keyed `conversation.chat.commandview`
 * registrations, the settled renderings for success, error and unparseable
 * results, and the one deliberately empty state. A command node whose
 * `outcome` is still null renders nothing at all: the host keeps the node
 * open while the handler runs, and a placeholder would paint a box where the
 * card is about to appear.
 * @module test/client-command-cards.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createClientApp } from "../lib/client-app.js";
import * as models from "../lib/client-models.js";

const helpers = models;
const ROUTE = "claude-subscription-111111111111";
const cacheKey = (route = ROUTE) => `claude-subscription:usage:v2:${route}`;

const USAGE = [
  "Claude usage",
  "Account: user@example.com",
  `Route: ${ROUTE}`,
  "Plan: Pro",
  "5-hour:      [██████░░░░░░░░░░░░░░] 34% used · resets in 3h 19m",
  "Weekly:      [█░░░░░░░░░░░░░░░░░░░] 5% used · resets in 4d 3h",
  "Observed: 2020-01-01T12:00:00.000Z",
].join("\n");

const ACCOUNT = [
  "Claude account",
  "Auth: Subscription (OAuth)",
  "Account: user@example.com",
  "Organization: Acme Inc",
  "Plan: Pro",
  "OAuth token: expires in 59m",
  `Route: ${ROUTE}`,
].join("\n");

function flatten(node) {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flatten).join("");
  return flatten(node.children);
}

function collect(node, predicate) {
  const out = [];
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.shift();
    if (current === null || current === undefined || typeof current !== "object") continue;
    if (predicate(current)) out.push(current);
    if (Array.isArray(current)) stack.push(...current);
    else if (current.children !== undefined)
      stack.push(...(Array.isArray(current.children) ? current.children : [current.children]));
  }
  return out;
}

function reactStub() {
  const effects = [];
  const slots = [];
  let cursor = 0;
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState(initial) {
      const at = cursor++;
      if (slots[at] === undefined)
        slots[at] = { value: typeof initial === "function" ? initial() : initial };
      return [
        slots[at].value,
        (next) => {
          slots[at].value = typeof next === "function" ? next(slots[at].value) : next;
        },
      ];
    },
    useRef(initial) {
      const at = cursor++;
      if (slots[at] === undefined) slots[at] = { value: { current: initial } };
      return slots[at].value;
    },
    useCallback: (fn) => fn,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useEffect: (fn) => effects.push(fn),
    useLayoutEffect: (fn) => effects.push(fn),
    resetCursor() {
      cursor = 0;
    },
    drainEffects() {
      for (const effect of effects.splice(0)) effect();
    },
  };
}

function storageStub() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
}

function withLocalStorage(stub, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    value: stub,
    configurable: true,
    writable: true,
  });
  try {
    return fn();
  } finally {
    if (descriptor === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, "localStorage", descriptor);
  }
}

/** Mount the client app against recording slot and effect doubles. */
function mount() {
  const stub = reactStub();
  const app = createClientApp({ React: stub, helpers, pluginName: "test-double" });
  const registered = {};
  app.apply({
    remote: {},
    effect() {},
    get: () => undefined,
    slots: {
      inject: (_slot, factory) => factory(),
      register: (config, component) => {
        registered[config.key ?? config.name] = { config, component };
        return config;
      },
    },
  });
  return { registered, stub };
}

test("both command results claim the keyed command card slot", () => {
  const { registered } = mount();
  const usage = registered["claude-usage"];
  const account = registered["claude-account"];
  assert.equal(usage?.config.name, "conversation.chat.commandview");
  assert.equal(account?.config.name, "conversation.chat.commandview");
  assert.equal(typeof usage.component, "function");
  assert.equal(typeof account.component, "function");
});

test("a running command renders nothing at all", () => {
  const { registered } = mount();
  for (const name of ["claude-usage", "claude-account"]) {
    const tree = registered[name].component({ node: { name, outcome: null } });
    assert.equal(tree, null, `${name} draws no placeholder while it runs`);
  }
});

test("a settled usage result renders the quota panel with its bars", () => {
  const { registered } = mount();
  const tree = registered["claude-usage"].component({
    node: { name: "claude-usage", outcome: { kind: "success", text: USAGE } },
  });
  const text = flatten(tree);
  assert.ok(text.includes("Usage quota"));
  assert.ok(
    text.includes("user@example.com · Pro plan"),
    "the header pairs the identity with the plan",
  );
  assert.ok(text.includes("5-hour · resets in 3h 19m"));
  assert.ok(text.includes("34%") && text.includes("5%"));
  const fills = collect(tree, (n) => n.props?.className === "dsh-cs-ufill").map(
    (n) => n.props.style.width,
  );
  assert.deepEqual(fills, ["34%", "5%"], "one bar per window, sized by the parsed percent");
});

test("guidance and errors keep the host's own words", () => {
  const { registered } = mount();
  const card = registered["claude-usage"].component;
  const guidance = card({
    node: {
      name: "claude-usage",
      outcome: {
        kind: "success",
        text: "Claude usage\nNote: No Claude credential stored. Run /claude-login, then /claude-usage again.",
      },
    },
  });
  assert.ok(flatten(guidance).includes("No Claude credential stored"));
  const failed = card({
    node: {
      name: "claude-usage",
      outcome: { kind: "error", text: "Anthropic usage request failed (HTTP 401)." },
    },
  });
  assert.ok(flatten(failed).includes("HTTP 401"));
  const raw = card({
    node: {
      name: "claude-usage",
      outcome: { kind: "success", text: "something this plugin cannot parse" },
    },
  });
  assert.ok(
    flatten(raw).includes("cannot parse"),
    "an unparseable success falls back to the raw text block",
  );
});

test("the account card renders its facts and falls back to the Auth line", () => {
  const { registered } = mount();
  const card = registered["claude-account"].component;
  const text = flatten(
    card({ node: { name: "claude-account", outcome: { kind: "success", text: ACCOUNT } } }),
  );
  assert.ok(text.includes("Claude account"));
  assert.ok(text.includes("user@example.com · Pro plan"));
  assert.ok(text.includes("Acme Inc"));
  assert.ok(
    text.includes("OAuth token"),
    "the row names the credential, and the value carries the countdown",
  );
  assert.ok(text.includes("expires in 59m"));
  const bare = flatten(
    card({
      node: {
        name: "claude-account",
        outcome: { kind: "success", text: "Claude account\nAuth: Not signed in" },
      },
    }),
  );
  assert.ok(
    bare.includes("Not signed in"),
    "a card with no identity or plan keeps the Auth label as its subtitle",
  );
});

test("a usage result feeds the indicator cache only when it names its route", () => {
  const { registered, stub } = mount();
  const storage = storageStub();
  withLocalStorage(storage, () => {
    registered["claude-usage"].component({
      node: { name: "claude-usage", outcome: { kind: "success", text: USAGE } },
    });
    stub.drainEffects();
    const cached = JSON.parse(storage.getItem(cacheKey()));
    assert.equal(cached.plan, "Pro");
    assert.equal(cached.windows[0].percent, 34);
    assert.equal(cached.observedAt, Date.parse("2020-01-01T12:00:00.000Z"));

    // Every account route is a hash: a result with no Route row cannot name
    // the account, and guessing one would paint another account's quota.
    storage.setItem(cacheKey(), "sentinel");
    registered["claude-usage"].component({
      node: { name: "claude-usage", outcome: { kind: "success", text: "Claude usage\nPlan: Pro" } },
    });
    stub.drainEffects();
    assert.equal(storage.getItem(cacheKey()), "sentinel", "an unidentified result writes nothing");

    // A result with readings but no Observed stamp has unknown age.
    const unstamped =
      "Claude usage\nRoute: " + ROUTE + "\n5-hour:      [██████░░░░░░░░░░░░░░] 90% used";
    registered["claude-usage"].component({
      node: { name: "claude-usage", outcome: { kind: "success", text: unstamped } },
    });
    stub.drainEffects();
    assert.equal(
      storage.getItem(cacheKey()),
      "sentinel",
      "an undated reading is not presented as current",
    );
  });
});
