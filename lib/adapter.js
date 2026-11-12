/**
 * The `LlmAdapter` implementation for the Claude subscription route.
 *
 * lib/index.js registers one instance per account route. Every operation reads
 * live state (credential, catalog, config), so an edit reaches the next request
 * without a restart.
 *
 * @module @apcamargo/dsh-claude-subscription/adapter
 */

import {
  LlmError,
  QUOTA_EXCEEDED_CODE,
  assertUsableApiKey,
  attributionHeaders,
  errorChain,
} from "@deepseek-ai/dsh-llm";
import { requestImageDimensions } from "@deepseek-ai/dsh-attachment";
import { catalogOfRoute, modelsOfRoute, providerTitle, publishedCatalogOf } from "./accounts.js";
import { availableCatalog, resolveCatalog, specForRequest, toHarnessModel } from "./catalog.js";
import { OTHER_ACCOUNTS_HINT } from "./client-models.js";
import { keyOf } from "./credentials.js";
import { anthropicToChunks, classifyError, parseRetryAfterMs } from "./stream.js";
import {
  assertSupportedHistory,
  buildAnthropicRequest,
  isOAuthToken,
  splitSystemPrompt,
} from "./wire.js";

export const DEFAULT_BASE_URL = "https://api.anthropic.com";

/**
 * The request-image budget this route applies before serialization. Shared by
 * the request assembly and by `imageRequestTarget`, so the harness's view of what
 * the wire sends (image budgeting, offload decisions, token estimates) matches
 * the projection `resolveRequestImages` produces.
 */
const IMAGE_REQUEST_BUDGET = Object.freeze({ maxPixels: 4194304, maxBytes: 1048576 });

/**
 * The request-image target for one normalized attachment: the exact dimensions
 * and byte cap `resolveRequestImages` serializes with.
 * @param {{ width: number, height: number }} image - a normalized image reference.
 * @returns {{ width: number, height: number, maxBytes: number }}
 */
function imageRequestTargetOf(image) {
  return {
    ...requestImageDimensions(image.width, image.height, IMAGE_REQUEST_BUDGET.maxPixels),
    maxBytes: IMAGE_REQUEST_BUDGET.maxBytes,
  };
}

/**
 * @param {string} message
 * @param {string} code
 * @returns {LlmError}
 */
function llmFailure(message, code) {
  return new LlmError(`claude-subscription: ${message}`, code);
}

/**
 * Whether a resolved credential selects the OAuth (subscription) request path.
 *
 * The stored record kind alone is not enough, since a record can hold a raw API
 * key, and the wire decides on the token's shape. `prepareCall` (the capability
 * declaration the agent loop reads) and `stream` (the wire) share this predicate,
 * so the harness and the request can never disagree about which path is served.
 * @param {{ oauth?: boolean, apiKey?: string } | undefined} credential
 * @returns {boolean}
 */
function credentialIsOAuth(credential) {
  return (
    credential?.oauth === true &&
    typeof credential.apiKey === "string" &&
    // `assertUsableApiKey` trims before the wire sees the key, so the declaration
    // must trim too or a padded token could diverge the halves.
    isOAuthToken(credential.apiKey.trim())
  );
}

/**
 * The non-empty mid-conversation system messages a request history carries.
 * Diagnostics only: the wire applies the same rule when deciding whether an
 * update needs to be emitted at all.
 * @param {object[]} messages
 * @returns {number}
 */
function systemUpdateCount(messages) {
  let count = 0;
  for (const message of messages) {
    if (message.role !== "system") continue;
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("");
    if (text.trim().length > 0) count += 1;
  }
  return count;
}

/**
 * The wording that tells a user why a route cannot serve.
 * @returns {string}
 */
function missingCredentialMessage() {
  return "no credential is stored; run /claude-login to sign in with your Claude account";
}

/**
 * Create the adapter of one account route. One instance per route: the route is
 * bound by closure, so no operation guesses an account from `options.provider`,
 * and replay state (kept per adapter instance by the host) never carries a
 * thinking signature minted under one account into another's request.
 * @param {object} deps
 * @param {string} deps.route - the provider route (and credential id) this adapter serves.
 * @param {object} deps.grants - the grant manager (lib/credentials.js).
 * @param {{ accounts?: { models?: Record<string, object[]> }, extraBetas?: string[], debug?: boolean }} deps.config
 *   the live plugin config. Volatile sections are read through their reference on
 *   every operation, so a Models-page edit reaches the next call.
 * @param {(message: string, ...rest: unknown[]) => void} deps.debug
 * @param {object} deps.ctx - host context. `ctx.get("attachments")` resolves request images.
 * @param {() => import("./accounts.js").RouteEntry | undefined} [deps.entry] - the route's live
 *   state (kind, picker heading, account). A route with no state yet reads as an
 *   ordinary account.
 * @param {() => void} [deps.onQuotaExhausted] - called when an OAuth request
 *   runs out of quota to store the marker and refresh usage.
 * @returns {object} the adapter.
 */
export function createAdapter({ route, grants, config, debug, ctx, entry = () => undefined, onQuotaExhausted }) {
  /** The route's live state, with the defaults of a route nobody has described yet. */
  function state() {
    return (
      entry() ?? {
        route,
        kind: "account",
        name: providerTitle(undefined),
        status: "signedIn",
        others: 0,
      }
    );
  }

  /**
   * The route's available catalog: its account reading, else the published one,
   * else empty. Never the saved list, so the add picker stays useful.
   */
  function available() {
    return availableCatalog(
      catalogOfRoute(config, route)?.models,
      publishedCatalogOf(config)?.models,
    );
  }

  function catalog() {
    return resolveCatalog(modelsOfRoute(config, route), available());
  }

  /** One servable spec by id: the saved list, else the route's reading. */
  function specOf(model) {
    return specForRequest(available(), modelsOfRoute(config, route), model);
  }

  /**
   * The sentence tying a failure to the account that served the request, and
   * (for exhausted allowance) pointing at the others. Worded without the numbers
   * and quota words classifyError matches, so re-classifying the composed message
   * cannot flip the code. The others sentence is the shared OTHER_ACCOUNTS_HINT
   * constant. There is deliberately no automatic failover: a silent account
   * switch would change what is being billed.
   * @param {string} code - the failure's LlmError code.
   */
  function accountHint(code) {
    const current = state();
    if (current.kind !== "account" || current.email === undefined) return "";
    if (code === "AUTH")
      return ` This request used the Claude account ${current.email}: run /claude-login ${current.email} to sign in again.`;
    if ((code === "RATE_LIMIT" || code === QUOTA_EXCEEDED_CODE) && current.others > 0) {
      return ` This request used the Claude account ${current.email}. ${OTHER_ACCOUNTS_HINT}`;
    }
    return "";
  }

  /** Resolve this account's credential or fail with the wording its kind calls for. */
  async function credentialOrFail(signal) {
    const credential = await grants.resolve({ route, signal });
    if (credential === undefined)
      throw llmFailure(missingCredentialMessage(), "MISSING_CREDENTIAL");
    return credential;
  }

  /**
   * Report quota exhaustion only for OAuth requests, and never mask the
   * original error. API keys have no allowance window.
   * @param {string} code - the failure's LlmError code.
   * @param {boolean} oauth - whether the request ran on the OAuth path.
   */
  function noteQuotaExhaustion(code, oauth) {
    if (!oauth || code !== QUOTA_EXCEEDED_CODE) return;
    try {
      onQuotaExhausted?.();
    } catch {
      // The failure being reported matters more than the report.
    }
  }

  return {
    providerInfo(provider) {
      return { id: provider, name: state().name };
    },

    /**
     * Harness defaults apply. No adapter-level retry layer (upstream passes
     * `maxRetries: 0` to its SDK client for the same reason): failures surface
     * immediately, and retrying is the harness retry executor's job via the
     * RATE_LIMIT/QUOTA classification.
     */
    providerRetryPolicy() {
      return undefined;
    },

    /** No provider-side image pricing. Consumers use their neutral estimate. */
    imageRequestPricing() {
      return undefined;
    },

    /**
     * What this route actually sends for one image. It downscales (unlike the
     * harness default, which preserves the normalized source), so it overrides.
     * dsh-llm 0.2.1 exposes the target to image-budget consumers, and the runtime
     * calls it unguarded on the adapter.
     */
    imageRequestTarget(_provider, _model, image) {
      return imageRequestTargetOf(image);
    },

    /** Every registered route lists its catalog. A removed account's route is unregistered. */
    listModels(provider) {
      return catalog().map((model) => {
        const info = toHarnessModel(provider, model);
        return {
          provider,
          id: info.id,
          name: info.name,
          inputModalities: [...info.inputModalities],
        };
      });
    },

    resolveModel(provider, model) {
      const spec = specOf(model);
      if (spec === undefined) {
        throw new LlmError(`claude-subscription has no model "${model}"`, "UNKNOWN_MODEL");
      }
      const info = toHarnessModel(provider, spec);
      // The catalog field is the model's documented mid-conversation
      // capability; the kill switch removes it from every surface. The broader
      // OAuth-path declaration lives in prepareCall below.
      if (config.systemPromptUpdates === false) delete info.systemPromptUpdate;
      return info;
    },

    async prepareCall(provider, model, signal) {
      // The credential first: a route with no stored credential must say so,
      // whatever model the session had picked on it.
      const credential = await credentialOrFail(signal);
      const spec = specOf(model);
      if (spec === undefined) {
        throw new LlmError(`claude-subscription has no model "${model}"`, "UNKNOWN_MODEL");
      }
      const info = this.resolveModel(provider, model);
      // In-history prompt delivery is a property of the request this route
      // builds, not only of the model. On OAuth the wire appends a changed prompt
      // as a <system-reminder> user turn, which every model accepts, so the mode
      // is declared for every model there. On an API key the update would be a
      // mid-conversation system message, which the catalog publishes no
      // capability for, so no API-key record declares one. The agent loop reads
      // the mode from THIS prepared call, not from resolveModel, so this is the
      // authoritative declaration.
      if (
        config.systemPromptUpdates !== false &&
        (credentialIsOAuth(credential) || spec.systemPromptUpdate === "in-history")
      ) {
        info.systemPromptUpdate = "in-history";
      }
      return {
        model: info,
        stream: (options) => this.stream(options),
      };
    },

    async *stream(options) {
      const spec = specOf(options.model);
      if (spec === undefined) {
        throw new LlmError(`claude-subscription has no model "${options.model}"`, "UNKNOWN_MODEL");
      }
      assertSupportedHistory(options.messages);
      const split = splitSystemPrompt(options);

      const credential = await credentialOrFail(options.signal);
      const apiKey = assertUsableApiKey(credential.apiKey, "claude-subscription", keyOf(route));
      // A stored API-key record wins over shape guessing. The OAuth marker
      // decides the request path and the in-history capability prepareCall declares.
      const oauth = credentialIsOAuth(credential);
      const systemUpdates = systemUpdateCount(split.messages);

      const images = await resolveRequestImages(ctx, options.messages, options.signal);
      const request = buildAnthropicRequest({
        model: spec,
        systemPrompt: split.systemPrompt,
        messages: split.messages,
        tools: options.tools,
        images,
        oauth,
        apiKey,
        reasoning: options.reasoningEffort,
        maxTokens: options.maxTokens,
        temperature: options.temperature,
        stop: options.stop,
        baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
        extraBetas: config.extraBetas ?? [],
        cacheTtl: config.cacheTtl,
      });

      debug(
        `POST ${request.url} model=${spec.id} oauth=${oauth} maxTokens=${request.maxTokens} betas=${request.betas}`,
      );

      const headers = { ...request.headers };
      // The DSH attribution UA applies to the API-key path only. The OAuth path's
      // pinned Cowork UA is the credential's identity (see README, "Attribution
      // divergence").
      if (!oauth) {
        for (const [name, value] of Object.entries(attributionHeaders())) {
          headers[name] = value;
        }
      }

      let response;
      try {
        response = await fetch(request.url, {
          method: "POST",
          headers,
          body: request.body,
          signal: options.signal,
        });
      } catch (error) {
        if (options.signal?.aborted) {
          throw new LlmError("claude-subscription request aborted by caller", "ABORTED", {
            cause: error,
          });
        }
        throw llmFailure(`request to ${request.url} failed: ${String(error)}`, "TRANSPORT");
      }

      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        // Classify the provider's response before adding account or consent hints.
        // Retry-After tells the retry executor when to try again and separates a
        // spent allowance from a brief throttle.
        const consentHint = /third-party apps now draw|draw from your extra usage/i.test(text)
          ? " The credential's consent looks stale: run /claude-login and sign in again."
          : "";
        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
        const code = classifyError(response.status, text, { retryAfterMs });
        noteQuotaExhaustion(code, oauth);
        throw new LlmError(
          `Anthropic API error ${response.status}: ${text}${consentHint}${accountHint(code)}`,
          code,
          {
            status: response.status,
            ...(retryAfterMs !== undefined ? { providerRetryAfterMs: retryAfterMs } : {}),
          },
        );
      }

      // The runtime turns a generator throw into a terminal failure chunk.
      // Stream-level Anthropic errors are converted here so they carry codes,
      // and connection-level failures (undici's "terminated" on a reset) are
      // classified instead of escaping as opaque UNKNOWNs. The `_` tool prefix
      // was applied on the wire for this path, so the names come back prefixed
      // and must be stripped for the harness.
      try {
        for await (const chunk of anthropicToChunks(
          response.body,
          (code, message) => new LlmError(`claude-subscription: ${message}`, code),
          { stripToolPrefix: oauth },
        )) {
          if (chunk.type === "usage") {
            const usage = chunk.usage;
            const read = usage.cacheReadTokens ?? 0;
            const write = usage.cacheWriteTokens ?? 0;
            // Anthropic's `input_tokens` is the uncached remainder, so the
            // denominator is the whole prompt the request was billed for.
            const total = read + write + usage.inputTokens;
            const hit = total > 0 ? ((read / total) * 100).toFixed(1) : "0.0";
            debug(
              `usage input=${usage.inputTokens} cacheRead=${read} cacheWrite=${write} output=${usage.outputTokens} cacheHit=${hit}% systemUpdates=${systemUpdates}`,
            );
            // Each in-history prompt change retains a full prompt version in
            // history, re-read on every later request until compaction clears it.
            // Flag the growth instead of hiding it.
            if (systemUpdates >= 3) {
              debug(
                `prompt cache: ${systemUpdates} retained system-prompt versions in history; each is re-read on every request until compaction clears it`,
              );
            }
          }
          yield chunk;
        }
      } catch (error) {
        if (error instanceof LlmError) {
          // Handle in-band failures the same way as HTTP failures. Keep their
          // existing code; none currently maps to QUOTA.
          noteQuotaExhaustion(error.code, oauth);
          throw error;
        }
        if (options.signal?.aborted) {
          throw new LlmError("claude-subscription stream aborted by caller", "ABORTED", {
            cause: error,
          });
        }
        const streamCode = classifyError(undefined, String(error));
        noteQuotaExhaustion(streamCode, oauth);
        throw new LlmError(
          `claude-subscription: stream failed: ${errorChain(error)}`,
          streamCode,
          { cause: error },
        );
      }
    },
  };
}

/**
 * Read every image the request history references into base64 request
 * versions through the durable attachments service. Images are prepared per
 * attachment id, so one shared version serves repeated occurrences.
 * @param {object} ctx - host context.
 * @param {object[]} messages
 * @param {AbortSignal} [signal]
 * @returns {Promise<Map<string, { data: string, mediaType: string }>>}
 */
async function resolveRequestImages(ctx, messages, signal) {
  const refs = new Map();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "image" && block.offloaded !== true) {
        refs.set(block.attachment.attachmentId, block.attachment);
      }
    }
  }
  if (refs.size === 0) return new Map();

  const attachments = ctx.get("attachments");
  if (attachments === undefined) {
    throw new LlmError(
      "claude-subscription image input requires the durable attachment service",
      "UNSUPPORTED_CONTENT",
    );
  }
  const versions = new Map();
  for (const ref of refs.values()) {
    const target = imageRequestTargetOf(ref);
    const prepared = await attachments.readImageRequest(ref, target, signal);
    versions.set(ref.attachmentId, {
      data: Buffer.from(prepared.data).toString("base64"),
      mediaType: prepared.mediaType,
    });
  }
  return versions;
}
