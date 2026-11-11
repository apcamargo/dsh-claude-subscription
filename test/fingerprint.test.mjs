/**
 * Fingerprint conformance: canonical XXH64 vectors, the cch attestation patch,
 * the pinned beta profiles, and the billing-header fingerprint shape.
 * @module test/fingerprint.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBetaHeader,
  buildCoworkBetas,
  claudeCodeVersion,
  coworkUserAgent,
  createClaudeBillingHeader,
  generateClaudeCloakingUserId,
  patchCch,
  stripClaudeToolPrefix,
  applyClaudeToolPrefix,
  xxHash64,
} from "../lib/fingerprint.js";

const enc = new TextEncoder();
const hex = (v) => v.toString(16).padStart(16, "0");

// Canonical XXH64 seed-0 vectors (Cyan4973/xxHash reference), also confirmed
// against Bun's native xxHash64 (836/836).
const VECTORS = [
  ["", 0n, "ef46db3751d8e999"],
  ["a", 0n, "d24ec4f1a98c6e5b"],
  ["abc", 0n, "44bc2cf5ad770999"],
  ["message digest", 0n, "066ed728fceeb3be"],
  ["abcdefghijklmnopqrstuvwxyz", 0n, "cfe1f278fa89835c"],
  [
    "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
    0n,
    "e04a477f19ee145d",
  ],
];

test("xxHash64 matches the canonical seed-0 vectors", () => {
  for (const [input, seed, expected] of VECTORS) {
    assert.equal(hex(xxHash64(enc.encode(input), seed)), expected, `input "${input}"`);
  }
});

test("xxHash64 is seed-sensitive and length-agnostic at boundaries", () => {
  const body = enc.encode("x".repeat(31));
  const at31 = xxHash64(body, 0x4d659218e32a3268n);
  const at32 = xxHash64(enc.encode("x".repeat(32)), 0x4d659218e32a3268n);
  const seeded = xxHash64(enc.encode("x".repeat(31)), 0x4d659218e32a3267n);
  assert.notEqual(at31, at32);
  assert.notEqual(at31, seeded);
});

/** Serialize like the wire layer and patch. */
function billingBody(firstUserText) {
  const header = createClaudeBillingHeader(firstUserText);
  const body = JSON.stringify({
    system: [
      { type: "text", text: header },
      { type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." },
    ],
    messages: [{ role: "user", content: firstUserText }],
  });
  return enc.encode(body);
}

test("patchCch writes the 5-hex attestation over the placeholder", () => {
  const bytes = billingBody("hello world");
  assert.equal(patchCch(bytes), "patched");
  const json = Buffer.from(bytes).toString("utf8");
  const cch = /cch=([0-9a-f]{5});/.exec(json)?.[1];
  assert.ok(cch, "body carries a patched cch value");
  assert.equal(json.includes("cch=00000"), false, "placeholder is replaced");
  // Deterministic: the same body hashes to the same attestation.
  const again = billingBody("hello world");
  patchCch(again);
  assert.equal(/cch=([0-9a-f]{5});/.exec(Buffer.from(again).toString("utf8"))?.[1], cch);
  // And a changed body hashes differently.
  const other = billingBody("hello worlds");
  patchCch(other);
  assert.notEqual(/cch=([0-9a-f]{5});/.exec(Buffer.from(other).toString("utf8"))?.[1], cch);
});

test("patchCch classifies bodies without an anchored placeholder", () => {
  assert.equal(patchCch(enc.encode('{"messages":[]}')), "no-billing-header");
  // A placeholder stranded beyond the 150-byte search window is refused. The
  // marker is the `"system":[{"type":"text","text":"x-anthropic-billing-header:`
  // byte sequence the wire layout produces.
  const prefix = '"system":[{"type":"text","text":"x-anthropic-billing-header:';
  const far = enc.encode(`${prefix}${"y".repeat(300)}cch=00000`);
  assert.equal(patchCch(far), "unanchored");
  // Within the window it patches.
  const near = enc.encode(
    `${prefix} cc_version=2.1.322.abc; cc_entrypoint=claude-desktop; cch=00000;`,
  );
  assert.equal(patchCch(near), "patched");
});

test("the cch attestation stays self-consistent with non-BMP body text", () => {
  // The wire sanitizer preserves valid surrogate pairs, so bodies carry emoji.
  // the attestation is computed over the final serialized bytes, so it must
  // re-verify against the patched body with the placeholder restored.
  const bytes = billingBody("hello 🎉 world");
  assert.equal(patchCch(bytes), "patched");
  const json = Buffer.from(bytes).toString("utf8");
  const cch = /cch=([0-9a-f]{5});/.exec(json)?.[1];
  assert.ok(cch, "body carries a patched cch value");
  const restored = json.replace(/cch=[0-9a-f]{5};/, "cch=00000;");
  const recomputed = xxHash64(enc.encode(restored), 0x4d659218e32a3268n) & 0xfffffn;
  assert.equal(recomputed.toString(16).padStart(5, "0"), cch);
});

test("the billing header fingerprint salts the first user message", () => {
  // The fingerprint uses msg[4], msg[7], and msg[20]. The pair differs at
  // index 7 only and is long enough that msg[20] exists.
  const one = createClaudeBillingHeader("hello world, this is a long enough message");
  const two = createClaudeBillingHeader("hello wbrld, this is a long enough message");
  const version = new RegExp(`cc_version=${claudeCodeVersion}\.[0-9a-f]{3}`).exec(one)?.[0];
  assert.ok(version, "header carries cc_version.<3-hex>");
  assert.notEqual(one, two, "message[7] changes the fingerprint");
  assert.ok(one.startsWith("x-anthropic-billing-header:"));
  assert.ok(one.includes("cc_entrypoint=claude-desktop;"));
  // A short message hashes the same as any other short message: missing
  // characters read as "0".
  assert.equal(createClaudeBillingHeader("abcd"), createClaudeBillingHeader("wxyz"));
});

test("the Cowork identity is pinned", () => {
  assert.equal(claudeCodeVersion, "2.1.322");
  assert.equal(coworkUserAgent, `claude-cli/2.1.322 (external, claude-desktop)`);
});

test("the OAuth agent beta profile is pinned and never advertises 1M context", () => {
  const betas = buildCoworkBetas(true, true);
  assert.deepEqual(betas, [
    "claude-code-20250219",
    "interleaved-thinking-2025-05-14",
    "thinking-token-count-2026-05-13",
    "context-management-2025-06-27",
    "prompt-caching-scope-2026-01-05",
    "mid-conversation-system-2026-04-07",
    "advanced-tool-use-2025-11-20",
    "effort-2025-11-24",
    "fallback-credit-2026-06-01",
  ]);
  assert.ok(!betas.some((beta) => beta.includes("1m")), "no 1M-context beta on OAuth");
  const utility = buildCoworkBetas(false, false);
  assert.deepEqual(utility, [
    "interleaved-thinking-2025-05-14",
    "thinking-token-count-2026-05-13",
    "context-management-2025-06-27",
    "prompt-caching-scope-2026-01-05",
    "structured-outputs-2025-12-15",
  ]);
});

test("buildBetaHeader dedupes and preserves order", () => {
  assert.equal(buildBetaHeader(["b", "a"], ["a", "c", " b "]), "b,a,c");
  assert.equal(buildBetaHeader([], []), "");
});

test("tool prefix is applied and stripped symmetrically", () => {
  assert.equal(applyClaudeToolPrefix("read_file"), "_read_file");
  assert.equal(stripClaudeToolPrefix("_read_file"), "read_file");
  assert.equal(stripClaudeToolPrefix("read_file"), "read_file");
});

test("the cloaked user_id has the Claude Code shape", () => {
  const id = generateClaudeCloakingUserId();
  assert.match(id, /^user_[0-9a-f]{64}_account_[0-9a-f-]{36}_session_[0-9a-f-]{36}$/);
  assert.notEqual(id, generateClaudeCloakingUserId());
});
