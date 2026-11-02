/**
 * Command handlers against a scripted grant manager: the credential-resolution
 * paths `/claude-usage` and `/claude-account` report, and the text contract.
 * Network-free.
 * @module test/commands.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  ACCOUNT_TAG,
  AUTH_PREFIX,
  NOTE_PREFIX,
  ROUTE_PREFIX,
  USAGE_TAG,
} from "../lib/client-models.js";
import { registerCommands } from "../lib/commands.js";
import { isAccountRoute } from "../lib/credentials.js";

/** Two account routes, for cases where the target is one of several. */
const FIRST_ROUTE = "claude-subscription-111111111111";
const SECOND_ROUTE = "claude-subscription-222222222222";

/** The API-key guidance sentence a stored api-key record emits. */
const API_KEY_NOTE = `${NOTE_PREFIX}API-key accounts have no plan quota. Usage is billed as API credits.`;

/**
 * Register the real command handlers against scripted dependencies.
 * @param {object} [options]
 * @param {object[]} [options.accounts] - what `grants.listAccounts()` answers.
 * @param {(request: object) => unknown} [options.resolve] - per-request resolve answer. May throw.
 * @param {(route: string) => object} [options.describe] - `grants.describe()` answer.
 * @param {(answers: object[]) => object} [options.answer] - the selected option labels, per question.
 * @param {() => Promise<object>} [options.begin] - the authorization seam's answer.
 */
function mount({
  accounts = [],
  resolve,
  describe = async () => ({ configured: false }),
  answer,
  begin = async () => ({ status: "cancelled" }),
} = {}) {
  const handlers = new Map();
  const resolvers = [];
  const calls = { deleteStaging: 0, deleteCredential: [], remove: [], drop: [], sync: 0 };
  const ctx = {
    commands: {
      register(definition) {
        handlers.set(definition.name, definition);
      },
    },
    get: () => undefined,
    authorization: { begin },
  };
  const grants = {
    async listAccounts() {
      return accounts;
    },
    async resolve(request) {
      resolvers.push(request);
      return resolve === undefined ? undefined : resolve(request);
    },
    async describe(route) {
      return describe(route);
    },
    async deleteCredential(route) {
      calls.deleteCredential.push(route);
    },
    async deleteStaging() {
      calls.deleteStaging += 1;
    },
  };
  const deps = {
    ctx,
    grants,
    // By default the handlers under test never ask: a dismissal is the stop
    // signal. `answer` scripts the selection question instead.
    ask: async (request) => {
      if (answer === undefined)
        throw Object.assign(new Error("The question was dismissed"), { code: "ASK_CANCELLED" });
      return {
        answers: request.questions.map((question) => ({
          id: question.id,
          selected: answer(question),
        })),
      };
    },
    login: {},
    syncAccounts: () => {
      calls.sync += 1;
    },
    dropRoute: (route) => calls.drop.push(route),
    removeAccount: (route) => calls.remove.push(route),
    isAccountRoute,
  };
  registerCommands(ctx, deps, { signal: new AbortController().signal, track: (work) => work });
  const run = (name, rawInput = "") => {
    const signal = new AbortController().signal;
    return handlers.get(name).handler({ agent: {}, rawInput, signal });
  };
  return { run, resolvers, calls, deps };
}

test("/claude-usage reports the API-key path for a stored api-key record", async () => {
  const stored = mount({
    accounts: [
      { route: FIRST_ROUTE, kind: "api-key", oauth: false, needsReauth: false, identity: {} },
    ],
    resolve: () => ({ oauth: false, apiKey: "sk-ant-api03-record" }),
  });
  const outcome = await stored.run("claude-usage");
  assert.equal(outcome.kind, "success");
  assert.deepEqual(outcome.text.split("\n"), [
    USAGE_TAG,
    `${ROUTE_PREFIX}${FIRST_ROUTE}`,
    API_KEY_NOTE,
  ]);
});

test("/claude-usage keeps the sign-in guidance when nothing is stored", async () => {
  const { run } = mount({ resolve: () => undefined });
  const outcome = await run("claude-usage");
  assert.equal(outcome.kind, "success");
  assert.deepEqual(outcome.text.split("\n"), [
    USAGE_TAG,
    `${NOTE_PREFIX}No Claude credential stored. Run /claude-login, then /claude-usage again.`,
  ]);
});

test("/claude-usage resolves the account's route", async () => {
  const { run, resolvers } = mount({
    accounts: [
      {
        route: SECOND_ROUTE,
        kind: "grant",
        oauth: true,
        needsReauth: false,
        email: "dev@example.com",
        identity: {},
      },
    ],
    resolve: () => undefined,
  });
  const outcome = await run("claude-usage");
  assert.equal(outcome.kind, "success");
  assert.match(outcome.text, /dev@example\.com is not signed in/);
  assert.equal(resolvers[0].route, SECOND_ROUTE);
});

test("/claude-account reports a refusal its own resolve discovered", async () => {
  const email = "dev@example.com";
  const { run } = mount({
    accounts: [
      { route: FIRST_ROUTE, kind: "grant", oauth: true, needsReauth: false, email, identity: {} },
    ],
    resolve: () => {
      throw Object.assign(new Error("HTTP 401: refresh token rejected"), { status: 401 });
    },
    // What the grant manager reports after that refusal: the flag was set by
    // the failed refresh, after the listing that fed `accounts`.
    describe: () => ({
      configured: true,
      oauth: true,
      route: FIRST_ROUTE,
      email,
      expires: Date.now() + 3_600_000,
      expired: false,
      needsReauth: true,
    }),
  });
  const outcome = await run("claude-account");
  assert.equal(outcome.kind, "success");
  const lines = outcome.text.split("\n");
  assert.equal(lines[0], ACCOUNT_TAG);
  assert.equal(lines[1], `${AUTH_PREFIX}Needs sign-in again`);
  assert.ok(
    lines.some((line) => line.startsWith(NOTE_PREFIX) && line.includes(`/claude-login ${email}`)),
    "the note names the re-login command",
  );
});

test("a selected account option names its account, display label and all", async () => {
  // The options carry the email as their label and the plan as the dimmed
  // description: the command must resolve the label it presented back to the
  // same account.
  const accounts = [
    {
      route: FIRST_ROUTE,
      kind: "grant",
      oauth: true,
      needsReauth: false,
      email: "a@x.com",
      plan: "Pro",
      orgName: "Personal",
      identity: {},
    },
    {
      route: SECOND_ROUTE,
      kind: "grant",
      oauth: true,
      needsReauth: false,
      email: "b@x.com",
      plan: "Max",
      orgName: "Acme",
      identity: {},
    },
  ];
  const seen = [];
  const offered = [];
  const { run } = mount({
    accounts,
    answer: (question) => {
      seen.push(question.question);
      offered.push(...question.options);
      // The second account's label, exactly as the question rendered it.
      return [question.options.find((option) => option.label === "b@x.com").label];
    },
  });
  const outcome = await run("claude-account");
  assert.deepEqual(seen, ["Which account?"], "several accounts ask");
  assert.deepEqual(
    offered,
    [
      { label: "a@x.com", description: "Pro plan" },
      { label: "b@x.com", description: "Max plan" },
      { label: "Cancel", description: "Do nothing" },
    ],
    "the email is the row's main text and the plan its dimmed description",
  );
  assert.equal(outcome.kind, "success");
  assert.match(outcome.text, /^Account: b@x\.com$/m, "the selected account is the one rendered");
  assert.match(outcome.text, new RegExp(`^${ROUTE_PREFIX}${SECOND_ROUTE}$`, "m"));
  assert.doesNotMatch(
    outcome.text,
    /other account/i,
    "the card does not advertise the other signed-in account",
  );
});

test("a shared email keeps selector rows distinct while the plan stays dimmed", async () => {
  // The answer carries the chosen label back, so two accounts under one email
  // need a label that names exactly one of them. The plan no longer does that
  // job, so the organization stands in beside the email.
  const accounts = [
    {
      route: FIRST_ROUTE,
      kind: "grant",
      oauth: true,
      needsReauth: false,
      email: "a@x.com",
      plan: "Pro",
      orgName: "Personal",
      identity: {},
    },
    {
      route: SECOND_ROUTE,
      kind: "grant",
      oauth: true,
      needsReauth: false,
      email: "a@x.com",
      plan: "Max",
      orgName: "Acme",
      identity: {},
    },
  ];
  let offered = [];
  const { run } = mount({
    accounts,
    answer: (question) => {
      offered = question.options;
      return [question.options.find((option) => option.label === "a@x.com (Acme)").label];
    },
  });
  const outcome = await run("claude-account");
  assert.deepEqual(offered, [
    { label: "a@x.com (Personal)", description: "Pro plan" },
    { label: "a@x.com (Acme)", description: "Max plan" },
    { label: "Cancel", description: "Do nothing" },
  ]);
  assert.equal(outcome.kind, "success");
  assert.match(
    outcome.text,
    /^Account: a@x\.com$/m,
    "the selected row still names the shared email",
  );
  assert.match(outcome.text, new RegExp(`^${ROUTE_PREFIX}${SECOND_ROUTE}$`, "m"));
});

test("a shared email is reported as ambiguous instead of picking one account", async () => {
  // A personal plan and a Team seat share the account id and email. Only the
  // route id tells them apart.
  const accounts = [
    {
      route: FIRST_ROUTE,
      kind: "grant",
      oauth: true,
      needsReauth: false,
      email: "a@x.com",
      orgName: "Personal",
      identity: {},
    },
    {
      route: SECOND_ROUTE,
      kind: "grant",
      oauth: true,
      needsReauth: false,
      email: "a@x.com",
      orgName: "Acme",
      identity: {},
    },
  ];
  const { run } = mount({ accounts });
  const outcome = await run("claude-usage", "a@x.com");
  assert.equal(outcome.kind, "error");
  assert.match(outcome.text, /matches more than one account/);
  assert.ok(
    outcome.text.includes(FIRST_ROUTE) && outcome.text.includes(SECOND_ROUTE),
    "it names the routes that disambiguate",
  );
});

test("/claude-login leaves a refused attempt's staging record and prompt state alone", async () => {
  // A second /claude-login is refused while one runs. The running attempt owns
  // the staging record (the seam confirms its commit on it) and the shared
  // prompt state.
  const { run, deps, calls } = mount({
    begin: async () => {
      throw Object.assign(new Error("an authorization attempt is already running"), {
        code: "ALREADY_IN_FLIGHT",
      });
    },
  });
  deps.login.url = "https://claude.ai/oauth/authorize?code=true";
  const outcome = await run("claude-login");
  assert.equal(outcome.kind, "error");
  assert.equal(calls.deleteStaging, 0, "the staging record belongs to the running attempt");
  assert.equal(
    deps.login.url,
    "https://claude.ai/oauth/authorize?code=true",
    "the running attempt's prompt state survives",
  );

  // An invocation that ran its own attempt does clean up after itself.
  const own = mount({ begin: async () => ({ status: "cancelled" }) });
  const cancelled = await own.run("claude-login");
  assert.equal(cancelled.kind, "success");
  assert.equal(own.calls.deleteStaging, 1);
});

test("/claude-logout removes the account and rejects unknown options", async () => {
  const { run, calls } = mount({
    accounts: [
      {
        route: FIRST_ROUTE,
        kind: "grant",
        oauth: true,
        needsReauth: false,
        email: "one@example.com",
        identity: {},
      },
    ],
    answer: () => ["Sign out"],
  });
  const rejected = await run("claude-logout", "--force");
  assert.equal(rejected.kind, "error");
  assert.match(rejected.text, /Unknown option/);
  assert.equal(calls.deleteCredential.length, 0, "an unknown option changes nothing");

  const outcome = await run("claude-logout");
  assert.equal(outcome.kind, "success");
  assert.match(outcome.text, /Removed one@example\.com/);
  assert.deepEqual(calls.deleteCredential, [FIRST_ROUTE], "the credential is deleted");
  assert.deepEqual(calls.remove, [FIRST_ROUTE], "the account settings are removed");
  assert.deepEqual(calls.drop, [FIRST_ROUTE], "the route is dropped even if the sync was skipped");
  assert.equal(calls.sync, 1, "the route set is reconciled");
});

test("/claude-logout --all removes every stored account", async () => {
  const accounts = [
    {
      route: FIRST_ROUTE,
      kind: "grant",
      oauth: true,
      needsReauth: false,
      email: "one@example.com",
      identity: {},
    },
    {
      route: SECOND_ROUTE,
      kind: "grant",
      oauth: true,
      needsReauth: false,
      email: "two@example.com",
      identity: {},
    },
  ];
  const { run, calls } = mount({ accounts, answer: () => ["Sign out"] });
  const outcome = await run("claude-logout", "--all");
  assert.equal(outcome.kind, "success");
  assert.match(outcome.text, /Removed 2 accounts/);
  assert.deepEqual(calls.deleteCredential, [FIRST_ROUTE, SECOND_ROUTE]);
  assert.deepEqual(calls.remove, [FIRST_ROUTE, SECOND_ROUTE]);
  assert.deepEqual(calls.drop, [FIRST_ROUTE, SECOND_ROUTE]);
});
