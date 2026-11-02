/**
 * Integration: the adapter end-to-end against a local mock Anthropic server,
 * the grant manager against an in-memory credential store, and the OAuth login
 * against a mocked token endpoint.
 * @module test/integration.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createAdapter } from "../lib/adapter.js";
import {
  allocateRoute,
  createGrantManager,
  hashRoute,
  identityOf,
  jsonImage,
  keyOf,
  routeOf,
  readStoredCredential,
  sameAccount,
} from "../lib/credentials.js";
import { CALLBACK_PORT, exchangeCode, login, refreshGrant } from "../lib/oauth.js";
import { buildAnthropicRequest } from "../lib/wire.js";

/** An in-memory credential store shaped like `ctx.credentials`. */
function memoryStore() {
  const records = new Map();
  const refs = new Map();
  return {
    records,
    refs,
    async readRecord(key) {
      return records.get(key);
    },
    async describeRecord(key) {
      const record = records.get(key);
      return record === undefined
        ? { key, configured: false }
        : { key, configured: true, kind: record.kind };
    },
    async listRecords() {
      return [...records].map(([key, record]) => ({ key, kind: record.kind }));
    },
    async modifyRecord(key, mutate) {
      // Match the real store: returning undefined from the mutation
      // DECLINES the write and leaves the entry untouched.
      const current = records.get(key);
      const next = await mutate(current);
      if (next === undefined) return current;
      records.set(key, next);
      return next;
    },
    async deleteRecord(key) {
      records.delete(key);
    },
    async resolve(ref) {
      const value = refs.get(ref);
      return value === undefined ? undefined : { ref, value };
    },
  };
}

function fakeCtx() {
  const services = new Map();
  return {
    get(name) {
      return services.get(name);
    },
    setService(name, service) {
      services.set(name, service);
    },
  };
}

const GRANT = {
  access: "sk-ant-oat01-example",
  refresh: "refresh-1",
  expires: Date.now() + 60 * 60 * 1000,
  email: "dev@example.com",
  orgName: "Example Org",
};

/** The route the fixture grant is stored on: the hash of its identity. */
const ROUTE = hashRoute(identityOf(GRANT));
/** That route's credential record key. */
const KEY = keyOf(ROUTE);

function setup(overrides = {}) {
  const ctx = fakeCtx();
  const store = memoryStore();
  ctx.setService("credentials", store);
  const refreshed = [];
  const grants = createGrantManager({
    ctx,
    refresh: async (grant) => {
      refreshed.push(grant.refresh);
      return { ...grant, access: `${grant.access}-next`, expires: Date.now() + 3600_000 };
    },
    ...overrides,
  });
  // A catalog reading, as the route would have fetched one.
  const config = {
    debug: false,
    extraBetas: [],
    catalog: {
      accounts: {
        [ROUTE]: {
          fetchedAt: Date.now(),
          models: [
            {
              id: "claude-opus-5-5",
              name: "Opus 5.5",
              contextWindow: 1_000_000,
              maxTokens: 128_000,
              effortLevels: ["low", "medium", "high", "xhigh", "max"],
              defaultEffort: "medium",
            },
            {
              id: "claude-sonnet-4-5",
              name: "Sonnet 4.5",
              contextWindow: 200_000,
              maxTokens: 64_000,
            },
            {
              id: "claude-haiku-4-5",
              name: "Haiku 4.5",
              contextWindow: 200_000,
              maxTokens: 64_000,
            },
          ],
        },
      },
    },
  };
  const debugs = [];
  const adapter = createAdapter({
    route: ROUTE,
    grants,
    config,
    debug: (message) => debugs.push(message),
    ctx,
  });
  return { ctx, store, grants, adapter, refreshed, config, debugs };
}

test("the adapter refuses to stream without a credential", async () => {
  const { adapter } = setup();
  await assert.rejects(
    adapter.prepareCall(ROUTE, "claude-opus-5-5", undefined),
    (error) => error.code === "MISSING_CREDENTIAL",
  );
});

test("prepareCall declares in-history on OAuth for every model, and never on an API key", async () => {
  const oauth = setup();
  await oauth.store.modifyRecord(KEY, () => ({ kind: "grant", payload: GRANT }));
  for (const model of ["claude-opus-5-5", "claude-sonnet-4-5"]) {
    const prepared = await oauth.adapter.prepareCall(ROUTE, model, undefined);
    assert.equal(prepared.model.systemPromptUpdate, "in-history", `${model} on OAuth`);
  }
  // resolveModel carries no capability: the catalog does not publish one,
  // and the OAuth extension lives on the prepared call only.
  assert.equal(
    oauth.adapter.resolveModel(ROUTE, "claude-sonnet-4-5").systemPromptUpdate,
    undefined,
  );

  const apiKey = setup();
  await apiKey.store.modifyRecord(KEY, () => ({ kind: "api-key", key: "sk-ant-api03-example" }));
  for (const model of ["claude-opus-5-5", "claude-sonnet-4-5"]) {
    assert.equal(
      (await apiKey.adapter.prepareCall(ROUTE, model, undefined)).model.systemPromptUpdate,
      undefined,
      `${model} on an API key`,
    );
  }

  // The kill switch removes the declaration from both surfaces and both paths.
  oauth.config.systemPromptUpdates = false;
  assert.equal(
    (await oauth.adapter.prepareCall(ROUTE, "claude-opus-5-5", undefined)).model.systemPromptUpdate,
    undefined,
  );
  assert.equal(oauth.adapter.resolveModel(ROUTE, "claude-opus-5-5").systemPromptUpdate, undefined);
});

test("imageRequestTarget reports the projection the wire actually sends", () => {
  const { adapter } = setup();
  // This route downscales, so it must override the harness's normalized
  // passthrough default (dsh-llm 0.2.1): a 48MP source lands inside the
  // 4.19-megapixel pixel budget, byte-capped at 1 MiB.
  const huge = { attachmentId: "a1", width: 8000, height: 6000, bytes: 5_000_000 };
  const target = adapter.imageRequestTarget(ROUTE, "claude-opus-5-5", huge);
  assert.ok(
    target.width * target.height <= 4194304,
    `${target.width}x${target.height} exceeds the pixel budget`,
  );
  assert.ok(
    target.width < huge.width && target.height < huge.height,
    "an oversized source must be downscaled",
  );
  assert.equal(target.maxBytes, 1048576);
  // A source already inside the budget keeps its normalized dimensions.
  const small = { attachmentId: "a2", width: 640, height: 480, bytes: 90_000 };
  assert.deepEqual(adapter.imageRequestTarget(ROUTE, "claude-opus-5-5", small), {
    width: 640,
    height: 480,
    maxBytes: 1048576,
  });
});

test("a stored OAuth grant resolves and streams against a local mock", async () => {
  const { store, adapter, config, debugs } = setup();
  await store.modifyRecord(KEY, () => ({ kind: "grant", payload: GRANT }));

  /** The wire facts the mock server observed. */
  const observed = {};
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      observed.headers = req.headers;
      observed.body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        [
          `event: message_start`,
          `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 2, output_tokens: 0 } } })}`,
          ``,
          `event: content_block_start`,
          `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } })}`,
          ``,
          `event: content_block_delta`,
          `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}`,
          ``,
          `event: content_block_stop`,
          `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
          ``,
          `event: content_block_start`,
          `data: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_int1", name: "_bash" } })}`,
          ``,
          `event: content_block_delta`,
          `data: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } })}`,
          ``,
          `event: content_block_stop`,
          `data: ${JSON.stringify({ type: "content_block_stop", index: 1 })}`,
          ``,
          `event: message_delta`,
          `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } })}`,
          ``,
          `event: message_stop`,
          `data: ${JSON.stringify({ type: "message_stop" })}`,
          ``,
        ].join("\n"),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  // Point the route at the mock through the same config object the adapter reads.
  config.baseUrl = `http://127.0.0.1:${port}`;

  try {
    const chunks = [];
    for await (const chunk of adapter.stream({
      provider: ROUTE,
      model: "claude-opus-5-5",
      system: "You are DeepSeek Harness.",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: [
        {
          name: "bash",
          description: "Run a shell command",
          parameters: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      ],
    })) {
      chunks.push(chunk);
    }
    assert.equal(chunks.at(-1).reason.kind, "tool-calls");
    assert.equal(chunks.at(-2).type, "usage");
    // Node lowercases observed request headers.
    assert.equal(observed.headers["x-app"], "cli");
    assert.match(observed.headers["user-agent"], /^claude-cli\//);
    assert.match(observed.headers["anthropic-beta"], /claude-code-20250219/);
    assert.match(observed.headers.authorization, /^Bearer sk-ant-oat01-example$/);
    assert.match(observed.body.metadata.user_id, /^user_[0-9a-f]{64}_account_/);
    assert.equal(observed.body.system[0].text.startsWith("x-anthropic-billing-header:"), true);
    assert.equal(
      observed.body.system[1].text,
      "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
    );
    assert.match(
      observed.body.messages[0].content[0].text,
      /^<system-reminder>\nYou are DeepSeek Harness\./,
    );
    assert.equal(observed.body.max_tokens, 64000);
    assert.match(observed.body.system[0].text, /cch=[0-9a-f]{5};/);
    // The streamed tool call arrives under the harness's own tool name: the
    // wire's `_` prefix (see the outgoing tools list) is stripped on the way
    // in, so dispatch never sees an unknown "_bash".
    assert.deepEqual(
      observed.body.tools.map((tool) => tool.name),
      ["_bash"],
    );
    const end = chunks.find(
      (chunk) => chunk.type === "block-end" && chunk.block?.type === "tool-call",
    );
    assert.equal(end.block.name, "bash");
    assert.equal(end.block.id, "toolu_int1");
    assert.ok(
      debugs.some((line) => line.startsWith("usage input=") && line.includes("cacheRead=")),
      "the debug log reports cache usage",
    );
  } finally {
    server.close();
  }
});

test("an in-history prompt update is appended as a user turn and the usage log reports the hit rate", async () => {
  const { store, adapter, config, debugs } = setup();
  await store.modifyRecord(KEY, () => ({ kind: "grant", payload: GRANT }));

  const observed = {};
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      observed.body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        [
          `event: message_start`,
          `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 700, cache_creation_input_tokens: 200 } } })}`,
          ``,
          `event: content_block_start`,
          `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } })}`,
          ``,
          `event: content_block_delta`,
          `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}`,
          ``,
          `event: content_block_stop`,
          `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
          ``,
          `event: message_delta`,
          `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}`,
          ``,
          `event: message_stop`,
          `data: ${JSON.stringify({ type: "message_stop" })}`,
          ``,
        ].join("\n"),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  config.baseUrl = `http://127.0.0.1:${port}`;

  try {
    for await (const _chunk of adapter.stream({
      provider: ROUTE,
      model: "claude-opus-5-5",
      system: "You are DeepSeek Harness.",
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        {
          role: "assistant",
          source: { kind: "model", provider: ROUTE, model: "claude-opus-5-5" },
          content: [{ type: "text", text: "ok" }],
        },
        {
          role: "system",
          source: { kind: "system-prompt" },
          content: [{ type: "text", text: "Plan mode is off. You may edit files." }],
        },
        { role: "user", content: [{ type: "text", text: "continue" }] },
      ],
      tools: [],
    })) {
      // drain the stream
    }
    // The subscription wire never sends a system role for an appended update.
    assert.equal(observed.body.messages.filter((message) => message.role === "system").length, 0);
    const reminder = observed.body.messages.at(-2);
    assert.equal(reminder.role, "user");
    assert.match(reminder.content[0].text, /^<system-reminder>\nPlan mode is off\./);
    assert.ok(
      debugs.some((line) => line.includes("cacheHit=70.0%") && line.includes("systemUpdates=1")),
      "the usage log reports the per-request hit rate and the retained update count",
    );
  } finally {
    server.close();
  }
});

test("a mid-stream connection reset classifies as TRANSPORT, not UNKNOWN", async () => {
  const { store, adapter, config } = setup();
  await store.modifyRecord(KEY, () => ({ kind: "grant", payload: GRANT }));

  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      [
        `event: message_start`,
        `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 2, output_tokens: 0 } } })}`,
        ``,
      ].join("\n"),
    );
    // Cut the socket without ending the response: the body read fails.
    setTimeout(() => res.destroy(), 10);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  config.baseUrl = `http://127.0.0.1:${port}`;

  try {
    await assert.rejects(
      async () => {
        for await (const chunk of adapter.stream({
          provider: ROUTE,
          model: "claude-opus-5-5",
          messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        })) {
          // Drain until the reset surfaces.
        }
      },
      (error) => error.code === "TRANSPORT",
    );
  } finally {
    server.close();
  }
});

test("a stale-consent 400 surfaces a re-login hint without changing its class", async () => {
  const { store, adapter, config } = setup();
  await store.modifyRecord(KEY, () => ({ kind: "grant", payload: GRANT }));

  // The consent-staleness error Anthropic returns when the stored grant
  // predates the current OAuth scope contract. The provider text alone
  // classifies as INVALID_REQUEST (it matches none of the quota/auth
  // wordings). The hint is appended after classification.
  const server = http.createServer((req, res) => {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Third-party apps now draw from your extra usage, not your plan limits.",
        },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  config.baseUrl = `http://127.0.0.1:${port}`;

  try {
    await assert.rejects(
      async () => {
        for await (const chunk of adapter.stream({
          provider: ROUTE,
          model: "claude-opus-5-5",
          messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        })) {
          // The failure throws before the first chunk.
        }
      },
      (error) => {
        assert.equal(error.code, "INVALID_REQUEST");
        assert.match(error.message, /Third-party apps now draw/);
        assert.match(error.message, /run \/claude-login and sign in again/);
        return true;
      },
    );
  } finally {
    server.close();
  }
});

test("a mid-stream abort fails as ABORTED", async () => {
  const { store, adapter, config } = setup();
  await store.modifyRecord(KEY, () => ({ kind: "grant", payload: GRANT }));

  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      [
        `event: message_start`,
        `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 2, output_tokens: 0 } } })}`,
        ``,
      ].join("\n"),
    );
    // Deliberately never ends: the caller's abort must break the read.
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  config.baseUrl = `http://127.0.0.1:${port}`;

  const controller = new AbortController();
  const streamed = (async () => {
    for await (const chunk of adapter.stream({
      provider: ROUTE,
      model: "claude-opus-5-5",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      signal: controller.signal,
    })) {
      // Drain until the abort surfaces.
    }
  })();
  setTimeout(() => controller.abort(), 20);
  try {
    await assert.rejects(streamed, (error) => error.code === "ABORTED");
  } finally {
    server.close();
  }
});

test("a thinking turn mints replay state that replays with its signature", async () => {
  const { store, adapter, config } = setup();
  await store.modifyRecord(KEY, () => ({ kind: "grant", payload: GRANT }));

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        [
          `event: message_start`,
          `data: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", model: "claude-opus-5-5", usage: { input_tokens: 2, output_tokens: 0 } } })}`,
          ``,
          `event: content_block_start`,
          `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking" } })}`,
          ``,
          `event: content_block_delta`,
          `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } })}`,
          ``,
          `event: content_block_delta`,
          `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG" } })}`,
          ``,
          `event: content_block_stop`,
          `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
          ``,
          `event: content_block_start`,
          `data: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "text" } })}`,
          ``,
          `event: content_block_delta`,
          `data: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ok" } })}`,
          ``,
          `event: content_block_stop`,
          `data: ${JSON.stringify({ type: "content_block_stop", index: 1 })}`,
          ``,
          `event: message_delta`,
          `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } })}`,
          ``,
          `event: message_stop`,
          `data: ${JSON.stringify({ type: "message_stop" })}`,
          ``,
        ].join("\n"),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  config.baseUrl = `http://127.0.0.1:${port}`;

  try {
    const chunks = [];
    for await (const chunk of adapter.stream({
      provider: ROUTE,
      model: "claude-opus-5-5",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    })) {
      chunks.push(chunk);
    }
    const finish = chunks.at(-1);
    assert.equal(finish.reason.kind, "stop");
    assert.equal(finish.replayState.kind, "claude-subscription");
    assert.deepEqual(finish.replayState.blocks, [
      { type: "reasoning", thinkingSignature: "SIG" },
      { type: "text" },
    ]);

    // Replay the accumulated assistant message on the wire: the thinking
    // block survives with the signature this adapter minted.
    const assistant = {
      role: "assistant",
      content: chunks.filter((chunk) => chunk.type === "block-end").map((chunk) => chunk.block),
      source: {
        kind: "model",
        provider: ROUTE,
        model: "claude-opus-5-5",
        replayState: finish.replayState,
      },
    };
    const request = buildAnthropicRequest({
      model: {
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
        compat: {
          forceAdaptiveThinking: true,
          supportsTemperature: false,
          supportsStrictTools: true,
        },
      },
      messages: [assistant],
      oauth: true,
      apiKey: "sk-ant-oat01-example0token",
      reasoning: "high",
    });
    const json = JSON.parse(Buffer.from(request.body).toString("utf8"));
    const thinking = json.messages
      .find((message) => message.role === "assistant")
      .content.find((block) => block.type === "thinking");
    assert.deepEqual(thinking, { type: "thinking", thinking: "hmm", signature: "SIG" });
  } finally {
    server.close();
  }
});

test("an expired grant refreshes exactly once under concurrent streams", async () => {
  const { store, grants, refreshed } = setup();
  const stale = { ...GRANT, access: "sk-ant-oat01-stale", expires: Date.now() - 1000 };
  await store.modifyRecord(KEY, () => ({ kind: "grant", payload: stale }));

  const [first, second] = await Promise.all([
    grants.resolve({ route: ROUTE }),
    grants.resolve({ route: ROUTE }),
  ]);
  assert.equal(first.apiKey, "sk-ant-oat01-stale-next");
  assert.equal(second.apiKey, first.apiKey, "both callers share one refresh");
  assert.deepEqual(refreshed, ["refresh-1"], "exactly one network refresh");

  // The refreshed grant is persisted.
  const stored = readStoredCredential(await store.readRecord(KEY));
  assert.equal(stored.grant.access, "sk-ant-oat01-stale-next");
  assert.ok(stored.grant.expires > Date.now() + 30 * 60 * 1000);
});

test("a logout during an in-flight refresh is not resurrected", async () => {
  let releaseRefresh;
  const gate = new Promise((resolve) => {
    releaseRefresh = resolve;
  });
  const { store, grants } = setup({
    refresh: async (grant) => {
      await gate;
      return { ...grant, access: `${grant.access}-next`, expires: Date.now() + 3600_000 };
    },
  });
  await store.modifyRecord(KEY, () => ({
    kind: "grant",
    payload: { ...GRANT, expires: Date.now() - 1000 },
  }));

  const pending = grants.resolve({ route: ROUTE });
  await store.deleteRecord(KEY); // the user logs out mid-refresh
  releaseRefresh();

  const credential = await pending;
  // The in-flight request still gets the fresh token, but the store keeps
  // the deletion: a refresh must never resurrect a logged-out credential.
  assert.equal(credential.oauth, true);
  assert.equal(credential.apiKey, "sk-ant-oat01-example-next");
  assert.equal(await store.readRecord(KEY), undefined);
});

test("a concurrently rotated grant wins over the in-flight refresh", async () => {
  let releaseRefresh;
  const gate = new Promise((resolve) => {
    releaseRefresh = resolve;
  });
  const { store, grants } = setup({
    refresh: async (grant) => {
      await gate;
      return { ...grant, access: `${grant.access}-next`, expires: Date.now() + 3600_000 };
    },
  });
  await store.modifyRecord(KEY, () => ({
    kind: "grant",
    payload: { ...GRANT, refresh: "r1", expires: Date.now() - 1000 },
  }));

  const pending = grants.resolve({ route: ROUTE });
  // Another process rotates the refresh token while the refresh is in flight.
  await store.modifyRecord(KEY, () => ({
    kind: "grant",
    payload: {
      ...GRANT,
      access: "sk-ant-oat01-rotated",
      refresh: "r2",
      expires: Date.now() + 3600_000,
    },
  }));
  releaseRefresh();

  const credential = await pending;
  assert.equal(
    credential.apiKey,
    "sk-ant-oat01-rotated",
    "the rotation wins; the stale write is declined",
  );
  assert.equal(readStoredCredential(await store.readRecord(KEY)).grant.refresh, "r2");
});

test("an explicit commit lands on an empty store", async () => {
  const { store, grants } = setup();
  await grants.commit({ key: "sk-ant-api03-example" }, undefined, ROUTE);
  assert.equal(readStoredCredential(await store.readRecord(KEY))?.apiKey, "sk-ant-api03-example");
});

test("an aborted caller starts no refresh work", async () => {
  const { store, grants, refreshed } = setup();
  await store.modifyRecord(KEY, () => ({
    kind: "grant",
    payload: { ...GRANT, expires: Date.now() - 1000 },
  }));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(grants.resolve({ route: ROUTE, signal: controller.signal }));
  assert.deepEqual(refreshed, [], "no network refresh for an aborted caller");
  assert.equal(
    readStoredCredential(await store.readRecord(KEY)).grant.access,
    GRANT.access,
    "nothing committed",
  );
});

test("a dropped resolve() promise never surfaces as an unhandled rejection", async () => {
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    const { store, grants } = setup({
      refresh: async () => {
        throw new Error("refresh failed");
      },
    });
    await store.modifyRecord(KEY, () => ({
      kind: "grant",
      payload: { ...GRANT, expires: Date.now() - 1000 },
    }));
    grants.resolve({ route: ROUTE }); // deliberately not awaited: the caller dropped it
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(rejections, []);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

test("a failing store surfaces delete errors instead of a silent success", async () => {
  const { ctx, grants } = setup();
  const failing = memoryStore();
  failing.deleteRecord = async () => {
    throw new Error("credentials-local is disposed: cannot delete");
  };
  ctx.setService("credentials", failing);
  await assert.rejects(grants.deleteCredential(ROUTE), /disposed/);
});

test("a stored api-key record takes the non-OAuth path without refresh", async () => {
  const { store, grants, refreshed, adapter } = setup();
  await store.modifyRecord(KEY, () => ({ kind: "api-key", key: "sk-ant-api03-example" }));
  const credential = await grants.resolve({ route: ROUTE });
  assert.deepEqual(credential, { oauth: false, apiKey: "sk-ant-api03-example" });
  assert.equal(refreshed.length, 0);
  // prepareCall succeeds without any refresh round trip.
  const prepared = await adapter.prepareCall(ROUTE, "claude-haiku-4-5", undefined);
  assert.equal(prepared.model.id, "claude-haiku-4-5");
});

test("describe reads one account's identity and flags per route", async () => {
  const { store, grants } = setup();
  // No credential: not configured.
  assert.deepEqual(await grants.describe(ROUTE), { configured: false, route: ROUTE });
  // An API-key record carries no account identity.
  await store.modifyRecord(KEY, () => ({ kind: "api-key", key: "sk-ant-api03-example" }));
  const apiKeyAccount = await grants.describe(ROUTE);
  assert.equal(apiKeyAccount.configured, true);
  assert.equal(apiKeyAccount.oauth, false);
  // The OAuth grant's captured identity is the mirror's value.
  await store.modifyRecord(KEY, () => ({
    kind: "grant",
    payload: jsonImage({ ...GRANT, accountId: "acc-1", orgId: "org-1" }),
  }));
  const oauthAccount = await grants.describe(ROUTE);
  assert.equal(oauthAccount.email, "dev@example.com");
  assert.equal(oauthAccount.route, ROUTE);
  // A second account describes independently.
  const secondKey = "claude-subscription/claude-subscription-111111111111";
  await store.modifyRecord(secondKey, () => ({
    kind: "grant",
    payload: jsonImage({ ...GRANT, email: "other@example.com", accountId: "acc-2" }),
  }));
  assert.equal(
    (await grants.describe("claude-subscription-111111111111")).email,
    "other@example.com",
  );
  assert.equal((await grants.describe(ROUTE)).email, "dev@example.com");
});

test("listAccounts lists every record in the scope, in sign-in order", async () => {
  const { store, grants } = setup();
  await store.modifyRecord("claude-subscription/login-staging", () => ({
    kind: "grant",
    payload: jsonImage({ ...GRANT }),
  }));
  await store.modifyRecord("claude-subscription/not-a-route", () => ({
    kind: "grant",
    payload: jsonImage({ ...GRANT }),
  }));
  await store.modifyRecord(KEY, () => ({
    kind: "grant",
    payload: jsonImage({ ...GRANT, addedAt: 200 }),
  }));
  await store.modifyRecord("claude-subscription/claude-subscription-111111111111", () => ({
    kind: "grant",
    payload: jsonImage({ ...GRANT, email: "other@example.com", accountId: "acc-2", addedAt: 100 }),
  }));
  const accounts = await grants.listAccounts();
  // The staging record and the hand-added foreign id are not accounts.
  assert.deepEqual(
    accounts.map((account) => account.route),
    ["claude-subscription-111111111111", ROUTE],
  );
  assert.deepEqual(
    accounts.map((account) => account.email),
    ["other@example.com", "dev@example.com"],
  );
});

test("resolve serves each account's own credential and refreshes per key", async () => {
  const { store, grants, refreshed } = setup();
  const stale = { ...GRANT, accountId: "acc-1", refresh: "r-legacy", expires: Date.now() - 1000 };
  const second = {
    ...GRANT,
    accountId: "acc-2",
    email: "other@example.com",
    refresh: "r-second",
    expires: Date.now() - 1000,
  };
  await store.modifyRecord(KEY, () => ({ kind: "grant", payload: jsonImage(stale) }));
  await store.modifyRecord("claude-subscription/claude-subscription-111111111111", () => ({
    kind: "grant",
    payload: jsonImage(second),
  }));
  const first = await grants.resolve({ route: ROUTE });
  const secondResolved = await grants.resolve({ route: "claude-subscription-111111111111" });
  assert.equal(first.apiKey, "sk-ant-oat01-example-next");
  assert.equal(secondResolved.apiKey, "sk-ant-oat01-example-next");
  // Each account refreshed exactly once, against its own refresh token.
  assert.deepEqual(refreshed, ["r-legacy", "r-second"]);
});

test("two accounts refresh concurrently, each exactly once (single-flight is per key)", async () => {
  const { store, grants, refreshed } = setup();
  const secondRoute = "claude-subscription-111111111111";
  const stale = { ...GRANT, accountId: "acc-1", refresh: "r-legacy", expires: Date.now() - 1000 };
  const second = {
    ...GRANT,
    accountId: "acc-2",
    email: "other@example.com",
    refresh: "r-second",
    expires: Date.now() - 1000,
  };
  await store.modifyRecord(KEY, () => ({ kind: "grant", payload: jsonImage(stale) }));
  await store.modifyRecord(`claude-subscription/${secondRoute}`, () => ({
    kind: "grant",
    payload: jsonImage(second),
  }));
  // Both resolves start in the same tick: each key gets its own in-flight
  // refresh, and neither blocks or duplicates the other.
  const [first, secondResolved] = await Promise.all([
    grants.resolve({ route: ROUTE }),
    grants.resolve({ route: secondRoute }),
  ]);
  assert.equal(first.apiKey, "sk-ant-oat01-example-next");
  assert.equal(secondResolved.apiKey, "sk-ant-oat01-example-next");
  assert.deepEqual(
    [...refreshed].sort(),
    ["r-legacy", "r-second"],
    "each key refreshed exactly once under concurrency",
  );
});

test("a route's needsReauth flag flips on a status-coded refusal only, and clears on the next success", async () => {
  const store = memoryStore();
  const ctx = fakeCtx();
  ctx.setService("credentials", store);
  let mode = "refused";
  let refusalStatus = 400;
  const grants = createGrantManager({
    ctx,
    refresh: async () => {
      // The token endpoint's status is the signal. The message is not.
      if (mode === "refused")
        throw Object.assign(new Error("invalid_grant"), { status: refusalStatus });
      if (mode === "transient")
        throw new Error("Anthropic token refresh failed (HTTP 400): invalid_grant");
      return { ...GRANT, access: "sk-ant-oat01-fresh", expires: Date.now() + 3600_000 };
    },
  });
  const stale = () =>
    store.modifyRecord(KEY, () => ({
      kind: "grant",
      payload: jsonImage({ ...GRANT, refresh: "r1", expires: Date.now() - 1000 }),
    }));

  // An offline-style failure carries no status: transient, not a refusal.
  await stale();
  mode = "transient";
  await assert.rejects(grants.resolve({ route: ROUTE }));
  assert.equal(
    grants.isReauth(ROUTE),
    false,
    "a message that merely contains HTTP 400 is not a refusal signal",
  );

  // A server error carries a status but is transient, not a refusal.
  await stale();
  mode = "refused";
  refusalStatus = 500;
  await assert.rejects(grants.resolve({ route: ROUTE }));
  assert.equal(grants.isReauth(ROUTE), false, "HTTP 500 does not mark needsReauth");

  // Every token-endpoint refusal status (REAUTH_STATUSES) needs a fresh sign-in.
  for (const status of [400, 401, 403]) {
    await stale();
    refusalStatus = status;
    await assert.rejects(grants.resolve({ route: ROUTE }));
    assert.equal(grants.isReauth(ROUTE), true, `HTTP ${status} marks needsReauth`);
    // A successful refresh clears it before the next status.
    await stale();
    mode = "ok";
    await grants.resolve({ route: ROUTE });
    assert.equal(grants.isReauth(ROUTE), false, "a successful refresh clears it");
    mode = "refused";
  }
});

test("adopt stores a new grant on its hash route and re-sign-ins keep their place", async () => {
  const { store, grants } = setup();
  const first = await grants.adopt(
    jsonImage({ ...GRANT, accountId: "acc-1", orgId: "org-1", addedAt: 5 }),
  );
  assert.equal(first.outcome, "created");
  assert.match(first.route, /^claude-subscription-[0-9a-f]{12}$/);
  // A re-sign-in of the same account is a refresh on the same route, and
  // the account keeps its sign-in order.
  const again = await grants.adopt(
    jsonImage({ ...GRANT, accountId: "acc-1", orgId: "org-1", access: "sk-ant-oat01-new" }),
  );
  assert.equal(again.route, first.route);
  assert.equal(again.outcome, "refreshed");
  const stored = readStoredCredential(await store.readRecord(keyOf(first.route)));
  assert.equal(stored.grant.access, "sk-ant-oat01-new");
  assert.equal(stored.grant.addedAt, 5);
  // A different account gets the hash route.
  const other = await grants.adopt(
    jsonImage({ ...GRANT, accountId: "acc-2", email: "other@example.com" }),
  );
  assert.equal(
    other.route,
    hashRoute(identityOf({ accountId: "acc-2", email: "other@example.com" })),
  );
  assert.equal(other.outcome, "created");
});

test("a deleted account is reallocated on re-login: the same hash route, a fresh allocation", async () => {
  const { store, grants } = setup();
  // Deleting an account's record removes the account; a later sign-in is a
  // fresh allocation on the same deterministic hash route.
  await grants.adopt(jsonImage({ ...GRANT, accountId: "acc-1", email: "one@example.com" }));
  const route = hashRoute(identityOf({ accountId: "acc-2", email: "other@example.com" }));
  await grants.adopt(jsonImage({ ...GRANT, accountId: "acc-2", email: "other@example.com" }));
  await store.deleteRecord(`claude-subscription/${route}`);
  const again = await grants.adopt(
    jsonImage({ ...GRANT, accountId: "acc-2", email: "other@example.com" }),
  );
  assert.equal(again.route, route, "the deterministic hash route is stable");
  assert.equal(again.outcome, "created", "a fresh allocation, not a restore");
});

test("hasStore distinguishes an unavailable credentials service from an empty store", async () => {
  const present = setup();
  assert.equal(present.grants.hasStore(), true);
  const absent = createGrantManager({ ctx: fakeCtx(), refresh: async (grant) => grant });
  assert.equal(absent.hasStore(), false);
  assert.deepEqual(await absent.listAccounts(), []);
});

test("route identity helpers", () => {
  // Only the plugin's own route ids are account routes. The staging record and
  // hand-added ids are not.
  assert.equal(routeOf("claude-subscription/login-staging"), undefined);
  assert.equal(
    routeOf("claude-subscription/claude-subscription-111111111111"),
    "claude-subscription-111111111111",
  );
  assert.equal(routeOf("other/claude-subscription"), undefined);
  assert.equal(routeOf("claude-subscription/claude-subscription-xyz"), undefined);
  // A personal plan and a Team seat share the account id and email. The
  // organization is what separates them.
  const personal = identityOf({
    accountId: "acc-1",
    orgId: "org-personal",
    email: "Dev@Example.com",
  });
  const team = identityOf({ accountId: "acc-1", orgId: "org-team", email: "dev@example.com" });
  assert.equal(sameAccount(personal, team), false);
  assert.equal(
    sameAccount(personal, identityOf({ accountId: "acc-1", email: "dev@example.com" })),
    true,
    "an org-less side matches on the person",
  );
  // Without account ids, the lowercased email decides.
  assert.equal(
    sameAccount(identityOf({ email: "A@x.com" }), identityOf({ email: "a@x.com" })),
    true,
  );
  assert.equal(
    sameAccount(identityOf({ email: "a@x.com" }), identityOf({ email: "b@x.com" })),
    false,
  );
  // The hash route has a fixed shape.
  assert.match(hashRoute(personal), /^claude-subscription-[0-9a-f]{12}$/);
  // An identity-less grant gets a random route; an identity-bearing one is
  // always hashed, even when it is the only account.
  const random = allocateRoute({
    identity: {},
    accounts: [{ route: ROUTE, identity: identityOf({ accountId: "acc-1" }) }],
  });
  assert.match(random.route, /^claude-subscription-[0-9a-f]{12}$/);
  assert.equal(random.outcome, "created");
  assert.deepEqual(
    allocateRoute({
      identity: identityOf({ accountId: "a" }),
      accounts: [{ route: "x", identity: identityOf({ accountId: "a" }) }],
    }),
    {
      route: "x",
      outcome: "refreshed",
    },
  );
});

test("exchangeCode translates the token response and captures identity", async () => {
  const originalFetch = globalThis.fetch;
  const tokenBody = {
    access_token: "sk-ant-oat01-new",
    refresh_token: "refresh-2",
    expires_in: 3600,
    account: { uuid: "acc-1", email_address: "dev@example.com" },
    organization: { uuid: "org-1", name: "Example Org" },
  };
  globalThis.fetch = async (url) => ({
    ok: true,
    text: async () => JSON.stringify(tokenBody),
    url,
  });
  try {
    const { grant } = await exchangeCode({
      code: "code-1",
      state: "state-1",
      verifier: "v",
      redirectUri: "http://localhost:54545/callback",
    });
    assert.equal(grant.access, "sk-ant-oat01-new");
    assert.equal(grant.email, "dev@example.com");
    assert.equal(grant.orgId, "org-1");
    assert.ok(grant.expires > Date.now() + 30 * 60 * 1000, "expires is skew-adjusted");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the login flow commits through the session and races paste against the callback", async () => {
  const originalFetch = globalThis.fetch;
  let tokenRequests = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/v1/oauth/token")) {
      tokenRequests += 1;
      const body = JSON.parse(init.body);
      assert.equal(body.grant_type, "authorization_code");
      assert.equal(body.code, "code-from-server");
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            access_token: "sk-ant-oat01-x",
            refresh_token: "r",
            expires_in: 3600,
            account: { uuid: "a", email_address: "e@x.com" },
          }),
      };
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const committed = [];
  const notices = [];
  const session = {
    signal: new AbortController().signal,
    notify: (notice) => notices.push(notice),
    prompt: async () => {
      // The paste loser: resolve only after the callback has won the race.
      await new Promise((resolve) => setTimeout(resolve, 150));
      return "code-from-paste";
    },
    commit: async (record) => committed.push(record),
  };

  // Drive the callback server by hand with the REAL fetch (the mock above only
  // answers the token endpoint): extract the authorize URL, hit the redirect
  // with the code, and let the flow settle.
  const loginPromise = login({ session, openBrowser: false });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(notices.length, 1);
  const authorizeUrl = new URL(notices[0].url);
  assert.equal(authorizeUrl.origin, "https://claude.ai");
  const state = authorizeUrl.searchParams.get("state");
  const callback = await originalFetch(
    `http://127.0.0.1:54545/callback?code=code-from-server&state=${state}`,
  );
  assert.match(await callback.text(), /Login complete/);
  const grant = await loginPromise;

  assert.equal(tokenRequests, 1);
  assert.equal(grant.access, "sk-ant-oat01-x");
  assert.equal(committed.length, 0, "the flow returns the grant; the seam commits");
  globalThis.fetch = originalFetch;
});

// ---- token-response validation (fail fast, keep the old grant) --------------

test("the token endpoints fail fast on a malformed 2xx body, and a refusal carries its status", async () => {
  const originalFetch = globalThis.fetch;
  try {
    // A 2xx body missing any required member is a failure, not a half-grant.
    for (const body of [
      { refresh_token: "r", expires_in: 3600 },
      { access_token: "sk-ant-oat01-x", expires_in: 3600 },
      { access_token: "sk-ant-oat01-x", refresh_token: "r" },
    ]) {
      globalThis.fetch = async () => ({ ok: true, text: async () => JSON.stringify(body) });
      await assert.rejects(
        exchangeCode({
          code: "c",
          state: "s",
          verifier: "v",
          redirectUri: "http://localhost:54545/callback",
        }),
        /Anthropic token exchange/,
      );
    }

    const grant = { access: "sk-ant-oat01-old", refresh: "r1", expires: Date.now() + 60_000 };
    globalThis.fetch = async () => ({
      ok: true,
      text: async () => JSON.stringify({ access_token: "sk-ant-oat01-y" }),
    });
    await assert.rejects(refreshGrant(grant), /non-numeric expires_in/);
    globalThis.fetch = async () => ({
      ok: true,
      text: async () => JSON.stringify({ refresh_token: "r2", expires_in: 3600 }),
    });
    await assert.rejects(refreshGrant(grant), /no access token/);
    // Rotation may omit the refresh token: the stored one stays.
    globalThis.fetch = async () => ({
      ok: true,
      text: async () => JSON.stringify({ access_token: "sk-ant-oat01-new", expires_in: 3600 }),
    });
    const next = await refreshGrant(grant);
    assert.equal(next.access, "sk-ant-oat01-new");
    assert.equal(next.refresh, "r1", "an omitted rotation token falls back to the stored one");

    // A refusal rides on the status so callers can classify it without
    // parsing the message.
    globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => "invalid_grant" });
    await assert.rejects(refreshGrant({ ...GRANT }), (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /HTTP 400/);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("refreshGrant only calls the token endpoint and keeps the stored plan", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const requested = [];
    globalThis.fetch = async (url) => {
      requested.push(String(url));
      return {
        ok: true,
        text: async () => JSON.stringify({ access_token: "sk-ant-oat01-new", expires_in: 3600 }),
      };
    };
    const next = await refreshGrant({ ...GRANT, plan: "Pro" });
    assert.deepEqual(
      requested,
      ["https://api.anthropic.com/v1/oauth/token"],
      "no cosmetic profile request on the refresh path",
    );
    assert.equal(
      next.plan,
      "Pro",
      "the stored plan is kept; the mount sweep and the usage engine refresh it",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a malformed refresh response leaves the stored grant intact", async () => {
  const { store, grants } = setup({
    refresh: async () => {
      throw new Error(
        "Anthropic token refresh returned a non-numeric expires_in. url=https://api.anthropic.com/v1/oauth/token",
      );
    },
  });
  await store.modifyRecord(KEY, () => ({
    kind: "grant",
    payload: { ...GRANT, expires: Date.now() - 1000 },
  }));
  await assert.rejects(grants.resolve({ route: ROUTE }), /non-numeric expires_in/);
  const stored = readStoredCredential(await store.readRecord(KEY));
  assert.equal(stored.grant.access, GRANT.access, "the old grant survives a failed refresh");
});

test("the login grant round-trips the store's strict JSON validation", async () => {
  const originalFetch = globalThis.fetch;
  // No organization in the body: every identity member starts undefined, so
  // the committed payload must be normalized (jsonImage) before it can pass
  // the store's assertJsonValue.
  globalThis.fetch = async () => ({
    ok: true,
    text: async () =>
      JSON.stringify({
        access_token: "sk-ant-oat01-x",
        refresh_token: "r",
        expires_in: 3600,
        account: { uuid: "a-1", email_address: "e@x.com" },
      }),
  });
  try {
    const { grant } = await exchangeCode({
      code: "c",
      state: "s",
      verifier: "v",
      redirectUri: "http://localhost:54545/callback",
    });
    const payload = jsonImage(grant);
    // The token body named the account but no organization: the org members
    // start undefined and must be stripped, or assertJsonValue would reject
    // the commit after the browser dance.
    assert.deepEqual(Object.keys(payload).sort(), [
      "access",
      "accountId",
      "email",
      "expires",
      "refresh",
    ]);
    assert.ok(!("orgId" in payload) && !("orgName" in payload));
    assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload, "lossless JSON round-trip");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---- OAuth state + callback-server handling ---------------------------------

test("a callback whose state does not match the login attempt is rejected", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new Error(`unexpected token exchange ${url}`);
  };
  try {
    for (const query of ["code=x&state=not-the-state", "code=x"]) {
      let authorizeUrl;
      const session = {
        signal: new AbortController().signal,
        notify: (notice) => {
          authorizeUrl = notice.url;
        },
        // The seam withdraws the losing prompt through its own signal. A
        // prompt stub must honor it or the race's loser lingers.
        prompt: (prompt) =>
          new Promise((_resolve, reject) => {
            prompt.signal?.addEventListener("abort", () => reject(new Error("withdrawn")), {
              once: true,
            });
          }),
        commit: async () => {},
      };
      const loginPromise = login({ session, openBrowser: false });
      // The login rejects the moment the callback server answers, while
      // this test is still parked on the fetch below, so observe the
      // rejection at creation time instead of after the fetch resolves.
      const settled = loginPromise.catch((error) => error);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const state = new URL(authorizeUrl).searchParams.get("state");
      assert.ok(state, "the authorize URL carries the state");
      const callback = await originalFetch(`http://127.0.0.1:${CALLBACK_PORT}/callback?${query}`);
      assert.equal(callback.status, 400);
      const error = await settled;
      assert.match(error.message, /state mismatch/);
      await new Promise((resolve) => setTimeout(resolve, 10)); // let the server close settle
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a pasted redirect with a mismatched state is rejected; a bare code still works", async () => {
  const originalFetch = globalThis.fetch;
  let tokenCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/v1/oauth/token")) tokenCalls += 1;
    return {
      ok: true,
      url,
      text: async () =>
        JSON.stringify({
          access_token: "sk-ant-oat01-paste",
          refresh_token: "r-paste",
          expires_in: 3600,
          account: { uuid: "a", email_address: "e@x.com" },
        }),
    };
  };
  try {
    const declined = {
      signal: new AbortController().signal,
      notify: () => {},
      prompt: async () => "code-x#wrong-state",
      commit: async () => {},
    };
    await assert.rejects(
      login({ session: declined, openBrowser: false }),
      /Pasted redirect state does not match/,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const accepted = {
      signal: new AbortController().signal,
      notify: () => {},
      prompt: async () => "code-from-server",
      commit: async () => {},
    };
    const grant = await login({ session: accepted, openBrowser: false });
    assert.equal(grant.access, "sk-ant-oat01-paste");
    assert.equal(tokenCalls, 1, "only the bare-code paste reaches the token endpoint");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("login falls back to paste and names the failure when the callback port is taken", async () => {
  const blocker = http.createServer(() => {});
  await new Promise((resolve) => blocker.listen(CALLBACK_PORT, "127.0.0.1", resolve));
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          access_token: "sk-ant-oat01-pasted",
          refresh_token: "r",
          expires_in: 3600,
          account: { uuid: "a", email_address: "e@x.com" },
        }),
    });
    let promptMessage;
    const session = {
      signal: new AbortController().signal,
      notify: () => {},
      prompt: async (prompt) => {
        promptMessage = prompt.message;
        return "code-from-paste";
      },
      commit: async () => {},
    };
    const grant = await login({ session, openBrowser: false });
    assert.equal(grant.access, "sk-ant-oat01-pasted", "the paste path completes the login");
    assert.match(promptMessage, /callback server could not start/);
    assert.match(promptMessage, /EADDRINUSE/);
  } finally {
    globalThis.fetch = originalFetch;
    blocker.close();
  }
});
