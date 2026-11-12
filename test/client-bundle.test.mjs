/**
 * The generated browser bundle matches the current sources: rebuilding leaves
 * it byte-for-byte unchanged. Catches edits made to lib/client.js by hand and
 * stale sources that were not rebuilt, even in a dirty checkout.
 * @module test/client-bundle.test.mjs
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("the generated client bundle matches its current sources", () => {
  const target = new URL("../lib/client.js", import.meta.url);
  const beforeBuild = readFileSync(target, "utf8");
  execFileSync(process.execPath, ["scripts/build-client.mjs"], { cwd: root });
  const generated = readFileSync(target, "utf8");
  assert.equal(
    generated,
    beforeBuild,
    "lib/client.js is stale: run `npm run build:client` and commit the result",
  );
  assert.ok(generated.startsWith("/* eslint-disable */"), "bundle carries the generated banner");
  assert.match(generated, /window\.__ModuleLoader__\.load\(\{/);
  // The wrapper id is the package name: the client-module manifest keys
  // modules by it, and the module system materializes factories under it.
  assert.match(generated, /id: "@apcamargo\/dsh-claude-subscription"/);
  assert.match(generated, /require\("react"\)/);
  // The card's slot registration must be present in the serialized sources.
  assert.match(generated, /settings\.models\.footer/);
  // The pure helpers are inlined, not required: no relative require survives.
  assert.doesNotMatch(generated, /require\("\.\//);
});

/** Flatten a rendered tree to its text content. */
function flattenTree(node) {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenTree).join("");
  return flattenTree(node.children);
}

test("the evaluated bundle renders the usage indicator without a ReferenceError", async () => {
  // The bundle serializes functions by source, so a module-level binding a
  // helper uses but HELPER_NAMES omits only fails in the browser (the host
  // then drops the throwing slot entry for good). Evaluate the generated file
  // itself, not the ESM sources, and render the indicator with real data.
  const { runInNewContext } = await import("node:vm");
  execFileSync(process.execPath, ["scripts/build-client.mjs"], { cwd: root });
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  const route = "claude-subscription-111111111111";
  const now = Date.now();
  const store = new Map([
    [
      `claude-subscription:usage:v2:${route}`,
      JSON.stringify({
        plan: "Max",
        windows: [{ label: "5-hour", percent: 42, resetsAt: now + 3_600_000 }],
        extra: null,
        observedAt: now,
      }),
    ],
  ]);
  let loaded;
  runInNewContext(source, {
    window: { __ModuleLoader__: { load: (module) => (loaded = module) } },
    localStorage: { getItem: (key) => store.get(key) ?? null, setItem: () => {} },
  });
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (init) => [typeof init === "function" ? init() : init, () => {}],
    useRef: () => ({ current: null }),
    useEffect: () => {},
    useLayoutEffect: () => {},
    useCallback: (fn) => fn,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  };
  const app = loaded.factory((id) => {
    if (id === "react") return React;
    if (id === "react-dom") return {};
    throw new Error(`unmapped module ${id}`);
  });
  // Check the service list exactly: dropping one breaks its slots, while adding
  // one can stop older hosts loading the plugin. The spread avoids a cross-realm
  // Array prototype comparison in deepStrictEqual.
  assert.deepEqual([...app.inject], ["slots", "remote", "remote.llm", "remote.settings"]);
  const components = new Map();
  const slots = [];
  let slotName;
  app.apply({
    effect: () => {},
    remote: { settings: {}, llm: {}, $on: () => () => {} },
    slots: {
      inject: (name, factory) => {
        slotName = name;
        return factory();
      },
      register: (options, component) => {
        slots.push(slotName);
        components.set(options.id ?? options.key, component);
      },
    },
  });
  // Slot registrations: the Models editor card, the composer indicator, one
  // keyed command card per command name, and the quota notice's chain entry.
  assert.deepEqual(slots.sort(), [
    "conversation.chat.commandview",
    "conversation.chat.commandview",
    "conversation.input.right",
    "settings.models.footer",
    "shell.quota-notice",
  ]);
  // A command still running renders nothing, not a placeholder box.
  assert.equal(
    components.get("claude-usage")({ node: { name: "claude-usage", outcome: null } }),
    null,
  );
  assert.equal(
    components.get("claude-account")({ node: { name: "claude-account", outcome: null } }),
    null,
  );
  // Settled cards render through the bundle's inlined helper scope.
  const usageTree = components.get("claude-usage")({
    node: {
      name: "claude-usage",
      outcome: {
        kind: "success",
        text: "Claude usage\nAccount: one@example.com\nRoute: claude-subscription-111111111111\nPlan: Max\n5-hour:      [██████░░░░░░░░░░░░░░] 42% used",
      },
    },
  });
  assert.ok(
    flattenTree(usageTree).includes("Max plan"),
    "the usage card renders through the bundle",
  );
  const accountTree = components.get("claude-account")({
    node: {
      name: "claude-account",
      outcome: {
        kind: "success",
        text: "Claude account\nAuth: Subscription (OAuth)\nAccount: one@example.com",
      },
    },
  });
  assert.ok(
    flattenTree(accountTree).includes("one@example.com"),
    "the account card renders through the bundle",
  );
  const pie = components.get("claude-subscription-usage");
  assert.equal(typeof pie, "function");
  // The pie reads the selected model's account from the session model
  // directory's store and gates visibility on the account mirror, whose pull
  // is async. This stub runs no effects, so the synchronous render hides.
  // What this test guards is the ReferenceError class: every binding the
  // render path touches must exist in the bundle.
  const directory = {
    subscribe: () => () => {},
    getSnapshot: () => ({ current: { provider: route, model: "claude-opus-5-5" } }),
  };
  const operations = {
    describe: async () => ({
      ok: true,
      value: {
        namespaces: [
          {
            ns: "claude-subscription",
            value: {
              accounts: {
                mirror: { accounts: [{ route, email: "one@example.com", status: "signedIn" }] },
                models: {},
              },
              usage: { snapshots: {} },
            },
          },
        ],
      },
    }),
    discoverModels: async () => ({ ok: true, value: [] }),
    onSettingsUpdated: () => () => {},
    onEvent: () => () => {},
  };
  let tree;
  assert.doesNotThrow(() => {
    tree = pie({ operations, sessionId: "session-1", directory });
  }, "the indicator renders without a ReferenceError");
  assert.ok(tree, "an account route shows the indicator before the mirror pull lands");
});

test("the client factory degrades when the host does not map react-dom", async () => {
  // react-dom is host-mapped, not an npm dependency, so a host may leave it
  // unmapped. The app already tolerates ReactDOM === undefined. The factory must
  // not throw before the app can, or a host without the module loses every slot
  // entry (the Models card included).
  const { runInNewContext } = await import("node:vm");
  execFileSync(process.execPath, ["scripts/build-client.mjs"], { cwd: root });
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  let loaded;
  runInNewContext(source, {
    window: { __ModuleLoader__: { load: (module) => (loaded = module) } },
    localStorage: { getItem: () => null, setItem: () => {} },
  });
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (init) => [typeof init === "function" ? init() : init, () => {}],
    useRef: () => ({ current: null }),
    useEffect: () => {},
    useLayoutEffect: () => {},
    useCallback: (fn) => fn,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  };
  let app;
  assert.doesNotThrow(() => {
    app = loaded.factory((id) => {
      if (id === "react") return React;
      throw new Error(`unmapped module ${id}`);
    });
  }, "a missing react-dom must not fail the whole client factory");
  assert.equal(typeof app?.apply, "function");
});

test("no client source module-level binding is referenced by the bundle without being inlined", () => {
  // The build serializes functions by source, so a helper reaching a
  // module-level binding the build does not inline is a ReferenceError in the
  // browser only. Static guard: every top-level binding of the two sources
  // must either be inlined into the bundle or never mentioned by it.
  execFileSync(process.execPath, ["scripts/build-client.mjs"], { cwd: root });
  const bundle = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  const code = bundle
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/(["'])(?:\\.|(?!\1)[^\\\n])*\1/g, '""');
  const declaration =
    /^(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
  for (const file of ["../lib/client-models.js", "../lib/client-app.js"]) {
    const names = [
      ...readFileSync(new URL(file, import.meta.url), "utf8").matchAll(declaration),
    ].map((match) => match[1]);
    for (const name of names) {
      const inlined = new RegExp(`(?:const|function)\\s+${name}\\b`).test(code);
      const referenced = new RegExp(`(?<![\\w$.])${name}\\b`).test(code);
      assert.ok(
        inlined || !referenced,
        `${file}: "${name}" is used by the bundle but never defined in it — add it to HELPER_NAMES in scripts/build-client.mjs`,
      );
    }
  }
});
