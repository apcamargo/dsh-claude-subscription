/**
 * Wire-shape assertions: the OAuth (subscription) path and the API-key path
 * must stay divergent in exactly the ported ways. Every outgoing request fact
 * asserted here is a fingerprint fact. See lib/wire.js.
 * @module test/wire.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";
import { resolveCatalog, toHarnessModel } from "../lib/catalog.js";
import {
  buildAnthropicRequest,
  isOAuthToken,
  readReplayState,
  splitSystemPrompt,
  toReplayState,
} from "../lib/wire.js";
import { coworkUserAgent } from "../lib/fingerprint.js";

/** A servable spec, as the runtime catalog produces one. */
const spec = (fields) => ({
  name: "Claude Test",
  contextWindow: 200_000,
  maxTokens: 64_000,
  ...fields,
});
const OPUS = spec({
  id: "claude-opus-5-5",
  name: "Claude Opus 5.5",
  contextWindow: 1_000_000,
  maxTokens: 128_000,
  thinkingLevelMap: {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  },
  defaultEffort: "medium",
  compat: { forceAdaptiveThinking: true, supportsTemperature: false, supportsStrictTools: true },
});
const OPUS_45 = spec({ id: "claude-opus-4-5", name: "Claude Opus 4.5" });
const OPUS_46 = spec({
  id: "claude-opus-4-6",
  name: "Claude Opus 4.6",
  thinkingLevelMap: { max: "max" },
  compat: { forceAdaptiveThinking: true, supportsStrictTools: true },
});
const FABLE = spec({
  id: "claude-fable-5-1",
  name: "Claude Fable 5.1",
  thinkingLevelMap: {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  },
  compat: { forceAdaptiveThinking: true, supportsTemperature: false, supportsStrictTools: true },
});
const HAIKU = spec({ id: "claude-haiku-4-5", name: "Claude Haiku 4.5" });

const OAUTH_KEY = "sk-ant-oat01-example0token";
const API_KEY = "sk-ant-api03-example";

/** A minimal harness history. */
function history() {
  return [{ role: "user", content: [{ type: "text", text: "hello world" }] }];
}

/** A user message + an assistant tool call + its result, the common agentic loop. */
function toolHistory() {
  return [
    { role: "user", content: [{ type: "text", text: "list files" }] },
    {
      role: "assistant",
      source: { kind: "model", provider: "claude-subscription", model: "claude-opus-5-5" },
      content: [
        { type: "text", text: "I will look." },
        { type: "tool-call", id: "toolu_01ABC-DEF", name: "bash", arguments: '{"command":"ls"}' },
      ],
    },
    {
      role: "tool",
      toolCallId: "toolu_01ABC-DEF",
      isError: false,
      content: [{ type: "text", text: "a.txt" }],
    },
  ];
}

const TOOLS = [
  {
    name: "bash",
    description: "Run a shell command",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
];

/** Build a request and expose its serialized body as a parsed object. */
function wire(overrides = {}) {
  const request = buildAnthropicRequest(base(overrides));
  return { ...request, json: JSON.parse(Buffer.from(request.body).toString("utf8")) };
}

function base(overrides = {}) {
  return {
    model: OPUS,
    messages: history(),
    tools: TOOLS,
    oauth: true,
    apiKey: OAUTH_KEY,
    reasoning: "high",
    ...overrides,
  };
}

/** Every cache breakpoint in a serialized request, as [location, control] pairs, in wire order. */
function cacheEntries(json) {
  const entries = [];
  const collect = (blocks, label, suffix) =>
    (blocks ?? []).forEach((block, index) => {
      if (block.cache_control) entries.push([`${label}${index}${suffix}`, block.cache_control]);
    });
  collect(json.system, "system[", "]");
  collect(json.tools, "tools[", "]");
  (json.messages ?? []).forEach((message, messageIndex) => {
    if (Array.isArray(message.content)) collect(message.content, `messages[${messageIndex}].`, "");
  });
  return entries;
}

/** Every cache breakpoint's location, in wire order. */
function cacheMarkers(json) {
  return cacheEntries(json).map(([location]) => location);
}

/** Every cache-control object, in wire order. */
function cacheControls(json) {
  return cacheEntries(json).map(([, control]) => control);
}

test("isOAuthToken detects the subscription marker", () => {
  assert.equal(isOAuthToken(OAUTH_KEY), true);
  assert.equal(isOAuthToken(API_KEY), false);
});

// ---- OAuth path ------------------------------------------------------------

test("OAuth requests carry the Cowork fingerprint headers, the 64k clamp, and the cloaked user id", () => {
  const { headers, json } = wire();
  assert.equal(headers["User-Agent"], coworkUserAgent);
  assert.equal(headers["x-app"], "cli");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(headers["Authorization"], `Bearer ${OAUTH_KEY}`);
  assert.equal(headers["Accept-Encoding"], "gzip, deflate, br");
  assert.equal(headers["X-Stainless-OS"], "Linux");
  assert.equal(headers["X-Stainless-Runtime"], "node");
  assert.ok(headers["x-client-request-id"]);
  // The model's 128k ceiling is never sent raw.
  assert.equal(json.max_tokens, 64000);
  assert.notEqual(json.max_tokens, OPUS.maxTokens);
  assert.match(json.metadata.user_id, /^user_[0-9a-f]{64}_account_/);
  // Model-level headers may add keys but never clobber the fingerprint.
  const shaped = buildAnthropicRequest(
    base({ modelHeaders: { "X-Custom": "1", "user-agent": "evil" } }),
  );
  assert.equal(shaped.headers["X-Custom"], "1");
  assert.equal(shaped.headers["User-Agent"], coworkUserAgent);
});

test("the composed OAuth beta header never advertises 1M context", () => {
  // The pinned profile arrays live in fingerprint.test.mjs. This test owns the
  // composed header: attached, and never carrying a 1M beta.
  const { betas, headers } = buildAnthropicRequest(base());
  assert.equal(headers["anthropic-beta"], betas);
  assert.ok(betas.startsWith("claude-code-20250219"));
  assert.ok(!betas.includes("1m"), "no 1M-context beta on OAuth");
});

test("OAuth system carries the billing header and the Cowork identity, not the harness prompt", () => {
  const { json } = wire({ systemPrompt: "You are DeepSeek Harness, a coding agent." });
  assert.equal(json.system.length, 2);
  assert.match(json.system[0].text, /^x-anthropic-billing-header: cc_version=/);
  assert.equal(
    json.system[1].text,
    "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
  );
  assert.equal(json.system[1].cache_control.type, "ephemeral");
});

test("OAuth relocates the harness prompt into a leading <system-reminder> user turn", () => {
  const { json } = wire({ systemPrompt: "You are DeepSeek Harness, a coding agent." });
  const first = json.messages[0];
  assert.equal(first.role, "user");
  assert.ok(Array.isArray(first.content), "user content is a block array so it can carry a marker");
  assert.match(first.content[0].text, /^<system-reminder>\nYou are DeepSeek Harness/);
  assert.equal(json.messages[1].role, "assistant");
  assert.equal(json.messages[1].content[0].text, "Understood.");
  assert.equal(json.messages[1].content[0].cache_control.type, "ephemeral");
  assert.equal(json.messages[2].content[0].text, "hello world");
  // The original user turn is preserved verbatim after the relocation, and it
  // is the turn that carries the conversation-tail breakpoint.
  assert.equal(json.messages.at(-1).content[0].text, "hello world");
  assert.equal(json.messages.at(-1).content[0].cache_control.type, "ephemeral");
});

test("reasoning maps to thinking/output_config: effort on adaptive models, budget below the cap, nothing when off", () => {
  // Adaptive models are effort-shaped.
  const adaptive = wire({ reasoning: "xhigh" });
  assert.deepEqual(adaptive.json.thinking, { type: "adaptive", display: "summarized" });
  assert.deepEqual(adaptive.json.output_config, { effort: "xhigh" });

  // The model's thinkingLevelMap wins over the default effort ladder. A level
  // the map omits falls back to the ladder (the port's behavior, the
  // harness's UNSUPPORTED_REASONING_EFFORT gate keeps that unreachable).
  const opus55 = wire({ model: OPUS, reasoning: "max" });
  assert.deepEqual(opus55.json.output_config, { effort: "max" });
  const opus46 = wire({ model: OPUS_46, reasoning: "high" });
  assert.deepEqual(opus46.json.output_config, { effort: "high" });

  // Budget models carry a token budget clamped below max_tokens.
  const budget = wire({ model: OPUS_45, reasoning: "high" });
  assert.equal(budget.json.thinking.type, "enabled");
  assert.ok(budget.json.thinking.budget_tokens < budget.json.max_tokens);
  assert.ok(budget.json.thinking.budget_tokens >= 1024);

  // No reasoning option (or "off") sends neither thinking nor effort.
  for (const reasoning of [undefined, "off"]) {
    const idle = wire({ reasoning });
    assert.equal(idle.json.thinking, undefined, `no thinking for ${String(reasoning)}`);
    assert.equal(idle.json.output_config, undefined, `no effort for ${String(reasoning)}`);
  }
});

test("temperature is omitted on adaptive models and while thinking", () => {
  const { json } = wire({ temperature: 0.5 });
  assert.equal(json.temperature, undefined);
  const budget = wire({ model: OPUS_45, reasoning: "high", temperature: 0.5 });
  assert.equal(budget.json.temperature, undefined);
  const idle = wire({ model: OPUS_45, reasoning: "off", temperature: 0.5 });
  assert.equal(idle.json.temperature, 0.5);
});

test("OAuth tool mapping: declared prefix, sanitized ids, parsed arguments, idempotent replay", () => {
  const { json } = wire({ messages: toolHistory() });
  const names = json.tools.map((tool) => tool.name);
  assert.deepEqual(names, ["_bash"]);
  assert.equal(json.tools[0].cache_control.type, "ephemeral");
  // The replayed assistant tool_use and its result share the sanitized id.
  const assistant = json.messages.find((message) => message.role === "assistant");
  const toolUse = assistant.content.find((block) => block.type === "tool_use");
  assert.equal(toolUse.name, "_bash");
  assert.deepEqual(toolUse.input, { command: "ls" });
  const resultTurn = json.messages.find(
    (message) => Array.isArray(message.content) && message.content[0]?.type === "tool_result",
  );
  assert.equal(resultTurn.content[0].tool_use_id, toolUse.id);

  // Malformed arguments replay as an empty object instead of failing the turn.
  const malformed = toolHistory();
  malformed[1].content[1].arguments = "{not json";
  const broken = wire({ messages: malformed }).json;
  const brokenUse = broken.messages
    .find((message) => message.role === "assistant")
    .content.find((block) => block.type === "tool_use");
  assert.deepEqual(brokenUse.input, {});

  // A stored prefixed name must not double-prefix, and an unprefixed one
  // gains the prefix: one wire name.
  for (const stored of ["bash", "_bash"]) {
    const stale = toolHistory();
    stale[1].content[1].name = stored;
    const replayed = wire({ messages: stale })
      .json.messages.find((message) => message.role === "assistant")
      .content.find((block) => block.type === "tool_use");
    assert.equal(replayed.name, "_bash", `stored "${stored}" maps to the declared wire name`);
  }
});

test("text-only tool results keep string content; the enclosing block is the cached tail", () => {
  const { json } = wire({ messages: toolHistory() });
  const result = json.messages.find(
    (message) => Array.isArray(message.content) && message.content[0]?.type === "tool_result",
  );
  assert.equal(result.content[0].content, "a.txt");
  assert.equal(result.content[0].cache_control.type, "ephemeral");
});
test("empty, whitespace-only, and thinking blocks are dropped or never marked", () => {
  // Upstream #39: an empty text block that survives conversion gets the tail
  // breakpoint, and Anthropic 400s ("cache_control cannot be set for empty
  // text blocks"). userContent filters empty text instead.
  const { json } = wire({
    messages: [
      { role: "user", content: [{ type: "text", text: "" }] },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ],
  });
  assert.deepEqual(json.messages, [
    {
      role: "user",
      content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral", ttl: "1h" } }],
    },
  ]);

  // Whitespace-only text takes the same drop one line later: the joined
  // string fails the trim guard.
  const whitespace = wire({
    messages: [
      { role: "user", content: [{ type: "text", text: "  " }] },
      { role: "user", content: [{ type: "text", text: "hello world" }] },
    ],
  });
  assert.deepEqual(whitespace.json.messages, [
    {
      role: "user",
      content: [
        { type: "text", text: "hello world", cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
    },
  ]);

  // A history that is only an empty turn serializes to no messages at all.
  const onlyEmpty = wire({ messages: [{ role: "user", content: [{ type: "text", text: "" }] }] });
  assert.deepEqual(onlyEmpty.json.messages, []);

  // A trailing empty turn drops, and the breakpoint falls back to the last
  // real block instead of padding the empty one.
  const trailing = wire({
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi there" }] },
      { role: "user", content: [{ type: "text", text: "" }] },
    ],
  });
  assert.equal(trailing.json.messages.length, 2);
  assert.equal(trailing.json.messages.at(-1).role, "assistant");
  assert.equal(trailing.json.messages.at(-1).content.at(-1).cache_control.type, "ephemeral");

  // A whitespace-only system prompt is NOT dropped, but it cannot carry a
  // cache breakpoint: the API-key path sends it unmarked, and the OAuth
  // relocation skips it and sends the identity blocks.
  const apiSystem = wire({ oauth: false, apiKey: API_KEY, systemPrompt: "  " });
  assert.deepEqual(apiSystem.json.system, [{ type: "text", text: "  " }]);
  const oauthSystem = wire({ systemPrompt: "  " });
  assert.equal(oauthSystem.json.system.length, 2);
  assert.ok(oauthSystem.json.system.every((block) => block.text !== "  "));

  // A signed thinking block is never a cache breakpoint.
  const reasoning = [{ type: "reasoning", text: "thinking hard", thinkingSignature: "sig-abc" }];
  const replay = toReplayState(reasoning, { stopReason: "stop" });
  const thinking = wire({
    systemPrompt: undefined,
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", source: { replayState: replay }, content: reasoning },
    ],
  });
  const assistant = thinking.json.messages.find((message) => message.role === "assistant");
  assert.equal(assistant.content[0].type, "thinking");
  assert.equal(assistant.content[0].cache_control, undefined);
});

test("the breakpoint layout follows the request shape", () => {
  // The common OAuth request: identity system block, last tool, the static
  // relocated prompt, and the text tail.
  const common = wire({ systemPrompt: "You are DeepSeek Harness." });
  assert.deepEqual(cacheMarkers(common.json), [
    "system[1]",
    "tools[0]",
    "messages[1].0",
    "messages[2].0",
  ]);

  // The layout shrinks with a missing tool list or prompt.
  const noTools = wire({ systemPrompt: "You are DeepSeek Harness.", tools: [] });
  assert.deepEqual(cacheMarkers(noTools.json), ["system[1]", "messages[1].0", "messages[2].0"]);
  const noPrompt = wire({ systemPrompt: undefined });
  assert.deepEqual(cacheMarkers(noPrompt.json), ["system[1]", "tools[0]", "messages[0].0"]);
  const neither = wire({ systemPrompt: undefined, tools: [] });
  assert.deepEqual(cacheMarkers(neither.json), ["system[1]", "messages[0].0"]);

  // The ack is marked once when it is also the tail: an existing marker is
  // never overwritten.
  const ackOnly = wire({ systemPrompt: "You are DeepSeek Harness.", messages: [], tools: [] });
  assert.deepEqual(cacheMarkers(ackOnly.json), ["system[1]", "messages[1].0"]);
  assert.equal(ackOnly.json.messages[1].content[0].cache_control.type, "ephemeral");
});

test("an image tail is cached on the image block", () => {
  const images = new Map([["a1", { data: "AAAA", mediaType: "image/png" }]]);
  const { json } = wire({
    systemPrompt: undefined,
    messages: [
      {
        role: "user",
        content: [{ type: "image", attachment: { attachmentId: "a1", name: "pic.png" } }],
      },
    ],
    images,
  });
  const last = json.messages.at(-1);
  assert.equal(last.content.at(-1).type, "image");
  assert.equal(last.content.at(-1).cache_control.type, "ephemeral");
});

test("cache TTL defaults to 1h on OAuth and 5m on API keys; the extended-cache beta is withheld", () => {
  const oauthControls = cacheControls(wire({ systemPrompt: "You are DeepSeek Harness." }).json);
  assert.ok(oauthControls.length > 0);
  for (const control of oauthControls) assert.deepEqual(control, { type: "ephemeral", ttl: "1h" });

  const apiControls = cacheControls(
    wire({ oauth: false, apiKey: API_KEY, systemPrompt: "You are DeepSeek Harness." }).json,
  );
  assert.ok(apiControls.length > 0);
  for (const control of apiControls) assert.deepEqual(control, { type: "ephemeral" });

  const forced5m = cacheControls(
    wire({ systemPrompt: "You are DeepSeek Harness.", cacheTtl: "5m" }).json,
  );
  for (const control of forced5m) assert.deepEqual(control, { type: "ephemeral" });

  const forced1hApi = cacheControls(
    wire({
      oauth: false,
      apiKey: API_KEY,
      systemPrompt: "You are DeepSeek Harness.",
      cacheTtl: "1h",
    }).json,
  );
  for (const control of forced1hApi) assert.deepEqual(control, { type: "ephemeral", ttl: "1h" });

  // The extended-cache-ttl beta is deliberately not added until a live
  // subscription request proves it necessary.
  for (const request of [
    wire({ systemPrompt: "You are DeepSeek Harness." }),
    wire({
      oauth: false,
      apiKey: API_KEY,
      systemPrompt: "You are DeepSeek Harness.",
      cacheTtl: "1h",
    }),
  ]) {
    assert.equal(request.betas.includes("extended-cache-ttl-2025-04-11"), false);
  }
});

/** A deep copy with every `cache_control` object removed, for prefix comparison. */
function withoutControls(value) {
  return JSON.parse(
    JSON.stringify(value, (key, item) => (key === "cache_control" ? undefined : item)),
  );
}

/** The system-prompt update a mid-session prompt change appends. */
function promptUpdate(text = "Plan mode is off. You may edit files now.") {
  return { role: "system", source: { kind: "system-prompt" }, content: [{ type: "text", text }] };
}

function assistantReply() {
  return {
    role: "assistant",
    source: { kind: "model", provider: "claude-subscription", model: "claude-opus-5-5" },
    content: [{ type: "text", text: "ok" }],
  };
}

test("a later non-empty system message is rejected on a route without the capability", () => {
  assert.throws(
    () =>
      wire({
        model: OPUS_45,
        oauth: false,
        apiKey: API_KEY,
        messages: [
          ...history(),
          { role: "system", content: [{ type: "text", text: "From now on, be terse." }] },
        ],
      }),
    (error) => error?.code === "UNSUPPORTED_CONTENT" && /claude-opus-4-5/.test(error.message),
  );
});

test("OAuth appends a changed prompt as a <system-reminder> user turn on every model", () => {
  // A model without the documented mid-conversation capability still gets the
  // OAuth win: the subscription wire never sends a `system` role.
  const { json } = wire({ model: OPUS_45, messages: [...history(), promptUpdate()] });
  const reminder = json.messages.at(-1);
  assert.equal(reminder.role, "user");
  assert.match(reminder.content[0].text, /^<system-reminder>\nPlan mode is off\./);
  assert.match(reminder.content[0].text, /<\/system-reminder>$/);
  assert.equal(json.messages.filter((message) => message.role === "system").length, 0);
});

test("a prompt change keeps the cached prefix byte-identical", () => {
  const head = { systemPrompt: "You are DeepSeek Harness.", messages: history() };
  const first = wire(head);
  const changed = wire({
    ...head,
    messages: [
      ...history(),
      assistantReply(),
      promptUpdate(),
      { role: "user", content: [{ type: "text", text: "carry on" }] },
    ],
  });
  // Earlier history, the identity system block, and the tool schemas are
  // byte-identical after the update. Only the unmarked billing header (its
  // per-request cch attestation) differs.
  assert.deepEqual(
    withoutControls(changed.json.messages.slice(0, first.json.messages.length)),
    withoutControls(first.json.messages),
  );
  assert.deepEqual(
    withoutControls(changed.json.system.slice(1)),
    withoutControls(first.json.system.slice(1)),
  );
  assert.deepEqual(withoutControls(changed.json.tools), withoutControls(first.json.tools));
  assert.notEqual(changed.json.system[0].text, first.json.system[0].text);
});

test("the appended update participates in the breakpoint budget without exceeding four", () => {
  const common = wire({
    systemPrompt: "You are DeepSeek Harness.",
    messages: [
      ...history(),
      assistantReply(),
      promptUpdate(),
      { role: "user", content: [{ type: "text", text: "carry on" }] },
    ],
  });
  assert.deepEqual(cacheMarkers(common.json), [
    "system[1]",
    "tools[0]",
    "messages[1].0",
    "messages[5].0",
  ]);

  // When the update is the last block, the tail marker lands on it.
  const tail = wire({
    systemPrompt: "You are DeepSeek Harness.",
    messages: [...history(), promptUpdate()],
  });
  assert.deepEqual(cacheMarkers(tail.json), [
    "system[1]",
    "tools[0]",
    "messages[1].0",
    "messages[3].0",
  ]);
  assert.match(tail.json.messages[3].content[0].text, /^<system-reminder>/);
});

test("the cch attestation is patched into the body bytes", () => {
  const { body } = buildAnthropicRequest(base({ systemPrompt: "You are DeepSeek Harness." }));
  const json = Buffer.from(body).toString("utf8");
  assert.match(json, /cch=[0-9a-f]{5};/);
  assert.equal(json.includes("cch=00000"), false);
  // A body varied after the fact (stop sequences) still carries the
  // attestation: patchCch hashes the final serialized bytes.
  const stopped = buildAnthropicRequest(base({ stop: ["END"] }));
  assert.match(Buffer.from(stopped.body).toString("utf8"), /cch=[0-9a-f]{5};/);
});

test("signed thinking blocks replay with their signature; unsigned ones degrade to text", () => {
  const signed = toolHistory();
  signed[1].content.splice(1, 0, {
    type: "reasoning",
    text: "thinking hard",
    thinkingSignature: "sig-abc",
  });
  const replay = toReplayState(signed[1].content, { stopReason: "stop" });
  signed[1].source.replayState = replay;

  const { json } = wire({ messages: signed });
  const assistant = json.messages.find((message) => message.role === "assistant");
  const thinking = assistant.content.find((block) => block.type === "thinking");
  assert.deepEqual(thinking, { type: "thinking", thinking: "thinking hard", signature: "sig-abc" });

  // The same reasoning block without a usable signature replays as text.
  const unsigned = signed.map((message, index) =>
    index === 1
      ? {
          ...message,
          content: message.content.map((block) =>
            block.type === "reasoning" ? { type: "reasoning", text: block.text } : block,
          ),
          source: { kind: "model", provider: "other", model: "other" },
        }
      : message,
  );
  const degraded = wire({ messages: unsigned });
  const degradedAssistant = degraded.json.messages.find((message) => message.role === "assistant");
  assert.equal(
    degradedAssistant.content.find((block) => block.type === "thinking"),
    undefined,
  );
  assert.ok(
    degradedAssistant.content.some(
      (block) => block.type === "text" && block.text === "thinking hard",
    ),
  );
});

test("replay state round-trips and rejects foreign envelopes", () => {
  const content = [
    { type: "reasoning", text: "think", thinkingSignature: "sig" },
    { type: "text", text: "answer" },
  ];
  const state = toReplayState(content, { stopReason: "stop", responseId: "msg_1" });
  assert.equal(readReplayState(state).response.responseId, "msg_1");
  assert.equal(readReplayState(state).blocks[0].thinkingSignature, "sig");
  assert.equal(readReplayState({ kind: "other", version: 1 }), undefined);
  assert.equal(readReplayState({ kind: "claude-subscription", version: 99 }), undefined);
  assert.equal(readReplayState(null), undefined);
  // A foreign adapter's state must not restore a signature.
  assert.equal(
    readReplayState({
      kind: "another-adapter",
      version: 2,
      response: {},
      blocks: [{ type: "reasoning" }],
    }),
    undefined,
  );
});

test("a foreign replay envelope never restores a signature through the wire", () => {
  const foreign = {
    kind: "another-adapter",
    version: 1,
    response: { stopReason: "stop" },
    blocks: [{ type: "reasoning", text: "thinking hard", thinkingSignature: "sig-foreign" }],
  };
  const { json } = wire({
    messages: [
      ...history(),
      {
        role: "assistant",
        source: { kind: "model", provider: "other", model: "other", replayState: foreign },
        content: [{ type: "reasoning", text: "thinking hard", thinkingSignature: "sig-foreign" }],
      },
    ],
  });
  const assistant = json.messages.find((message) => message.role === "assistant");
  assert.equal(
    assistant.content.find((block) => block.type === "thinking"),
    undefined,
    "no thinking block is minted from a foreign state",
  );
  assert.ok(
    assistant.content.some((block) => block.type === "text" && block.text === "thinking hard"),
    "the reasoning degrades to text",
  );
});

test("model-level headers may add keys but never clobber the fingerprint", () => {
  const { headers } = buildAnthropicRequest(
    base({ modelHeaders: { "X-Custom": "1", "user-agent": "evil" } }),
  );
  assert.equal(headers["X-Custom"], "1");
  assert.equal(headers["User-Agent"], coworkUserAgent);
});

// ---- API-key path ----------------------------------------------------------

test("API-key requests keep the plain Anthropic shape", () => {
  const { headers, json } = wire({
    oauth: false,
    apiKey: API_KEY,
    systemPrompt: "You are DeepSeek Harness.",
  });
  assert.equal(headers["X-Api-Key"], API_KEY);
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers["x-app"], undefined);
  assert.equal(headers["User-Agent"], undefined, "the adapter adds the attribution UA");
  assert.equal(json.max_tokens, OPUS.maxTokens, "full model ceiling");
  assert.equal(json.metadata, undefined);
  assert.equal(json.system.length, 1);
  assert.equal(json.system[0].text, "You are DeepSeek Harness.");
  assert.equal(json.tools[0].name, "bash", "tools ride along unprefixed");

  // Tool history replays unprefixed on the API path: nothing was prefixed,
  // so nothing is stripped.
  const replay = wire({ oauth: false, apiKey: API_KEY, messages: toolHistory() });
  assert.deepEqual(
    replay.json.tools.map((tool) => tool.name),
    ["bash"],
  );
  const assistant = replay.json.messages.find((message) => message.role === "assistant");
  assert.equal(assistant.content.find((block) => block.type === "tool_use").name, "bash");
  assert.equal(replay.json.messages[0].content[0].text, "list files");
});

test("extraBetas append to the beta header on both credential paths", () => {
  // Without extras the API-key header is empty, and no header is sent.
  const bare = buildAnthropicRequest(base({ oauth: false, apiKey: API_KEY }));
  assert.equal(bare.betas, "");
  assert.equal(bare.headers["anthropic-beta"], undefined);
  // OAuth: appended after the pinned Cowork profile, deduplicated.
  const oauth = buildAnthropicRequest(
    base({ extraBetas: ["experimental-thing", "effort-2025-11-24"] }),
  );
  assert.ok(oauth.betas.startsWith("claude-code-20250219"));
  assert.ok(oauth.betas.endsWith("experimental-thing"));
  assert.equal(
    oauth.betas.split(",").filter((beta) => beta === "effort-2025-11-24").length,
    1,
    "deduplicated",
  );
  // API-key: the extras are the whole header (the config documents this).
  const apiKey = buildAnthropicRequest(
    base({ oauth: false, apiKey: API_KEY, extraBetas: ["experimental-thing"] }),
  );
  assert.equal(apiKey.betas, "experimental-thing");
  assert.equal(apiKey.headers["anthropic-beta"], "experimental-thing");
});

// ---- history handling ------------------------------------------------------

test("splitSystemPrompt prefers options.system and folds a leading system message", () => {
  const options = {
    system: "explicit",
    messages: [{ role: "system", content: [{ type: "text", text: "leading" }] }],
  };
  assert.deepEqual(splitSystemPrompt(options), { systemPrompt: "explicit", messages: [] });
  const folded = splitSystemPrompt({
    messages: [
      {
        role: "system",
        content: [
          { type: "text", text: "leading" },
          { type: "text", text: " prompt" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ],
  });
  assert.equal(folded.systemPrompt, "leading prompt");
  assert.equal(folded.messages.length, 1);
});

test("catalog specs map to complete harness metadata", () => {
  const LADDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  for (const model of [OPUS, OPUS_45, OPUS_46, FABLE, HAIKU]) {
    const info = toHarnessModel("claude-subscription", model);
    assert.equal(info.provider, "claude-subscription");
    assert.ok(info.context.contextWindow > 0);
    assert.ok(info.defaultMaxTokens > 0 && info.defaultMaxTokens <= 64000);
    assert.deepEqual(info.inputModalities, ["text", "image"]);
    if (info.reasoning) {
      assert.ok(info.reasoning.efforts.length > 0);
      for (const effort of info.reasoning.efforts) {
        assert.match(effort.id, /^(?:off|minimal|low|medium|high|xhigh|max)$/);
      }
      // dsh-llm 0.2.1 pins the efforts order to the escalation ladder
      // (least → greatest selectable reasoning effort). The model-selection
      // UI reads efforts[0] as the least effort.
      const ids = info.reasoning.efforts.map((effort) => effort.id);
      assert.deepEqual(
        [...ids].sort((a, b) => LADDER.indexOf(a) - LADDER.indexOf(b)),
        ids,
        `${model.id}: efforts must follow the escalation ladder`,
      );
      // The harness resolves an unset caller preference to defaultEffort and
      // refuses undeclared levels, so it must be one of the declared ones.
      assert.ok(
        info.reasoning.efforts.some((effort) => effort.id === info.reasoning.defaultEffort),
        `${model.id}: defaultEffort must be declared`,
      );
    }
  }
  // Adaptive models hide "off" (Fable always thinks). Budget models offer it.
  const fable = toHarnessModel("claude-subscription", FABLE);
  assert.ok(!fable.reasoning.efforts.some((effort) => effort.id === "off"));
  assert.equal(fable.reasoning.defaultEffort, "high");
  assert.ok(fable.reasoning.efforts.some((effort) => effort.id === "xhigh"));
  const haiku = toHarnessModel("claude-subscription", HAIKU);
  assert.ok(haiku.reasoning.efforts.some((effort) => effort.id === "off"));

  // The same invariant on the saved-list path: a bare row inherits the
  // reading's default effort.
  for (const bare of resolveCatalog([{ id: "claude-opus-5-5" }], [OPUS])) {
    const info = toHarnessModel("claude-subscription", bare);
    assert.ok(info.reasoning.efforts.some((effort) => effort.id === info.reasoning.defaultEffort));
  }
});

// ---- text sanitization ------------------------------------------------------

test("text is sanitized without damaging valid text: non-BMP survives, lone surrogates are replaced", () => {
  // Non-BMP text survives on both credential paths.
  for (const oauth of [true, false]) {
    const { json } = wire({
      oauth,
      apiKey: oauth ? OAUTH_KEY : API_KEY,
      systemPrompt: "You are 🎉 DeepSeek Harness.",
      messages: [
        { role: "user", content: [{ type: "text", text: "hello 🎉 world" }] },
        { role: "assistant", content: [{ type: "text", text: "hi 🧑 there" }] },
      ],
    });
    const serialized = JSON.stringify(json);
    assert.ok(
      serialized.includes("🎉"),
      `emoji survives on the ${oauth ? "OAuth" : "API-key"} path`,
    );
    assert.equal(serialized.includes("\uFFFD\uFFFD"), false, "no doubled replacement characters");
  }

  // Lone surrogates become one U+FFFD each. A valid pair rides through as 🎉.
  const { json } = wire({
    messages: [{ role: "user", content: [{ type: "text", text: "\uD800ok🎉\uDC00" }] }],
  });
  assert.equal(json.messages.at(-1).content[0].text, "\uFFFDok🎉\uFFFD");

  // Attachment labels are user-visible strings too.
  const images = new Map([["att-1", { data: "aGk=", mediaType: "image/png" }]]);
  const labelled = wire({
    images,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", attachment: { attachmentId: "att-1", name: "report \uD800 final.png" } },
        ],
      },
    ],
  });
  const serialized = JSON.stringify(labelled.json);
  assert.ok(
    serialized.includes("report \uFFFD final.png"),
    "the label carries the replacement character",
  );
  assert.equal(serialized.includes("\\ud800"), false, "no lone-surrogate escape reaches the body");
});

// ---- thinking vs output caps ------------------------------------------------

test("a thinking request needs room for its budget; a tiny cap fails fast or clamps", () => {
  for (const maxTokens of [512, 1024]) {
    assert.throws(
      () => buildAnthropicRequest(base({ model: OPUS_45, reasoning: "high", maxTokens })),
      /no room for thinking/,
    );
    assert.throws(
      () =>
        buildAnthropicRequest(
          base({ model: OPUS_45, reasoning: "high", maxTokens, oauth: false, apiKey: API_KEY }),
        ),
      /no room for thinking/,
    );
  }

  // The smallest workable cap clamps the budget below max_tokens.
  const smallest = wire({ model: OPUS_45, reasoning: "high", maxTokens: 1025 });
  assert.equal(smallest.json.thinking.budget_tokens, 1024);
  assert.ok(smallest.json.thinking.budget_tokens < smallest.json.max_tokens);

  // Adaptive models and an explicit "off" never need a budget, so a tiny cap
  // is not an error for them.
  const adaptive = wire({ reasoning: "high", maxTokens: 512 });
  assert.deepEqual(adaptive.json.thinking, { type: "adaptive", display: "summarized" });
  const off = wire({ model: OPUS_45, reasoning: "off", maxTokens: 512 });
  assert.equal(off.json.thinking, undefined);
});

// ---- stop sequences ---------------------------------------------------------

test("stop sequences map to stop_sequences on both paths; an absent or empty list emits none", () => {
  for (const oauth of [true, false]) {
    const { json } = wire({ oauth, apiKey: oauth ? OAUTH_KEY : API_KEY, stop: ["END", "STOP"] });
    assert.deepEqual(json.stop_sequences, ["END", "STOP"]);
  }
  assert.equal(wire().json.stop_sequences, undefined);
  assert.equal(wire({ stop: [] }).json.stop_sequences, undefined);
});
