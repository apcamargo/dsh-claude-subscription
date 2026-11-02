import assert from "node:assert/strict";
import test from "node:test";
import { buildMirror, buildRouteTable } from "../lib/accounts.js";
import { planOf } from "../lib/plan.js";

const grant = (route, fields = {}) => ({
  route,
  key: `claude-subscription/${route}`,
  kind: "grant",
  oauth: true,
  needsReauth: false,
  identity: {},
  ...fields,
});
const names = (table) => table.map((entry) => entry.name);

test("planOf reads the plan from the profile, including plans it has never seen", () => {
  assert.equal(planOf({ organization: { organization_type: "claude_pro" } }), "Pro");
  assert.equal(planOf({ organization: { organization_type: "claude_max" } }), "Max");
  assert.equal(planOf({ organization: { organization_type: "claude_team" } }), "Team");
  assert.equal(planOf({ organization: { organization_type: "claude_ultra_plus" } }), "Ultra Plus");
  assert.equal(planOf({ organization: { rate_limit_tier: "claude_max_standard" } }), "Max");
  assert.equal(planOf({}), undefined);
  assert.equal(planOf(null), undefined);
});

test("planOf prefers the server's plan_display_name and recognizes ultra tier tokens", () => {
  // plan_display_name wins over the derived plan: only it names Ultra.
  assert.equal(
    planOf({ organization: { organization_type: "claude_max", plan_display_name: "Ultra" } }),
    "Ultra",
  );
  // A blank display name is absent, so the derivation runs.
  assert.equal(
    planOf({ organization: { organization_type: "claude_pro", plan_display_name: "  " } }),
    "Pro",
  );
  assert.equal(planOf({ organization: { rate_limit_tier: "claude_ultra_standard" } }), "Ultra");
});

test("one account is named by its plan; several add the email; a shared email adds the organization", () => {
  assert.deepEqual(
    names(
      buildRouteTable({
        accounts: [grant("claude-subscription-111111111111", { email: "a@x.com", plan: "Pro" })],
      }),
    ),
    ["Claude Pro"],
  );
  assert.deepEqual(
    names(
      buildRouteTable({
        accounts: [grant("claude-subscription-111111111111", { email: "a@x.com" })],
      }),
    ),
    ["Claude subscription"],
  );

  const several = buildRouteTable({
    accounts: [
      grant("claude-subscription-111111111111", { email: "a@x.com", plan: "Pro", addedAt: 1 }),
      grant("claude-subscription-222222222222", { email: "b@x.com", plan: "Max", addedAt: 2 }),
      grant("claude-subscription-333333333333", { email: "c@x.com", addedAt: 3 }),
    ],
  });
  assert.deepEqual(names(several), [
    "Claude Pro (a@x.com)",
    "Claude Max (b@x.com)",
    "Claude subscription (c@x.com)",
  ]);

  // A personal plan and a Team seat share the email: the organization is the
  // only thing that tells the two headings apart.
  const shared = buildRouteTable({
    accounts: [
      grant("claude-subscription-111111111111", {
        email: "a@x.com",
        plan: "Pro",
        orgName: "Personal",
        addedAt: 1,
      }),
      grant("claude-subscription-222222222222", {
        email: "a@x.com",
        plan: "Team",
        orgName: "Acme",
        addedAt: 2,
      }),
    ],
  });
  assert.deepEqual(names(shared), [
    "Claude Pro (a@x.com, Personal)",
    "Claude Team (a@x.com, Acme)",
  ]);
});

test("the mirror carries each account's plan with explicit nulls", () => {
  const table = buildRouteTable({
    accounts: [
      grant("claude-subscription-111111111111", { email: "a@x.com", plan: "Pro" }),
      grant("claude-subscription-222222222222", { email: "b@x.com" }),
    ],
  });
  const mirror = buildMirror(table);
  assert.deepEqual(Object.keys(mirror), ["accounts"]);
  assert.deepEqual(
    mirror.accounts.map((row) => row.plan),
    ["Pro", null],
  );
});
