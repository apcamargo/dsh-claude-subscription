/**
 * Harness request history -> Anthropic Messages wire request.
 *
 * OAuth (subscription) requests diverge from a plain Messages request. Each
 * behaviour below was measured on a live subscription credential:
 *
 *   1. `max_tokens` clamped to 64k
 *   2. Cowork user-agent `claude-cli/2.1.322 (external, claude-desktop)`
 *   3. Cowork system identity block
 *   4. Billing header + `cch` attestation as system[0]
 *   5. Tools prefixed with `_` instead of renamed to Read/Write/Bash/...
 *   6. Full X-Stainless-* header set, x-client-request-id, keep-alive
 *   7. The harness system prompt relocated into a leading `<system-reminder>`
 *      user turn (a `system` block would bill against extra-usage credits,
 *      surfacing as a 400 "You're out of extra usage")
 *   8. `metadata.user_id` cloaking
 *   9. A mid-session prompt change is APPENDED (in-history) instead of rewritten
 *      at the head (see convertMessages), keeping the cached prefix intact.
 *
 * The API-key path keeps the plain shape: prompt in `system`, full `max_tokens`
 * ceiling, unprefixed tools.
 *
 * Prompt caching is a separate layer: user turns are always block arrays so the
 * tail can carry `cache_control`, at most four breakpoints (see below).
 *
 * @module @apcamargo/dsh-claude-subscription/wire
 */

import { LlmError } from "@deepseek-ai/dsh-llm";
import {
  CLAUDE_CODE_MAX_OUTPUT_TOKENS,
  applyClaudeToolPrefix,
  buildBetaHeader,
  buildCoworkBetas,
  claudeCodeSystemInstruction,
  coworkHeaders,
  coworkUserAgent,
  createClaudeBillingHeader,
  generateClaudeCloakingUserId,
  patchCch,
  stripClaudeToolPrefix,
} from "./fingerprint.js";

const ANTHROPIC_VERSION = "2023-06-01";

/** Headers this provider owns: model-level headers may add keys but never
 * override these, or the Cowork fingerprint breaks. */
const ENFORCED_HEADER_KEYS = new Set(
  [
    ...Object.keys(coworkHeaders),
    "Accept",
    "Accept-Encoding",
    "Connection",
    "Content-Type",
    "anthropic-version",
    "anthropic-dangerous-direct-browser-access",
    "anthropic-beta",
    "User-Agent",
    "x-app",
    "Authorization",
    "X-Api-Key",
    "x-client-request-id",
  ].map((k) => k.toLowerCase()),
);

/** @param {string} apiKey @returns {boolean} */
export function isOAuthToken(apiKey) {
  return apiKey.includes("sk-ant-oat");
}

/** Replace lone surrogates, preserving valid pairs: JSON.stringify emits an
 * invalid `\udXXX` escape for a lone surrogate, which strict server parsers
 * reject. `toWellFormed` is a pair-aware no-op on well-formed text. */
function sanitizeSurrogates(text) {
  return text.toWellFormed();
}

/** Tool-call ids replayed from a history another provider generated must match
 * Anthropic's `^[a-zA-Z0-9_-]+$`. Deterministic per input, so a toolCall id and
 * its toolResult id still line up. */
function sanitizeToolId(id) {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned || "_";
}

function normalizeImageMediaType(mimeType) {
  const normalized = mimeType.trim().toLowerCase();
  if (normalized === "image/jpg") return "image/jpeg";
  if (["image/jpeg", "image/png", "image/gif", "image/webp"].includes(normalized)) {
    return normalized;
  }
  return "image/png";
}

/** The first non-empty text of a harness user message, for the billing fingerprint. */
function firstUserText(messages) {
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const block of message.content) {
      if (block.type === "text" && block.text) return block.text;
    }
  }
  return "";
}

/** Fold the request-level system prompt out of the history: an explicit
 * `options.system` wins, else a leading `system` message supplies it.
 * @param {{ system?: string, messages: object[] }} options
 * @returns {{ systemPrompt: string | undefined, messages: object[] }}
 */
export function splitSystemPrompt(options) {
  if (options.system !== undefined) {
    const [first, ...rest] = options.messages;
    return {
      systemPrompt: options.system,
      messages: first?.role === "system" ? rest : options.messages,
    };
  }
  const [first, ...rest] = options.messages;
  if (first?.role !== "system") return { systemPrompt: undefined, messages: options.messages };
  const text =
    typeof first.content === "string"
      ? first.content
      : first.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("");
  return { systemPrompt: text.length > 0 ? text : undefined, messages: rest };
}

/** Reject history this provider cannot represent. @param {object[]} messages */
export function assertSupportedHistory(messages) {
  for (const message of messages) {
    if (message.role === "developer") {
      throw new TypeError("claude-subscription: developer messages are not supported yet");
    }
    if (
      message.content.some(
        (block) => block.type === "tool-addition" || block.type === "tool-removal",
      )
    ) {
      throw new TypeError("claude-subscription: tool-change blocks require developer role");
    }
    if (
      message.role !== "user" &&
      message.role !== "tool" &&
      message.content.some((block) => block.type === "image")
    ) {
      throw new TypeError(
        `claude-subscription: cannot represent an image in an in-history ${message.role} message`,
      );
    }
  }
}

/** Read this adapter's replay envelope back, or `undefined` when the state is
 * not ours to use (another adapter's, another version, malformed).
 * @param {unknown} raw - `assistant.source.replayState`.
 * @returns {{ response: object, blocks: object[] } | undefined}
 */
export function readReplayState(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const envelope = raw;
  if (envelope["kind"] !== "claude-subscription" || envelope["version"] !== 1) return undefined;
  const response = envelope["response"];
  const blocks = envelope["blocks"];
  if (typeof response !== "object" || response === null || !Array.isArray(blocks)) return undefined;
  return { response, blocks };
}

/** This adapter's durable replay state for one completed turn: only the
 * provider-native metadata that restores wire fidelity (thinking signatures,
 * the redacted flag), index-aligned with the content blocks.
 * @param {object[]} content - the finished harness content blocks.
 * @param {{ stopReason: string, responseId?: string, responseModel?: string }} response
 * @returns {object}
 */
export function toReplayState(content, response) {
  return {
    kind: "claude-subscription",
    version: 1,
    response: {
      stopReason: response.stopReason,
      ...(response.responseId === undefined ? {} : { responseId: response.responseId }),
      ...(response.responseModel === undefined ? {} : { responseModel: response.responseModel }),
    },
    blocks: content.map((block) => {
      switch (block.type) {
        case "text":
          return { type: "text" };
        case "reasoning":
          return {
            type: "reasoning",
            ...(block.thinkingSignature ? { thinkingSignature: block.thinkingSignature } : {}),
            ...(block.redacted === true ? { redacted: true } : {}),
          };
        case "tool-call":
          return { type: "tool-call" };
        default:
          return { type: "unknown" };
      }
    }),
  };
}

/** One harness user or tool-result message's content as Anthropic content: a
 * plain string when text-only, a block array otherwise. Image bytes come from
 * the prepared request images (the adapter resolves them via the attachments
 * service). Tool results deliberately keep the string form so a text-only one
 * stays byte-identical across turns.
 * @param {object[]} blocks - harness user content blocks.
 * @param {Map<string, { data: string, mediaType: string }>} images - by attachmentId.
 * @returns {string | object[]}
 */
function userContent(blocks, images) {
  const content = [];
  for (const block of blocks) {
    if (block.type === "text") {
      if (block.text.length > 0)
        content.push({ type: "text", text: sanitizeSurrogates(block.text) });
    } else if (block.type === "image") {
      const version = images?.get(block.attachment?.attachmentId);
      if (version === undefined) continue;
      const attachmentName = block.attachment?.name
        ? `"${sanitizeSurrogates(block.attachment.name)}" `
        : "";
      content.push({ type: "text", text: `Image ${attachmentName}(attached).` });
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: normalizeImageMediaType(version.mediaType),
          data: version.data,
        },
      });
    }
  }
  if (content.length === 0) return "";
  if (content.every((block) => block.type === "text")) {
    return content.map((block) => block.text).join("\n");
  }
  if (!content.some((block) => block.type === "text")) {
    content.unshift({ type: "text", text: "(see attached image)" });
  }
  return content;
}

/** One harness user message as Anthropic `content`. Unlike a tool result, a
 * user turn is always a block array, even text-only: the tail cache breakpoint
 * can only live on a block, and the representation must stay identical once the
 * turn becomes history.
 * @param {object[]} blocks
 * @param {Map<string, { data: string, mediaType: string }>} images
 * @returns {string | object[]}
 */
function userMessageContent(blocks, images) {
  // A whitespace-only message carries no turn (and must not become a cacheable
  // but invalid text block).
  if (!blocks.some((block) => block.type !== "text" || block.text.trim().length > 0)) return "";
  const content = userContent(blocks, images);
  if (content === "") return "";
  if (typeof content === "string") {
    return content.trim() ? [{ type: "text", text: content }] : "";
  }
  const kept = content.filter((block) => block.type !== "text" || block.text.trim().length > 0);
  return kept.length > 0 ? kept : "";
}

/** Anthropic's maximum explicit prompt-cache breakpoints per request. */
const MAX_CACHE_BREAKPOINTS = 4;

/** A fresh ephemeral cache-control object. 5m is the API default and omitted. */
function cacheControl(ttl) {
  return { type: "ephemeral", ...(ttl === "1h" ? { ttl: "1h" } : {}) };
}

/** Resolve the request TTL: explicit config wins. OAuth defaults to 1h. */
function cacheTtlFor(configTtl, oauth) {
  if (configTtl === "5m" || configTtl === "1h") return configTtl;
  return oauth ? "1h" : "5m";
}

function isCacheableBlock(block) {
  if (block === null || typeof block !== "object") return false;
  switch (block.type) {
    case "text":
      return typeof block.text === "string" && block.text.trim().length > 0;
    case "image":
    case "document":
    case "tool_use":
    case "tool_result":
      return true;
    default:
      return false;
  }
}

/** Add a breakpoint to one block, never overwriting an existing one. */
function markCacheable(block, ttl) {
  if (!isCacheableBlock(block) || block.cache_control !== undefined) return;
  block.cache_control = cacheControl(ttl);
}

/** Cache the last cacheable block of the conversation, skipping thinking/empty. */
function markTail(params, ttl) {
  const last = params.at(-1);
  if (last === undefined || !Array.isArray(last.content)) return;
  for (let index = last.content.length - 1; index >= 0; index--) {
    if (!isCacheableBlock(last.content[index])) continue;
    markCacheable(last.content[index], ttl);
    return;
  }
}

function countCacheBreakpoints(body) {
  const count = (blocks) => blocks.filter((block) => block.cache_control !== undefined).length;
  let total = count(body.system ?? []) + count(body.tools ?? []);
  for (const message of body.messages ?? []) {
    if (Array.isArray(message.content)) total += count(message.content);
  }
  return total;
}

/** The text of a mid-conversation system message. Only text blocks are
 * representable; anything else fails rather than silently dropping content.
 * @param {string | object[]} content
 * @returns {string}
 */
function systemText(content) {
  if (typeof content === "string") return content;
  const texts = [];
  for (const block of content) {
    if (block.type !== "text") {
      throw new LlmError(
        `claude-subscription: a system prompt update cannot carry a block of type ${block.type}`,
        "UNSUPPORTED_CONTENT",
      );
    }
    texts.push(block.text);
  }
  return texts.join("");
}

/**
 * Harness history -> Anthropic `messages`: thinking blocks replay only with a
 * signature this adapter minted, everything else degrades to text; consecutive
 * tool results share one user turn; user turns are block arrays so the tail can
 * be cached.
 *
 * A later non-empty `system` message is the harness's in-history prompt update.
 * When the prepared route declares `systemPromptUpdate:"in-history"` it is
 * serialized per credential path:
 *
 *   - OAuth: a `<system-reminder>` USER turn at its position. A subscription
 *     credential must not receive a harness-shaped `system` block (extra-usage
 *     billing), and the API merges the user turn into its neighbour, so every
 *     model accepts it.
 *   - API key: a content `system` message, which must follow a user turn and
 *     precede an assistant turn (or end the array). A change normally lands
 *     between an assistant and the next user turn, so it is held until the next
 *     assistant turn and emitted right before it; the position is then identical
 *     on every later request, keeping the prefix stable.
 *
 * An incapable route rejects the update rather than silently losing it.
 * @param {object[]} messages - harness messages (no leading system message).
 * @param {object} options
 * @param {boolean} options.isOAuth
 * @param {Map<string, { data: string, mediaType: string }>} options.images
 * @param {"5m" | "1h"} options.ttl
 * @param {boolean} options.inHistory - the prepared route declares in-history updates.
 * @param {string} options.modelId - for the rejection message.
 * @returns {object[]}
 */
function convertMessages(messages, { isOAuth, images, ttl, inHistory, modelId }) {
  const params = [];
  const nameFor = (name) =>
    isOAuth
      ? // Idempotent: a stored session can hold an already-prefixed name, so
        // strip-then-prefix keeps replays on the declared wire name.
        applyClaudeToolPrefix(stripClaudeToolPrefix(name))
      : name;

  // API-key updates waiting for a legal position (see the contract above).
  const pendingSystems = [];
  const flushSystems = () => {
    if (pendingSystems.length === 0) return;
    if (params.at(-1)?.role !== "user") return;
    params.push({ role: "system", content: [{ type: "text", text: pendingSystems.join("\n\n") }] });
    pendingSystems.length = 0;
  };

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];

    if (message.role === "system") {
      const text = systemText(message.content);
      // An empty/whitespace-only system node carries no instruction.
      if (text.trim().length === 0) continue;
      if (!inHistory) {
        // The harness only appends a second system node when the route declares
        // in-history; dropping it here would silently lose instructions.
        throw new LlmError(
          `claude-subscription: a mid-conversation system message on ${modelId} requires an in-history prompt route, which this request does not declare`,
          "UNSUPPORTED_CONTENT",
        );
      }
      if (isOAuth) {
        params.push({
          role: "user",
          content: [
            {
              type: "text",
              text: `<system-reminder>\n${sanitizeSurrogates(text)}\n</system-reminder>`,
            },
          ],
        });
      } else {
        pendingSystems.push(sanitizeSurrogates(text));
      }
    } else if (message.role === "user") {
      const content =
        typeof message.content === "string"
          ? message.content.trim()
            ? [{ type: "text", text: sanitizeSurrogates(message.content) }]
            : ""
          : userMessageContent(message.content, images);
      if (content.length > 0) params.push({ role: "user", content });
    } else if (message.role === "assistant") {
      const state = readReplayState(message.source?.replayState);
      const blocks = [];
      message.content.forEach((block, index) => {
        if (block.type === "text" && block.text.trim()) {
          const textBlock = { type: "text", text: sanitizeSurrogates(block.text) };
          // The synthetic relocation ack is the one harness block that
          // already carries a marker. Preserve it through conversion.
          if (block.cache_control !== undefined) textBlock.cache_control = block.cache_control;
          blocks.push(textBlock);
        } else if (block.type === "reasoning" && block.text.trim()) {
          // A signature only verifies if this adapter minted it; a signature from
          // a provider swap would 400, so treat it as "no signature".
          const replay = state?.blocks[index];
          const signature =
            state !== undefined && replay?.type === "reasoning"
              ? replay.thinkingSignature
              : undefined;
          if (signature) {
            blocks.push({
              type: "thinking",
              thinking: sanitizeSurrogates(block.text),
              signature,
            });
          } else {
            // No signature: replay as plain text or the API rejects it.
            const textBlock = { type: "text", text: sanitizeSurrogates(block.text) };
            if (block.cache_control !== undefined) textBlock.cache_control = block.cache_control;
            blocks.push(textBlock);
          }
        } else if (block.type === "tool-call") {
          let input = {};
          try {
            const parsed = JSON.parse(block.arguments);
            if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
              input = parsed;
          } catch {
            // Model malformation: send an empty input rather than failing.
          }
          blocks.push({
            type: "tool_use",
            id: sanitizeToolId(block.id),
            name: nameFor(block.name),
            input,
          });
        }
      });
      if (blocks.length > 0) {
        // A pending update must PRECEDE the assistant turn (after a user turn),
        // so it flushes only when the assistant is actually emitted.
        flushSystems();
        params.push({ role: "assistant", content: blocks });
      }
    } else if (message.role === "tool") {
      const toolResults = [
        {
          type: "tool_result",
          tool_use_id: sanitizeToolId(message.toolCallId),
          content: userContent(message.content, images) || "(no output)",
          is_error: message.isError ?? false,
        },
      ];
      // Anthropic requires consecutive tool results to share one user turn.
      let j = i + 1;
      while (j < messages.length && messages[j].role === "tool") {
        const next = messages[j];
        toolResults.push({
          type: "tool_result",
          tool_use_id: sanitizeToolId(next.toolCallId),
          content: userContent(next.content, images) || "(no output)",
          is_error: next.isError ?? false,
        });
        j++;
      }
      i = j - 1;
      params.push({ role: "user", content: toolResults });
    }
  }

  flushSystems();
  if (pendingSystems.length > 0) {
    // The history ends with a system update that has no following assistant turn
    // yet (a continuation step). It must still follow a user turn, so it goes
    // after the last one; a later request emits it after the next user turn
    // instead. That rare reposition costs a partial cache read, never a failure.
    const text = pendingSystems.join("\n\n");
    let lastUser = -1;
    for (let index = params.length - 1; index >= 0; index--) {
      if (params[index].role === "user") {
        lastUser = index;
        break;
      }
    }
    if (lastUser === -1) {
      throw new LlmError(
        `claude-subscription: a mid-conversation system message on ${modelId} has no preceding user or tool-result turn`,
        "UNSUPPORTED_CONTENT",
      );
    }
    params.splice(lastUser + 1, 0, { role: "system", content: [{ type: "text", text }] });
    pendingSystems.length = 0;
  }

  // Cache the conversation tail on its last cacheable block (empty/thinking
  // blocks skipped, an existing marker such as the static ack kept).
  markTail(params, ttl);

  return params;
}

/**
 * @param {object[]} tools
 * @param {boolean} isOAuth
 * @param {"5m" | "1h"} ttl
 * @returns {object[]}
 */
function convertTools(tools, isOAuth, ttl) {
  return tools.map((tool, idx) => {
    const schema = tool.parameters ?? {};
    const entry = {
      name: isOAuth ? applyClaudeToolPrefix(tool.name) : tool.name,
      description: tool.description,
      input_schema: {
        type: "object",
        properties: schema.properties ?? {},
        required: schema.required ?? [],
      },
    };
    // Cache the tool block: it is stable across a session.
    if (idx === tools.length - 1) entry.cache_control = cacheControl(ttl);
    return entry;
  });
}

/** System blocks in Cowork's order on OAuth: [0] billing header (carries the
 * cch placeholder patched on the wire), [1] Claude Agent SDK identity. The
 * caller's own prompt is NOT appended here on OAuth; see
 * `relocateSystemPrompt`.
 * @param {string | undefined} systemPrompt
 * @param {object[]} messages
 * @param {boolean} isOAuth
 * @param {"5m" | "1h"} ttl
 * @returns {object[] | undefined}
 */
function buildSystemBlocks(systemPrompt, messages, isOAuth, ttl) {
  const userPrompt = systemPrompt ? sanitizeSurrogates(systemPrompt) : undefined;

  if (!isOAuth) {
    if (!userPrompt) return undefined;
    return [
      userPrompt.trim()
        ? { type: "text", text: userPrompt, cache_control: cacheControl(ttl) }
        : { type: "text", text: userPrompt },
    ];
  }

  const blocks = [
    { type: "text", text: createClaudeBillingHeader(firstUserText(messages)) },
    { type: "text", text: claudeCodeSystemInstruction, cache_control: cacheControl(ttl) },
  ];
  return blocks;
}

/**
 * Move the harness's system prompt out of `system` into a leading
 * `<system-reminder>` user turn, for OAuth (subscription) requests.
 *
 * WHY: a subscription credential presenting the Cowork fingerprint is expected
 * to carry a Claude-Code-shaped prompt. A harness prompt sent as a `system`
 * block is billed against extra-usage credits instead of the plan (a 400
 * "You're out of extra usage"). Relocation into a user turn preserves the
 * prompt verbatim. API-key requests keep the prompt in `system`.
 * @param {string | undefined} systemPrompt
 * @param {object[]} messages
 * @param {"5m" | "1h"} ttl
 * @returns {object[]}
 */
function relocateSystemPrompt(systemPrompt, messages, ttl) {
  const prompt = systemPrompt ? sanitizeSurrogates(systemPrompt) : "";
  if (!prompt.trim()) return messages;

  // The synthetic ack keeps user/assistant alternation and stops the model
  // replying to the instructions; its breakpoint caches the static prefix
  // (tools + system + prompt) across sessions, independent of the moving tail.
  return [
    {
      role: "user",
      content: [{ type: "text", text: `<system-reminder>\n${prompt}\n</system-reminder>` }],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Understood.", cache_control: cacheControl(ttl) }],
    },
    ...messages,
  ];
}

/** Harness thinking level -> Anthropic effort for adaptive models. */
function mapThinkingLevelToEffort(model, level) {
  const mapped = model.thinkingLevelMap?.[level];
  if (typeof mapped === "string") return mapped;
  switch (level) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    default:
      return "high";
  }
}

const THINKING_BUDGETS = {
  minimal: 1024,
  low: 4096,
  medium: 10240,
  high: 20480,
  xhigh: 32768,
  max: 49152,
};

/** Anthropic's documented minimum `budget_tokens`. Also the output reserve. */
const MIN_THINKING_BUDGET = 1024;

/**
 * Build the complete wire request.
 * @param {object} input
 * @param {object} input.model - catalog ModelSpec.
 * @param {string | undefined} input.systemPrompt - request-level system prompt.
 * @param {object[]} input.messages - harness messages, leading system removed.
 * @param {object[] | undefined} input.tools
 * @param {Map<string, { data: string, mediaType: string }>} input.images - prepared request images by attachmentId.
 * @param {boolean} input.oauth - the credential is a subscription OAuth token.
 * @param {string} input.apiKey - resolved access token or API key.
 * @param {string | undefined} input.reasoning - harness reasoning effort level.
 * @param {number | undefined} input.maxTokens - caller output cap.
 * @param {number | undefined} input.temperature
 * @param {string[]} [input.stop] - harness stop strings, mapped to Anthropic's `stop_sequences`.
 * @param {string} [input.baseUrl]
 * @param {string[]} [input.extraBetas]
 * @param {"auto" | "5m" | "1h"} [input.cacheTtl] - prompt-cache TTL. "auto" is 1h on OAuth, 5m on API keys.
 * @param {Record<string, string>} [input.modelHeaders]
 * @param {typeof fetch} [input.fetchImpl] - injectable for tests.
 * @returns {{ url: string, headers: Record<string, string>, body: Uint8Array, betas: string, maxTokens: number }}
 */
export function buildAnthropicRequest(input) {
  const {
    model,
    systemPrompt,
    messages,
    tools,
    images = new Map(),
    oauth,
    apiKey,
    reasoning,
    maxTokens: callerMaxTokens,
    temperature,
    stop,
    baseUrl = "https://api.anthropic.com",
    extraBetas = [],
    cacheTtl,
    modelHeaders,
  } = input;

  const hasTools = !!tools?.length;
  const thinkingRequested =
    reasoning !== undefined && reasoning !== "off" && model.reasoning !== false;
  const ttl = cacheTtlFor(cacheTtl, oauth);

  // ---- headers ----
  // Always the agent beta profile, tools-free requests included: the utility
  // branch of buildCoworkBetas is pinned but deliberately unreachable here (it
  // would drop the effort beta adaptive thinking needs). extraBetas rides on
  // BOTH credential paths by config contract.
  const betaHeader = buildBetaHeader(
    oauth ? buildCoworkBetas(true, thinkingRequested) : [],
    extraBetas,
  );

  // The pinned Cowork UA IS the request identity on the subscription path:
  // replacing it with the harness attribution UA breaks the credential class.
  // The API-key path sends the harness UA instead. Documented divergence.
  const headers = oauth
    ? {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": coworkUserAgent,
        ...coworkHeaders,
        ...(betaHeader ? { "anthropic-beta": betaHeader } : {}),
        "anthropic-dangerous-direct-browser-access": "true",
        "anthropic-version": ANTHROPIC_VERSION,
        Authorization: `Bearer ${apiKey}`,
        "x-app": "cli",
        "x-client-request-id": crypto.randomUUID(),
        Connection: "keep-alive",
        "Accept-Encoding": "gzip, deflate, br",
      }
    : {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-dangerous-direct-browser-access": "true",
        ...(betaHeader ? { "anthropic-beta": betaHeader } : {}),
        "X-Api-Key": apiKey,
      };

  // Model-level headers may add keys but never clobber the fingerprint.
  for (const [k, v] of Object.entries(modelHeaders ?? {})) {
    if (ENFORCED_HEADER_KEYS.has(k.toLowerCase())) continue;
    headers[k] = v;
  }

  // ---- max_tokens: OAuth clamps to 64k, the raw API does not ----
  const modelMaxTokens = model.maxTokens ?? CLAUDE_CODE_MAX_OUTPUT_TOKENS;
  const ceiling = oauth ? Math.min(CLAUDE_CODE_MAX_OUTPUT_TOKENS, modelMaxTokens) : modelMaxTokens;
  const maxTokens = Math.min(ceiling, callerMaxTokens ?? modelMaxTokens);

  // On OAuth the harness prompt is relocated into a leading <system-reminder>
  // user turn (see relocateSystemPrompt).
  const outboundMessages = oauth ? relocateSystemPrompt(systemPrompt, messages, ttl) : messages;

  // A route declaring an appended prompt update (prepareCall) keeps a changed
  // prompt after the cached history instead of rewriting the head. The OAuth
  // path always tolerates one (serialized as a user turn, so a cross-provider
  // history never throws on the subscription path).
  const inHistory = oauth || model.systemPromptUpdate === "in-history";

  const body = {
    model: model.id,
    messages: convertMessages(outboundMessages, {
      isOAuth: oauth,
      images,
      ttl,
      inHistory,
      modelId: model.id,
    }),
  };

  const systemBlocks = buildSystemBlocks(systemPrompt, messages, oauth, ttl);
  if (systemBlocks) body.system = systemBlocks;
  if (hasTools) body.tools = convertTools(tools, oauth, ttl);

  if (oauth) {
    body.metadata = { user_id: generateClaudeCloakingUserId() };
  }

  body.max_tokens = maxTokens;

  if (thinkingRequested && model.compat?.forceAdaptiveThinking === true) {
    // Adaptive models take an effort level, not a budget. `display:"summarized"`
    // because newer models otherwise return thinking blocks with no text.
    body.thinking = { type: "adaptive", display: "summarized" };
    body.output_config = { effort: mapThinkingLevelToEffort(model, reasoning) };
  } else if (thinkingRequested) {
    if (maxTokens <= MIN_THINKING_BUDGET) {
      // Anthropic requires 1024 <= budget_tokens < max_tokens; a smaller cap
      // cannot carry thinking, so fail loudly instead of a guaranteed 400.
      throw new LlmError(
        `claude-subscription: maxTokens ${maxTokens} leaves no room for thinking on ${model.id} (Anthropic requires ${MIN_THINKING_BUDGET} <= budget_tokens < max_tokens); raise the output cap above ${MIN_THINKING_BUDGET} or set reasoning to "off"`,
        "INVALID_REQUEST",
      );
    }
    const budget = THINKING_BUDGETS[reasoning] ?? 10240;
    body.thinking = {
      type: "enabled",
      budget_tokens: Math.max(
        MIN_THINKING_BUDGET,
        Math.min(budget, maxTokens - MIN_THINKING_BUDGET),
      ), // < max_tokens, as Anthropic requires
    };
  }

  if (
    temperature !== undefined &&
    !thinkingRequested &&
    model.compat?.supportsTemperature !== false
  ) {
    body.temperature = temperature;
  }
  if (stop?.length) body.stop_sequences = [...stop];

  body.stream = true;

  const breakpoints = countCacheBreakpoints(body);
  if (breakpoints > MAX_CACHE_BREAKPOINTS) {
    throw new LlmError(
      `claude-subscription: request carries ${breakpoints} prompt-cache breakpoints; Anthropic allows at most ${MAX_CACHE_BREAKPOINTS}`,
      "INVALID_REQUEST",
    );
  }

  const url = `${baseUrl.replace(/\/+$/, "")}/v1/messages`;
  const serialized = JSON.stringify(body);

  // cch attestation is patched into the body bytes on the way out. A body
  // without the billing placeholder is a wire bug, not a request failure:
  // send it unpatched rather than refusing to answer.
  const bytes = new TextEncoder().encode(serialized);
  if (oauth) patchCch(bytes);

  return { url, headers, body: bytes, betas: betaHeader, maxTokens };
}
