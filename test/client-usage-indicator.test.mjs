/**
 * The composer's 5-hour usage indicator: its slot registration and the
 * rendered trees for the cached, empty, and degraded states, with a
 * Map-backed localStorage double for the cache. The command result itself is
 * plain text now, so nothing here renders a `/claude-usage` card.
 * @module test/client-usage-indicator.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createClientApp } from "../lib/client-app.js";
import * as models from "../lib/client-models.js";
import { applyPathOp } from "./apply-path-op.mjs";

const helpers = models;
const { SETTINGS_NS } = models;
/** The selected model's route in these tests: one signed-in account. */
const ROUTE = "claude-subscription-111111111111";
/** The per-account cache key of one route. */
const cacheKey = (route = ROUTE) => `claude-subscription:usage:v2:${route}`;

/** Flatten a rendered tree to its text content. */
function flatten(node) {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flatten).join("");
  return flatten(node.children);
}

/** Walk the tree for the first element matching a predicate over type and props. */
function find(node, predicate) {
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.shift();
    if (current === null || current === undefined || typeof current !== "object") continue;
    if (predicate(current)) return current;
    if (Array.isArray(current)) stack.push(...current);
    else if (current.children !== undefined)
      stack.push(...(Array.isArray(current.children) ? current.children : [current.children]));
  }
  return undefined;
}

/**
 * The composer mark's clay band: the inner svg viewport that clips the fill to the
 * logo's lower (100 - used)%. The `y` guard keeps the match on the band even if the
 * outer trigger svg ever grew a preserveAspectRatio.
 */
function findBand(node) {
  return find(
    node,
    (n) =>
      n.type === "svg" && n.props?.preserveAspectRatio !== undefined && n.props?.y !== undefined,
  );
}

/**
 * The gauge's spent share: the base path carries the receded-track modifier, while
 * the no-reading mark carries only `dsh-cs-pieDepleted` (full ink).
 */
function findTrack(node) {
  return find(
    node,
    (n) =>
      n.type === "path" &&
      typeof n.props?.className === "string" &&
      n.props.className.includes("dsh-cs-pieTrack"),
  );
}

/** A React stub with the hooks the usage card and indicator use. */
function reactStub() {
  const slots = [];
  let cursor = 0;
  const effects = [];
  const cleanups = [];
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState(initial) {
      const at = cursor++;
      if (slots[at] === undefined)
        slots[at] = { value: typeof initial === "function" ? initial() : initial };
      const slot = slots[at];
      return [
        slot.value,
        (next) => {
          slot.value = typeof next === "function" ? next(slot.value) : next;
        },
      ];
    },
    useRef(initial) {
      // Same call-order model as useState. The slot holds a stable ref cell.
      const at = cursor++;
      if (slots[at] === undefined) slots[at] = { value: { current: initial } };
      return slots[at].value;
    },
    useCallback(fn) {
      return fn;
    },
    // The pie reads the session's model directory through
    // useSyncExternalStore. The stub answers the snapshot synchronously and
    // leaves re-rendering to the test's manual renders.
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot();
    },
    useEffect(fn) {
      effects.push(fn);
    },
    useLayoutEffect(fn) {
      effects.push(fn);
    },
    resetCursor() {
      cursor = 0;
    },
    drainEffects() {
      for (const effect of effects.splice(0)) {
        // Effect cleanups (event unsubscriptions, interval clears) are
        // collected so a drained indicator's timers and subscriptions
        // can be disposed deterministically. runCleanups does that.
        const cleanup = effect();
        if (typeof cleanup === "function") cleanups.push(cleanup);
      }
    },
    runCleanups() {
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
}

/** A Map-backed localStorage double. */
function storageStub() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
}

/** Run fn with globalThis.localStorage bound to stub, restoring afterwards. */
function withLocalStorage(stub, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    value: stub,
    configurable: true,
    writable: true,
  });
  try {
    fn();
  } finally {
    if (descriptor === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, "localStorage", descriptor);
  }
}

// A recording stand-in for the host's shared Tooltip primitive, kept at module
// scope so renders can be found by element type (the stub does not invoke
// components). Every indicator render wraps its trigger in it.
const primitivesTooltip = ({ label, side, delayMs, disabled, portal, children }) => ({
  type: "span",
  props: {
    "data-tooltip": label,
    "data-side": side,
    "data-delay": delayMs,
    "data-disabled": disabled,
    "data-portal": portal,
  },
  children,
});

/** Mount the client app against a recording slots stub. */
function mount({ primitives = { Tooltip: primitivesTooltip }, storeFactory, remote } = {}) {
  const stub = reactStub();
  const app = createClientApp({
    React: stub,
    helpers,
    pluginName: "test-double",
    primitives,
    storeFactory,
  });
  const registered = {};
  const ctx = {
    remote: remote ?? {},
    // Run effects immediately. Under Node, skip only styles; every other setup
    // error must propagate.
    effect(fn, name) {
      if (name === "claude-subscription: styles" && typeof document === "undefined")
        return undefined;
      return fn();
    },
    get: () => undefined,
    slots: {
      inject: (_slot, factory) => factory(),
      register: (config, component) => {
        registered[config.key ?? config.name] = { config, component };
        return config;
      },
    },
  };
  app.apply(ctx);
  return { registered, stub };
}

/**
 * A stand-in for the session model directory's snapshot store: the pie reads the
 * selected model's provider route from `current`.
 */
function directoryStub(route = ROUTE) {
  return {
    route,
    store: snapshotStore({
      current: route === undefined ? null : { provider: route, model: "claude-opus-5-5" },
    }),
  };
}

test("the indicator draws the 5-hour family's band or the neutral mark", async () => {
  // No cache: the neutral mark.
  withLocalStorage(storageStub(), () => {
    const { registered, stub } = mount();
    const { store } = directoryStub();
    stub.resetCursor();
    const tree = registered["conversation.input.right"].component({
      operations: operationsStub(),
      sessionId: "session-1",
      directory: store,
    });
    assert.ok(tree, "no cache: the indicator still shows");
    assert.equal(
      find(tree, (n) => n.props?.className === "dsh-cs-spark"),
      undefined,
      "no cache: the neutral mark",
    );
    assert.equal(
      findTrack(tree),
      undefined,
      "no cache: the neutral mark keeps its full ink, not the receded track",
    );
  });
  // A 0% reading draws the fully-colored mark: the band covers the whole
  // viewBox and the depleted base rides beneath it.
  const emptyStorage = storageStub();
  emptyStorage.setItem(
    cacheKey(),
    JSON.stringify({
      plan: "Pro",
      windows: [{ label: "5-hour", percent: 0, reset: "resets in 5h" }],
      extra: null,
      observedAt: Date.now(),
    }),
  );
  await withLocalStorageAsync(emptyStorage, async () => {
    const { registered, stub } = mount();
    const operations = operationsStub();
    const { store } = directoryStub();
    const pie = registered["conversation.input.right"].component;
    stub.resetCursor();
    pie({ operations, sessionId: "session-1", directory: store });
    stub.drainEffects();
    await settle(5);
    stub.resetCursor();
    const tree = pie({ operations, sessionId: "session-1", directory: store });
    const band = findBand(tree);
    assert.equal(band.props.y, 0);
    assert.equal(band.props.height, 100, "a 0% reading leaves the mark fully colored");
    assert.ok(
      findTrack(tree),
      "the depleted base rides beneath the clay band as the receded track",
    );
    assert.equal(
      find(tree, (n) => n.type === primitivesTooltip).props.label,
      "0% of the 5-hour quota was used\nResets in 5h",
    );
  });
  // The host scopes session windows ("5-hour (Fable only)"). The family
  // match feeds the band from the scoped label.
  const scopedStorage = storageStub();
  scopedStorage.setItem(
    cacheKey(),
    JSON.stringify({
      plan: "Pro",
      windows: [{ label: "5-hour (Fable only)", percent: 55, reset: "resets in 2h" }],
      extra: null,
      observedAt: Date.now(),
    }),
  );
  await withLocalStorageAsync(scopedStorage, async () => {
    const { registered, stub } = mount();
    const operations = operationsStub();
    const { store } = directoryStub();
    const pie = registered["conversation.input.right"].component;
    stub.resetCursor();
    pie({ operations, sessionId: "session-1", directory: store });
    stub.drainEffects();
    await settle(5);
    stub.resetCursor();
    const tree = pie({ operations, sessionId: "session-1", directory: store });
    const band = findBand(tree);
    assert.equal(band.props.y, 55);
    assert.equal(band.props.height, 45, "the scoped session window feeds the band");
    assert.equal(
      find(tree, (n) => n.type === primitivesTooltip).props.label,
      "55% of the 5-hour quota was used\nResets in 2h",
    );
  });
});

test("a spent quota keeps the empty mark on screen", async () => {
  // At 100% used the clay band collapses into the depleted base, and a
  // fresh reading gets no staleness dim. The base layer remains on screen.
  const { registered, stub } = mount();
  const storage = storageStub();
  storage.setItem(
    cacheKey(),
    JSON.stringify({
      plan: "Pro",
      windows: [{ label: "5-hour", percent: 100, reset: "resets in 20m" }],
      extra: null,
      observedAt: Date.now(),
    }),
  );
  await withLocalStorageAsync(storage, async () => {
    const pie = registered["conversation.input.right"].component;
    const operations = operationsStub();
    const { store } = directoryStub();
    stub.resetCursor();
    pie({ operations, sessionId: "session-1", directory: store });
    stub.drainEffects();
    await settle(5);
    stub.resetCursor();
    const tree = pie({ operations, sessionId: "session-1", directory: store });
    const band = findBand(tree);
    assert.equal(band.props.y, 100);
    assert.equal(band.props.height, 0, "the clay band collapses into the base");
    assert.ok(findTrack(tree), "the empty mark is still drawn as the receded track");
    const root = find(tree, (n) => n.props?.className === "dsh-cs-pie");
    assert.equal(root.props["data-stale"], undefined, "a fresh reading is not dimmed");
    assert.equal(
      find(tree, (n) => n.type === primitivesTooltip).props.label,
      "100% of the 5-hour quota was used\nResets in 20m",
    );
  });
});

test("a spent weekly window depletes the mark and renames the tooltip", async () => {
  // The 5-hour window still has room, but the spent weekly gate blocks every
  // message. An extra pool cannot reopen it when exhausted or disabled.
  const observedAt = Date.now();
  const windows = [
    { label: "5-hour", percent: 21, resetsAt: observedAt + 115 * 60_000 },
    {
      label: "Weekly",
      percent: 100,
      resetsAt: observedAt + 4 * 86_400_000 + 17 * 3_600_000,
    },
  ];
  const cases = [
    { name: "no extra-usage pool", extra: null },
    {
      name: "an enabled but fully spent extra-usage pool",
      extra:
        "[████████████████████] 100% used · enabled · spent 40.00 USD · monthly cap 40.00 USD",
    },
    {
      name: "a disabled extra-usage pool",
      extra:
        "[██░░░░░░░░░░░░░░░░░░] 8% used · disabled · spent 2.50 USD · monthly cap 10.00 USD",
    },
  ];
  for (const { name, extra } of cases) {
    const { registered, stub } = mount();
    const storage = storageStub();
    storage.setItem(cacheKey(), JSON.stringify({ plan: "Pro", windows, extra, observedAt }));
    await withLocalStorageAsync(storage, async () => {
      const pie = registered["conversation.input.right"].component;
      const operations = operationsStub();
      const { store } = directoryStub();
      stub.resetCursor();
      pie({ operations, sessionId: "session-1", directory: store });
      stub.drainEffects();
      await settle(5);
      stub.resetCursor();
      const tree = pie({ operations, sessionId: "session-1", directory: store });
      const band = findBand(tree);
      assert.equal(band.props.y, 100, name);
      assert.equal(band.props.height, 0, name);
      const tip = find(tree, (n) => n.type === primitivesTooltip);
      assert.equal(tip.props.label, "Weekly limit reached\nResets in 4d 17h", name);
      const button = find(tree, (n) => n.props?.className === "dsh-cs-pieBtn");
      assert.equal(
        button.props["aria-label"],
        "Weekly limit reached (resets in 4d 17h)",
        name,
      );
      stub.runCleanups();
    });
  }
});

test("an active extra-usage pool takes the mark from any spent plan-limit family", async () => {
  const observedAt = Date.now();
  const extra =
    "[██░░░░░░░░░░░░░░░░░░] 8% used · enabled · spent 2.50 USD · monthly cap 10.00 USD";
  const cases = [
    {
      name: "a spent weekly overrides a five-hour window with room",
      windows: [
        { label: "5-hour", percent: 21, resetsAt: observedAt + 115 * 60_000 },
        {
          label: "Weekly",
          percent: 100,
          resetsAt: observedAt + 4 * 86_400_000 + 17 * 3_600_000,
        },
      ],
    },
    {
      name: "a spent five-hour activates credits while the weekly has room",
      windows: [
        { label: "5-hour", percent: 100, resetsAt: observedAt + 60_000 },
        { label: "Weekly", percent: 48, resetsAt: observedAt + 3 * 86_400_000 },
      ],
    },
    {
      name: "a spent scoped weekly activates credits while the general weekly has room",
      windows: [
        { label: "Weekly", percent: 40, resetsAt: observedAt + 3 * 86_400_000 },
        { label: "Weekly (Opus)", percent: 101, resetsAt: observedAt + 3 * 86_400_000 },
      ],
    },
  ];
  for (const { name, windows } of cases) {
    const { registered, stub } = mount();
    const storage = storageStub();
    storage.setItem(cacheKey(), JSON.stringify({ plan: "Pro", windows, extra, observedAt }));
    await withLocalStorageAsync(storage, async () => {
      const pie = registered["conversation.input.right"].component;
      const operations = operationsStub();
      const { store } = directoryStub();
      stub.resetCursor();
      pie({ operations, sessionId: "session-1", directory: store });
      stub.drainEffects();
      await settle(5);
      stub.resetCursor();
      const tree = pie({ operations, sessionId: "session-1", directory: store });
      const band = findBand(tree);
      assert.equal(band.props.y, 8, name);
      assert.equal(band.props.height, 92, name);
      const tip = find(tree, (n) => n.type === primitivesTooltip);
      assert.equal(tip.props.label, "8% of the extra quota was used", name);
      stub.runCleanups();
    });
  }
});

test("weekly quota with room keeps the 5-hour mark and tooltip", async () => {
  // The pool stays secondary until a plan limit is spent or no plan window is usable.
  const observedAt = Date.now();
  const windows = [
    { label: "5-hour", percent: 21, resetsAt: observedAt + 115 * 60_000 },
    { label: "Weekly", percent: 48, resetsAt: observedAt + 5 * 86_400_000 },
  ];
  const cases = [
    {
      name: "an active extra-usage pool stays secondary",
      extra:
        "[██░░░░░░░░░░░░░░░░░░] 8% used · enabled · spent 2.50 USD · monthly cap 10.00 USD",
    },
    { name: "no extra-usage pool", extra: null },
  ];
  for (const { name, extra } of cases) {
    const { registered, stub } = mount();
    const storage = storageStub();
    storage.setItem(cacheKey(), JSON.stringify({ plan: "Pro", windows, extra, observedAt }));
    await withLocalStorageAsync(storage, async () => {
      const pie = registered["conversation.input.right"].component;
      const operations = operationsStub();
      const { store } = directoryStub();
      stub.resetCursor();
      pie({ operations, sessionId: "session-1", directory: store });
      stub.drainEffects();
      await settle(5);
      stub.resetCursor();
      const tree = pie({ operations, sessionId: "session-1", directory: store });
      const band = findBand(tree);
      assert.equal(band.props.y, 21, name);
      assert.equal(band.props.height, 79, name);
      const tip = find(tree, (n) => n.type === primitivesTooltip);
      assert.equal(tip.props.label, "21% of the 5-hour quota was used\nResets in 1h 55m", name);
      stub.runCleanups();
    });
  }
});

test("an active extra-usage pool drives the mark when no plan window is usable", async () => {
  // The pool sits last in the priority chain, so it takes the mark only when
  // the cache has no usable plan window at all.
  const { registered, stub } = mount();
  const storage = storageStub();
  storage.setItem(
    cacheKey(),
    JSON.stringify({
      plan: "Pro",
      windows: [],
      extra: "[██░░░░░░░░░░░░░░░░░░] 8% used · enabled · spent 2.50 USD · monthly cap 10.00 USD",
      observedAt: Date.now(),
    }),
  );
  await withLocalStorageAsync(storage, async () => {
    const pie = registered["conversation.input.right"].component;
    const operations = operationsStub();
    const { store } = directoryStub();
    stub.resetCursor();
    pie({ operations, sessionId: "session-1", directory: store });
    stub.drainEffects();
    await settle(5);
    stub.resetCursor();
    const tree = pie({ operations, sessionId: "session-1", directory: store });
    const band = findBand(tree);
    assert.equal(band.props.y, 8, "the pool's utilization drives the gauge");
    assert.equal(band.props.height, 92);
    const tip = find(tree, (n) => n.type === primitivesTooltip);
    assert.equal(
      tip.props.label,
      "8% of the extra quota was used",
      "the pool's reading has no countdown: it resets monthly, not on the wire",
    );
  });
});

test("a scoped weekly window drives the override when no general weekly exists", async () => {
  // Ultra-style plans report scoped weeklies ("Weekly (Opus)") and no 5-hour
  // window. The startsWith fallback must reach them, or the spent scoped gate
  // reads as an ordinary spent share instead of the weekly limit.
  const { registered, stub } = mount();
  const storage = storageStub();
  const observedAt = Date.now();
  storage.setItem(
    cacheKey(),
    JSON.stringify({
      plan: "Ultra",
      windows: [
        { label: "Weekly (Opus)", percent: 100, resetsAt: observedAt + 3 * 86_400_000 },
      ],
      extra: null,
      observedAt,
    }),
  );
  await withLocalStorageAsync(storage, async () => {
    const pie = registered["conversation.input.right"].component;
    const operations = operationsStub();
    const { store } = directoryStub();
    stub.resetCursor();
    pie({ operations, sessionId: "session-1", directory: store });
    stub.drainEffects();
    await settle(5);
    stub.resetCursor();
    const tree = pie({ operations, sessionId: "session-1", directory: store });
    const tip = find(tree, (n) => n.type === primitivesTooltip);
    assert.equal(tip.props.label, "Weekly limit reached\nResets in 3d");
  });
});

test("the composer mark draws the cached 5-hour band wrapped in the shared tooltip", async () => {
  const { registered, stub } = mount();
  const storage = storageStub();
  // A cache with `ts` and no `observedAt` exercises the stamp fallback, and its
  // reset carries an absolute clock: the tooltip strips it and reads the countdown
  // alone.
  storage.setItem(
    cacheKey(),
    JSON.stringify({
      plan: "Pro",
      windows: [{ label: "5-hour", percent: 34, reset: "resets in 3h 9m · at 11:10 AM" }],
      extra: null,
      ts: Date.now(),
    }),
  );
  await withLocalStorageAsync(storage, async () => {
    const pie = registered["conversation.input.right"].component;
    const operations = operationsStub();
    const { store } = directoryStub();
    stub.resetCursor();
    pie({ operations, sessionId: "session-1", directory: store });
    stub.drainEffects();
    await settle(5);
    stub.resetCursor();
    const tree = pie({ operations, sessionId: "session-1", directory: store });
    const band = findBand(tree);
    assert.equal(band.props.y, 34);
    assert.equal(band.props.height, 66, "the cached 5-hour percent sets the clay/neutral boundary");
    // The stub does not invoke components, so assert on the Tooltip
    // element's own props, the part this plugin controls.
    const tip = find(tree, (n) => n.type === primitivesTooltip);
    assert.ok(tip, "the trigger is wrapped in the shared Tooltip");
    assert.equal(
      tip.props.label,
      "34% of the 5-hour quota was used\nResets in 3h 9m",
      "the tooltip reads the countdown, clock stripped",
    );
    assert.equal(
      tip.props.portal,
      true,
      "the bubble portals out of the composer's container row",
    );
    const root = find(tree, (n) => n.props?.className === "dsh-cs-pie");
    assert.equal(root.props["data-stale"], undefined, "a fresh cache is not dimmed");
  });
});

test("a corrupted cache degrades instead of crashing the slot", async () => {
  const { registered, stub } = mount();
  const storage = storageStub();
  storage.setItem(
    cacheKey(),
    JSON.stringify({
      plan: 42,
      windows: [{ label: "5-hour", percent: 20, reset: "resets in 1h" }],
      extra: null,
      observedAt: Date.now(),
    }),
  );
  await withLocalStorageAsync(storage, async () => {
    const pie = registered["conversation.input.right"].component;
    const operations = operationsStub();
    const { store } = directoryStub();
    stub.resetCursor();
    let tree = pie({ operations, sessionId: "session-1", directory: store });
    stub.drainEffects();
    await settle(5);
    stub.resetCursor();
    tree = pie({ operations, sessionId: "session-1", directory: store });
    const button = find(tree, (n) => n.props?.className === "dsh-cs-pieBtn");
    assert.ok(button, "the indicator still renders");
    button.props.onClick({ stopPropagation() {} });
    stub.resetCursor();
    tree = pie({ operations, sessionId: "session-1", directory: store });
    assert.equal(
      find(tree, (n) => n.props?.className === "dsh-cs-sTitleValue"),
      undefined,
      "a non-string plan renders as absent",
    );
  });
});

test("a host without the shared primitives module degrades to a bare trigger", async () => {
  const { registered, stub } = mount({ primitives: {} });
  const storage = storageStub();
  storage.setItem(
    cacheKey(),
    JSON.stringify({
      plan: "Pro",
      windows: [{ label: "5-hour", percent: 34, reset: "resets in 3h" }],
      extra: null,
      observedAt: Date.now(),
    }),
  );
  await withLocalStorageAsync(storage, async () => {
    const pie = registered["conversation.input.right"].component;
    const operations = operationsStub();
    const { store } = directoryStub();
    stub.resetCursor();
    pie({ operations, sessionId: "session-1", directory: store });
    stub.drainEffects();
    await settle(5);
    stub.resetCursor();
    const tree = pie({ operations, sessionId: "session-1", directory: store });
    assert.ok(
      find(tree, (n) => n.props?.className === "dsh-cs-pieBtn"),
      "the trigger renders",
    );
    assert.equal(
      find(tree, (n) => n.type === primitivesTooltip),
      undefined,
      "no tooltip wrapper without the module",
    );
    const band = findBand(tree);
    assert.equal(band.props.y, 34);
    assert.equal(band.props.height, 66, "the band still draws");
  });
});

test("clicking the indicator toggles the full plan panel", async () => {
  const { registered, stub } = mount();
  const storage = storageStub();
  storage.setItem(
    cacheKey(),
    JSON.stringify({
      plan: "Pro",
      windows: [{ label: "5-hour", percent: 34, reset: "resets in 3h 19m · at 11:10 AM" }],
      // The host's formatExtra string, plain-text bar included.
      extra: "[██░░░░░░░░░░░░░░░░░░] 8% used · enabled · spent 2.50 USD · monthly cap 10.00 USD",
      ts: Date.now(),
    }),
  );
  await withLocalStorageAsync(storage, async () => {
    const pie = registered["conversation.input.right"].component;
    const operations = operationsStub();
    const { store } = directoryStub();
    stub.resetCursor();
    let tree = pie({ operations, sessionId: "session-1", directory: store });
    stub.drainEffects();
    await settle(5);
    stub.resetCursor();
    tree = pie({ operations, sessionId: "session-1", directory: store });
    assert.equal(
      find(tree, (n) => n.props?.className?.includes("dsh-cs-piePop")),
      undefined,
      "closed initially",
    );
    const trigger = () => find(tree, (n) => n.props?.className === "dsh-cs-pieBtn");
    assert.equal(trigger().props["aria-expanded"], false, "the trigger reports a closed dialog");
    assert.equal(
      trigger().props["aria-haspopup"],
      "dialog",
      "the trigger declares the dialog role",
    );
    trigger().props.onClick();
    stub.resetCursor();
    tree = pie({ operations, sessionId: "session-1", directory: store });
    const pop = find(tree, (n) => n.props?.className?.includes("dsh-cs-piePop"));
    assert.ok(pop, "the panel opens on click");
    assert.equal(trigger().props["aria-expanded"], true, "the trigger reports the open dialog");
    assert.equal(
      flatten(find(pop, (n) => n.props?.className === "dsh-cs-sTitleValue")),
      "Pro plan",
      "the plan rides the panel header",
    );
    assert.ok(
      flatten(pop).includes("5-hour · resets in 3h 19m"),
      "the window carries its countdown",
    );
    assert.ok(flatten(pop).includes("34%"));
    assert.ok(
      flatten(pop).includes("enabled · spent 2.50 USD · monthly cap 10.00 USD"),
      "the pool detail rides the panel",
    );
    assert.equal(/[█░]/.test(flatten(pop)), false, "the plain-text bar never reaches the panel");
    const fills = [];
    (function collect(node) {
      if (node === null || node === undefined || typeof node !== "object") return;
      if (node.props?.className === "dsh-cs-sFill") fills.push(node.props.style.width);
      if (Array.isArray(node)) return node.forEach(collect);
      if (Array.isArray(node.children)) node.children.forEach(collect);
    })(pop);
    assert.deepEqual(fills, ["34%", "8%"], "one bar per window, and one for the extra-usage pool");
    // The popover shows the countdown the command output also carries.
    assert.equal(flatten(pop).includes("11:10 AM"), false);
    assert.equal(
      find(tree, (n) => n.type === primitivesTooltip).props.disabled,
      true,
      "the shared tooltip is disabled while the panel is open",
    );
    // Without the shared placement primitive (this stub's primitives carry
    // only the Tooltip) the panel rides the stylesheet's absolute seat: no
    // fixed class, no inline placement, and no onClick of its own, the
    // vanilla seat dismisses through document-level containment, so panel
    // clicks are recognized, not stopped.
    assert.equal(
      pop.props.className.includes("dsh-cs-piePopFixed"),
      false,
      "no fixed seat without the placement primitive",
    );
    assert.equal(pop.props.style, undefined, "no inline placement without the placement primitive");
    assert.equal(
      pop.props.onClick,
      undefined,
      "the panel stops no propagation; dismissal is containment-based",
    );
    stub.resetCursor();
    tree = pie({ operations, sessionId: "session-1", directory: store });
    assert.ok(
      find(tree, (n) => n.props?.className?.includes("dsh-cs-piePop")),
      "the panel stays open across renders",
    );
    trigger().props.onClick();
    stub.resetCursor();
    tree = pie({ operations, sessionId: "session-1", directory: store });
    assert.equal(
      find(tree, (n) => n.props?.className?.includes("dsh-cs-piePop")),
      undefined,
      "second click closes",
    );
    assert.equal(
      find(tree, (n) => n.type === primitivesTooltip).props.disabled,
      false,
      "closed again re-enables the tooltip",
    );
  });
});

// ---- the self-refresh pulls and triggers ------------------------------------

/** The engine's published snapshot shape, with resets anchored in the near future. */
const SNAPSHOT = {
  observedAt: Date.parse("2020-01-01T12:00:00.000Z"),
  plan: "Pro",
  windows: [
    { label: "5-hour", percent: 34, resetsAt: Date.now() + 3 * 60 * 60_000 },
    { label: "Weekly", percent: 5 },
  ],
  extra: "disabled",
};

/**
 * An operations double wired like the real createOperations face: describe
 * answers one namespace row with the account mirror and per-route usage
 * snapshots, $on records the forwarded-event subscriptions, and discoverModels
 * records the pings with their target.
 */
function operationsStub({
  snapshot = SNAPSHOT,
  ok = true,
  accounts = [{ route: ROUTE, email: "one@example.com", status: "signedIn" }],
  route = ROUTE,
  lastQuotaFailure = null,
  enforceRevision = false,
  onConflict,
} = {}) {
  const subscriptions = [];
  const pings = [];
  /** Mutate calls recorded at the settings seam: `{ ns, ops }`. */
  const mutates = [];
  let revision = 1;
  // The served settings document: mutations apply into it, so a re-pull after
  // a write observes the write (the real service's behavior).
  let document = {
    accounts: { mirror: { accounts }, models: {} },
    usage: {
      snapshots: snapshot === undefined || route === undefined ? {} : { [route]: snapshot },
      lastQuotaFailure,
    },
  };
  const $on = (event, listener) => {
    subscriptions.push({ event, listener });
    return () => {
      const at = subscriptions.findIndex(
        (entry) => entry.event === event && entry.listener === listener,
      );
      if (at !== -1) subscriptions.splice(at, 1);
    };
  };
  let describes = 0;
  const settingsDouble = {
    // Match the browser Remote's response envelope and count every describe call.
    describe() {
      describes += 1;
      if (!ok) return { ok: false, error: { message: "offline" } };
      return { ok: true, value: { namespaces: [{ ns: SETTINGS_NS, revision, value: document }] } };
    },
    async mutate(ns, ops) {
      if (!ok) throw new Error(`Plugin entry "${ns}" is no longer configurable`);
      mutates.push({ ns, ops });
      for (const op of ops) document = applyPathOp(document, op.path, op);
      revision += 1;
      return { ok: true };
    },
  };
  return {
    subscriptions,
    pings,
    mutates,
    describes: () => describes,
    document: () => document,
    remoteSettings: settingsDouble,
    describe: async () => settingsDouble.describe(),
    mutate: settingsDouble.mutate,
    writeModels: async (ops, expectedRevision) => {
      if (enforceRevision && expectedRevision !== revision) {
        // The real service's stale-revision answer: a resolved refusal
        // envelope, not a throw. onConflict runs first, so a raced write can
        // land before the caller's retry reads the document.
        onConflict?.();
        return {
          ok: false,
          error: { code: "settings/conflict", message: "the document moved" },
        };
      }
      await settingsDouble.mutate(SETTINGS_NS, ops, expectedRevision);
      return { ok: true, value: { revision } };
    },
    discoverModels: async (provider) => {
      pings.push(provider);
      return { ok: true, value: [] };
    },
    onAdaptersUpdated: (listener) => $on("llm/adapters-updated", listener),
    onSettingsUpdated: (listener) => $on("settings/document-updated", listener),
    onEvent: (event, listener) => $on(event, listener),
  };
}

/** Mount and drain a pie against an operations double, returning the pieces. */
async function mountPie({
  snapshot,
  ok,
  accounts,
  route,
  directory = directoryStub(route ?? ROUTE),
  sessionId = "session-1",
} = {}) {
  const { registered, stub } = mount();
  const operations = operationsStub({ snapshot, ok, accounts, route: directory.route });
  const pie = registered["conversation.input.right"].component;
  stub.resetCursor();
  pie({ operations, sessionId, directory: directory.store });
  stub.drainEffects();
  // The mirror pull (the visibility gate and the account name) is async.
  // let it land before the test's own renders.
  await settle(5);
  stub.resetCursor();
  const tree = pie({ operations, sessionId, directory: directory.store });
  return { registered, stub, operations, pie, tree, directory, sessionId };
}

test("a plan without a 5-hour window tracks its weekly quota", async () => {
  const observedAt = Date.now();
  const ultra = {
    observedAt,
    plan: "Ultra",
    windows: [{ label: "Weekly", percent: 23, resetsAt: observedAt + 6 * 24 * 60 * 60_000 }],
    extra: null,
  };
  await withLocalStorageAsync(storageStub(), async () => {
    const { stub, pie, operations, directory, sessionId } = await mountPie({ snapshot: ultra });
    stub.resetCursor();
    let tree = pie({ operations, sessionId, directory: directory.store });
    const band = findBand(tree);
    assert.ok(band, "the weekly reading drives the gauge");
    assert.equal(band.props.y, 23);
    assert.equal(band.props.height, 77, "the weekly percent sets the clay/neutral boundary");
    const tip = find(tree, (n) => n.type === primitivesTooltip);
    assert.equal(tip.props.label, "23% of the weekly quota was used\nResets in 6d");
    assert.equal(
      tip.props.label.includes("Fetching"),
      false,
      "the mark is not in its fetching state",
    );
    const trigger = find(tree, (n) => n.props?.className === "dsh-cs-pieBtn");
    trigger.props.onClick();
    stub.resetCursor();
    tree = pie({ operations, sessionId, directory: directory.store });
    const pop = find(tree, (n) => n.props?.className?.includes("dsh-cs-piePop"));
    assert.ok(pop, "the panel opens");
    assert.ok(flatten(pop).includes("Weekly"), "the weekly window renders");
    assert.ok(flatten(pop).includes("23%"), "the panel carries the weekly percent");
    assert.equal(flatten(pop).includes("Fetching…"), false, "the panel has no fetching row");
    stub.runCleanups();
  });
});

test("a settings-document snapshot lands in the cache and the render", async () => {
  const storage = storageStub();
  await withLocalStorageAsync(storage, async () => {
    const { stub, pie, operations, directory, sessionId } = await mountPie({});
    await settle(5);
    const cached = JSON.parse(storage.getItem(cacheKey()));
    assert.equal(
      cached.observedAt,
      SNAPSHOT.observedAt,
      "the cache carries the snapshot's observation stamp",
    );
    assert.equal(cached.plan, "Pro");
    assert.equal(
      cached.windows[0].resetsAt,
      SNAPSHOT.windows[0].resetsAt,
      "the epoch reset rides the cache",
    );
    assert.equal(operations.describes(), 1, "exactly one mount pull");
    stub.resetCursor();
    const tree = pie({ operations, sessionId, directory: directory.store });
    assert.equal(findBand(tree).props.y, 34, "the mark depletes by the pulled percent");
    // The epoch countdown renders live from the cache, not the string form.
    const tip = find(tree, (n) => n.type === primitivesTooltip);
    assert.ok(
      tip.props.label.includes("Resets in 3h"),
      `the tooltip carries the recomputed countdown (got: ${JSON.stringify(tip.props.label)})`,
    );
    stub.runCleanups();
  });
});

test("the indicator keeps its tooltip quota-only and hides for another provider", async () => {
  const storage = storageStub();
  await withLocalStorageAsync(storage, async () => {
    // A second signed-in account does not add an account line to the
    // tooltip; the open panel is where the account is named.
    const { stub, pie, directory, sessionId } = await mountPie({
      accounts: [
        { route: ROUTE, email: "one@example.com", status: "signedIn" },
        { route: "claude-subscription-222222222222", email: "two@example.com", status: "signedIn" },
      ],
    });
    await settle(5);
    stub.resetCursor();
    const tree = pie({ operations: operationsStub(), sessionId, directory: directory.store });
    const tip = find(tree, (n) => n.type === primitivesTooltip);
    assert.equal(
      tip.props.label.includes("@"),
      false,
      `two accounts: the tooltip stays quota-only (got: ${JSON.stringify(tip.props.label)})`,
    );
    stub.runCleanups();
  });
  await withLocalStorageAsync(storageStub(), async () => {
    // One account: the tooltip is quota-only as well.
    const { stub, pie, directory, sessionId } = await mountPie({});
    await settle(5);
    stub.resetCursor();
    const tree = pie({ operations: operationsStub(), sessionId, directory: directory.store });
    const tip = find(tree, (n) => n.type === primitivesTooltip);
    assert.equal(tip.props.label.includes("@"), false, "one account: no account line");
    stub.runCleanups();
  });
  await withLocalStorageAsync(storageStub(), async () => {
    // A model from another provider: no indicator at all.
    const other = directoryStub("deepseek-official");
    const { stub, pie, sessionId } = await mountPie({ directory: other });
    await settle(5);
    stub.resetCursor();
    assert.equal(
      pie({ operations: operationsStub(), sessionId, directory: other.store }),
      null,
      "another provider's model: no indicator",
    );
    stub.runCleanups();
  });
});

test("switching the selected model switches the reported account", async () => {
  const storage = storageStub();
  await withLocalStorageAsync(storage, async () => {
    const routeB = "claude-subscription-222222222222";
    const accounts = [
      { route: ROUTE, email: "one@example.com", status: "signedIn" },
      { route: routeB, email: "two@example.com", status: "signedIn" },
    ];
    const { stub, pie, operations, directory, sessionId } = await mountPie({ accounts });
    await settle(5);
    // Flush the queue the mount's second render left: the manual stub runs
    // effects only when drained, and a stale pull must not outlive the
    // switch it precedes.
    stub.drainEffects();
    await settle(5);
    // Account B's snapshot lands in the document and its cache.
    storage.setItem(
      cacheKey(routeB),
      JSON.stringify({
        plan: "Max",
        windows: [{ label: "5-hour", percent: 80 }],
        extra: null,
        observedAt: Date.now(),
      }),
    );
    directory.store.set({ current: { provider: routeB, model: "claude-opus-5-5" } });
    // Render first: the route-scoped effects queue against the NEW route,
    // then drain, then the re-render reads the switched account's cache.
    stub.resetCursor();
    pie({ operations, sessionId, directory: directory.store });
    stub.drainEffects();
    await settle(5);
    stub.resetCursor();
    const tree = pie({ operations, sessionId, directory: directory.store });
    const tip = find(tree, (n) => n.type === primitivesTooltip);
    assert.ok(
      tip.props.label.includes("80%"),
      `the switched account's own reading renders (got: ${JSON.stringify(tip.props.label)})`,
    );
    // The ping targets the newly selected account.
    const trigger = find(tree, (n) => n.props?.className === "dsh-cs-pieBtn");
    trigger.props.onMouseEnter();
    assert.ok(operations.pings.at(-1) === `ping:${routeB}`, "the ping names the selected account");
    stub.runCleanups();
  });
});

test("a needs-sign-in account renders the re-login guidance", async () => {
  const { stub, pie, directory, sessionId } = await mountPie({
    accounts: [{ route: ROUTE, email: "one@example.com", status: "needsReauth" }],
  });
  await settle(5);
  stub.resetCursor();
  const tree = pie({
    operations: operationsStub({
      accounts: [{ route: ROUTE, email: "one@example.com", status: "needsReauth" }],
    }),
    sessionId,
    directory: directory.store,
  });
  const tip = find(tree, (n) => n.type === primitivesTooltip);
  assert.match(tip.props.label, /needs sign-in again/);
  assert.match(tip.props.label, /one@example.com/);
  assert.match(tip.props.label, /\/claude-login/);
  stub.runCleanups();
});

test("a pull never regresses a newer manual run", async () => {
  const storage = storageStub();
  await withLocalStorageAsync(storage, async () => {
    // A manual /claude-usage run observed AFTER the snapshot: its cache wins.
    const manual = {
      plan: "Pro",
      windows: [{ label: "5-hour", percent: 50, reset: "resets in 2h" }],
      extra: null,
      observedAt: SNAPSHOT.observedAt + 60_000,
    };
    storage.setItem(cacheKey(), JSON.stringify(manual));
    const { stub, operations } = await mountPie({});
    await settle(5);
    const cached = JSON.parse(storage.getItem(cacheKey()));
    assert.equal(cached.observedAt, manual.observedAt, "the newer manual run survives the pull");
    assert.equal(cached.windows[0].percent, 50);
    assert.equal(operations.describes(), 1, "the pull ran and deferred");
    stub.runCleanups();
  });
  // The reverse: an older cache is replaced by the newer snapshot.
  const older = storageStub();
  older.setItem(
    cacheKey(),
    JSON.stringify({
      plan: null,
      windows: [{ label: "5-hour", percent: 9 }],
      extra: null,
      observedAt: SNAPSHOT.observedAt - 60_000,
    }),
  );
  await withLocalStorageAsync(older, async () => {
    const { stub } = await mountPie({});
    await settle(5);
    const cached = JSON.parse(older.getItem(cacheKey()));
    assert.equal(
      cached.observedAt,
      SNAPSHOT.observedAt,
      "the newer snapshot replaces the older cache",
    );
    assert.equal(cached.windows[0].percent, 34);
    stub.runCleanups();
  });
});

test("the forwarded settings event re-pulls for this namespace only", async () => {
  const { stub, operations } = await mountPie({});
  await settle(5);
  const settingsEvent = operations.subscriptions.find(
    (entry) => entry.event === "settings/document-updated",
  );
  assert.ok(settingsEvent, "the settings invalidation is subscribed");
  const describes = operations.describes();
  settingsEvent.listener("other-plugin");
  await settle(5);
  assert.equal(operations.describes(), describes, "another namespace's update is ignored");
  settingsEvent.listener(SETTINGS_NS);
  await settle(5);
  assert.ok(operations.describes() > describes, "this namespace's update re-pulls");
  stub.runCleanups();
});

test("a failed pull keeps the cache", async () => {
  const storage = storageStub();
  const original = {
    plan: "Pro",
    windows: [{ label: "5-hour", percent: 34 }],
    extra: null,
    observedAt: 1,
  };
  storage.setItem(cacheKey(), JSON.stringify(original));
  await withLocalStorageAsync(storage, async () => {
    const { stub, pie, operations, directory, sessionId } = await mountPie({ ok: false });
    await settle(5);
    const cached = JSON.parse(storage.getItem(cacheKey()));
    assert.deepEqual(cached, original, "the failed describe leaves the cache alone");
    stub.resetCursor();
    // The failed pull leaves the account unknown, and the indicator never
    // guesses: it hides until the next successful pull.
    assert.ok(
      pie({ operations, sessionId, directory: directory.store }),
      "a failed pull never hides an account route's indicator",
    );
    stub.runCleanups();
  });
});

test("each trigger pings the host for its own session and account", async () => {
  const { stub, operations, pie, directory, sessionId } = await mountPie({});
  await settle(5);
  const events = Object.fromEntries(
    operations.subscriptions.map((entry) => [entry.event, entry.listener]),
  );
  assert.ok(events["api-session/activity"], "a sent message is subscribed");
  assert.ok(events["api-session/status"], "a settled agent turn is subscribed");
  const pings = operations.pings.length;
  events["api-session/activity"](sessionId);
  assert.equal(operations.pings.length, pings + 1, "a sent message pings");
  assert.equal(operations.pings.at(-1), `ping:${ROUTE}`, "the ping names the selected account");
  events["api-session/activity"]("another-session");
  assert.equal(
    operations.pings.length,
    pings + 1,
    "another session's activity does not drive this account",
  );
  events["api-session/status"](sessionId, true);
  assert.equal(operations.pings.length, pings + 1, "a running session does not ping");
  events["api-session/status"](sessionId, false);
  assert.equal(operations.pings.length, pings + 2, "the settled turn pings");
  // The forwarded subscriptions were cleaned up. The trigger's own handlers
  // are the remaining trigger surface, and they ping too.
  stub.resetCursor();
  const trigger = pieTrigger(pie({ operations, sessionId, directory: directory.store }));
  assert.equal(
    typeof trigger.props.onMouseEnter,
    "function",
    "the hover ping rides the tooltip's trigger",
  );
  assert.equal(typeof trigger.props.onFocus, "function", "keyboard focus pings too");
  const before = operations.pings.length;
  trigger.props.onMouseEnter();
  trigger.props.onFocus();
  assert.equal(operations.pings.length, before + 2, "hover and focus each ping");
  trigger.props.onClick();
  assert.equal(operations.pings.length, before + 3, "the click pings alongside its toggle");
  stub.runCleanups();
  assert.equal(
    operations.subscriptions.length,
    0,
    "the cleanups unsubscribe every forwarded event",
  );
});

/** Render one pie and return its trigger button element. */
function pieTrigger(tree) {
  return find(tree, (n) => n.props?.className === "dsh-cs-pieBtn");
}

test("the string cache ticks from its observation anchor", async () => {
  const storage = storageStub();
  // Observed 10 minutes ago, the cached "resets in 3h 19m" reads 3h 9m now.
  const observedAt = Date.now() - 10 * 60_000;
  storage.setItem(
    cacheKey(),
    JSON.stringify({
      plan: "Pro",
      windows: [{ label: "5-hour", percent: 34, reset: "resets in 3h 19m" }],
      extra: null,
      observedAt,
    }),
  );
  await withLocalStorageAsync(storage, async () => {
    const { stub, operations, pie, directory, sessionId } = await mountPie({});
    stub.resetCursor();
    const tree = pie({ operations, sessionId, directory: directory.store });
    const tip = find(tree, (n) => n.type === primitivesTooltip);
    assert.ok(
      tip.props.label.includes("3h 9m"),
      `the anchored countdown ticks (got: ${tip.props.label})`,
    );
    stub.runCleanups();
  });
});

test("the indicator degrades without an operations face", async () => {
  const storage = storageStub();
  storage.setItem(
    cacheKey(),
    JSON.stringify({
      plan: "Pro",
      windows: [{ label: "5-hour", percent: 34, reset: "resets in 3h 19m" }],
      extra: null,
      observedAt: 1,
    }),
  );
  await withLocalStorageAsync(storage, async () => {
    const { stub, pie, directory, sessionId } = await mountPie();
    stub.resetCursor();
    // No operations face: the pie cannot learn which account it would be
    // reporting on, so it renders nothing instead of guessing, and never
    // throws.
    assert.doesNotThrow(
      () => pie({ sessionId, directory: directory.store }),
      "no operations prop: a quiet hide, not a crash",
    );
    assert.ok(
      pie({ sessionId, directory: directory.store }),
      "no operations face: the route alone shows the indicator",
    );
    // No directory either (a host without the model-directory service):
    // the same quiet hide.
    assert.doesNotThrow(() => pie({ sessionId }), "no directory: a quiet hide, not a crash");
    assert.equal(pie({ sessionId }), null, "no directory: no indicator");
    stub.runCleanups();
  });
});

/** settle: one macrotask turn for the async pulls. */
const settle = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

/** withLocalStorage for async bodies. */
async function withLocalStorageAsync(stub, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    value: stub,
    configurable: true,
    writable: true,
  });
  try {
    await fn();
  } finally {
    if (descriptor === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, "localStorage", descriptor);
  }
}

test("selecting an account's model refreshes it past the cooldown, once per account", async () => {
  const { stub, operations } = await mountPie({});
  await settle(5);
  const selects = operations.pings.filter((ping) => ping === `ping:${ROUTE}#select`);
  assert.equal(selects.length, 1, "the first render on an account's model is a selection ping");
  stub.runCleanups();
});

// ---- the quota notice (shell.quota-notice) ------------------------------------
//
// Our quota failures get a custom modal; everyone else keeps the host Toast.

/** A minimal snapshot store matching @deepseek-ai/dsh-client-store's face. */
function snapshotStore(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (next) => {
      value = next;
      for (const listener of listeners) listener();
    },
  };
}

/** Small stand-ins for host components, found by function identity in the tree. */
function noticePrimitives() {
  const modal = (props) => ({ type: "modal", props });
  const toast = (props) => ({ type: "toast", props });
  const button = (props) => ({ type: "button", props, children: props.children });
  const warning = (props) => ({ type: "warning-icon", props });
  return {
    Modal: modal,
    Toast: toast,
    Button: button,
    IconWarningOutlineRegular: warning,
    Tooltip: primitivesTooltip,
    modal,
    toast,
    button,
    warning,
  };
}

/** The chain owner the renderer passes the elected component. */
function ownerDouble() {
  const dismissed = [];
  return {
    owner: {
      code: "QUOTA",
      message: "Request quota exhausted.",
      dismiss: () => dismissed.push(true),
    },
    dismissed,
  };
}

/**
 * Mount a notice against a live marker store. `rawMarker` populates
 * `usage.lastQuotaFailure`; `detached` leaves it unsettled; `guardMs` shortens
 * the guard; `enforceRevision` simulates revision conflicts.
 */
async function mountNotice({
  rawMarker = null,
  primitive = true,
  guardMs = 2000,
  detached = false,
  enforceRevision = false,
  onConflict,
  accounts = [{ route: ROUTE, email: "one@example.com", status: "signedIn" }],
} = {}) {
  const store = snapshotStore(undefined);
  const primitives = primitive ? noticePrimitives() : { Tooltip: primitivesTooltip };
  const operations = operationsStub({
    accounts,
    lastQuotaFailure: rawMarker,
    enforceRevision,
    onConflict,
  });
  const { registered, stub } = mount({
    primitives,
    storeFactory: () => store,
    ...(detached ? {} : { remote: { settings: operations.remoteSettings, $on: operations.onEvent } }),
  });
  const notice = registered["shell.quota-notice"];
  if (!primitive) assert.ok(notice, "the registration exists even without the shared Modal");
  const { owner, dismissed } = ownerDouble();
  const render = () => {
    stub.resetCursor();
    return notice.component({
      ...owner,
      useMarker: () => store.getSnapshot(),
      operations,
      guardMs,
    });
  };
  render();
  stub.drainEffects();
  await settle(5); // the apply-level refresh settles the store from the document
  render();
  stub.drainEffects(); // the capture effect fixes the decision
  await settle(5);
  render();
  stub.drainEffects(); // the decision's consequences (the marker consumption) run
  await settle(5); // the consumption write lands
  return { registered, stub, operations, store, render, dismissed, types: primitives };
}

/** A raw marker as the host writes it into the settings document. */
function rawMarkerNow(overrides = {}) {
  return { route: ROUTE, at: Date.now() - 5_000, ...overrides };
}

test("a fresh marker renders the account modal and both close actions dismiss", async () => {
  const { stub, render, dismissed, types } = await mountNotice({ rawMarker: rawMarkerNow() });
  const tree = render();
  const modal = find(tree, (n) => n.type === types.modal);
  assert.ok(modal, "a fresh marker renders the modal");
  assert.equal(modal.props.open, true);
  // A single account gets no others hint or command link, and the reset label is lowercase.
  assert.match(modal.props.description, /Usage limit for this account reached\./);
  assert.match(modal.props.description, /The 5-hour limit resets in 3h\./);
  assert.ok(!modal.props.description.includes("other signed-in accounts"));
  assert.ok(!modal.props.description.includes("/claude-usage"));
  assert.equal(modal.props.children, undefined, "single account: no body paragraph");
  // The X and the footer Close both dismiss through the chain owner.
  modal.props.onClose();
  const footerClose = find(modal.props.footer, (n) => n.type === types.button);
  assert.equal(flatten(footerClose.children), "Close");
  footerClose.props.onClick();
  assert.equal(dismissed.length, 2, "both close affordances dismiss");
  stub.runCleanups();
});

test("a second signed-in account adds the others hint as the modal's second line", async () => {
  const { stub, render, types } = await mountNotice({
    accounts: [
      { route: ROUTE, email: "one@example.com", status: "signedIn" },
      { route: "claude-subscription-222222222222", email: "two@example.com", status: "signedIn" },
    ],
    rawMarker: rawMarkerNow(),
  });
  const modal = find(render(), (n) => n.type === types.modal);
  // Line 1 keeps the description paragraph; the hint is a separate body
  // paragraph (the Modal renders children below the description).
  assert.ok(
    !modal.props.description.includes("other signed-in accounts"),
    "the hint is not glued onto line 1",
  );
  const body = find(modal.props.children, (n) => n.props?.className === "dsh-cs-quotaLine");
  assert.ok(body, "the hint renders as the body's own paragraph");
  assert.match(
    flatten(body.children),
    /Other signed-in accounts have separate allowances\. Try selecting a model from one of them\./,
  );
  stub.runCleanups();
});

test("displaying the notice consumes the marker and keeps the modal visible", async () => {
  const { stub, operations, store, render, types } = await mountNotice({ rawMarker: rawMarkerNow() });
  render();
  await settle(5);
  const unset = operations.mutates.find((call) => call.ops[0]?.op === "unset");
  assert.ok(unset, "the display consumed the marker");
  assert.deepEqual(unset.ops, [{ op: "unset", path: ["usage", "lastQuotaFailure"] }]);
  // The next document event re-pulls and finds no marker: a later foreign
  // QUOTA failure reads as absent and falls back to the generic Toast.
  const settingsEvent = operations.subscriptions.find(
    (entry) => entry.event === "settings/document-updated",
  );
  settingsEvent.listener(SETTINGS_NS);
  await settle(5);
  assert.equal(store.getSnapshot(), null, "the consumed marker reads as absent");
  assert.ok(
    find(render(), (n) => n.type === types.modal),
    "the modal stays open after the consumed marker disappears",
  );
  stub.runCleanups();
});

test("a conflicted consume re-describes and retries with the fresh revision", async () => {
  // Retry with the fresh revision only while the decided marker is unchanged.
  const { stub, operations, store, render } = await mountNotice({
    detached: true,
    guardMs: 5_000,
    enforceRevision: true,
  });
  // The document holds the marker at revision 1; a host write moves it to 2
  // before the notice's consume runs.
  const marker = rawMarkerNow();
  await operations.mutate(SETTINGS_NS, [
    models.setQuotaMarkerOp(marker),
  ]);
  store.set({
    route: ROUTE,
    at: marker.at,
    email: "one@example.com",
    others: false,
    revision: 1, // the deciding describe's revision: already stale
    usage: SNAPSHOT,
  });
  render();
  stub.drainEffects(); // the capture fixes the decision
  render();
  stub.drainEffects(); // the consume fires against the stale revision and retries
  await settle(5); // the retry lands
  const unsets = operations.mutates.filter((call) => call.ops[0]?.op === "unset");
  assert.equal(unsets.length, 1, "exactly one unset lands: the retried one");
  assert.equal(
    operations.document().usage.lastQuotaFailure,
    undefined,
    "the decided marker is consumed after the conflict retry",
  );
  stub.runCleanups();
});

test("a conflicted consume never eats a fresh marker from a raced second failure", async () => {
  // A raced second marker belongs to a new failure and must not be consumed.
  const { stub, operations, store, render } = await mountNotice({
    detached: true,
    guardMs: 5_000,
    enforceRevision: true,
    onConflict: () => {
      // The raced second failure's marker rides the host write that conflicts
      // the consume's stale revision.
      void operations.mutate(SETTINGS_NS, [
        models.setQuotaMarkerOp({ route: ROUTE, at: Date.now() }),
      ]);
    },
  });
  const marker = rawMarkerNow();
  await operations.mutate(SETTINGS_NS, [
    models.setQuotaMarkerOp(marker),
  ]);
  store.set({
    route: ROUTE,
    at: marker.at,
    email: "one@example.com",
    others: false,
    revision: 1, // stale: the document already moved
    usage: SNAPSHOT,
  });
  render();
  stub.drainEffects(); // the capture fixes the decision
  render();
  stub.drainEffects(); // the consume conflicts; the retry stands down
  await settle(5);
  const unsets = operations.mutates.filter((call) => call.ops[0]?.op === "unset");
  assert.equal(unsets.length, 0, "the retry stands down: no unset runs");
  const kept = operations.document().usage.lastQuotaFailure;
  assert.ok(kept !== undefined && kept.at !== marker.at, "the fresh marker survives untouched");
  stub.runCleanups();
});

test("an empty marker store falls back once and ignores later markers", async () => {
  // A settled-null store may be pre-marker: this failure's write is still in
  // flight. Once the window closes empty, the elected entry must preserve the
  // host's foreign-failure notice rather than leaving a blank chain.
  const { stub, store, render, dismissed, types } = await mountNotice({
    detached: true,
    guardMs: 80,
  });
  assert.equal(render(), null, "undecided: the notice renders nothing yet");
  store.set(null);
  render();
  stub.drainEffects();
  assert.equal(render(), null, "a settled-null store keeps the notice waiting");
  await settle(150);
  const tree = render();
  const toast = find(tree, (n) => n.type === types.toast);
  assert.ok(toast, "the empty window renders the generic Toast");
  assert.equal(toast.props.text, "Request quota exhausted.");
  assert.equal(find(tree, (n) => n.type === types.modal), undefined, "no account modal");
  const icon = find(toast.props.icon, (n) => n.type === types.warning);
  assert.equal(icon.props.size, 18, "the host's warning icon and size");
  toast.props.onDone();
  assert.equal(dismissed.length, 1, "Toast completion dismisses through the owner");
  store.set({
    route: ROUTE,
    at: Date.now(),
    email: "one@example.com",
    others: false,
    revision: 3,
    usage: SNAPSHOT,
  });
  render();
  stub.drainEffects();
  const late = render();
  assert.equal(find(late, (n) => n.type === types.modal), undefined, "no late account modal");
  assert.ok(find(late, (n) => n.type === types.toast), "the decided Toast remains");
  stub.runCleanups();
});

test("a marker that lands after the notice mounts still produces the modal", async () => {
  // The production race this design fixes: the failure's marker reaches the
  // store a beat after the notice fires. The notice must still wait for it.
  const { stub, store, render, types } = await mountNotice({ detached: true, guardMs: 5_000 });
  assert.equal(render(), null, "undecided: the notice renders nothing yet");
  store.set({
    route: ROUTE,
    at: Date.now(),
    email: "one@example.com",
    others: false,
    revision: 3,
    usage: SNAPSHOT,
  });
  render();
  stub.drainEffects();
  const modal = find(render(), (n) => n.type === types.modal);
  assert.ok(modal, "the late-arriving marker produces the modal");
  assert.match(modal.props.description, /Usage limit for this account reached\./);
  stub.runCleanups();
});

test("a stale leftover marker falls back to the generic Toast", async () => {
  // A marker older than the write-to-notice allowance (a page reload, a failed
  // consumption) is not this failure's, so the custom modal must not claim it.
  const { stub, store, render, types } = await mountNotice({
    detached: true,
    guardMs: 5_000,
  });
  store.set({
    route: ROUTE,
    at: Date.now() - 60_000,
    email: "one@example.com",
    others: false,
    revision: 3,
  });
  render();
  stub.drainEffects();
  const tree = render();
  assert.equal(find(tree, (n) => n.type === types.modal), undefined, "no account modal");
  const toast = find(tree, (n) => n.type === types.toast);
  assert.equal(toast.props.text, "Request quota exhausted.");
  stub.runCleanups();
});

test("the quota selector claims QUOTA only when the shared Modal is available", async () => {
  const { registered, stub } = await mountNotice({ rawMarker: null });
  const select = registered["shell.quota-notice"].config.select;
  const owner = { code: "QUOTA", message: "Request quota exhausted." };
  assert.equal(select(owner), owner, "ownership is decided after election, not from the lagging store");
  assert.equal(select({ code: "RATE_LIMIT" }), null);
  assert.equal(select({ code: "ACCOUNT_QUOTA" }), null, "the DeepSeek balance modal owns that code");
  stub.runCleanups();

  const unavailable = await mountNotice({ rawMarker: rawMarkerNow(), primitive: false });
  assert.equal(
    unavailable.registered["shell.quota-notice"].config.select(owner),
    null,
    "without Modal, the host keeps its fallback",
  );
  unavailable.stub.runCleanups();
});

test("a quota marker subscription failure propagates out of mount", () => {
  const failure = new Error("subscribe failed");
  assert.throws(
    () =>
      mount({
        storeFactory: () => snapshotStore(undefined),
        remote: {
          settings: { describe: async () => ({ ok: true, value: { namespaces: [] } }) },
          $on: () => {
            throw failure;
          },
        },
      }),
    (error) => error === failure,
  );
});

test("the notice store pulls on mount and on its own namespace updates", async () => {
  const { stub, operations, store } = await mountNotice({ rawMarker: null });
  await settle(5);
  const describes = operations.describes();
  assert.ok(describes >= 1, "the store pulls at mount");
  assert.equal(store.getSnapshot(), null, "a document without a marker settles to null");
  const settingsEvent = operations.subscriptions.find(
    (entry) => entry.event === "settings/document-updated",
  );
  settingsEvent.listener("other-plugin");
  await settle(5);
  assert.equal(operations.describes(), describes, "another namespace's update is ignored");
  await operations.mutate(SETTINGS_NS, [
    models.setQuotaMarkerOp({ route: ROUTE, at: Date.now() }),
  ]);
  settingsEvent.listener(SETTINGS_NS);
  await settle(5);
  assert.equal(store.getSnapshot()?.route, ROUTE, "this namespace's update re-pulls the marker");
  stub.runCleanups();
});
