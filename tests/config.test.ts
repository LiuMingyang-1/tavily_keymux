import { describe, expect, it } from "vitest";
import { readAuth, readKeys } from "../src/config.js";

describe("secret configuration", () => {
  it("rejects missing, malformed, duplicate and weak secrets without disclosure", () => {
    for (const raw of [
      undefined,
      "private-not-json",
      "{}",
      '{"primary":"not-a-key"}',
      '{"a":"tvly-same","b":"tvly-same"}',
    ]) {
      expect(() => readKeys({ TAVILY_API_KEYS: raw as string })).toThrow(
        "Server secrets are missing or invalid.",
      );
    }
    for (const clients of [
      "{}",
      JSON.stringify({ alma: "short" }),
      JSON.stringify({ alma: "a".repeat(32), hermes: "a".repeat(32) }),
    ]) {
      expect(() =>
        readAuth({ CLIENT_TOKENS: clients, ADMIN_TOKEN: "m".repeat(64) }),
      ).toThrow("Server secrets are missing or invalid.");
    }
    expect(() =>
      readAuth({
        CLIENT_TOKENS: JSON.stringify({ alma: "a".repeat(64) }),
        ADMIN_TOKEN: "a".repeat(64),
      }),
    ).toThrow();
  });
});
