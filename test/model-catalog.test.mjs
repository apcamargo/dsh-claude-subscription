/**
 * The catalog engine: TTL gating, single-flight publishes, last-known-good,
 * unset on removal, and the published reading.
 * @module test/model-catalog.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createModelCatalog } from "../lib/model-catalog.js";

const servedDocument = {
  model_selector_config: [
    {
      models: [
        {
          id: "claude-opus-5-5",
          name: "Opus 5.5",
          runtime: {
            max_input_tokens: 1_000_000,
            max_output_tokens: 128_000,
            effort_levels: ["low", "medium", "high", "xhigh", "max"],
            default_effort: "medium",
            family: "opus",
          },
        },
      ],
    },
  ],
};
const publishedDocument = {
  schema_version: 1,
  version: 7,
  expires_at: "2030-01-01T00:00:00Z",
  surfaces: {
    cc: {
      model_selector_config: [
        {
          models: [
            {
              id: "claude-sonnet-5-5",
              name: "Sonnet 5.5",
              runtime: {
                max_input_tokens: 1_000_000,
                max_output_tokens: 128_000,
                effort_levels: ["low", "high"],
                default_effort: "high",
              },
            },
          ],
        },
      ],
    },
  },
};

const settle = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

function harness({ credential = { oauth: true, apiKey: "token" }, answer } = {}) {
  const config = { catalog: { accounts: {}, published: {} } };
  const writes = [];
  let fetches = 0;
  const catalog = createModelCatalog({
    config,
    grants: { resolve: async () => credential },
    publish: async (path, value) => {
      writes.push({ path, value });
      let target = config;
      for (const key of path.slice(0, -1)) target = target[key] ??= {};
      target[path.at(-1)] = value;
    },
    unset: async (path) => {
      let target = config;
      for (const key of path.slice(0, -1)) target = target[key] ??= {};
      delete target[path.at(-1)];
    },
    isLive: () => true,
    debug: () => {},
    fetchImpl: async (url) => {
      fetches += 1;
      return (
        answer ??
        new Response(
          JSON.stringify(url.includes("downloads") ? publishedDocument : servedDocument),
          { status: 200 },
        )
      );
    },
  });
  return { catalog, config, writes, fetches: () => fetches };
}

test("an account reading is published once and reused inside the TTL", async () => {
  const h = harness();
  h.catalog.requestRefresh("route-a");
  await settle();
  assert.equal(h.fetches(), 1);
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.writes[0].path, ["catalog", "accounts", "route-a"]);
  assert.equal(h.writes[0].value.models[0].id, "claude-opus-5-5");
  assert.equal(h.writes[0].value.etag, null);
  assert.equal(typeof h.writes[0].value.fetchedAt, "number");

  h.catalog.requestRefresh("route-a");
  await settle();
  assert.equal(h.fetches(), 1, "a fresh reading is not refetched");

  h.catalog.requestRefresh("route-a", { immediate: true });
  await settle();
  assert.equal(h.fetches(), 2, "an explicit refresh bypasses the TTL");
  assert.equal(h.writes.length, 2);
});

test("the published reading is shared and published to its own key", async () => {
  const h = harness();
  h.catalog.requestPublished();
  await settle();
  assert.equal(h.fetches(), 1);
  assert.deepEqual(h.writes[0].path, ["catalog", "published"]);
  assert.equal(h.writes[0].value.version, 7);
  h.catalog.requestPublished();
  await settle();
  assert.equal(h.fetches(), 1);
});

test("an API-key credential never reads the account selector", async () => {
  const h = harness({ credential: { oauth: false, apiKey: "sk-ant-api" } });
  h.catalog.requestRefresh("route-a");
  await settle();
  assert.equal(h.fetches(), 0);
  assert.equal(h.writes.length, 0);
});

test("a 304 keeps the reading and does not republish it", async () => {
  const h = harness({ answer: new Response(null, { status: 304 }) });
  h.config.catalog.accounts["route-a"] = {
    fetchedAt: Date.now() - 25 * 60 * 60 * 1000,
    etag: "e",
    models: [],
  };
  h.catalog.requestRefresh("route-a");
  await settle();
  assert.equal(h.fetches(), 1);
  assert.equal(h.writes.length, 0, "a 304 publishes nothing");
  h.catalog.requestRefresh("route-a");
  await settle();
  assert.equal(h.fetches(), 1, "the checked reading stays fresh in-process");
});

test("a failed refresh backs off; an explicit refresh still tries", async () => {
  let fail = true;
  const config = { catalog: { accounts: {}, published: {} } };
  const writes = [];
  let fetches = 0;
  const catalog = createModelCatalog({
    config,
    grants: { resolve: async () => ({ oauth: true, apiKey: "token" }) },
    publish: async (path, value) => {
      writes.push({ path, value });
    },
    unset: async () => {},
    isLive: () => true,
    debug: () => {},
    fetchImpl: async () => {
      fetches += 1;
      if (fail) throw new Error("offline");
      return new Response(JSON.stringify(servedDocument), { status: 200 });
    },
  });
  catalog.requestRefresh("route-a");
  await settle();
  assert.equal(fetches, 1);
  catalog.requestRefresh("route-a");
  await settle();
  assert.equal(fetches, 1, "the backoff clock suppresses the automatic retry");
  fail = false;
  catalog.requestRefresh("route-a", { immediate: true });
  await settle();
  assert.equal(fetches, 2);
  assert.equal(writes.length, 1);
});
