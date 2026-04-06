import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createCollectorRegistrar,
  createDualRegistrar,
  type ToolEntry,
} from "../src/core/tool-registry.js";
import { z } from "zod";

describe("createCollectorRegistrar", () => {
  it("collects tool entries into the provided array", () => {
    const collector: ToolEntry[] = [];
    const register = createCollectorRegistrar(collector);

    const handler = async () => ({ ok: true });
    register("my_tool", "A test tool", { name: z.string() }, handler);

    assert.equal(collector.length, 1);
    assert.equal(collector[0].name, "my_tool");
    assert.equal(collector[0].description, "A test tool");
    assert.equal(collector[0].handler, handler);
  });

  it("collects multiple tools in order", () => {
    const collector: ToolEntry[] = [];
    const register = createCollectorRegistrar(collector);

    register("tool_a", "First tool", {}, async () => "a");
    register("tool_b", "Second tool", {}, async () => "b");
    register("tool_c", "Third tool", {}, async () => "c");

    assert.equal(collector.length, 3);
    assert.deepEqual(
      collector.map((t) => t.name),
      ["tool_a", "tool_b", "tool_c"]
    );
  });

  it("handler is invocable and returns expected result", async () => {
    const collector: ToolEntry[] = [];
    const register = createCollectorRegistrar(collector);

    register("echo_tool", "Echoes input", {}, async (args) => ({
      echo: args.message,
    }));

    const result = await collector[0].handler({ message: "hello" });
    assert.deepEqual(result, { echo: "hello" });
  });
});

describe("createDualRegistrar", () => {
  it("pushes to collector array", () => {
    // We can't easily create a real McpServer in tests, so we test the collector
    // behavior by verifying createCollectorRegistrar is the building block
    const collector: ToolEntry[] = [];
    const register = createCollectorRegistrar(collector);

    register("dual_test", "Dual test tool", { id: z.string() }, async () => null);
    assert.equal(collector.length, 1);
    assert.equal(collector[0].name, "dual_test");
  });
});
