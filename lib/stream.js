/**
 * Anthropic Messages SSE -> harness StreamChunks: block-start / text-delta /
 * reasoning-delta / tool-call-delta / block-end / usage / finish, the chunk
 * vocabulary `@deepseek-ai/dsh-llm` assembles.
 *
 * @module @apcamargo/dsh-claude-subscription/stream
 */

import { CONTEXT_WINDOW_EXCEEDED_CODE, QUOTA_EXCEEDED_CODE } from "@deepseek-ai/dsh-llm";
import { stripClaudeToolPrefix } from "./fingerprint.js";
import { toReplayState } from "./wire.js";

async function* iterateSse(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);

        if (line === "") {
          eventName = "";
          continue;
        }
        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
          continue;
        }
        if (line.startsWith("data:")) {
          const raw = line.slice(5).trim();
          if (!raw || raw === "[DONE]") continue;
          let data;
          try {
            data = JSON.parse(raw);
          } catch {
            // Non-JSON data lines (keep-alive padding, proxy junk) are dropped.
            // A genuinely truncated stream still fails below via the
            // missing-stop-reason check.
            continue;
          }
          yield { event: eventName, data };
        }
      }
    }
  } finally {
    // Release the connection when the consumer stops early. cancel() resolves a
    // pending read with {done: true}, so this is safe mid-read.
    reader.cancel().catch(() => {});
  }
}

/**
 * Map an Anthropic stop_reason onto the harness finish vocabulary.
 * @param {string | null | undefined} reason
 * @returns {"stop" | "max-tokens" | "tool-calls" | "error"}
 */
export function mapStopReason(reason) {
  switch (reason) {
    case "end_turn":
    case "pause_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "max-tokens";
    case "tool_use":
      return "tool-calls";
    default:
      return "error";
  }
}

/**
 * Treat a Retry-After of 15 minutes or more as a spent account allowance, not
 * a brief throttle.
 * @type {number}
 */
const RETRY_AFTER_QUOTA_MIN_MS = 15 * 60_000;

/**
 * Return `Retry-After` in milliseconds, whether it is delay-seconds or an HTTP
 * date. Invalid and non-positive values return undefined.
 * @param {string | null | undefined} value - the raw header value.
 * @returns {number | undefined} milliseconds, or undefined when unparsable.
 */
export function parseRetryAfterMs(value) {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds)) {
    const ms = Math.round(seconds * 1000);
    return ms > 0 ? ms : undefined;
  }
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  const remaining = at - Date.now();
  return remaining > 0 ? remaining : undefined;
}

/**
 * Match the OAuth account-limit message. Retry-After tells a spent allowance
 * from a brief throttle.
 * @param {string} text - response or stream error text.
 * @returns {boolean}
 */
function isAccountAllowance429(text) {
  return /exceed your account's rate limit/i.test(text);
}

/**
 * Map one Anthropic failure onto the harness error taxonomy. The context-window
 * code is what consumers compact on. The quota code is the harness's canonical
 * terminal quota signal (not part of the default retryable set: retrying quota
 * exhaustion is the retry executor's job). An account's allowance 429 is
 * terminal only with a long Retry-After; short throttles stay RATE_LIMIT.
 * @param {number} status - HTTP status of the failed response, when any.
 * @param {string} text - response or stream error text.
 * @param {{ retryAfterMs?: number }} [options] - the parsed Retry-After header.
 * @returns {string} an LlmError code.
 */
export function classifyError(status, text, { retryAfterMs } = {}) {
  if (
    /prompt is too long|input length and `max_tokens` exceed context limit|request too large/i.test(
      text,
    )
  ) {
    return "CONTEXT_WINDOW_EXCEEDED";
  }
  if (
    /\bout of extra usage|usage limit|credit balance is too low|billing/i.test(text) ||
    (isAccountAllowance429(text) &&
      typeof retryAfterMs === "number" &&
      retryAfterMs >= RETRY_AFTER_QUOTA_MIN_MS)
  ) {
    return QUOTA_EXCEEDED_CODE;
  }
  if (status === 401 || status === 403 || /\b(?:401|403)\b/.test(text)) return "AUTH";
  if (status === 429 || /\b429\b|rate.?limit/i.test(text)) return "RATE_LIMIT";
  if (status === 413 || /\b413\b|payload too large|request body too large/i.test(text))
    return "INVALID_REQUEST";
  if (status === 400 || /\b400\b|invalid.?request/i.test(text)) return "INVALID_REQUEST";
  if (status !== undefined && status >= 500) return "SERVER";
  if (/\btime(?:d)?\s*out\b|timeout/i.test(text)) return "TIMEOUT";
  if (
    /\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(text) ||
    /\b(?:other side closed|terminated)\b|premature close/i.test(text)
  ) {
    return "TRANSPORT";
  }
  return "PROVIDER_ERROR";
}

/**
 * Map an in-band Anthropic error event onto the harness taxonomy. "Overloaded"
 * matches no classifyError wording, so the error.type drives the code. A
 * mid-stream overload must stay retryable exactly like an HTTP 529.
 * @param {string | undefined} type - the Anthropic error `type`.
 * @returns {string} an LlmError code.
 */
function inBandErrorCode(type) {
  switch (type) {
    case "overloaded_error":
      return "SERVER";
    case "rate_limit_error":
      return "RATE_LIMIT";
    case "timeout_error":
      return "TIMEOUT";
    default:
      return "PROVIDER_ERROR";
  }
}

/**
 * Read one Anthropic event stream and yield harness chunks, ending with `usage`
 * then `finish`. Throws the `failure` builder's errors (LlmError shaped, with a
 * `code`) for stream failures. Successful finishes carry a `replayState`
 * envelope (minted by {@link toReplayState}) so signed thinking blocks survive
 * replay. Failure finishes never do.
 * @param {ReadableStream<Uint8Array>} body - the response body stream.
 * @param {(code: string, message: string) => Error} failure - builds the thrown error type.
 * @param {object} [options]
 * @param {boolean} [options.stripToolPrefix] - strip the Cowork `_` tool prefix from
 *   incoming tool names. Must mirror the outgoing request: the OAuth path prefixes
 *   tool definitions, so the names come back prefixed. The API-key path never
 *   prefixes and must not strip.
 * @returns {AsyncGenerator<object>} harness chunks.
 */
export async function* anthropicToChunks(body, failure, { stripToolPrefix = false } = {}) {
  const blocks = new Map();
  /** Completed harness blocks, in emission order. The replayState source. */
  const emitted = [];
  let stopReason;
  /** The provider's `stop_details.explanation`, for reasons we don't map. */
  let stopExplanation;
  let responseId;
  let responseModel;
  let usage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

  for await (const { data: event } of iterateSse(body)) {
    if (event.type === "message_start") {
      const wire = event.message?.usage ?? {};
      responseId = event.message?.id;
      responseModel = event.message?.model;
      usage = {
        inputTokens: wire.input_tokens || 0,
        outputTokens: wire.output_tokens || 0,
        cacheReadTokens: wire.cache_read_input_tokens || 0,
        cacheWriteTokens: wire.cache_creation_input_tokens || 0,
        totalTokens:
          (wire.input_tokens || 0) +
          (wire.output_tokens || 0) +
          (wire.cache_read_input_tokens || 0) +
          (wire.cache_creation_input_tokens || 0),
      };
    } else if (event.type === "content_block_start") {
      const block = event.content_block;
      if (block.type === "text") {
        blocks.set(event.index, { kind: "text", text: "" });
        yield { type: "block-start", index: event.index, blockType: "text" };
      } else if (block.type === "thinking" || block.type === "redacted_thinking") {
        blocks.set(event.index, {
          kind: "reasoning",
          text: "",
          signature: "",
          redacted: block.type === "redacted_thinking",
        });
        yield { type: "block-start", index: event.index, blockType: "reasoning" };
      } else if (block.type === "tool_use") {
        blocks.set(event.index, {
          kind: "tool-call",
          id: block.id,
          // The wire name carries the Cowork `_` prefix on the OAuth path;
          // the harness knows the tool by its unprefixed name.
          name: stripToolPrefix ? stripClaudeToolPrefix(block.name) : block.name,
          partialJson: "",
        });
        yield { type: "block-start", index: event.index, blockType: "tool-call" };
      }
    } else if (event.type === "content_block_delta") {
      const block = blocks.get(event.index);
      if (block === undefined) continue;
      const delta = event.delta;

      if (delta.type === "text_delta" && block.kind === "text") {
        block.text += delta.text;
        yield { type: "text-delta", index: event.index, text: delta.text };
      } else if (delta.type === "thinking_delta" && block.kind === "reasoning") {
        block.text += delta.thinking;
        yield { type: "reasoning-delta", index: event.index, text: delta.thinking };
      } else if (delta.type === "signature_delta" && block.kind === "reasoning") {
        block.signature = (block.signature ?? "") + delta.signature;
      } else if (delta.type === "input_json_delta" && block.kind === "tool-call") {
        block.partialJson += delta.partial_json;
        yield {
          type: "tool-call-delta",
          index: event.index,
          id: block.id,
          name: block.name,
          argumentsDelta: delta.partial_json,
        };
      }
    } else if (event.type === "content_block_stop") {
      const block = blocks.get(event.index);
      if (block === undefined) continue;

      if (block.kind === "text") {
        const finished = { type: "text", text: block.text };
        emitted.push(finished);
        yield { type: "block-end", index: event.index, block: finished };
      } else if (block.kind === "reasoning") {
        const finished = {
          type: "reasoning",
          text: block.text,
          ...(block.redacted === true ? { redacted: true } : {}),
          ...(block.signature ? { thinkingSignature: block.signature } : {}),
        };
        emitted.push(finished);
        yield { type: "block-end", index: event.index, block: finished };
      } else if (block.kind === "tool-call") {
        let argumentsText = block.partialJson;
        try {
          // Validate the accumulated arguments: a truncated tail or malformed
          // JSON degrades to an empty object (wire.js does the same on replay).
          JSON.parse(argumentsText);
        } catch {
          argumentsText = JSON.stringify({});
        }
        const finished = {
          type: "tool-call",
          id: block.id,
          name: block.name,
          arguments: argumentsText,
        };
        emitted.push(finished);
        yield { type: "block-end", index: event.index, block: finished };
      }
    } else if (event.type === "message_delta") {
      if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
      if (event.delta?.stop_details?.explanation)
        stopExplanation = event.delta.stop_details.explanation;
      if (event.usage?.output_tokens) {
        usage.outputTokens = event.usage.output_tokens;
        usage.totalTokens =
          usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
      }
    } else if (event.type === "error") {
      throw failure(
        inBandErrorCode(event.error?.type),
        event.error?.message ?? "Anthropic stream error",
      );
    } else if (event.type === "message_stop") {
      break;
    }
  }

  const visible = [...blocks.values()].some((block) =>
    block.kind === "text"
      ? block.text.length > 0
      : block.kind === "tool-call" || block.text.length > 0,
  );
  if (stopReason === undefined) {
    throw failure("TRANSPORT", "Anthropic stream ended without a stop reason");
  }
  const mapped = mapStopReason(stopReason);
  if (mapped === "stop" && !visible) {
    throw failure("EMPTY_RESPONSE", "Anthropic returned a completed response with no content");
  }

  yield {
    type: "usage",
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      ...(usage.cacheReadTokens > 0 ? { cacheReadTokens: usage.cacheReadTokens } : {}),
      ...(usage.cacheWriteTokens > 0 ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
    },
  };
  if (mapped === "error") {
    // Context-window exhaustion must compact rather than dead-end; every other
    // unrecognised reason stays a generic provider failure. Neither carries
    // replay state, because the response did not complete successfully.
    const code =
      stopReason === "model_context_window_exceeded"
        ? CONTEXT_WINDOW_EXCEEDED_CODE
        : "PROVIDER_ERROR";
    yield {
      type: "finish",
      reason: {
        kind: "error",
        failure: {
          message: `Anthropic stop_reason "${stopReason}" is not recognised${stopExplanation ? ` — ${stopExplanation}` : ""}`,
          code,
        },
      },
    };
    return;
  }
  yield {
    type: "finish",
    reason: { kind: mapped },
    replayState: toReplayState(emitted, { stopReason, responseId, responseModel }),
  };
}
