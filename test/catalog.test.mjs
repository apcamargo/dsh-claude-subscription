/**
 * The runtime catalog mapping: fetched entries to servable specs, saved-list
 * resolution, behaviour heuristics, and the harness projection. A route serves
 * its reading.
 * @module test/catalog.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  availableCatalog,
  behaviorFor,
  discoveryModels,
  entryToSpec,
  resolveCatalog,
  specForRequest,
  supportedLevels,
  toHarnessModel,
} from "../lib/catalog.js";

const opus = {
  id: "claude-opus-5-5",
  name: "Opus 5.5",
  contextWindow: 900_000,
  maxTokens: 100_000,
  input: ["text", "image"],
  effortLevels: ["low", "medium", "high", "xhigh", "max"],
  defaultEffort: "medium",
};
const haiku = {
  id: "claude-haiku-4-5-20251001",
  name: "Haiku 4.5",
  contextWindow: 200_000,
  maxTokens: 64_000,
  input: ["text"],
};

test("the account reading wins; the published one is the fallback; neither is empty", () => {
  const served = availableCatalog([opus, haiku], [{ id: "claude-sonnet-5-5", name: "Sonnet 5.5" }]);
  assert.deepEqual(
    served.map((model) => model.id),
    ["claude-opus-5-5", "claude-haiku-4-5-20251001"],
  );
  const published = availableCatalog(undefined, [
    { id: "claude-sonnet-5-5", name: "Sonnet 5.5", contextWindow: 500_000, maxTokens: 64_000 },
  ]);
  assert.deepEqual(
    published.map((model) => model.id),
    ["claude-sonnet-5-5"],
  );
  assert.deepEqual(availableCatalog(undefined, undefined), []);
  assert.deepEqual(availableCatalog([], []), []);
});

test("a reading maps its capacities, modalities, ladder, and default effort", () => {
  const spec = entryToSpec(opus);
  assert.equal(spec.name, "Claude Opus 5.5");
  assert.equal(spec.contextWindow, 900_000);
  assert.equal(spec.maxTokens, 100_000);
  assert.deepEqual(spec.input, ["text", "image"]);
  assert.deepEqual(supportedLevels(spec), ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(spec.defaultEffort, "medium");
  assert.equal(spec.compat?.forceAdaptiveThinking, true);
  assert.equal(spec.compat?.supportsTemperature, false);
});

test("a row without a ladder gets one only when its family predates adaptive thinking", () => {
  assert.deepEqual(supportedLevels(entryToSpec(haiku)), [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
  ]);
  assert.deepEqual(supportedLevels(entryToSpec({ id: "claude-opus-6" })), []);
  assert.equal(entryToSpec(haiku).contextWindow, 200_000);
  assert.deepEqual(entryToSpec(haiku).input, ["text"]);
  // An entry that discloses nothing falls back to the neutral defaults.
  const bare = entryToSpec({ id: "claude-haiku-4-9" });
  assert.equal(bare.contextWindow, DEFAULT_CONTEXT_WINDOW);
  assert.equal(bare.maxTokens, DEFAULT_MAX_TOKENS);
});

test("a saved list replaces the reading and inherits its values", () => {
  const available = availableCatalog([opus, haiku], undefined);
  const [spec] = resolveCatalog([{ id: "claude-opus-5-5" }], available);
  assert.equal(spec.name, "Claude Opus 5.5");
  assert.equal(spec.contextWindow, 900_000);
  assert.equal(spec.maxTokens, 100_000);
  assert.deepEqual(supportedLevels(spec), ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(spec.defaultEffort, "medium");
  // Explicit configured fields win.
  const [overridden] = resolveCatalog(
    [{ id: "claude-opus-5-5", name: "Mine", contextWindow: 500_000, maxTokens: 32_000 }],
    available,
  );
  assert.equal(overridden.name, "Mine");
  assert.equal(overridden.contextWindow, 500_000);
  assert.equal(overridden.maxTokens, 32_000);
  // An id the reading does not carry still resolves, with neutral defaults.
  const [future] = resolveCatalog([{ id: "future-claude" }], available);
  assert.equal(future.contextWindow, DEFAULT_CONTEXT_WINDOW);
  assert.equal(future.maxTokens, DEFAULT_MAX_TOKENS);
  assert.deepEqual(supportedLevels(future), ["off", "minimal", "low", "medium", "high"]);
});

test("a configured list is authoritative for the request layer; the reading otherwise", () => {
  const available = availableCatalog([opus, haiku], undefined);
  assert.equal(specForRequest(available, undefined, "claude-opus-5-5").id, "claude-opus-5-5");
  assert.equal(
    specForRequest(available, [], "claude-haiku-4-5-20251001").id,
    "claude-haiku-4-5-20251001",
  );
  assert.equal(specForRequest(available, undefined, "claude-opus-4-5"), undefined);
  assert.equal(
    specForRequest(available, [{ id: "claude-opus-4-5" }], "claude-opus-4-5").id,
    "claude-opus-4-5",
  );
  // No reading at all: nothing is servable in default mode.
  assert.equal(specForRequest([], undefined, "claude-opus-5-5"), undefined);
});

test("malformed configured entries are dropped, not fatal", () => {
  const catalog = resolveCatalog([{ id: "" }, { nope: true }, { id: "claude-opus-5-5" }]);
  assert.deepEqual(
    catalog.map((model) => model.id),
    ["claude-opus-5-5"],
  );
});

test("the harness projection declares ordered ladders and clamps default output", () => {
  const defaults = { name: "Claude Test", contextWindow: 200_000, maxTokens: 64_000 };
  const rows = [
    {
      model: entryToSpec(opus),
      contextWindow: 900_000,
      effortIds: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "medium",
    },
    {
      model: { ...defaults, id: "claude-opus-4-5", name: "Claude Opus 4.5" },
      contextWindow: 200_000,
      effortIds: ["off", "minimal", "low", "medium", "high"],
      defaultEffort: "high",
    },
    {
      model: {
        ...defaults,
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        thinkingLevelMap: { max: "max" },
        compat: { forceAdaptiveThinking: true, supportsStrictTools: true },
      },
      contextWindow: 200_000,
      effortIds: ["off", "minimal", "low", "medium", "high", "max"],
      defaultEffort: "high",
    },
    {
      model: {
        ...defaults,
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
      },
      contextWindow: 200_000,
      effortIds: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
    },
    {
      model: { ...defaults, id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
      contextWindow: 200_000,
      effortIds: ["off", "minimal", "low", "medium", "high"],
      defaultEffort: "high",
    },
  ];
  for (const { model, contextWindow, effortIds, defaultEffort } of rows) {
    const info = toHarnessModel("claude-subscription", model);
    assert.equal(info.provider, "claude-subscription");
    assert.equal(info.id, model.id);
    assert.equal(info.name, model.name);
    assert.equal(info.context.contextWindow, contextWindow);
    assert.equal(info.defaultMaxTokens, 64_000);
    assert.deepEqual(info.inputModalities, ["text", "image"]);
    assert.deepEqual(
      info.reasoning.efforts.map((effort) => effort.id),
      effortIds,
      model.id,
    );
    assert.equal(info.reasoning.defaultEffort, defaultEffort, model.id);
  }
});

test("the discovery projection emits exact servable records", () => {
  assert.deepEqual(discoveryModels([entryToSpec(opus), entryToSpec(haiku)]), [
    {
      id: "claude-opus-5-5",
      name: "Claude Opus 5.5",
      contextWindow: 900_000,
      maxTokens: 100_000,
      inputModalities: ["text", "image"],
    },
    {
      id: "claude-haiku-4-5-20251001",
      name: "Claude Haiku 4.5",
      contextWindow: 200_000,
      maxTokens: 64_000,
      inputModalities: ["text"],
    },
  ]);
  assert.deepEqual(discoveryModels(), []);
});

test("the wire behaviour follows the family generation", () => {
  assert.equal(behaviorFor("claude-opus-6").compat.forceAdaptiveThinking, true);
  assert.equal(behaviorFor("claude-opus-6").compat.supportsTemperature, false);
  assert.equal(behaviorFor("claude-opus-6").hideOff, true);
  assert.equal(behaviorFor("claude-haiku-4-9").compat.supportsTemperature, undefined);
  assert.equal(behaviorFor("claude-haiku-4-9").hideOff, false);
  // No system-prompt capability is invented for a model the catalog lists.
  assert.equal(entryToSpec({ id: "claude-opus-5-5" }).systemPromptUpdate, undefined);
});
