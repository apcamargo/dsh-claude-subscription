/**
 * Anthropic OAuth flow for a Claude subscription, re-based onto the harness
 * authorization seam's session vocabulary.
 *
 * Divergences from the harness's built-in Anthropic OAuth flow:
 *
 *   | thing        | built-in flow                          | this plugin                           |
 *   |--------------|----------------------------------------|---------------------------------------|
 *   | token URL    | platform.claude.com/v1/oauth/token     | api.anthropic.com/v1/oauth/token      |
 *   | callback port| 53692                                  | 54545                                 |
 *   | bootstrap    | none                                   | /api/claude_cli/bootstrap             |
 *   | identity     | not captured                           | account/org uuid + email captured     |
 *
 * The client id, authorize URL and scopes are the first-party Claude Code ones.
 *
 * The flow talks to the starting surface through `session.notify` (a notice
 * carrying the authorize URL) and `session.prompt` (the manual paste fallback,
 * raced against the localhost callback server). The losing side of the race is
 * withdrawn through its own signal.
 *
 * @module @apcamargo/dsh-claude-subscription/oauth
 */

import nodeCrypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { claudeCodeVersion } from "./fingerprint.js";
import { fetchPlanName } from "./plan.js";

const CLIENT_ID = atob("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
/** Token endpoint on api.anthropic.com, not platform.claude.com. */
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const BOOTSTRAP_URL = "https://api.anthropic.com/api/claude_cli/bootstrap";
const CLAUDE_CODE_BOOTSTRAP_MODEL = "claude-opus-4-8";
const CLAUDE_CODE_BOOTSTRAP_USER_AGENT = `claude-code/${claudeCodeVersion}`;

/** Callback port, different from the built-in flow's 53692 so both can coexist. */
export const CALLBACK_PORT = 54545;
const CALLBACK_PATH = "/callback";

/**
 * Scopes required for direct OAuth-token inference (user:inference) plus
 * account/session management. platform.claude.com/oauth/authorize issues console
 * tokens (org:create_api_key only) and does NOT grant user:inference. The
 * claude.ai endpoint is required for direct inference.
 */
const SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

/** @typedef {{ accountId?: string, email?: string, orgId?: string, orgName?: string }} AnthropicIdentity */

function nonEmpty(v) {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function generatePKCE() {
  const bytes = nodeCrypto.randomBytes(32);
  const b64url = (b) =>
    b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const verifier = b64url(bytes);
  const challenge = b64url(nodeCrypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) {
    // The status rides on the error so callers can classify it (a refused
    // refresh token means a fresh sign-in, an outage does not) without
    // parsing the message.
    throw Object.assign(new Error(`HTTP ${response.status}: ${text}`), { status: response.status });
  }
  return text;
}

/** @returns {AnthropicIdentity} */
function extractAccountFromTokenResponse(data) {
  return {
    accountId: nonEmpty(data.account?.uuid),
    email: nonEmpty(data.account?.email_address),
    orgId: nonEmpty(data.organization?.uuid),
    orgName: nonEmpty(data.organization?.name),
  };
}

/** Bootstrap round-trip. Fills identity gaps the token response leaves. */
async function fetchBootstrapIdentity(accessToken) {
  const url = `${BOOTSTRAP_URL}?entrypoint=cli&model=${encodeURIComponent(CLAUDE_CODE_BOOTSTRAP_MODEL)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json, text/plain, */*",
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": CLAUDE_CODE_BOOTSTRAP_USER_AGENT,
      "anthropic-beta": "oauth-2025-04-20",
    },
    signal: AbortSignal.timeout(30_000),
  });
  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${responseBody}`);
  }
  const data = JSON.parse(responseBody);
  return {
    accountId: nonEmpty(data.oauth_account?.account_uuid),
    email: nonEmpty(data.oauth_account?.account_email),
    orgId: nonEmpty(data.oauth_account?.organization_uuid),
    orgName: nonEmpty(data.oauth_account?.organization_name),
  };
}

/**
 * `includeOrg` is login-only: the org an access token is scoped to is captured
 * once when the credential is created and never refreshed, because rewriting
 * identity during background refreshes could silently re-key stored credentials.
 * @returns {Promise<AnthropicIdentity>}
 */
async function resolveAccountIdentity(data, options = {}) {
  const identity = extractAccountFromTokenResponse(data);
  const orgSatisfied = !options.includeOrg || identity.orgId !== undefined;
  if (identity.accountId && identity.email && orgSatisfied) return identity;
  try {
    const bootstrap = await fetchBootstrapIdentity(data.access_token);
    return {
      accountId: identity.accountId ?? bootstrap.accountId,
      email: identity.email ?? bootstrap.email,
      orgId: identity.orgId ?? bootstrap.orgId,
      orgName: identity.orgName ?? bootstrap.orgName,
    };
  } catch {
    return identity;
  }
}

function parseAuthorizationInput(input) {
  const value = input.trim();
  if (!value) return {};
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // Not a URL. Treat as a raw "code#state" pasted from the browser.
    const hashIdx = value.indexOf("#");
    if (hashIdx >= 0) {
      return { code: value.slice(0, hashIdx), state: value.slice(hashIdx + 1) || undefined };
    }
    return { code: value };
  }
}

/**
 * Exchange one authorization code for tokens and resolve the account identity.
 * @param {object} input
 * @param {string} input.code
 * @param {string} input.state
 * @param {string} input.verifier
 * @param {string} input.redirectUri
 * @returns {Promise<{ grant: object }>} the grant payload to store.
 */
export async function exchangeCode({ code, state, verifier, redirectUri }) {
  const responseBody = await postJson(TOKEN_URL, {
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    state,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });

  let tokenData;
  try {
    tokenData = JSON.parse(responseBody);
  } catch (error) {
    throw new Error(
      `Anthropic token exchange returned invalid JSON. url=${TOKEN_URL}; body=${responseBody}; details=${String(error)}`,
    );
  }
  // Fail fast on a malformed 2xx body (the body is NOT included in these
  // messages: it may carry live tokens). Storing a grant without a usable
  // access/refresh pair would brick the credential until re-login.
  if (typeof tokenData.access_token !== "string" || tokenData.access_token.length === 0) {
    throw new Error(`Anthropic token exchange returned no access token. url=${TOKEN_URL}`);
  }
  if (typeof tokenData.refresh_token !== "string" || tokenData.refresh_token.length === 0) {
    throw new Error(`Anthropic token exchange returned no refresh token. url=${TOKEN_URL}`);
  }
  if (!Number.isFinite(tokenData.expires_in)) {
    throw new Error(`Anthropic token exchange returned a non-numeric expires_in. url=${TOKEN_URL}`);
  }
  const identity = await resolveAccountIdentity(tokenData, { includeOrg: true });
  // Best-effort: an unknown plan never fails the sign-in. The next refresh
  // or usage fetch fills it in.
  const plan = await fetchPlanName(tokenData.access_token);

  return {
    grant: {
      access: tokenData.access_token,
      refresh: tokenData.refresh_token,
      expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
      ...identity,
      plan,
    },
  };
}

/**
 * Refresh one grant against the token endpoint. Identity is captured at login
 * and not rewritten on refresh.
 * @param {object} grant - the stored grant payload.
 * @returns {Promise<object>} the refreshed grant payload.
 */
export async function refreshGrant(grant) {
  const responseBody = await postJson(TOKEN_URL, {
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: grant.refresh,
  });
  let data;
  try {
    data = JSON.parse(responseBody);
  } catch (error) {
    throw new Error(
      `Anthropic token refresh returned invalid JSON. url=${TOKEN_URL}; body=${responseBody}; details=${String(error)}`,
    );
  }
  // Fail fast on a malformed 2xx body: the throw happens BEFORE the commit, so
  // the previous stored grant (with its still-valid access token) stays intact.
  // The body is not quoted, because it may carry live tokens.
  if (typeof data.access_token !== "string" || data.access_token.length === 0) {
    throw new Error(`Anthropic token refresh returned no access token. url=${TOKEN_URL}`);
  }
  if (!Number.isFinite(data.expires_in)) {
    throw new Error(`Anthropic token refresh returned a non-numeric expires_in. url=${TOKEN_URL}`);
  }
  // The plan is cosmetic and NOT fetched here: this path runs inside a model
  // request waiting for a refreshed token, and a slow profile endpoint must not
  // delay it. The usage engine and the once-per-mount sweep (lib/index.js
  // syncPlans) keep the stored plan current.
  return {
    refresh: data.refresh_token || grant.refresh,
    access: data.access_token,
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
    accountId: grant.accountId,
    email: grant.email,
    orgId: grant.orgId,
    orgName: grant.orgName,
    addedAt: grant.addedAt,
    plan: grant.plan,
  };
}

/**
 * Run the login: open the callback server, surface the authorize URL, race the
 * browser callback against a manual paste, and exchange whichever arrives first.
 * The caller receives the grant payload to commit.
 * @param {object} input
 * @param {{ signal: AbortSignal, notify: (notice: { message: string, url?: string, code?: string }) => void,
 *   prompt: (prompt: { kind: "text", message: string, signal?: AbortSignal }) => Promise<string> }} input.session
 *   the authorization seam's session.
 * @param {boolean} [input.openBrowser] - best-effort `open` of the authorize URL.
 * @returns {Promise<object>} the grant payload.
 */
export async function login({ session, openBrowser = true }) {
  const { verifier, challenge } = generatePKCE();
  const state = nodeCrypto.randomUUID();
  const redirectUri = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;

  let server;
  /** Settles with the bind error when the local server cannot listen. */
  let bindError;
  let settleBind;
  const listenSettled = new Promise((resolve) => {
    settleBind = resolve;
  });

  const callbackPromise = new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      if (!req.url?.startsWith(CALLBACK_PATH)) {
        res.writeHead(404).end();
        return;
      }
      const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      // RFC 6749 §4.1.2: the authorization server echoes state back. A mismatch
      // (or absence) means the redirect did not originate from this sign-in.
      // PKCE would still stop the exchange, but the user should see the actual
      // problem instead of an opaque token 400.
      if (returnedState !== state) {
        res
          .writeHead(400, { "Content-Type": "text/html" })
          .end(
            "<html><body><h2>Login failed.</h2><p>The sign-in redirect did not match this login attempt (state mismatch). Close this tab and retry /claude-login.</p></body></html>",
          );
        reject(
          new Error(
            "OAuth callback state mismatch; the redirect did not originate from this sign-in",
          ),
        );
        return;
      }
      if (code) {
        res
          .writeHead(200, { "Content-Type": "text/html" })
          .end(
            "<html><body><h2>Login complete.</h2><p>You can close this tab and return to DeepSeek Harness.</p></body></html>",
          );
        resolve({ code, state: returnedState });
      } else {
        res
          .writeHead(400, { "Content-Type": "text/html" })
          .end("<html><body><h2>Login failed.</h2></body></html>");
        reject(new Error("OAuth callback carried no authorization code"));
      }
    });
    server.on("error", () => {
      // Post-settle socket errors must not kill a healthy login. Bind
      // failures are surfaced through listenSettled below.
    });
    server.listen(CALLBACK_PORT, "127.0.0.1");
  });

  // Detect a bind failure (port busy, EACCES) before composing the paste prompt:
  // the prompt is the only channel the user sees, and its "just wait for the
  // browser" copy would be a trap when no redirect can ever land.
  server.once("listening", () => settleBind(undefined));
  server.once("error", (error) => settleBind(error));
  bindError = await listenSettled;
  if (bindError !== undefined) {
    // The redirect can never arrive here: retire the callback server so
    // the paste path is the only way to finish.
    server.close();
  }

  const authParams = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  const authorizeUrl = `${AUTHORIZE_URL}?${authParams.toString()}`;

  session.notify({
    message: "Continue in your browser to sign in with your Claude account.",
    url: authorizeUrl,
  });
  if (openBrowser) openInBrowser(authorizeUrl);

  // The manual paste question races the callback server. Whoever loses is
  // withdrawn through its own signal, per the authorization seam's contract
  // for racing flows.
  const pasteController = new AbortController();
  const pastePromise = session
    .prompt({
      kind: "text",
      message:
        bindError === undefined
          ? "If the browser cannot reach this machine, paste the redirect URL (or the code) here. Otherwise just wait for the browser login to finish."
          : `The local callback server could not start (${bindError.code ?? String(bindError)}), so the browser redirect cannot reach this sign-in. Paste the redirect URL (or the code) here to finish.`,
      signal: pasteController.signal,
    })
    .then((input) => {
      const parsed = parseAuthorizationInput(input);
      if (!parsed.code) throw new Error("No authorization code provided");
      // A bare code (no state) is the documented paste fallback and stays
      // user-mediated (PKCE still guards the exchange). A present-but-mismatched
      // state means the paste is not from this sign-in.
      if (parsed.state !== undefined && parsed.state !== state) {
        throw new Error("Pasted redirect state does not match this login attempt");
      }
      return { code: parsed.code, state: parsed.state ?? state };
    });
  pastePromise.catch(() => {}); // a losing or withdrawn prompt must not reject unobserved

  const abortPromise = new Promise((_, reject) => {
    session.signal.addEventListener("abort", () => reject(new Error("login cancelled")), {
      once: true,
    });
    if (session.signal.aborted) reject(new Error("login cancelled"));
  });
  // A failed bind removes the callback from the race: it can never settle,
  // and a hung redirect page must not block the paste path.
  const racers =
    bindError === undefined
      ? [callbackPromise, pastePromise, abortPromise]
      : [pastePromise, abortPromise];

  let received;
  try {
    received = await Promise.race(racers);
  } finally {
    pasteController.abort(new Error("login settled"));
    server?.close();
  }

  const { grant } = await exchangeCode({ ...received, verifier, redirectUri });
  return grant;
}

/** Best-effort open of the authorize URL in the user's default browser. */
function openInBrowser(url) {
  try {
    const child =
      process.platform === "win32"
        ? spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" })
        : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], {
            detached: true,
            stdio: "ignore",
          });
    child.unref();
  } catch {
    // No browser, no desktop session: the URL is in the notice either way.
  }
}
