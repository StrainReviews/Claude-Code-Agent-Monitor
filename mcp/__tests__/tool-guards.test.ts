import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertMutationsEnabled, assertDestructiveEnabled } from "../src/policy/tool-guards.js";
import type { AppConfig } from "../src/config/app-config.js";

function fakeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    serverName: "test",
    serverVersion: "1.0.0",
    dashboardBaseUrl: new URL("http://127.0.0.1:4820"),
    requestTimeoutMs: 10_000,
    retryCount: 2,
    retryBackoffMs: 250,
    allowMutations: false,
    allowDestructive: false,
    logLevel: "error",
    transport: "stdio",
    httpPort: 8819,
    httpHost: "127.0.0.1",
    ...overrides,
  };
}

describe("assertMutationsEnabled", () => {
  it("throws when mutations disabled", () => {
    assert.throws(
      () => assertMutationsEnabled(fakeConfig({ allowMutations: false })),
      /Mutating tools are disabled/
    );
  });

  it("does not throw when mutations enabled", () => {
    assert.doesNotThrow(() => assertMutationsEnabled(fakeConfig({ allowMutations: true })));
  });
});

describe("assertDestructiveEnabled", () => {
  it("throws when mutations disabled (even if destructive enabled)", () => {
    assert.throws(
      () =>
        assertDestructiveEnabled(
          fakeConfig({ allowMutations: false, allowDestructive: true }),
          "CLEAR_ALL_DATA"
        ),
      /Mutating tools are disabled/
    );
  });

  it("throws when destructive disabled", () => {
    assert.throws(
      () =>
        assertDestructiveEnabled(
          fakeConfig({ allowMutations: true, allowDestructive: false }),
          "CLEAR_ALL_DATA"
        ),
      /Destructive tools are disabled/
    );
  });

  it("throws on wrong confirmation token", () => {
    assert.throws(
      () =>
        assertDestructiveEnabled(
          fakeConfig({ allowMutations: true, allowDestructive: true }),
          "WRONG_TOKEN"
        ),
      /Invalid confirmation_token/
    );
  });

  it("passes with correct config and token", () => {
    assert.doesNotThrow(() =>
      assertDestructiveEnabled(
        fakeConfig({ allowMutations: true, allowDestructive: true }),
        "CLEAR_ALL_DATA"
      )
    );
  });
});
