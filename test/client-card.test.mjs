/**
 * The Models-page card driven end-to-end under a React hook stub, against the
 * host's real describe/mutate shapes (`{writable, hasDocument, namespaces:
 * [view]}`; failures resolve as `{ok:false, error}`). Regression class: the card
 * once fed the whole describe envelope to a reader expecting the namespace value,
 * so stored lists never displayed.
 * @module test/client-card.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createClientApp } from "../lib/client-app.js";
import * as models from "../lib/client-models.js";

const helpers = models;
const FIRST_ROUTE = "claude-subscription-111111111111";
const SECOND_ROUTE = "claude-subscription-222222222222";
const STATE_ID = `dsh-cs-models-state-${FIRST_ROUTE}`;
const { setModelsOp, unsetModelsOp } = models;

/** A minimal React stand-in: createElement records, hooks work by call order. */
function reactStub() {
  const slots = [];
  const effects = [];
  let cursor = 0;
  return {
    React: {
      createElement: (type, props, ...children) => ({ type, props, children }),
      useState(initial) {
        const at = cursor++;
        if (slots[at] === undefined) slots[at] = { value: initial };
        const slot = slots[at];
        return [
          slot.value,
          (next) => {
            slot.value = typeof next === "function" ? next(slot.value) : next;
          },
        ];
      },
      useCallback(fn) {
        return fn;
      },
      useRef(initial) {
        return { current: initial };
      },
      useEffect(fn) {
        effects.push(fn);
      },
    },
    resetCursor() {
      cursor = 0;
    },
    drainEffects: async () => {
      for (const effect of effects.splice(0)) effect();
    },
  };
}

/** The tick the card's async reload/commit need to settle. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  await tick();
  await tick();
  await tick();
};

/** A remote double speaking the host's exact describe/mutate contract. */
function hostDouble({
  mirror = {
    accounts: [{ route: FIRST_ROUTE, email: "one@example.com", status: "signedIn", addedAt: 1 }],
  },
  accountModels = { [FIRST_ROUTE]: [{ id: "claude-haiku-4-5" }] },
  snapshots = {},
  mutateResult,
  catalog = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
  catalogReadings = {},
} = {}) {
  const calls = { describe: 0, mutate: [], discoverModels: [] };
  const subscriptions = [];
  let revision = 7;
  const view = (rev, value) => ({
    autoGenerate: true,
    ns: "claude-subscription",
    schema: {},
    value,
    applies: "live",
    secrets: [],
    revision: rev,
  });
  // Absent fields are omitted from the stored section, exactly as the real
  // document would be (an absent models key = the built-in catalog serves).
  const section = {
    accounts: { mirror, models: accountModels },
    usage: { snapshots },
    catalog: catalogReadings,
  };
  return {
    calls,
    subscriptions,
    emit(event, payload) {
      for (const entry of subscriptions.filter((candidate) => candidate.event === event))
        entry.listener(payload);
    },
    settings: {
      describe: async () => {
        calls.describe += 1;
        return {
          ok: true,
          value: { writable: true, hasDocument: true, namespaces: [view(revision, section)] },
        };
      },
      mutate: async (ns, ops, expectedRevision) => {
        calls.mutate.push({ ns, ops, expectedRevision });
        if (mutateResult !== undefined)
          return typeof mutateResult === "function" ? mutateResult(revision) : mutateResult;
        revision += 1;
        return { ok: true, value: view(revision, section) };
      },
    },
    llm: {
      discoverModels: async (_ns, request) => {
        calls.discoverModels.push(request);
        return { ok: true, value: catalog.map((id) => ({ id })) };
      },
    },
    $on: (event, listener) => {
      subscriptions.push({ event, listener });
      return () => {
        const at = subscriptions.findIndex((entry) => entry.listener === listener);
        if (at >= 0) subscriptions.splice(at, 1);
      };
    },
  };
}

/** Mount the card through its slot factory. Drive renders by hand. */
async function mountCard(
  remote,
  { primitives = { Tooltip: ({ children }) => children }, uiWorkspace } = {},
) {
  const stub = reactStub();
  // The usage surfaces use the shared primitives' Tooltip. The models card
  // itself never touches it, and the app degrades when the namespace is
  // absent (a host without the shared module).
  const app = createClientApp({
    React: stub.React,
    helpers,
    pluginName: "test-double",
    primitives,
  });
  const captured = {};
  const ctx = {
    remote,
    slots: {
      inject: (_slot, factory) => factory(),
      register: (config, component) => {
        captured[config.name] = { config, component };
        return config;
      },
    },
    // Registration only: the style effect touches document, which node lacks.
    effect() {},
    get: (name) => (name === "uiWorkspace" ? uiWorkspace : undefined),
  };
  app.apply(ctx);
  // The card under test occupies the models footer slot. The command cards
  // and the composer indicator register beside it (see
  // test/client-command-cards.test.mjs and test/client-usage-indicator.test.mjs).
  const models = captured["settings.models.footer"];
  const render = () => {
    stub.resetCursor();
    // config.inject() returns the component props ({ operations }).
    return models.component(models.config.inject());
  };
  let tree = render();
  await stub.drainEffects();
  await settle();
  tree = render();
  const refresh = () => {
    tree = render();
    return tree;
  };
  return { tree, refresh };
}

/** Flatten a rendered tree to its text content. */
function flatten(node) {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flatten).join("");
  return flatten(node.children);
}

/**
 * Walk the tree for the first element matching a predicate, in document order
 * (pre-order DFS). With several per-account sections, breadth-first would surface
 * a later section's control first; the tests mean the section the user sees first.
 */
function find(tree, predicate) {
  const stack = [tree];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || node === undefined || typeof node !== "object") continue;
    if (predicate(node)) return node;
    if (Array.isArray(node)) {
      stack.push(...[...node].reverse());
    } else if (node.children) {
      const children = Array.isArray(node.children) ? node.children : [node.children];
      stack.push(...[...children].reverse());
    }
  }
  return undefined;
}
const findButton = (tree, label) =>
  find(tree, (node) => node.type === "button" && flatten(node.children) === label);
const findLabeled = (tree, label) => find(tree, (node) => node.props?.["aria-label"] === label);

/** Every element in document order, so order-sensitive assertions can compare positions. */
function elements(tree) {
  const out = [];
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    out.push(node);
    if (node.children) {
      const children = Array.isArray(node.children) ? node.children : [node.children];
      for (const child of children) walk(child);
    }
  };
  walk(tree);
  return out;
}

/** Every element matching a predicate, in document order. */
const findAll = (tree, predicate) => elements(tree).filter(predicate);
/** Whether an element carries a class token. */
const hasClassLike = (name) => (node) =>
  String(node.props?.className ?? "")
    .split(" ")
    .includes(name);

test("each signed-in account renders as its own titled panel, and no account section renders without it", async () => {
  const remote = hostDouble({
    mirror: {
      accounts: [
        {
          route: FIRST_ROUTE,
          email: "one@example.com",
          orgName: "Personal",
          status: "signedIn",
          addedAt: 1,
        },
        {
          route: SECOND_ROUTE,
          email: "two@example.com",
          orgName: null,
          status: "signedIn",
          addedAt: 2,
        },
      ],
    },
  });
  const { tree } = await mountCard(remote);
  // The API-key panel is a labelled group too. The account panels are the
  // ones the mirror drove.
  const sections = tree.children
    .flat()
    .filter((node) => node !== null && typeof node === "object" && node.props?.role === "group");
  assert.deepEqual(
    sections.map((section) => section.props["aria-label"]).filter((label) => label.includes("@")),
    ["one@example.com", "two@example.com"],
    "one labelled group per account",
  );
  for (const section of sections.filter((candidate) =>
    candidate.props["aria-label"].includes("@"),
  )) {
    assert.ok(hasClassLike("dsh-cs-panel")(section), "the account is a grey panel");
    const title = find(section, (node) => node.props?.className === "dsh-cs-panelTitle");
    assert.equal(flatten(title), section.props["aria-label"]);
    assert.equal(
      title.props.title,
      section.props["aria-label"],
      "the full address is the hover title",
    );
  }
  // Each account's editor lives inside its own panel, not a shared section.
  const first = sections.find((section) => section.props["aria-label"] === "one@example.com");
  assert.ok(
    find(first, (node) => node.props?.["aria-label"] === "claude-haiku-4-5 display name"),
    "the editor is inside its account's panel",
  );
  // Each account's editor carries its own state sentence, suffixed by route.
  assert.ok(
    find(tree, (node) => node.props?.id === STATE_ID),
    "the first account's sentence",
  );
  assert.ok(
    find(tree, (node) => node.props?.id === `dsh-cs-models-state-${SECOND_ROUTE}`),
    "the second account's sentence",
  );

  // No account section without the mirror, and an empty mirror names the state.
  const plain = await mountCard(hostDouble({ mirror: { accounts: [] } }));
  assert.equal(
    find(
      plain.tree,
      (node) => node.props?.role === "group" && node.props?.["aria-label"]?.includes("@"),
    ),
    undefined,
  );
  assert.ok(flatten(plain.tree).includes("No account is signed in."), "the empty state says so");
});

test("a pushed settings update reloads the card and picks up the mirror", async () => {
  const remote = hostDouble({ mirror: { accounts: [] } });
  const { tree, refresh } = await mountCard(remote);
  assert.equal(
    find(tree, (node) => node.props?.role === "group" && node.props?.["aria-label"]?.includes("@")),
    undefined,
  );
  // A sign-in elsewhere mirrors the account into the volatile section and
  // the settings service publishes the invalidation. The card re-describes.
  remote.settings.describe = async () => {
    remote.calls.describe += 1;
    return {
      ok: true,
      value: {
        writable: true,
        hasDocument: true,
        namespaces: [
          {
            ns: "claude-subscription",
            schema: {},
            value: {
              accounts: {
                mirror: {
                  accounts: [{ route: FIRST_ROUTE, email: "late@example.com", status: "signedIn" }],
                },
                models: {},
              },
            },
            applies: "live",
            secrets: [],
            revision: 8,
          },
        ],
      },
    };
  };
  remote.emit("settings/document-updated", "claude-subscription");
  await settle();
  assert.ok(flatten(refresh()).includes("late@example.com"), "the pushed mirror reaches the card");
  // An unrelated namespace's write reloads too (vanilla parity): cheap describe.
  remote.emit("settings/document-updated", "some-other-plugin");
  await settle();
  assert.equal(remote.calls.describe, 3);
});

test("a needs-sign-in account shows its state and a targeted re-login action", async () => {
  const started = [];
  const uiWorkspace = { startSession: (...args) => started.push(args) };
  const remote = hostDouble({
    mirror: {
      accounts: [{ route: FIRST_ROUTE, email: "stale@example.com", status: "needsReauth" }],
    },
  });
  const { tree } = await mountCard(remote, { uiWorkspace });
  assert.ok(flatten(tree).includes("Needs sign-in again"), "the state is named");
  const again = findButton(tree, "Sign in again");
  assert.equal(again.props["aria-label"], "Sign in again: stale@example.com");
  again.props.onClick();
  assert.deepEqual(started.at(-1), [
    undefined,
    { prompt: "/claude-login stale@example.com", whenDraftExists: "replace" },
  ]);
});

test("each account's editor saves to its own settings path", async () => {
  const remote = hostDouble({
    mirror: {
      accounts: [
        { route: FIRST_ROUTE, email: "one@example.com", status: "signedIn" },
        { route: SECOND_ROUTE, email: "two@example.com", status: "signedIn" },
      ],
    },
    accountModels: { [SECOND_ROUTE]: [{ id: "claude-sonnet-5-5" }] },
  });
  const { tree, refresh } = await mountCard(remote);
  // The second account's list renders and stages through its own editor.
  const nameInput = findLabeled(tree, "claude-sonnet-5-5 display name");
  nameInput.props.onChange({ target: { value: "Sonnet (team)" } });
  // Both footers have Save buttons. The second account's is the one whose
  // section holds the staged edit. Find the Save inside that account group.
  // on the tree rendered after the staging, since a component's handlers
  // close over the state of their own render.
  const group = find(refresh(), (node) => node.props?.["aria-label"] === "two@example.com");
  const save = findButton(group, "Save");
  save.props.onClick();
  await settle();
  const last = remote.calls.mutate.at(-1);
  assert.equal(last.expectedRevision, 7);
  assert.deepEqual(
    last.ops,
    [setModelsOp([{ id: "claude-sonnet-5-5", name: "Sonnet (team)" }], SECOND_ROUTE)],
    "the op carries the account's route",
  );
});

test("staged edits survive the host's own settings writes", async () => {
  const remote = hostDouble({
    mirror: { accounts: [{ route: FIRST_ROUTE, email: "one@example.com", status: "signedIn" }] },
  });
  const { tree, refresh } = await mountCard(remote);
  findLabeled(tree, "claude-haiku-4-5 display name").props.onChange({
    target: { value: "Keep me" },
  });
  refresh();
  // The host publishes mirror/usage writes onto this same document while
  // the edit is staged. The reload must not wipe the user's staging.
  remote.emit("settings/document-updated", "claude-subscription");
  await settle();
  const after = refresh();
  assert.equal(
    findLabeled(after, "claude-haiku-4-5 display name").props.value,
    "Keep me",
    "the staged edit survives the reload",
  );
  findButton(after, "Save").props.onClick();
  await settle();
  assert.deepEqual(remote.calls.mutate.at(-1).ops, [
    setModelsOp([{ id: "claude-haiku-4-5", name: "Keep me" }], FIRST_ROUTE),
  ]);
});

test("a settings conflict against an unchanged base retries once against the fresh revision", async () => {
  let conflicts = 1;
  let describes = 0;
  const remote = hostDouble({
    mirror: { accounts: [{ route: FIRST_ROUTE, email: "one@example.com", status: "signedIn" }] },
  });
  // The document really moved while editing: the loaded read is revision 7,
  // the conflict re-read is revision 8. The retry must send 8. The closure's
  // `state.revision` is still 7 and would conflict forever.
  const describe = remote.settings.describe;
  remote.settings.describe = async () => {
    describes += 1;
    const answer = await describe();
    answer.value.namespaces[0].revision = describes === 1 ? 7 : 8;
    return answer;
  };
  remote.settings.mutate = async (ns, ops, expectedRevision) => {
    remote.calls.mutate.push({ ns, ops, expectedRevision });
    if (conflicts > 0) {
      conflicts -= 1;
      return { ok: false, error: { code: "settings/conflict", message: "changed", details: {} } };
    }
    // The gateway answers with the projected namespace after the write,
    // host-maintained sections included.
    const described = await remote.settings.describe();
    return { ok: true, value: { ...described.value.namespaces[0], revision: 9 } };
  };
  const { tree, refresh } = await mountCard(remote);
  findLabeled(tree, "claude-haiku-4-5 display name").props.onChange({
    target: { value: "Retried" },
  });
  refresh();
  findButton(refresh(), "Save").props.onClick();
  await settle();
  refresh();
  assert.equal(remote.calls.mutate.length, 2, "the save retried once");
  assert.equal(
    remote.calls.mutate[0].expectedRevision,
    7,
    "the first write used the loaded revision",
  );
  assert.equal(
    remote.calls.mutate[1].expectedRevision,
    8,
    "the retry used the revision the document moved to",
  );
  // The success answer carries the reloaded document, exactly as the real
  // gateway's does (host-maintained sections included), so the section
  // and its notice survive the apply.
  assert.ok(flatten(refresh()).includes("Saved."), "the retried save lands");
});

test("a conflict that cannot be retried asks for a re-apply and keeps the staged edit", async () => {
  // The document moved to a different saved list under the staged edit: no
  // retry, and the card carries its own guidance instead of the server text.
  let describes = 0;
  const remote = hostDouble({
    mirror: { accounts: [{ route: FIRST_ROUTE, email: "one@example.com", status: "signedIn" }] },
  });
  const describe = remote.settings.describe;
  remote.settings.describe = async () => {
    describes += 1;
    const answer = await describe();
    const view = answer.value.namespaces[0];
    if (describes > 1) {
      view.value.accounts.models[FIRST_ROUTE] = [{ id: "claude-haiku-4-5", name: "Someone else" }];
      view.revision = 8;
    }
    return answer;
  };
  remote.settings.mutate = async (ns, ops, expectedRevision) => {
    remote.calls.mutate.push({ ns, ops, expectedRevision });
    return { ok: false, error: { code: "settings/conflict", message: "changed", details: {} } };
  };
  const { tree, refresh } = await mountCard(remote);
  findLabeled(tree, "claude-haiku-4-5 display name").props.onChange({ target: { value: "Mine" } });
  refresh();
  findButton(refresh(), "Save").props.onClick();
  await settle();
  refresh();
  assert.equal(remote.calls.mutate.length, 1, "no retry when the saved list moved under the edit");
  assert.ok(flatten(refresh()).includes("apply again"), "the card asks the user to re-apply");
  assert.equal(
    findLabeled(refresh(), "claude-haiku-4-5 display name").props.value,
    "Mine",
    "the staged edit survives",
  );

  // A write that keeps conflicting follows the same path after one retry:
  // the guidance is the card's, never the server's raw message.
  const stubborn = hostDouble({
    mutateResult: {
      ok: false,
      error: {
        code: "settings/conflict",
        message: "The settings document changed while editing",
        details: {},
      },
    },
  });
  const mounted = await mountCard(stubborn);
  findLabeled(mounted.tree, "claude-haiku-4-5 display name").props.onChange({
    target: { value: "Renamed" },
  });
  mounted.refresh();
  findButton(mounted.refresh(), "Save").props.onClick();
  await settle();
  mounted.refresh();
  assert.equal(stubborn.calls.describe, 2, "the conflict path re-describes for the fresh revision");
  assert.equal(stubborn.calls.mutate.length, 2, "the save retried once");
  assert.ok(
    flatten(mounted.refresh()).includes("apply again"),
    "the conflict notice carries the card's guidance",
  );
  assert.equal(
    findLabeled(mounted.refresh(), "claude-haiku-4-5 display name").props.value,
    "Renamed",
    "the staged edit survives",
  );
});

test("a rejecting describe lands in the error phase instead of loading forever", async () => {
  const remote = hostDouble();
  remote.settings.describe = async () => {
    throw new Error("no active connection");
  };
  const { tree } = await mountCard(remote);
  assert.ok(flatten(tree).includes("no active connection"), "the error phase renders the message");
});

test("a rejecting mutate surfaces its message on the card and resets busy", async () => {
  const remote = hostDouble();
  remote.settings.mutate = async () => {
    throw new Error("namespace not started");
  };
  const { tree: initial, refresh } = await mountCard(remote);
  findLabeled(initial, "claude-haiku-4-5 display name").props.onChange({ target: { value: "X" } });
  refresh();
  findButton(refresh(), "Save").props.onClick();
  await settle();
  refresh();
  assert.ok(flatten(refresh()).includes("namespace not started"), "the rejection message renders");
  assert.ok(
    find(refresh(), hasClassLike("dsh-cs-statusError")),
    "the message rides the error tone",
  );
  assert.equal(findButton(refresh(), "Save").props.disabled, false, "busy is reset");
});

test("built-in mode shows no model list, just the state sentence and one Customize button", async () => {
  const { tree } = await mountCard(hostDouble({ accountModels: {} }));
  assert.ok(findButton(tree, "Customize models"), "Customize is the way into a custom list");
  assert.equal(findLabeled(tree, "Model to add"), undefined, "no add picker in built-in mode");
  assert.equal(
    findButton(tree, "Use all available models"),
    undefined,
    "nothing to switch back from",
  );
  for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]) {
    assert.equal(flatten(tree).includes(id), false, `the built-in id ${id} is not listed`);
  }
  const sentence = find(tree, (node) => node.props?.id === STATE_ID);
  assert.equal(sentence.props.role, "status");
  assert.equal(sentence.props["aria-live"], "polite");
  assert.equal(flatten(sentence), "All 3 available models are in use.");
  assert.equal(findButton(tree, "Customize models").props["aria-describedby"], STATE_ID);
});

test("the catalog caption is absent until a reading exists, in both list modes", async () => {
  for (const accountModels of [{}, { [FIRST_ROUTE]: [{ id: "claude-haiku-4-5" }] }]) {
    const { tree } = await mountCard(hostDouble({ accountModels }));
    assert.equal(flatten(tree).includes("Built-in list"), false, "no built-in placeholder caption");
    assert.equal(
      flatten(tree).includes("No catalog reading yet"),
      false,
      "no other placeholder caption",
    );
  }
});

test("the caption states the reading's age, and names the published fallback", async () => {
  const own = await mountCard(
    hostDouble({ catalogReadings: { accounts: { [FIRST_ROUTE]: { fetchedAt: Date.now() } } } }),
  );
  assert.ok(flatten(own.tree).includes("Updated just now"), "an account reading states its age");
  assert.equal(
    flatten(own.tree).includes("Published catalog"),
    false,
    "the normal path is not labelled",
  );

  // No account reading: the shared published document served the list, and
  // that is the one source the reader needs named, because it is not
  // plan-accurate.
  const fallback = await mountCard(
    hostDouble({ catalogReadings: { published: { fetchedAt: Date.now() } } }),
  );
  assert.ok(
    flatten(fallback.tree).includes("Published catalog · just now"),
    "the fallback names its source",
  );
});

test("Customize seeds every catalog id with blank overrides and stays staged until Save", async () => {
  const remote = hostDouble({ accountModels: {} });
  const { tree, refresh } = await mountCard(remote);
  findButton(tree, "Customize models").props.onClick();
  await settle();
  const next = refresh();
  assert.equal(remote.calls.mutate.length, 0, "Customize alone never writes");
  assert.equal(
    flatten(find(next, (node) => node.props?.id === STATE_ID)),
    "3 models are selected.",
  );
  assert.ok(findLabeled(next, "claude-sonnet-5-5 display name"), "the seeded rows are editable");
  assert.ok(flatten(next).includes("Unsaved changes"));
  findButton(next, "Save").props.onClick();
  await settle();
  assert.deepEqual(
    remote.calls.mutate.at(-1).ops,
    [
      setModelsOp(
        [{ id: "claude-opus-5-5" }, { id: "claude-sonnet-5-5" }, { id: "claude-haiku-5-5" }],
        FIRST_ROUTE,
      ),
    ],
    "ids only, so the rows keep inheriting built-in values",
  );
});

test("restoring then customizing again brings the edited rows back; Discard returns to the saved list", async () => {
  const remote = hostDouble();
  const { tree, refresh } = await mountCard(remote);
  findLabeled(tree, "claude-haiku-4-5 display name").props.onChange({ target: { value: "Mine" } });
  findButton(refresh(), "Use all available models").props.onClick();
  const restored = refresh();
  assert.equal(
    flatten(find(restored, (node) => node.props?.id === STATE_ID)),
    "The available models will be used when you save.",
  );
  findButton(restored, "Customize models").props.onClick();
  await settle();
  assert.equal(
    findLabeled(refresh(), "claude-haiku-4-5 display name").props.value,
    "Mine",
    "the edited rows return, not the catalog",
  );
  assert.equal(findLabeled(refresh(), "claude-opus-5-5 display name"), undefined, "no reseed");
  findButton(refresh(), "Use all available models").props.onClick();
  findButton(refresh(), "Discard").props.onClick();
  assert.equal(
    findLabeled(refresh(), "claude-haiku-4-5 display name").props.value,
    "",
    "Discard goes back to the saved list",
  );
});

test("the state sentence follows the staged list: one, several, none", async () => {
  const sentence = (t) => flatten(find(t, (node) => node.props?.id === STATE_ID));
  const { tree, refresh } = await mountCard(hostDouble());
  assert.equal(sentence(tree), "Only this model is available.");
  findLabeled(tree, "Model to add").props.onChange({ target: { value: "claude-opus-5-5" } });
  findButton(refresh(), "Add").props.onClick();
  assert.equal(sentence(refresh()), "2 models are selected.");
  findLabeled(refresh(), "Remove claude-opus-5-5").props.onClick();
  findLabeled(refresh(), "Remove claude-haiku-4-5").props.onClick();
  const empty = refresh();
  assert.equal(sentence(empty), "Only the models you add are available.");
  assert.ok(
    flatten(empty).includes("No models in the list. Add one below, or use all available models."),
  );
  assert.equal(findButton(empty, "Save").props.disabled, true, "an empty list cannot be saved");
});

test("a failing catalog lookup leaves the card usable", async () => {
  const remote = hostDouble({ accountModels: {} });
  remote.llm.discoverModels = async () => ({ ok: false, error: { message: "boom" } });
  const { tree, refresh } = await mountCard(remote);
  assert.equal(findLabeled(tree, "Available models"), undefined);
  assert.equal(
    flatten(find(tree, (node) => node.props?.id === STATE_ID)),
    "All available models are in use.",
  );
  findButton(tree, "Customize models").props.onClick();
  await settle();
  assert.ok(
    flatten(refresh()).includes("boom"),
    "the failure surfaces when seeding needs the catalog",
  );
});

test("a custom list shows its rows collapsed; an override opens the row expanded", async () => {
  const { tree, refresh } = await mountCard(hostDouble());
  assert.equal(
    findLabeled(tree, "claude-haiku-4-5 context window"),
    undefined,
    "collapsed by default without overrides",
  );
  const toggle = find(
    tree,
    (node) => node.props?.["aria-label"] === "Show settings: claude-haiku-4-5",
  );
  assert.equal(toggle.props["aria-expanded"], false);
  toggle.props.onClick();
  const next = refresh();
  assert.ok(
    findLabeled(next, "claude-haiku-4-5 context window"),
    "the capacity fields appear once expanded",
  );
  assert.ok(findLabeled(next, "claude-haiku-4-5 max output"));

  // A stored override means there is something to show, so the row starts open.
  const overridden = await mountCard(
    hostDouble({
      accountModels: { [FIRST_ROUTE]: [{ id: "claude-haiku-4-5", contextWindow: 200000 }] },
    }),
  );
  assert.equal(findLabeled(overridden.tree, "claude-haiku-4-5 context window").props.value, 200000);
});

test("Use all available models is staged: it writes only on Save, and Discard undoes it", async () => {
  const remote = hostDouble();
  const { tree, refresh } = await mountCard(remote);
  assert.equal(findButton(tree, "Save").props.disabled, true, "nothing staged yet");
  findButton(tree, "Use all available models").props.onClick();
  const staged = refresh();
  assert.equal(remote.calls.mutate.length, 0, "the switch alone never writes");
  assert.ok(
    flatten(staged).includes("The available models will be used when you save."),
    "the card previews the built-in mode",
  );
  assert.ok(flatten(staged).includes("Unsaved changes"));
  findButton(staged, "Discard").props.onClick();
  assert.ok(
    findLabeled(refresh(), "claude-haiku-4-5 display name"),
    "Discard brings the saved list back",
  );
  assert.equal(findButton(refresh(), "Save").props.disabled, true);

  findButton(refresh(), "Use all available models").props.onClick();
  findButton(refresh(), "Save").props.onClick();
  await settle();
  assert.deepEqual(remote.calls.mutate.at(-1).ops, [unsetModelsOp(FIRST_ROUTE)]);
});

test("the add picker offers only catalog models the list does not carry", async () => {
  const { tree, refresh } = await mountCard(
    hostDouble({ accountModels: { [FIRST_ROUTE]: [{ id: "claude-opus-5-5" }] } }),
  );
  const offered = (t) =>
    findAll(findLabeled(t, "Model to add"), (node) => node.type === "option")
      .map((option) => option.props.value)
      .filter((value) => value !== "");
  assert.deepEqual(
    offered(tree),
    ["claude-sonnet-5-5", "claude-haiku-5-5"],
    "the listed id is not an option",
  );
  const addButton = (t) => findButton(t, "Add");
  assert.equal(addButton(tree).props.disabled, true, "no selection yet");
  findLabeled(tree, "Model to add").props.onChange({ target: { value: "claude-sonnet-5-5" } });
  const ready = refresh();
  assert.equal(addButton(ready).props.disabled, false);
  addButton(ready).props.onClick();
  const next = refresh();
  assert.ok(findLabeled(next, "claude-sonnet-5-5 display name"), "the new row renders");
  assert.deepEqual(offered(next), ["claude-haiku-5-5"], "the added id leaves the picker");
});

test("a list holding every catalog model replaces the picker with a sentence", async () => {
  const models = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"].map((id) => ({ id }));
  const { tree } = await mountCard(hostDouble({ accountModels: { [FIRST_ROUTE]: models } }));
  assert.equal(findLabeled(tree, "Model to add"), undefined, "nothing left to pick");
  assert.ok(flatten(tree).includes("Every available model is already in the list."));
});

test("a failed catalog load names the failure and Retry reloads the picker", async () => {
  const remote = hostDouble();
  let attempts = 0;
  remote.llm.discoverModels = async () => {
    attempts += 1;
    return attempts === 1
      ? { ok: false, error: { message: "boom" } }
      : { ok: true, value: [{ id: "claude-opus-5-5" }] };
  };
  const { tree, refresh } = await mountCard(remote);
  assert.ok(flatten(tree).includes("Available models could not be loaded."));
  assert.equal(findLabeled(tree, "Model to add"), undefined, "no picker without a catalog");
  findButton(tree, "Retry").props.onClick();
  await settle();
  const next = refresh();
  assert.deepEqual(
    findAll(findLabeled(next, "Model to add"), (node) => node.type === "option").map(
      (option) => option.props.value,
    ),
    ["", "claude-opus-5-5"],
    "the retry's catalog fills the picker",
  );
});

test("the image toggle stages an input override through the shared Checkbox", async () => {
  const remote = hostDouble({
    accountModels: { [FIRST_ROUTE]: [{ id: "claude-haiku-4-5", contextWindow: 1000 }] },
  });
  const Checkbox = () => null;
  const { tree, refresh } = await mountCard(remote, { primitives: { Checkbox } });
  const text = find(tree, (node) => node.type === Checkbox && node.props.label === "Text");
  assert.deepEqual(
    [text.props.checked, text.props.disabled],
    [true, true],
    "text input is always on",
  );
  const image = find(tree, (node) => node.type === Checkbox && node.props.label === "Image");
  image.props.onChange(false);
  findButton(refresh(), "Save").props.onClick();
  await settle();
  assert.deepEqual(
    remote.calls.mutate.at(-1).ops[0],
    setModelsOp([{ id: "claude-haiku-4-5", contextWindow: 1000, input: ["text"] }], FIRST_ROUTE),
  );
});

test("the card degrades to native controls without the shared primitives namespace", async () => {
  // An empty namespace: the Tooltip lookup degrades to undefined, and the
  // model editor falls back to native checkboxes for the input modalities.
  const mounted = await mountCard(
    hostDouble({
      accountModels: { [FIRST_ROUTE]: [{ id: "claude-haiku-4-5", contextWindow: 1000 }] },
    }),
    { primitives: {} },
  );
  assert.ok(
    flatten(mounted.tree).includes("claude-haiku-4-5"),
    "the models card is unaffected by the absent namespace",
  );
  assert.ok(flatten(mounted.tree).includes("Image"), "the native checkbox fallback renders");
  assert.ok(
    find(mounted.tree, (node) => node.props?.["aria-label"] === "Remove claude-haiku-4-5"),
    "remove stays reachable",
  );
  assert.ok(mounted.refresh());
});

test("the header's sign-in button is persistent and pre-fills /claude-login, signed in or not", async () => {
  const started = [];
  const uiWorkspace = { startSession: (...args) => started.push(args) };
  for (const mirror of [
    { accounts: [] },
    { accounts: [{ route: FIRST_ROUTE, email: "user@example.com", status: "signedIn" }] },
  ]) {
    const mounted = await mountCard(hostDouble({ mirror }), { uiWorkspace });
    const button = findButton(mounted.tree, "Add account");
    assert.ok(button, "the button renders whatever the sign-in state is");
    assert.equal(button.props["aria-label"], "Add account");
    button.props.onClick();
    assert.deepEqual(started.at(-1), [
      undefined,
      { prompt: "/claude-login", whenDraftExists: "replace" },
    ]);
  }
  // A per-account sign-out prefills that account's logout command.
  const mounted = await mountCard(
    hostDouble({
      mirror: { accounts: [{ route: FIRST_ROUTE, email: "user@example.com", status: "signedIn" }] },
    }),
    { uiWorkspace },
  );
  const signOut = findButton(mounted.tree, "Sign out");
  assert.equal(
    signOut.props["aria-label"],
    "Sign out: user@example.com",
    "the accessible name names the account",
  );
  signOut.props.onClick();
  assert.deepEqual(
    started.at(-1),
    [undefined, { prompt: `/claude-logout ${FIRST_ROUTE}`, whenDraftExists: "replace" }],
    "logout names the unique route, not the email",
  );
});

test("one button refreshes every account's catalog, and no panel carries its own", async () => {
  const routes = [FIRST_ROUTE, SECOND_ROUTE];
  const remote = hostDouble({
    mirror: {
      accounts: routes.map((route, index) => ({
        route,
        email: `user${index}@example.com`,
        status: "signedIn",
      })),
    },
  });
  const { tree } = await mountCard(remote);
  const button = findButton(tree, "Refresh models");
  assert.ok(button, "the card carries the one refresh");
  assert.equal(
    elements(tree).filter(
      (node) => node.type === "button" && flatten(node.children).startsWith("Refresh"),
    ).length,
    1,
    "exactly one refresh control, not one per account",
  );
  remote.calls.discoverModels.length = 0;
  button.props.onClick();
  assert.deepEqual(
    remote.calls.discoverModels.map((request) => request?.provider),
    routes.map((route) => `catalog:${route}#refresh`),
    "one immediate refresh per live account",
  );
  // With nothing to refresh the control stays present but inert.
  const empty = await mountCard(hostDouble({ mirror: { accounts: [] } }));
  assert.equal(findButton(empty.tree, "Refresh models").props.disabled, true);
});

test("a per-account sign-out targets the route, which stays unique when two accounts share an email", async () => {
  // A personal plan and a Team seat share an email; /claude-logout refuses
  // an ambiguous email, so every panel's action names its own route.
  const started = [];
  const uiWorkspace = { startSession: (...args) => started.push(args) };
  const shared = "same@example.com";
  const routes = [FIRST_ROUTE, SECOND_ROUTE];
  const mounted = await mountCard(
    hostDouble({
      mirror: { accounts: routes.map((route) => ({ route, email: shared, status: "signedIn" })) },
    }),
    { uiWorkspace },
  );
  const buttons = elements(mounted.tree).filter(
    (node) => node.type === "button" && node.props?.["aria-label"] === `Sign out: ${shared}`,
  );
  assert.equal(buttons.length, 2, "both panels offer their own sign-out");
  for (const button of buttons) button.props.onClick();
  assert.deepEqual(
    started.map(([, options]) => options.prompt),
    routes.map((route) => `/claude-logout ${route}`),
    "each panel signs out its own route",
  );
});

test("without a session-opening service the card names the command and renders no empty action seats", async () => {
  const { tree } = await mountCard(
    hostDouble({
      mirror: {
        accounts: [{ route: FIRST_ROUTE, email: "user@example.com", status: "signedIn" }],
      },
    }),
  );
  assert.equal(findButton(tree, "Add account"), undefined);
  assert.equal(findButton(tree, "Sign out"), undefined);
  assert.equal(
    find(tree, hasClassLike("dsh-cs-panelActions")),
    undefined,
    "no empty panel action seat",
  );
  assert.ok(
    flatten(tree).includes("Run /claude-login in any session to sign in."),
    "the fallback text renders",
  );
});
