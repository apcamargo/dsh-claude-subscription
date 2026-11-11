/**
 * The catalog sources: envelope parsing, the first-party filter, and the two
 * fetchers' request shape and status handling.
 * @module test/catalog-source.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  PUBLISHED_CATALOG_URL,
  SERVED_CATALOG_URL,
  fetchPublishedCatalog,
  fetchServedCatalog,
  parseCatalogDocument,
} from "../lib/catalog-source.js";

const opus = {
  id: "claude-opus-5-5",
  name: "Opus 5.5",
  section: "main",
  capabilities: { mm_images: true },
  thinking: { type: "effort", effort_options: [{ id: "low" }, { id: "medium" }] },
  runtime: {
    max_input_tokens: 1_000_000,
    max_output_tokens: 128_000,
    effort_levels: ["low", "medium", "high", "xhigh", "max"],
    default_effort: "medium",
    family: "opus",
  },
  min_claude_code_version: "2.1.322",
};
const haiku = {
  id: "claude-haiku-4-5-20251001",
  name: "Haiku 4.5",
  section: "overflow",
  capabilities: { mm_images: false },
  runtime: { max_input_tokens: 200_000, max_output_tokens: 64_000 },
};
const deprecated = { id: "claude-opus-4-0", name: "Opus 4", section: "deprecated" };
const malformed = { id: "NOT A MODEL", name: "bad" };

const servedDocument = {
  model_selector_state: [{ id: "cc" }],
  model_selector_config: [{ id: "cc", models: [opus, haiku, deprecated, opus, malformed] }],
  organization_uuid: "org",
  resolution: "account",
};

const publishedDocument = {
  schema_version: 1,
  version: 42,
  expires_at: "2030-01-01T00:00:00Z",
  surfaces: {
    cc: {
      model_selector_config: [
        {
          models: [
            opus,
            { ...haiku, offered_on: ["first_party", "bedrock"] },
            { ...deprecated, offered_on: ["first_party"] },
            { ...haiku, id: "claude-opus-4-1-20250805", offered_on: ["bedrock"] },
          ],
        },
      ],
    },
  },
};

test("a served document normalizes every row, deduped and without a first-party filter", () => {
  const parsed = parseCatalogDocument(servedDocument, { source: "served" });
  assert.deepEqual(
    parsed.models.map((model) => model.id),
    ["claude-opus-5-5", "claude-haiku-4-5-20251001"],
  );
  const first = parsed.models[0];
  assert.equal(first.name, "Opus 5.5");
  assert.equal(first.contextWindow, 1_000_000);
  assert.equal(first.maxTokens, 128_000);
  assert.deepEqual(first.effortLevels, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(first.defaultEffort, "medium");
  assert.deepEqual(first.input, ["text", "image"]);
  assert.equal(first.minVersion, "2.1.322");
  // No capabilities block means the plugin's default modality set.
  assert.deepEqual(parsed.models[1].input, ["text"]);
});

test("a published document filters to first-party models and carries the document facts", () => {
  const parsed = parseCatalogDocument(publishedDocument, { source: "published" });
  assert.deepEqual(
    parsed.models.map((model) => model.id),
    ["claude-opus-5-5", "claude-haiku-4-5-20251001"],
  );
  assert.equal(parsed.version, 42);
  assert.equal(parsed.expiresAt, "2030-01-01T00:00:00Z");
});

test("an empty or malformed catalog is refused rather than adopted", () => {
  assert.throws(() => parseCatalogDocument({}, { source: "served" }), /malformed|empty/);
  assert.throws(
    () => parseCatalogDocument({ model_selector_config: [{ models: [] }] }, { source: "served" }),
    /empty/,
  );
  assert.throws(
    () =>
      parseCatalogDocument(
        { model_selector_config: [{ models: [malformed] }] },
        { source: "served" },
      ),
    /empty/,
  );
});

test("the served fetch sends the account's identity headers and returns the etag", async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify(servedDocument), { status: 200, headers: { etag: "abc" } });
  };
  const answer = await fetchServedCatalog(
    { apiKey: "sk-ant-oat01-token" },
    { fetchImpl, etag: "prev" },
  );
  assert.equal(seen.url, SERVED_CATALOG_URL);
  assert.equal(seen.init.headers.Authorization, "Bearer sk-ant-oat01-token");
  assert.equal(seen.init.headers["anthropic-beta"], "oauth-2025-04-20");
  assert.equal(seen.init.headers["If-None-Match"], "prev");
  assert.match(seen.init.headers["User-Agent"], /^claude-code\//);
  assert.equal(answer.status, "ok");
  assert.equal(answer.etag, "abc");
  assert.equal(answer.models.length, 2);
});

test("the served fetch reports 304 and surfaces a refusal's status", async () => {
  const notModified = await fetchServedCatalog(
    { apiKey: "t" },
    {
      fetchImpl: async () => new Response(null, { status: 304 }),
    },
  );
  assert.equal(notModified.status, "not-modified");
  await assert.rejects(
    fetchServedCatalog(
      { apiKey: "t" },
      {
        fetchImpl: async () => new Response("{}", { status: 403 }),
      },
    ),
    (error) => error.status === 403,
  );
});

test("the published fetch validates the schema and reads the document facts", async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify(publishedDocument), {
      status: 200,
      headers: { etag: "pub" },
    });
  };
  const answer = await fetchPublishedCatalog({ fetchImpl });
  assert.equal(seen.url, PUBLISHED_CATALOG_URL);
  assert.equal(answer.status, "ok");
  assert.equal(answer.version, 42);
  assert.equal(answer.expiresAt, "2030-01-01T00:00:00Z");
  assert.equal(answer.etag, "pub");
  await assert.rejects(
    fetchPublishedCatalog({
      fetchImpl: async () => new Response(JSON.stringify({ schema_version: 2 }), { status: 200 }),
    }),
    /unsupported schema version/,
  );
});
