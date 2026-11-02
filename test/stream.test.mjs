/**
 * Anthropic SSE -> harness chunk mapping, driven by in-memory event streams
 * (no network, no credentials).
 * @module test/stream.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";
import { anthropicToChunks, classifyError, mapStopReason } from "../lib/stream.js";

/** Build a ReadableStream from SSE `event:`/`data:` frames. */
function sseResponse(frames) {
  const payload = frames
    .map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`)
    .join("");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  });
}

/** The failure builder the adapter passes (LlmError-shaped). */
const failure = (code, message) => Object.assign(new Error(message), { code });

async function collect(frames) {
  const chunks = [];
  for await (const chunk of anthropicToChunks(sseResponse(frames), failure)) chunks.push(chunk);
  return chunks;
}

test("a text turn maps onto the block vocabulary with usage and finish", async () => {
  const chunks = await collect([
    { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 5 },
    },
    { type: "message_stop" },
  ]);
  assert.deepEqual(chunks, [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: "Hel" },
    { type: "text-delta", index: 0, text: "lo" },
    { type: "block-end", index: 0, block: { type: "text", text: "Hello" } },
    { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
    {
      type: "finish",
      reason: { kind: "stop" },
      replayState: {
        kind: "claude-subscription",
        version: 1,
        response: { stopReason: "end_turn" },
        blocks: [{ type: "text" }],
      },
    },
  ]);
});

test("thinking blocks carry deltas, end with the signature, and feed replay state", async () => {
  const chunks = await collect([
    {
      type: "message_start",
      message: {
        id: "msg_1",
        model: "claude-opus-5-5",
        usage: { input_tokens: 3, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hi" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "message_stop" },
  ]);
  assert.deepEqual(chunks[0], { type: "block-start", index: 0, blockType: "reasoning" });
  assert.deepEqual(chunks[1], { type: "reasoning-delta", index: 0, text: "hmm" });
  assert.deepEqual(chunks[2], {
    type: "block-end",
    index: 0,
    block: { type: "reasoning", text: "hmm", thinkingSignature: "SIG" },
  });
  assert.equal(chunks.at(-1).reason.kind, "stop");
  assert.deepEqual(chunks.at(-1).replayState, {
    kind: "claude-subscription",
    version: 1,
    response: { stopReason: "end_turn", responseId: "msg_1", responseModel: "claude-opus-5-5" },
    blocks: [{ type: "reasoning", thinkingSignature: "SIG" }, { type: "text" }],
  });
});

test("tool calls stream argument deltas and end with a raw-JSON block", async () => {
  const chunks = await collect([
    { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_1", name: "bash" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"comm' },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: 'and":"ls"}' },
    },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" } },
    { type: "message_stop" },
  ]);
  assert.deepEqual(chunks[0], { type: "block-start", index: 0, blockType: "tool-call" });
  assert.deepEqual(chunks[1], {
    type: "tool-call-delta",
    index: 0,
    id: "toolu_1",
    name: "bash",
    argumentsDelta: '{"comm',
  });
  assert.deepEqual(chunks[2], {
    type: "tool-call-delta",
    index: 0,
    id: "toolu_1",
    name: "bash",
    argumentsDelta: 'and":"ls"}',
  });
  assert.deepEqual(chunks[3], {
    type: "block-end",
    index: 0,
    block: { type: "tool-call", id: "toolu_1", name: "bash", arguments: '{"command":"ls"}' },
  });
  assert.equal(chunks.at(-1).reason.kind, "tool-calls");

  // A truncated argument tail degrades to an empty object instead of failing
  // the whole turn.
  const truncated = await collect([
    { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_1", name: "bash" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"comm' },
    },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" } },
    { type: "message_stop" },
  ]);
  assert.deepEqual(truncated.find((chunk) => chunk.type === "block-end").block.arguments, "{}");
});

test("a stream that ends without a reply (no content) or without a stop reason fails", async () => {
  await assert.rejects(
    collect([
      { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      { type: "message_stop" },
    ]),
    (error) => error.code === "EMPTY_RESPONSE",
  );
  await assert.rejects(
    collect([
      { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      { type: "content_block_stop", index: 0 },
    ]),
    (error) => error.code === "TRANSPORT",
  );
});

test("cache reads and writes surface on usage when non-zero", async () => {
  const chunks = await collect([
    {
      type: "message_start",
      message: {
        usage: {
          input_tokens: 100,
          output_tokens: 0,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 20,
        },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "message_stop" },
  ]);
  assert.deepEqual(chunks.at(-2).usage, {
    inputTokens: 100,
    outputTokens: 0,
    totalTokens: 170,
    cacheReadTokens: 50,
    cacheWriteTokens: 20,
  });
});

test("incoming tool names carry the Cowork prefix only when stripping is off", async () => {
  const frames = [
    { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_1", name: "_bash" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' },
    },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" } },
    { type: "message_stop" },
  ];

  // Subscription path: the request prefixed the tool definitions, so the
  // incoming `_bash` must be stripped back to the harness's `bash`.
  const stripped = [];
  for await (const chunk of anthropicToChunks(sseResponse(frames), failure, {
    stripToolPrefix: true,
  })) {
    stripped.push(chunk);
  }
  const end = stripped.find((chunk) => chunk.type === "block-end");
  assert.equal(end.block.name, "bash");
  const delta = stripped.find((chunk) => chunk.type === "tool-call-delta");
  assert.equal(delta.name, "bash");

  // API-key path: no prefix was applied, so the name must pass through.
  const passthrough = [];
  for await (const chunk of anthropicToChunks(sseResponse(frames), failure)) {
    passthrough.push(chunk);
  }
  assert.equal(passthrough.find((c) => c.type === "block-end").block.name, "_bash");
});

test("the provider vocabulary maps to harness stop reasons and failure codes", () => {
  // Stop reasons.
  assert.equal(mapStopReason("end_turn"), "stop");
  assert.equal(mapStopReason("pause_turn"), "stop");
  assert.equal(mapStopReason("stop_sequence"), "stop");
  assert.equal(mapStopReason("max_tokens"), "max-tokens");
  assert.equal(mapStopReason("tool_use"), "tool-calls");
  assert.equal(mapStopReason("model_context_window_exceeded"), "error");
  assert.equal(mapStopReason(undefined), "error");

  // Failure classification, by status and by stable text.
  assert.equal(
    classifyError(400, "prompt is too long: 200000 tokens > 100000 maximum"),
    "CONTEXT_WINDOW_EXCEEDED",
  );
  assert.equal(
    classifyError(400, "You're out of extra usage. Add more at claude.ai/settings/usage"),
    "QUOTA",
  );
  assert.equal(classifyError(401, "invalid x-api-key"), "AUTH");
  assert.equal(classifyError(403, "permission denied"), "AUTH");
  assert.equal(classifyError(429, "rate limit exceeded"), "RATE_LIMIT");
  assert.equal(classifyError(400, "max_tokens: field required"), "INVALID_REQUEST");
  assert.equal(classifyError(500, "internal server error"), "SERVER");
  assert.equal(classifyError(undefined, "fetch failed"), "TRANSPORT");
  assert.equal(classifyError(undefined, "TypeError: terminated"), "TRANSPORT");
  assert.equal(classifyError(undefined, "something odd"), "PROVIDER_ERROR");
});

test("an unrecognized stop reason fails without replay state; context-window exhaustion compacts", async () => {
  const failed = await collect([
    {
      type: "message_start",
      message: { id: "msg_1", model: "claude-x", usage: { input_tokens: 1, output_tokens: 0 } },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "model_context_window_exceeded" } },
    { type: "message_stop" },
  ]);
  assert.equal(failed.at(-1).reason.kind, "error");
  assert.equal(failed.at(-1).reason.failure.code, "CONTEXT_WINDOW_EXCEEDED");
  assert.equal(failed.at(-1).replayState, undefined);
});

test("in-band error events classify by their Anthropic error type", async () => {
  for (const [errorType, code] of [
    ["overloaded_error", "SERVER"],
    ["rate_limit_error", "RATE_LIMIT"],
    ["timeout_error", "TIMEOUT"],
    ["api_error", "PROVIDER_ERROR"],
    // A typeless error event takes the default branch (PROVIDER_ERROR).
    [undefined, "PROVIDER_ERROR"],
  ]) {
    await assert.rejects(
      collect([
        { type: "message_start", message: { usage: {} } },
        { type: "error", error: { type: errorType, message: "boom" } },
      ]),
      (error) => error.code === code,
    );
  }
  // The provider's message rides through with the classification.
  await assert.rejects(
    collect([
      { type: "message_start", message: { usage: {} } },
      { type: "error", error: { message: "overloaded" } },
    ]),
    (error) => error.code === "PROVIDER_ERROR" && /overloaded/.test(error.message),
  );
});

test("the replay envelope aligns with the real harness assembler", async () => {
  const { BlockAssembler } = await import("@deepseek-ai/dsh-llm");
  const chunks = await collect([
    {
      type: "message_start",
      message: {
        id: "msg_1",
        model: "claude-opus-5-5",
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hi" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "message_stop" },
  ]);
  const assembler = new BlockAssembler();
  for (const chunk of chunks) assembler.push(chunk);
  const envelope = assembler.replayState;
  assert.ok(envelope, "the assembler kept the finish chunk's replay state");
  assert.equal(envelope.blocks.length, assembler.blocks().length);
  assert.equal(envelope.blocks[0].thinkingSignature, "SIG");
});

test("stopping early cancels the body reader", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          [
            `event: message_start`,
            `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } })}`,
            ``,
            `event: content_block_start`,
            `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } })}`,
            ``,
          ].join("\n"),
        ),
      );
      // Never closed: only an explicit consumer stop can end the stream.
    },
    cancel() {
      cancelled = true;
    },
  });
  const chunks = [];
  for await (const chunk of anthropicToChunks(body, failure)) {
    chunks.push(chunk);
    if (chunks.length === 1) break; // the consumer abandons the stream
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(cancelled, true, "reader.cancel ran on early return");
});

test("stop_details explanations surface in unrecognized-stop failures", async () => {
  const chunks = await collect([
    {
      type: "message_start",
      message: { id: "msg_1", model: "claude-x", usage: { input_tokens: 1, output_tokens: 0 } },
    },
    {
      type: "message_delta",
      delta: {
        stop_reason: "refusal",
        stop_details: { explanation: "Blocked for policy reasons." },
      },
    },
    { type: "message_stop" },
  ]);
  const finish = chunks.at(-1);
  assert.equal(finish.reason.kind, "error");
  assert.equal(finish.reason.failure.code, "PROVIDER_ERROR");
  assert.equal(
    finish.reason.failure.message,
    'Anthropic stop_reason "refusal" is not recognised — Blocked for policy reasons.',
  );
  assert.equal(finish.replayState, undefined, "failed finishes never carry replay state");

  // A recognized stop has no failure message to carry the explanation.
  const ok = await collect([
    { type: "message_start", message: { usage: {} } },
    { type: "content_block_start", index: 0, content_block: { type: "text" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_details: { explanation: "ignored" } },
    },
    { type: "message_stop" },
  ]);
  assert.equal(ok.at(-1).reason.kind, "stop");
});

/**
 * A body that yields a full SSE transcript, then errors on the next pull: a
 * connection dying right after a completed reply (upstream #37).
 */
function sseErroringAfter(frames) {
  const payload = frames
    .map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`)
    .join("");
  let controller;
  return new ReadableStream({
    start(c) {
      controller = c;
      controller.enqueue(new TextEncoder().encode(payload));
    },
    pull() {
      controller.error(new Error("connection reset after message_stop"));
    },
  });
}

const COMPLETED = [
  {
    type: "message_start",
    message: { id: "msg_1", model: "claude-x", usage: { input_tokens: 3, output_tokens: 0 } },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
  { type: "message_stop" },
];

test("a body error after message_stop completes the reply; one before message_stop still fails", async () => {
  const chunks = [];
  for await (const chunk of anthropicToChunks(sseErroringAfter(COMPLETED), failure))
    chunks.push(chunk);
  assert.equal(chunks.at(-2).type, "usage");
  // Zero-valued cache fields are omitted from the usage chunk.
  assert.deepEqual(chunks.at(-2).usage, { inputTokens: 3, outputTokens: 2, totalTokens: 5 });
  assert.equal(chunks.at(-1).reason.kind, "stop");
  assert.equal(chunks.at(-1).replayState.response.stopReason, "end_turn");

  await assert.rejects(
    (async () => {
      for await (const chunk of anthropicToChunks(
        sseErroringAfter(COMPLETED.slice(0, -1)),
        failure,
      )) {
        // Drain. The body error must surface.
      }
    })(),
    /connection reset/,
  );
});
