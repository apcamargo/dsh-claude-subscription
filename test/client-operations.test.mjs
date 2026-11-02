/**
 * The browser card's Host operations: the settings.mutate payload must be the ops
 * array verbatim. Regression: writeModels once wrapped a single op in an array, so
 * a multi-op commit reached the wire as `[[op, …]]` and the gateway refused it
 * ("wire field ops failed boundary validation").
 * @module test/client-operations.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";
import { setModelsOp, unsetModelsOp } from "../lib/client-models.js";

/** A remote double recording mutate calls, shaped like the real gateway:
 * describe() answers the whole document view, mutate() one namespace view. */
function fakeRemote() {
  const calls = [];
  const view = (
    revision,
    value = {
      accounts: { models: { "claude-subscription-111111111111": [{ id: "claude-haiku-4-5" }] } },
    },
  ) => ({
    autoGenerate: true,
    ns: "claude-subscription",
    schema: {},
    value,
    applies: "live",
    secrets: [],
    revision,
  });
  return {
    calls,
    view,
    settings: {
      describe: async () => ({
        ok: true,
        value: { writable: true, hasDocument: true, namespaces: [view(7)] },
      }),
      mutate: async (ns, ops, expectedRevision) => {
        calls.push({ ns, ops, expectedRevision });
        return { ok: true, value: view(8) };
      },
    },
    llm: {
      discoverModels: async () => ({ ok: true, value: [] }),
    },
    $on: () => () => {},
  };
}

test("writeModels forwards the ops array verbatim to settings.mutate", async () => {
  const { createOperations } = await import("../lib/client-app.js");
  const remote = fakeRemote();
  const operations = createOperations(remote, "claude-subscription");

  // A multi-op commit reaches the wire as the ops array itself.
  const route = "claude-subscription-111111111111";
  const setOp = setModelsOp([{ id: "claude-haiku-4-5" }], route);
  const unsetOp = unsetModelsOp(route);
  await operations.writeModels([setOp, unsetOp], 7);
  assert.equal(remote.calls.length, 1);
  assert.deepEqual(remote.calls[0].ops, [setOp, unsetOp], "the ops array is not re-wrapped");
  assert.equal(remote.calls[0].ns, "claude-subscription");
  assert.equal(remote.calls[0].expectedRevision, 7);

  // A single op lands as a one-element array, never a wrapped [[op]] the
  // gateway's strict codec refuses.
  const unset = unsetModelsOp(route);
  await operations.writeModels([unset], undefined);
  assert.deepEqual(remote.calls[1].ops, [unset]);
});

test("the forwarded-event subscriptions deliver, detach, and degrade without $on", async () => {
  const { createOperations } = await import("../lib/client-app.js");
  const subscriptions = [];
  const remote = fakeRemote();
  remote.$on = (event, listener) => {
    subscriptions.push({ event, listener });
    return () =>
      subscriptions.splice(
        subscriptions.findIndex((entry) => entry.listener === listener),
        1,
      );
  };
  const operations = createOperations(remote, "claude-subscription");

  // The settings document's pushed invalidation is what makes the mirror and
  // the indicator refresh without a reload. The pie's own triggers ride the
  // generic face as forwarded session events.
  const seen = [];
  const offSettings = operations.onSettingsUpdated((ns) => seen.push(ns));
  const activity = operations.onEvent("api-session/activity", () => {});
  const status = operations.onEvent("api-session/status", () => {});
  assert.deepEqual(
    subscriptions.map((entry) => entry.event),
    ["settings/document-updated", "api-session/activity", "api-session/status"],
  );
  subscriptions[0].listener("claude-subscription");
  assert.deepEqual(seen, ["claude-subscription"]);
  offSettings();
  activity();
  status();
  assert.equal(subscriptions.length, 0, "every unsubscribe detaches its own listener");

  // A remote without $on degrades to a no-op subscription.
  const bare = createOperations({ settings: {}, llm: {} }, "claude-subscription");
  assert.doesNotThrow(() => bare.onSettingsUpdated(() => {}));
  assert.doesNotThrow(() => bare.onEvent("api-session/activity", () => {}));
});
