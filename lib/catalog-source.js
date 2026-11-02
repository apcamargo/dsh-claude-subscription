/**
 * The two Claude model-catalog sources and their normalization.
 *
 * The account catalog is Claude Code's model selector, served per account:
 * `GET /api/model_selector/cc` with the grant's OAuth bearer. It carries the
 * models the account may actually select, with their capacities and effort
 * ladder. It is not the public `/v1/models` list (ids and display names only).
 *
 * The published catalog is the anonymous, versioned document Claude Code ships
 * for third-party clients, used when the account lane declines or the plugin has
 * no OAuth grant yet. It covers every first-party model, not this account's
 * availability.
 *
 * Both normalize to one behaviour-neutral entry shape; `lib/catalog.js` adds the
 * wire-behaviour defaults and converts to the harness model metadata.
 *
 * @module @apcamargo/dsh-claude-subscription/catalog-source
 */

import { claudeCodeVersion } from "./fingerprint.js";

/** The account's model selector, surface `cc` (Claude Code). */
export const SERVED_CATALOG_URL = "https://api.anthropic.com/api/model_selector/cc";
/** The anonymous catalog Claude Code publishes for third-party clients. */
export const PUBLISHED_CATALOG_URL = "https://downloads.claude.ai/model-catalog/v1/catalog.json";

/** How long a successful reading is used before a background refresh is due. */
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
/** Retry delays after a failed fetch, indexed by attempt count. */
export const CATALOG_RETRY_MS = [5 * 60 * 1000, 30 * 60 * 1000];

/** A catalog row the plugin will never serve, and the hard cap on one reading. */
const MAX_CATALOG_MODELS = 100;

const MAX_NAME = 80;
const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MODEL_ID = /^[a-z][a-z0-9._-]{0,79}$/;
/** The harness effort levels, in escalation order (mirrors lib/catalog.js). */
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** One model array from either envelope (served response or published document). */
function modelRows(document) {
  const served = document?.model_selector_config?.[0]?.models ?? document?.config?.[0]?.models;
  if (Array.isArray(served)) return served;
  const published = document?.surfaces?.cc?.model_selector_config?.[0]?.models;
  if (Array.isArray(published)) return published;
  throw new Error("Claude returned a malformed model catalog");
}

/** Input modalities a catalog row advertises. */
function inputOf(row) {
  if (isPlainObject(row?.capabilities) && row.capabilities.mm_images === false) return ["text"];
  return ["text", "image"];
}

/** The effort ladder a row advertises, in harness vocabulary. */
function effortsOf(row) {
  const raw = row?.runtime?.effort_levels;
  if (!Array.isArray(raw)) return undefined;
  const levels = [...new Set(raw.filter((level) => EFFORT_LEVELS.includes(level)))];
  return levels.length > 0 ? levels : undefined;
}

/**
 * Normalize one catalog document to the entry shape.
 *
 * A published document is filtered to first-party models: its `offered_on` list
 * includes Bedrock/Vertex-only ids a subscription route cannot serve. Served
 * rows carry no `offered_on` (they are already this account's list).
 *
 * @param {unknown} document - parsed served response or published document.
 * @param {{ source: "served" | "published", now?: number }} options
 * @returns {{ models: object[], version?: number, expiresAt?: string }} the entries, document facts.
 */
export function parseCatalogDocument(document, { source }) {
  if (!isPlainObject(document)) throw new Error("Claude returned a malformed model catalog");
  const rows = modelRows(document);
  const seen = new Set();
  const models = [];
  for (const row of rows) {
    if (!isPlainObject(row)) continue;
    const id = nonEmpty(row.id);
    if (id === undefined || !MODEL_ID.test(id) || seen.has(id)) continue;
    if (row.section === "deprecated") continue;
    if (
      source === "published" &&
      Array.isArray(row.offered_on) &&
      !row.offered_on.includes("first_party")
    )
      continue;
    seen.add(id);
    const runtime = isPlainObject(row.runtime) ? row.runtime : {};
    const effortLevels = effortsOf(row);
    const defaultEffort = nonEmpty(runtime.default_effort);
    const family = nonEmpty(runtime.family);
    models.push({
      id,
      name: (nonEmpty(row.name) ?? nonEmpty(row.short_name) ?? id).slice(0, MAX_NAME),
      contextWindow:
        positiveInteger(runtime.max_input_tokens) ?? positiveInteger(runtime.max_context_window),
      maxTokens: positiveInteger(runtime.max_output_tokens),
      input: inputOf(row),
      ...(effortLevels === undefined ? {} : { effortLevels }),
      ...(defaultEffort === undefined || !EFFORT_LEVELS.includes(defaultEffort)
        ? {}
        : { defaultEffort }),
      ...(family === undefined ? {} : { family }),
      ...(nonEmpty(row.section) === undefined ? {} : { section: row.section }),
      ...(nonEmpty(row.min_claude_code_version) === undefined
        ? {}
        : { minVersion: row.min_claude_code_version }),
    });
    if (models.length >= MAX_CATALOG_MODELS) break;
  }
  if (models.length === 0)
    throw new Error("Claude returned an empty or incompatible model catalog");
  return {
    models,
    ...(Number.isSafeInteger(document.version) ? { version: document.version } : {}),
    ...(nonEmpty(document.expires_at) === undefined ? {} : { expiresAt: document.expires_at }),
  };
}

/** The caller's signal composed with this fetch's own budget. */
function requestSignal(signal) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/** Read a response body with a hard byte cap, then parse it as JSON. */
async function readJson(response) {
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new Error("Claude returned a model catalog that is too large");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Claude returned a model catalog that is not JSON");
  }
}

/**
 * Fetch this account's model selector.
 *
 * A 304 means the caller's cached reading is still current. A non-2xx throws
 * with `status` attached; the engine decides whether to back off or fall back
 * (a 403 here usually means the lane refuses this credential's scope, not that
 * the user needs to sign in again).
 *
 * @param {{ apiKey: string }} credential - the grant's OAuth access token.
 * @param {{ fetchImpl?: typeof fetch, signal?: AbortSignal, etag?: string }} [options]
 * @returns {Promise<{ status: "ok", models: object[], etag?: string } | { status: "not-modified" }>}
 */
export async function fetchServedCatalog(credential, { fetchImpl, signal, etag } = {}) {
  const headers = {
    Authorization: `Bearer ${credential.apiKey}`,
    "anthropic-beta": "oauth-2025-04-20",
    "anthropic-version": "2023-06-01",
    "User-Agent": `claude-code/${claudeCodeVersion}`,
    "anthropic-client-platform": "cli",
    "anthropic-client-version": claudeCodeVersion,
    Accept: "application/json",
  };
  if (etag !== undefined) headers["If-None-Match"] = etag;
  const response = await (fetchImpl ?? fetch)(SERVED_CATALOG_URL, {
    method: "GET",
    headers,
    redirect: "error",
    signal: requestSignal(signal),
  });
  if (response.status === 304) return { status: "not-modified" };
  if (!response.ok) {
    throw Object.assign(new Error(`Claude model selector failed (HTTP ${response.status})`), {
      status: response.status,
    });
  }
  const document = await readJson(response);
  const parsed = parseCatalogDocument(document, { source: "served" });
  return {
    status: "ok",
    models: parsed.models,
    ...(nonEmpty(response.headers.get("etag")) === undefined
      ? {}
      : { etag: response.headers.get("etag") }),
  };
}

/**
 * Fetch the anonymous published catalog.
 *
 * It is trusted over pinned HTTPS and shape validation, not by checking the
 * sibling signature: the two documents are published separately (a doc and
 * sidecar fetched a moment apart can straddle a publish), and the host has no
 * signing mechanism to reuse. `expires_at` is recorded, not enforced.
 *
 * @param {{ fetchImpl?: typeof fetch, signal?: AbortSignal, etag?: string }} [options]
 * @returns {Promise<{ status: "ok", models: object[], version?: number, expiresAt?: string, etag?: string } | { status: "not-modified" }>}
 */
export async function fetchPublishedCatalog({ fetchImpl, signal, etag } = {}) {
  const headers = { Accept: "application/json" };
  if (etag !== undefined) headers["If-None-Match"] = etag;
  const response = await (fetchImpl ?? fetch)(PUBLISHED_CATALOG_URL, {
    method: "GET",
    headers,
    redirect: "error",
    signal: requestSignal(signal),
  });
  if (response.status === 304) return { status: "not-modified" };
  if (!response.ok) {
    throw Object.assign(new Error(`Claude published catalog failed (HTTP ${response.status})`), {
      status: response.status,
    });
  }
  const document = await readJson(response);
  if (document?.schema_version !== 1)
    throw new Error("Claude published catalog has an unsupported schema version");
  const parsed = parseCatalogDocument(document, { source: "published" });
  return {
    status: "ok",
    models: parsed.models,
    ...(parsed.version === undefined ? {} : { version: parsed.version }),
    ...(parsed.expiresAt === undefined ? {} : { expiresAt: parsed.expiresAt }),
    ...(nonEmpty(response.headers.get("etag")) === undefined
      ? {}
      : { etag: response.headers.get("etag") }),
  };
}
