import { describe, expect, it } from "vitest";
import {
  classifyFailure,
  reconcile,
  retryDelay,
  selectKey,
} from "../src/key-pool/policy.js";

describe("key selection and failure policy", () => {
  it("alternates keys, skips exclusions and cooldowns, and resumes recovered keys", () => {
    const state = reconcile(undefined, { secondary: "b", primary: "a" });
    expect(Array.from({ length: 4 }, () => selectKey(state, [], 100))).toEqual([
      "primary",
      "secondary",
      "primary",
      "secondary",
    ]);
    expect(selectKey(state, ["primary"], 100)).toBe("secondary");
    state.keys.primary!.blockedUntil = 200;
    expect(selectKey(state, [], 100)).toBe("secondary");
    expect(selectKey(state, [], 201)).toBe("primary");
    state.keys.primary!.disabled = true;
    state.keys.secondary!.disabled = true;
    expect(selectKey(state, [], 201)).toBeUndefined();
  });

  it("keeps unchanged key state, drops removed keys, and resets a replaced secret", () => {
    const state = reconcile(undefined, { primary: "old", removed: "x" });
    state.keys.primary!.disabled = true;
    expect(reconcile(state, { primary: "old" }).keys.primary!.disabled).toBe(
      true,
    );
    const next = reconcile(state, { primary: "new" });
    expect(next.keys.primary!.disabled).toBe(false);
    expect(next.keys.removed).toBeUndefined();
  });

  it.each([
    [401, "INVALID_KEY", true],
    [403, "KEY_FORBIDDEN", true],
    [429, "RATE_LIMITED", true],
    [432, "QUOTA_EXHAUSTED", true],
    [433, "QUOTA_EXHAUSTED", true],
    [500, "UPSTREAM_UNAVAILABLE", true],
    [0, "UPSTREAM_UNAVAILABLE", true],
    [400, "UPSTREAM_REJECTED", false],
    [422, "UPSTREAM_REJECTED", false],
  ])("classifies HTTP %s", (status, code, retry) => {
    expect(classifyFailure(status as number, null, 100)).toMatchObject({
      code,
      retry,
    });
  });

  it("respects Retry-After seconds/dates and bounds malformed or excessive delays", () => {
    const now = Date.parse("2026-10-11T00:00:00Z");
    expect(retryDelay("120", now)).toBe(120_000);
    expect(retryDelay("Sun, 11 Oct 2026 00:02:00 GMT", now)).toBe(120_000);
    expect(retryDelay("nonsense", now)).toBe(60_000);
    expect(retryDelay("99999999", now)).toBe(3_600_000);
    expect(retryDelay("-1", now)).toBe(1000);
  });

  it("re-enables exhausted keys at the next UTC month, including year rollover", () => {
    const now = Date.parse("2026-12-31T23:00:00Z");
    expect(classifyFailure(432, null, now).blockedUntil).toBe(
      Date.parse("2027-01-01T00:00:00Z"),
    );
  });
});
