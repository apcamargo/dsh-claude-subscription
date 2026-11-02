/**
 * Cowork / Claude Code wire-fingerprint constants and helpers.
 *
 * WHY THESE VALUES ARE PINNED
 * A subscription credential is only honoured outside Claude Code when the
 * request reproduces the first-party wire fingerprint: user-agent, beta
 * profile, system-block layout, 64k output clamp, `_` tool prefix, billing
 * header, and the `cch` attestation hash. Change any of these and requests
 * stop billing against the plan (or fail outright).
 *
 * Do not "portability-fix" the constants in this file. `X-Stainless-OS` and
 * `X-Stainless-Runtime-Version` are pinned fingerprint values, not host facts.
 * Only `X-Stainless-Arch` is host-derived.
 *
 * XXH64 is pure BigInt JS here, verified against the canonical vectors
 * (test/fingerprint.test.mjs).
 *
 * @module @apcamargo/dsh-claude-subscription/fingerprint
 */

import nodeCrypto from "node:crypto";

// ---------------------------------------------------------------------------
// Version / identity constants
// ---------------------------------------------------------------------------

/** Claude runtime version bundled by the current Cowork desktop release. */
export const claudeCodeVersion = "2.1.280";

/** User-Agent emitted by Cowork's `claude-desktop` inference entrypoint. */
export const coworkUserAgent = `claude-cli/${claudeCodeVersion} (external, claude-desktop)`;

/** Prefix used to isolate custom Anthropic OAuth tools from built-in tools. */
const claudeToolPrefix = "_";

export const claudeCodeSystemInstruction =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

export const CLAUDE_CODE_MAX_OUTPUT_TOKENS = 64000;

// ---------------------------------------------------------------------------
// Beta profiles
// ---------------------------------------------------------------------------

const midConversationSystemBeta = "mid-conversation-system-2026-04-07";
const contextManagementBeta = "context-management-2025-06-27";
const structuredOutputsBeta = "structured-outputs-2025-12-15";
const thinkingTokenCountBeta = "thinking-token-count-2026-05-13";
const fallbackCreditBeta = "fallback-credit-2026-06-01";
const effortBeta = "effort-2025-11-24";

const coworkUtilityBetaDefaults = [
  "interleaved-thinking-2025-05-14",
  thinkingTokenCountBeta,
  contextManagementBeta,
  "prompt-caching-scope-2026-01-05",
  structuredOutputsBeta,
];

const coworkAgentBetaDefaults = [
  "claude-code-20250219",
  "interleaved-thinking-2025-05-14",
  thinkingTokenCountBeta,
  contextManagementBeta,
  "prompt-caching-scope-2026-01-05",
  midConversationSystemBeta,
  "advanced-tool-use-2025-11-20",
];

/**
 * NOTE: `context-1m-2025-08-07` is intentionally never advertised. OAuth
 * subscription credentials have no long-context credit balance, so Anthropic
 * hard-429s ("Usage credits are required for long context requests") on any
 * beta-gated 1M model regardless of prompt size.
 *
 * The utility profile (`agentRequest: false`) is pinned but unreachable from
 * wire.js, which always passes `true`: a tools-free request on that profile
 * would drop the effort beta adaptive thinking needs, and every model here
 * advertises thinking.
 * @param {boolean} agentRequest - an agentic (tool-bearing) request.
 * @param {boolean} thinkingRequest - reasoning was requested.
 * @param {boolean} [disableStrictTools] - drop the structured-outputs beta.
 * @returns {readonly string[]} the beta list.
 */
export function buildCoworkBetas(agentRequest, thinkingRequest, disableStrictTools = false) {
  if (!agentRequest && !disableStrictTools) return coworkUtilityBetaDefaults;
  const betas = [];
  for (const beta of agentRequest ? coworkAgentBetaDefaults : coworkUtilityBetaDefaults) {
    if (disableStrictTools && beta === structuredOutputsBeta) continue;
    betas.push(beta);
  }
  if (!agentRequest) return betas;
  if (thinkingRequest) betas.push(effortBeta);
  betas.push(fallbackCreditBeta);
  return betas;
}

/**
 * Join beta values into one header, deduplicated.
 * @param {readonly string[]} baseBetas
 * @param {readonly string[]} extraBetas
 * @returns {string} the `anthropic-beta` header value.
 */
export function buildBetaHeader(baseBetas, extraBetas) {
  const seen = new Set();
  const out = [];
  for (const beta of [...baseBetas, ...extraBetas]) {
    const trimmed = beta.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out.join(",");
}

// ---------------------------------------------------------------------------
// Stainless / Cowork static headers
// ---------------------------------------------------------------------------

/**
 * @param {string} arch - `process.arch` value.
 * @returns {"x64" | "arm64" | "x86" | `other::${string}`}
 */
function mapStainlessArch(arch) {
  switch (arch.toLowerCase()) {
    case "amd64":
    case "x64":
      return "x64";
    case "arm64":
    case "aarch64":
      return "arm64";
    case "386":
    case "x86":
    case "ia32":
      return "x86";
    default:
      return `other::${arch.toLowerCase()}`;
  }
}

/**
 * Static headers emitted by Cowork's Linux Claude runtime. Pinned on purpose
 * (see the module doc).
 */
export const coworkHeaders = {
  "X-Stainless-Arch": mapStainlessArch(process.arch),
  "X-Stainless-Lang": "js",
  "X-Stainless-OS": "Linux",
  "X-Stainless-Package-Version": "0.94.0",
  "X-Stainless-Retry-Count": "0",
  "X-Stainless-Runtime": "node",
  "X-Stainless-Runtime-Version": "v26.3.0",
  "X-Stainless-Timeout": "600",
};

// ---------------------------------------------------------------------------
// Billing header + cch attestation
// ---------------------------------------------------------------------------

const CLAUDE_BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";
const CCH_PLACEHOLDER_STR = "cch=00000";
const CCH_SEED = 0x4d659218e32a3268n;
const cchEncoder = new TextEncoder();
const CCH_PLACEHOLDER = cchEncoder.encode(CCH_PLACEHOLDER_STR);
const BILLING_SYSTEM_MARKER = cchEncoder.encode(
  `"system":[{"type":"text","text":"${CLAUDE_BILLING_HEADER_PREFIX}`,
);
const CCH_BILLING_SEARCH_WINDOW = 150;

/**
 * Fingerprint: SHA256(salt + msg[4] + msg[7] + msg[20] + version)[:3]. Matches
 * Claude Code's computeFingerprint in utils/fingerprint.ts. Uses characters
 * from the first *user* message (not the system prompt).
 * @param {string} firstUserMessageText
 * @returns {string} the billing header block text.
 */
export function createClaudeBillingHeader(firstUserMessageText) {
  const k = [4, 7, 20].map((i) => firstUserMessageText[i] ?? "0").join("");
  const versionSuffix = nodeCrypto
    .createHash("sha256")
    .update(`59cf53e54c78${k}${claudeCodeVersion}`)
    .digest("hex")
    .slice(0, 3);
  return `${CLAUDE_BILLING_HEADER_PREFIX} cc_version=${claudeCodeVersion}.${versionSuffix}; cc_entrypoint=claude-desktop; ${CCH_PLACEHOLDER_STR};`;
}

// --- XXH64, pure JS ---------------------------------------------------------

const P1 = 0x9e3779b185ebca87n;
const P2 = 0xc2b2ae3d27d4eb4fn;
const P3 = 0x165667b19e3779f9n;
const P4 = 0x85ebca77c2b2ae63n;
const P5 = 0x27d4eb2f165667c5n;
const MASK = 0xffffffffffffffffn;

const u64 = (v) => v & MASK;
const rotl = (v, r) => u64((v << r) | (v >> (64n - r)));

function round(acc, input) {
  return u64(rotl(u64(acc + u64(input * P2)), 31n) * P1);
}

function mergeRound(acc, val) {
  const v = round(0n, val);
  return u64(u64(u64(acc ^ v) * P1) + P4);
}

function avalanche(h) {
  h = u64(h ^ (h >> 33n));
  h = u64(h * P2);
  h = u64(h ^ (h >> 29n));
  h = u64(h * P3);
  return u64(h ^ (h >> 32n));
}

/**
 * XXH64 over `input` with `seed`. Pure-JS replacement for Bun.hash.xxHash64.
 * @param {Uint8Array} input
 * @param {bigint} seed
 * @returns {bigint}
 */
export function xxHash64(input, seed) {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const len = input.length;
  let p = 0;
  let h;

  if (len >= 32) {
    let v1 = u64(seed + P1 + P2);
    let v2 = u64(seed + P2);
    let v3 = u64(seed);
    let v4 = u64(seed - P1);
    const limit = len - 32;
    do {
      v1 = round(v1, view.getBigUint64(p, true));
      v2 = round(v2, view.getBigUint64(p + 8, true));
      v3 = round(v3, view.getBigUint64(p + 16, true));
      v4 = round(v4, view.getBigUint64(p + 24, true));
      p += 32;
    } while (p <= limit);

    h = u64(rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n));
    h = mergeRound(h, v1);
    h = mergeRound(h, v2);
    h = mergeRound(h, v3);
    h = mergeRound(h, v4);
  } else {
    h = u64(seed + P5);
  }

  h = u64(h + BigInt(len));

  while (p + 8 <= len) {
    h = u64(rotl(u64(h ^ round(0n, view.getBigUint64(p, true))), 27n) * P1 + P4);
    p += 8;
  }
  if (p + 4 <= len) {
    h = u64(rotl(u64(h ^ u64(BigInt(view.getUint32(p, true)) * P1)), 23n) * P2 + P3);
    p += 4;
  }
  while (p < len) {
    h = u64(rotl(u64(h ^ u64(BigInt(input[p]) * P5)), 11n) * P1);
    p += 1;
  }

  return avalanche(h);
}

/**
 * cch attestation: XXHash64(body_with_placeholder, seed) low-20-bits, 5 hex
 * chars, written back over the placeholder in place (matches Claude Code).
 * @param {Uint8Array} body - the serialized request body. Patched in place.
 * @returns {"patched" | "no-billing-header" | "unanchored"}
 */
export function patchCch(body) {
  const view = Buffer.from(body.buffer, body.byteOffset, body.byteLength);

  const markerIdx = view.indexOf(BILLING_SYSTEM_MARKER);
  if (markerIdx === -1) return "no-billing-header";

  const searchFrom = markerIdx + BILLING_SYSTEM_MARKER.length;
  const idx = view.indexOf(CCH_PLACEHOLDER, searchFrom);
  if (idx === -1 || idx - searchFrom > CCH_BILLING_SEARCH_WINDOW) return "unanchored";

  const h = xxHash64(body, CCH_SEED);
  const cch = (h & 0xfffffn).toString(16).padStart(5, "0");

  // idx points at "cch=", digits start 4 bytes later.
  for (let i = 0; i < 5; i++) body[idx + 4 + i] = cch.charCodeAt(i);
  return "patched";
}

// ---------------------------------------------------------------------------
// metadata.user_id cloaking
// ---------------------------------------------------------------------------

/** @returns {string} a random cloaked `user_..._account_..._session_...` id. */
export function generateClaudeCloakingUserId() {
  const userHash = nodeCrypto.randomBytes(32).toString("hex");
  const accountId = nodeCrypto.randomUUID().toLowerCase();
  const sessionId = nodeCrypto.randomUUID().toLowerCase();
  return `user_${userHash}_account_${accountId}_session_${sessionId}`;
}

// ---------------------------------------------------------------------------
// Tool-name prefixing
// ---------------------------------------------------------------------------

/**
 * Custom OAuth tools are isolated with a `_` prefix rather than renamed to
 * Claude Code's built-in tool names, which avoids schema collisions with the
 * server-side built-ins.
 * @param {string} name
 * @returns {string}
 */
export const applyClaudeToolPrefix = (name) =>
  claudeToolPrefix ? `${claudeToolPrefix}${name}` : name;

/**
 * @param {string} name
 * @returns {string}
 */
export const stripClaudeToolPrefix = (name) => {
  if (!claudeToolPrefix) return name;
  if (!name.toLowerCase().startsWith(claudeToolPrefix.toLowerCase())) return name;
  return name.slice(claudeToolPrefix.length);
};
