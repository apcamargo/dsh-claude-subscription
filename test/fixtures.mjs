/**
 * Fixtures pinned verbatim to observed provider responses, shared by the unit
 * tests, the integration tests, and scripts/verify-load.mjs.
 * @module test/fixtures
 */

/**
 * Observed OAuth account-allowance 429 body shared by the unit, integration,
 * and mount-verification tests.
 * @type {string}
 */
export const ALLOWANCE_429_BODY = JSON.stringify({
  type: "error",
  error: {
    type: "rate_limit_error",
    message: "This request would exceed your account's rate limit. Please try again later.",
  },
  request_id: "req_011CgkLQn6FMrjUHQEfqSUKD",
});
