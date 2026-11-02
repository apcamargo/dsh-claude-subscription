/**
 * Account management commands: `/claude-login`, `/claude-logout`,
 * `/claude-account`, `/claude-usage`.
 *
 * Several accounts can be signed in at once. The account that serves a model
 * request is determined by the model's provider route, never by a setting. These
 * commands therefore take an optional `[account]` argument (a route id, an email,
 * or a unique part of either) and resolve no-argument invocations against the
 * invoking session's own route first, then the only account, then a question.
 *
 * The login command drives the plugin's authorization flow in this session: the
 * authorize URL is shown as the question's detail, the browser is opened
 * best-effort, and the paste fallback races the localhost callback server. The
 * flow signs the account in on its own route, and whoever was signed in before
 * stays signed in. Sign-in state lives in the harness credential plane.
 *
 * @module @apcamargo/dsh-claude-subscription/commands
 */

import { CommandDefinitionId } from "@deepseek-ai/dsh-commands/brand";
import {
  ACCOUNT_PREFIX,
  ACCOUNT_TAG,
  AUTH_PREFIX,
  NO_USAGE_DATA,
  NOTE_PREFIX,
  OBSERVED_PREFIX,
  ORGANIZATION_PREFIX,
  ROUTE_PREFIX,
  TOKEN_PREFIX,
  USAGE_TAG,
  countdownDuration,
} from "./client-models.js";
import { fetchPlan, fetchUsage, formatUsage, usageHeaders } from "./usage.js";
import { isOAuthToken } from "./wire.js";

/** The user dismissed the question: stop, and report nothing as a failure. */
class Declined extends Error {}

/**
 * Ask through the host userQuestions seam. A dismissal (the panel closed, or its
 * "Discuss" button) means the user wants to type instead: the command stops,
 * which also withdraws the running login attempt.
 * @param {object} deps
 * @param {object} request - `{ questions, agent, signal }`.
 */
async function askOrDecline(deps, request) {
  try {
    return await deps.ask(request);
  } catch (error) {
    if (error?.code === "ASK_CANCELLED" || error?.code === "ASK_ABORTED") {
      throw new Declined("The question was dismissed, so the command stopped.");
    }
    throw error;
  }
}

function answerText(answer, id) {
  const entry = answer?.answers?.find((candidate) => candidate.id === id);
  return entry?.custom?.trim() || entry?.selected?.[0] || "";
}

/** The `Token` row's value: `expired` is the early-warning window, not a past stamp. */
function formatExpiry(expires, expired) {
  if (!Number.isFinite(expires)) return "unknown";
  return expired
    ? "needs a refresh on next use"
    : `expires in ${countdownDuration(expires - Date.now())}`;
}

/** The raw text following the command name, tolerating harnesses that pass none. */
function rawInputOf(invocation) {
  return typeof invocation?.rawInput === "string" ? invocation.rawInput : "";
}

/** Split the raw input into flag tokens (currently only "--all") and the rest. */
function parseArguments(raw) {
  const tokens = raw
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  const flags = new Set(tokens.filter((token) => token.startsWith("--")));
  const rest = tokens.filter((token) => !token.startsWith("--")).join(" ");
  return { flags, rest };
}

function displayName(account) {
  if (account.email) return account.email;
  return `account …${account.route.slice(-6)}`;
}

/** The plan noun of an account ("Pro" -> "Pro plan"), empty when unknown. */
function planText(account) {
  const plan = typeof account.plan === "string" ? account.plan.trim() : "";
  return plan.length > 0 ? `${plan} plan` : "";
}

/** The short route tail that tells apart accounts with no usable email or org. */
function routeTail(account) {
  return account.route.slice(-6);
}

/**
 * The selector row of one account. The email is the option label, so the host
 * renders it as the row's primary text, and the plan is the option description,
 * painted dimmed beside it. Labels must stay unique because the answer carries
 * the chosen label back, so a shared email also carries the organization (or the
 * route tail) in parentheses.
 */
function accountOption(account, accounts) {
  const email = displayName(account);
  const shared = accounts.filter((other) => displayName(other) === email);
  let label = email;
  if (shared.length > 1) {
    const org = typeof account.orgName === "string" ? account.orgName.trim() : "";
    const sameOrg =
      org.length > 0 &&
      shared.some(
        (other) =>
          other !== account && typeof other.orgName === "string" && other.orgName.trim() === org,
      );
    label = `${email} (${org.length > 0 ? org : routeTail(account)}${sameOrg ? `, ${routeTail(account)}` : ""})`;
  }
  const plan = planText(account);
  return plan.length > 0 ? { label, description: plan } : { label };
}

/**
 * Match an `[account]` argument against the stored accounts: a route id, an
 * email, or a unique case-insensitive part of either. An empty argument matches
 * nothing (the caller falls back to its default resolution); an ambiguous or
 * unknown one is reported.
 * @param {object[]} accounts
 * @param {string} token
 * @returns {{ matches: object[], problem?: string }}
 */
function matchAccounts(accounts, token) {
  const needle = token.trim().toLowerCase();
  if (needle.length === 0) return { matches: [] };
  const exact = accounts.filter(
    (account) =>
      account.route.toLowerCase() === needle || (account.email ?? "").toLowerCase() === needle,
  );
  if (exact.length === 1) return { matches: exact };
  if (exact.length > 1) {
    // A personal plan and a Team seat share an account id and email, so the
    // route id is the only name that picks one of them.
    return {
      matches: [],
      problem: `"${token.trim()}" matches more than one account: ${exact.map((account) => account.route).join(", ")}. Name one by route id.`,
    };
  }
  const partial = accounts.filter(
    (account) =>
      (account.email ?? "").toLowerCase().includes(needle) ||
      account.route.toLowerCase().includes(needle),
  );
  if (partial.length === 1) return { matches: partial };
  if (partial.length > 1) {
    return {
      matches: [],
      problem: `"${token.trim()}" matches more than one account: ${partial.map(displayName).join(", ")}. Name one exactly.`,
    };
  }
  return { matches: [], problem: `No account matches "${token.trim()}".` };
}

/**
 * The provider route the invoking session is pointed at, when it is one of this
 * plugin's. Read from the session's live model-selection projection
 * (`pending ?? lastUsed`); `agent.options` is only the creation-time option.
 * Then it reads from the session's last request header. Both reads are
 * best-effort: a host without the projections service, or an agent that has sent
 * nothing yet, yields no preference.
 * @param {object} deps
 * @param {object} invocation
 * @returns {string | undefined}
 */
function sessionRouteOf(deps, invocation) {
  const session = invocation?.agent?.session;
  if (session === undefined) return undefined;
  try {
    const state = deps.ctx.get?.("sessionProjections")?.stateOf?.(session, "modelSelection");
    const selection = state?.pending ?? state?.lastUsed;
    if (typeof selection?.provider === "string" && deps.isAccountRoute(selection.provider))
      return selection.provider;
  } catch {
    // No projections service or an unexpected shape: fall through.
  }
  try {
    const provider = session.requestHeader?.()?.config?.provider;
    if (typeof provider === "string" && deps.isAccountRoute(provider)) return provider;
  } catch {
    // No request header yet: fall through.
  }
  return undefined;
}

/**
 * Which account a no-argument invocation means, in resolution order: the invoking
 * session's route, then the only account, then a question listing the accounts
 * (the session's own first). "Cancel" and a dismissal stop the command. "All
 * accounts" reports every account.
 * @returns {Promise<{ kind: "one" | "all", account?: object }>}
 */
async function resolveAccount(
  deps,
  invocation,
  accounts,
  signal,
  { header, allowAll = false, allDescription = "Every signed-in account" } = {},
) {
  const sessionRoute = sessionRouteOf(deps, invocation);
  if (sessionRoute !== undefined) {
    const own = accounts.find((account) => account.route === sessionRoute);
    if (own !== undefined) return { kind: "one", account: own };
  }
  if (accounts.length === 1) return { kind: "one", account: accounts[0] };
  const ordered = [...accounts];
  if (sessionRoute !== undefined) {
    ordered.sort((a, b) => (a.route === sessionRoute ? -1 : b.route === sessionRoute ? 1 : 0));
  }
  const options = [
    ...ordered.map((account) => accountOption(account, accounts)),
    ...(allowAll ? [{ label: "All accounts", description: allDescription }] : []),
    { label: "Cancel", description: "Do nothing" },
  ];
  const answer = await askOrDecline(deps, {
    questions: [
      {
        id: "account",
        header: header ?? "Claude accounts",
        question: "Which account?",
        options,
      },
    ],
    agent: invocation.agent,
    signal,
  });
  const picked = answerText(answer, "account");
  if (picked === "All accounts") return { kind: "all" };
  if (picked === "" || picked === "Cancel") throw new Declined("Cancelled.");
  // The options carry display labels, not ids: resolve the selected label
  // through the same function that produced it before treating the text as a
  // typed email or route id.
  const chosen = ordered.find((account) => accountOption(account, accounts).label === picked);
  if (chosen !== undefined) return { kind: "one", account: chosen };
  const { matches, problem } = matchAccounts(accounts, picked);
  if (problem !== undefined) throw new Error(problem);
  if (matches.length !== 1) throw new Declined("Cancelled.");
  return { kind: "one", account: matches[0] };
}

/**
 * `/claude-login`: run the OAuth authorization flow in this session, signing the
 * account in on its own route. Re-running it for an account already signed in
 * only refreshes its credential; a different account is added alongside.
 *
 * The browser's claude.ai session decides which account the authorize page
 * offers, so a second login from the same browser usually re-authorizes the
 * account already signed in. The result text says so, and names the way to add
 * another one. `[email]` states which account was expected; a mismatch is
 * reported but the sign-in is kept.
 * @param {object} deps - `{ ctx, grants, login }`.
 */
async function login(deps, invocation, signal) {
  const { ctx, grants } = deps;
  const { rest } = parseArguments(rawInputOf(invocation));
  const expected = rest.trim().length > 0 ? rest.trim() : undefined;

  let outcome;
  // A second /claude-login is refused while an attempt is running. That attempt
  // owns the staging record the seam confirms its commit on and the shared
  // prompt state below, so a refused invocation must leave both alone.
  let ownsAttempt = true;
  try {
    outcome = await ctx.authorization.begin({
      key: grants.stagingKey,
      method: "oauth",
      signal,
      interaction: {
        notify: (received) => {
          // The flow's news rides the paste question's detail; the first ask
          // already carries the authorize URL.
          deps.login.notice = [deps.login.notice, received.message].filter(Boolean).join(" ");
          deps.login.url = received.url ?? deps.login.url;
        },
        prompt: async (prompt) => {
          deps.login.prompts = (deps.login.prompts ?? 0) + 1;
          const question =
            deps.login.prompts === 1
              ? prompt.message
              : [deps.login.notice, prompt.message].filter(Boolean).join(" ");
          const answer = await askOrDecline(deps, {
            questions: [
              {
                id: "paste",
                header: "Claude login",
                question,
                detail: deps.login.url ? `Authorize URL: ${deps.login.url}` : undefined,
              },
            ],
            agent: invocation.agent,
            signal: prompt.signal ?? signal,
          });
          const text = answerText(answer, "paste");
          if (!text) throw new Declined("No code was pasted.");
          return text;
        },
      },
    });
  } catch (error) {
    if (error?.code === "ALREADY_IN_FLIGHT") ownsAttempt = false;
    throw error;
  } finally {
    if (ownsAttempt) {
      // The staging record satisfied the seam's commit observation and is
      // scratch from here on, for every outcome. The account record itself was
      // already written by the flow.
      await grants.deleteStaging().catch(() => {});
      deps.login.notice = undefined;
      deps.login.url = undefined;
      deps.login.prompts = 0;
    }
  }

  if (outcome.status !== "authorized") {
    return { kind: "success", text: `Login ${outcome.status}. No credential was changed.` };
  }
  const adoption = deps.login.last;
  if (adoption === undefined) {
    // Should not happen (the flow adopts before it resolves), but never report
    // a sign-in that cannot be named.
    return {
      kind: "success",
      text: "The login completed, but the signed-in account could not be read. Run /claude-account to check.",
    };
  }
  const accounts = await grants.listAccounts();
  const who = adoption.identity.email ?? displayName({ email: undefined, route: adoption.route });
  const org =
    adoption.previous?.orgName ??
    accounts.find((account) => account.route === adoption.route)?.orgName;

  const lines = [];
  if (adoption.outcome === "refreshed") {
    lines.push(
      `${who} was already signed in; the credential was refreshed. No new account was added.`,
    );
    if (accounts.length > 1) {
      lines.push(
        "Your browser's claude.ai session decides which account the authorize page offers: to add a different account, sign in to it on claude.ai first, or open the URL in a private window.",
      );
    }
  } else {
    lines.push(
      `Signed in to Claude as ${who}${org ? ` (${org})` : ""}. Its subscription models are available as ${adoption.route}/<model> — pick one in the model selector.`,
    );
  }
  if (accounts.length > 1 && adoption.outcome !== "refreshed") {
    lines.push(
      `${accounts.length} accounts are signed in; each is its own group in the model selector.`,
    );
  }
  if (expected !== undefined) {
    const matched =
      who.toLowerCase().includes(expected.toLowerCase()) ||
      adoption.route.toLowerCase() === expected.toLowerCase();
    if (!matched) {
      lines.push(
        `You asked to sign in as ${expected}, but the browser authorized ${who}. ${who} is the account that was signed in.`,
      );
    }
  }
  return { kind: "success", text: lines.join(" ") };
}

/**
 * `/claude-logout [account|--all]`: delete stored credential(s) and remove the
 * account. One account: confirmed. Several: a question lists them. `--all` signs
 * out of every stored account.
 * @param {object} deps - `{ ctx, grants, login, syncAccounts, dropRoute, removeAccount, isAccountRoute }`.
 */
async function logout(deps, invocation, signal) {
  const { grants } = deps;
  const stored = await grants.listAccounts();
  const { flags, rest } = parseArguments(rawInputOf(invocation));
  const all = flags.has("--all");
  const unknown = [...flags].filter((flag) => flag !== "--all");
  if (unknown.length > 0) {
    return {
      kind: "error",
      text: `Unknown option${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}.`,
    };
  }
  if (all && rest.trim().length > 0) {
    return { kind: "error", text: "Use either an account or --all, not both." };
  }
  if (stored.length === 0) return { kind: "success", text: "No Claude credential is stored." };

  /** Pick the targets: an explicit argument, `--all`, else the default resolution. */
  let targets;
  if (rest.trim().length > 0) {
    const { matches, problem } = matchAccounts(stored, rest);
    if (problem !== undefined) return { kind: "error", text: problem };
    targets = matches;
  } else if (all) {
    targets = stored;
  } else {
    const resolved = await resolveAccount(deps, invocation, stored, signal, {
      header: "Claude logout",
      allowAll: true,
      allDescription: "Every signed-in account",
    });
    targets = resolved.kind === "all" ? stored : [resolved.account];
  }
  if (targets.length === 0)
    return { kind: "success", text: "Logout cancelled; the credentials were kept." };

  const names = targets.map((account) => displayName(account));
  const question =
    targets.length === 1
      ? `Sign out (${names[0]})? The stored credential is deleted and the account is removed.`
      : `Sign out of ${targets.length} accounts (${names.join(", ")})? The stored credentials are deleted and the accounts are removed.`;
  const answer = await askOrDecline(deps, {
    questions: [
      {
        id: "confirm",
        header: "Claude logout",
        question,
        options: [
          {
            label: "Sign out",
            description:
              "The credential records are deleted and the accounts are removed from this machine.",
          },
          { label: "Cancel", description: "Keep the credentials." },
        ],
      },
    ],
    agent: invocation.agent,
    signal,
  });
  if (answerText(answer, "confirm").toLowerCase() !== "sign out") {
    return { kind: "success", text: "Logout cancelled; the credentials were kept." };
  }

  const notes = [];
  for (const target of targets) {
    await grants.deleteCredential(target.route);
    await deps.login.usage?.clear(target.route);
    await deps.removeAccount(target.route);
  }
  await deps.syncAccounts();
  // A sync normally disposes the removed routes; this fallback covers a sync
  // skipped for an unavailable credential store.
  for (const target of targets) deps.dropRoute(target.route);
  notes.push(
    "Sessions that were using the removed account's models fail on their next send until you pick another model in the selector.",
  );
  notes.push(
    "The credential was removed from this machine only; nothing was revoked on Anthropic's side.",
  );
  const headline =
    targets.length === 1 ? `Removed ${names[0]}.` : `Removed ${targets.length} accounts.`;
  return { kind: "success", text: `${headline} ${notes.join(" ")}`.trim() };
}

/**
 * `/claude-account [account]`: show the sign-in state of one account (or a
 * summary when several are stored and none is named).
 *
 * The success text is the user-facing surface, the same grammar as
 * `/claude-usage`'s: a leading tag line, `Key: value` rows, guidance as a
 * `Note:` line. Optional rows are absent when unknown.
 * @param {object} deps - `{ ctx, grants }`.
 */
async function account(deps, invocation, signal) {
  const accounts = await deps.grants.listAccounts();
  if (accounts.length === 0) {
    return {
      kind: "success",
      text: [
        ACCOUNT_TAG,
        `${AUTH_PREFIX}Not signed in`,
        `${NOTE_PREFIX}No Claude credential stored. Run /claude-login.`,
      ].join("\n"),
    };
  }
  const { rest } = parseArguments(rawInputOf(invocation));
  let target;
  if (rest.trim().length > 0) {
    const { matches, problem } = matchAccounts(accounts, rest);
    if (problem !== undefined) return { kind: "error", text: problem };
    if (matches.length === 0)
      return { kind: "error", text: `No account matches "${rest.trim()}".` };
    target = matches[0];
  } else {
    const resolved = await resolveAccount(deps, invocation, accounts, signal, {
      header: "Claude account",
    });
    target = resolved.account;
  }

  if (!target.oauth) {
    // An API-key record or a record the plugin cannot read: no plan facts.
    const auth = target.kind === "api-key" ? "API key" : "Unreadable credential";
    return {
      kind: "success",
      text: [
        ACCOUNT_TAG,
        `${AUTH_PREFIX}${auth}`,
        `${ROUTE_PREFIX}${target.route}`,
        ...(target.kind === "api-key"
          ? [`${NOTE_PREFIX}Billed as API credits, not the subscription plan.`]
          : []),
      ]
        .filter((line) => line !== undefined)
        .join("\n"),
    };
  }

  // Resolve first, on the same path a model request takes: a stale grant
  // refreshes here, so the identity and expiry rows below report the stored
  // credential as it stands now. A failed resolve (offline) only drops the plan
  // row; the stored state is this command's subject, not a bonus.
  let credential;
  try {
    credential = await deps.grants.resolve({ route: target.route, signal });
  } catch {
    credential = undefined;
  }
  const stored = await deps.grants.describe(target.route);
  // fetchPlan never throws: its failure strings degrade the row to
  // "Plan: unavailable (…)", the same vocabulary the usage card shows.
  let plan;
  if (credential !== undefined && credential.oauth && isOAuthToken(credential.apiKey)) {
    plan = await fetchPlan(usageHeaders(credential.apiKey), { signal });
  }
  const who = stored.email
    ? `${ACCOUNT_PREFIX}${stored.email}`
    : `${ACCOUNT_PREFIX}${displayName(target)}`;
  // `stored` is re-read after the resolve, so this picks up a refusal the refresh
  // above just discovered (a success clears the flag).
  const needsReauth = stored.needsReauth === true;
  const lines = [
    ACCOUNT_TAG,
    needsReauth ? `${AUTH_PREFIX}Needs sign-in again` : `${AUTH_PREFIX}Subscription (OAuth)`,
    who,
  ];
  if (stored.orgName) lines.push(`${ORGANIZATION_PREFIX}${stored.orgName}`);
  if (plan !== undefined) lines.push(plan);
  if (stored.expires !== undefined)
    lines.push(`${TOKEN_PREFIX}${formatExpiry(stored.expires, stored.expired)}`);
  lines.push(`${ROUTE_PREFIX}${target.route}`);
  if (needsReauth) {
    lines.push(
      `${NOTE_PREFIX}Token refresh failed. Run /claude-login ${stored.email ?? ""} to sign in again.`.trim(),
    );
  }
  return { kind: "success", text: lines.join("\n") };
}

/** The guidance text of a usage request with no credential at all to resolve. */
function noUsageCredentialText() {
  return `${USAGE_TAG}\n${NOTE_PREFIX}No Claude credential stored. Run /claude-login, then /claude-usage again.`;
}

/**
 * The guidance text of a route that authenticates with an API key: it has no
 * plan quota to show, and saying so is more useful than naming a sign-in. Shared
 * by the stored-record path and the base route's environment fallback, so the
 * sentence has one spelling.
 * @param {string} route
 */
function apiKeyUsageText(route) {
  return `${USAGE_TAG}\n${ROUTE_PREFIX}${route}\n${NOTE_PREFIX}API-key accounts have no plan quota. Usage is billed as API credits.`;
}

/**
 * `/claude-usage [account]`: plan usage for one account's subscription
 * credential. Resolves through the grant manager, so an expired credential
 * refreshes on the same path model requests take. A stored API-key record has no
 * plan.
 *
 * The success text is the user-facing surface: guidance renders as a `Note:`
 * line, the trailing `Observed:` ISO stamp lets the composer indicator's cache
 * order runs by observation time instead of write time, the `Route:` row keys its
 * per-account cache, and an `Account:` line carries the email.
 * @param {object} deps - `{ ctx, grants }`.
 */
async function usage(deps, invocation, signal) {
  const accounts = await deps.grants.listAccounts();
  const { rest } = parseArguments(rawInputOf(invocation));
  let target;
  if (accounts.length === 0) return { kind: "success", text: noUsageCredentialText() };
  if (rest.trim().length > 0) {
    const { matches, problem } = matchAccounts(accounts, rest);
    if (problem !== undefined) return { kind: "error", text: problem };
    if (matches.length === 0)
      return { kind: "error", text: `No account matches "${rest.trim()}".` };
    target = matches[0];
  } else {
    const resolved = await resolveAccount(deps, invocation, accounts, signal, {
      header: "Claude usage",
    });
    target = resolved.account;
  }

  const credential = await deps.grants.resolve({ route: target.route, signal });
  if (credential === undefined) {
    const who = displayName(target);
    return {
      kind: "success",
      text: `${USAGE_TAG}\n${ROUTE_PREFIX}${target.route}\n${NOTE_PREFIX}${who} is not signed in. Run /claude-login${target.email ? ` ${target.email}` : ""}, then /claude-usage again.`,
    };
  }
  if (!credential.oauth || !isOAuthToken(credential.apiKey)) {
    return { kind: "success", text: apiKeyUsageText(target.route) };
  }
  // The account's email and route ride the same text contract, so the cards
  // compose their header subtitle from the same parsed fields and the composer
  // indicator keys its cache by route (lib/client-app.js).
  const headers = usageHeaders(credential.apiKey);
  const [plan, lines] = await Promise.all([
    fetchPlan(headers, { signal }),
    fetchUsage(headers, { signal }).then(formatUsage),
  ]);
  return {
    kind: "success",
    text: [
      USAGE_TAG,
      target.email ? `${ACCOUNT_PREFIX}${target.email}` : `${ACCOUNT_PREFIX}${displayName(target)}`,
      `${ROUTE_PREFIX}${target.route}`,
      plan,
      ...(lines.length > 0 ? lines : [NO_USAGE_DATA]),
      `${OBSERVED_PREFIX}${new Date().toISOString()}`,
    ]
      .filter((line) => line !== undefined)
      .join("\n"),
  };
}

/**
 * Register the commands.
 * @param {object} ctx - host context.
 * @param {object} deps - `{ ctx, grants, ask, login, syncAccounts, dropRoute, removeAccount, isAccountRoute }`.
 * @param {{ signal: AbortSignal, track: <T>(work: Promise<T>) => Promise<T> }} lifecycle
 */
export function registerCommands(ctx, deps, lifecycle) {
  const guarded = (work) => (invocation) => {
    const signal = AbortSignal.any([invocation.signal, lifecycle.signal]);
    return lifecycle.track(
      (async () => {
        try {
          return await work(deps, invocation, signal);
        } catch (error) {
          if (error instanceof Declined || signal.aborted) {
            return {
              kind: "success",
              text: error instanceof Declined ? error.message : "Cancelled.",
            };
          }
          return { kind: "error", text: error?.message ?? String(error) };
        }
      })(),
    );
  };

  ctx.commands.register({
    definitionId: CommandDefinitionId("@apcamargo/dsh-claude-subscription/claude-login"),
    name: "claude-login",
    description: "Sign in with a Claude subscription (OAuth); repeats add accounts",
    input: { hint: "[email]" },
    recordInput: false,
    handler: guarded(login),
  });
  ctx.commands.register({
    definitionId: CommandDefinitionId("@apcamargo/dsh-claude-subscription/claude-logout"),
    name: "claude-logout",
    description: "Sign out of a Claude account and delete its stored credential",
    input: { hint: "[account | --all]" },
    recordInput: false,
    handler: guarded(logout),
  });
  ctx.commands.register({
    definitionId: CommandDefinitionId("@apcamargo/dsh-claude-subscription/claude-account"),
    name: "claude-account",
    description: "Show the sign-in state of a Claude account used by the subscription provider",
    input: { hint: "[account]" },
    recordInput: false,
    handler: guarded(account),
  });
  ctx.commands.register({
    definitionId: CommandDefinitionId("@apcamargo/dsh-claude-subscription/claude-usage"),
    name: "claude-usage",
    description: "Show a Claude account's subscription usage quota and reset times",
    input: { hint: "[account]" },
    recordInput: false,
    handler: guarded(usage),
  });
}
