import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { jsonResult, errorResult } from "../src/core/tool-result.js";
import { ApiError } from "../src/clients/dashboard-api-client.js";

describe("jsonResult", () => {
  it("wraps payload as text content with title", () => {
    const result = jsonResult("my_tool", { status: "ok" });
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "text");
    assert.ok(result.content[0].type === "text" && result.content[0].text.includes("my_tool"));
    assert.ok(
      result.content[0].type === "text" && result.content[0].text.includes('"status": "ok"')
    );
  });

  it("handles null payload", () => {
    const result = jsonResult("null_tool", null);
    assert.equal(result.content.length, 1);
    assert.ok(result.content[0].type === "text" && result.content[0].text.includes("null"));
  });

  it("handles array payload", () => {
    const result = jsonResult("arr_tool", [1, 2, 3]);
    assert.equal(result.content.length, 1);
    assert.ok(result.content[0].type === "text" && result.content[0].text.includes("["));
  });
});

describe("errorResult", () => {
  it("handles ApiError with status and details", () => {
    const apiErr = new ApiError("Not found", {
      status: 404,
      code: "NOT_FOUND",
      details: { path: "/api/sessions/x" },
    });
    const result = errorResult(apiErr);
    assert.equal(result.isError, true);
    assert.equal(result.content.length, 1);
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    const parsed = JSON.parse(text);
    assert.equal(parsed.error, "Not found");
    assert.equal(parsed.status, 404);
    assert.equal(parsed.code, "NOT_FOUND");
  });

  it("handles generic Error", () => {
    const result = errorResult(new Error("Something broke"));
    assert.equal(result.isError, true);
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    const parsed = JSON.parse(text);
    assert.equal(parsed.error, "Something broke");
    assert.equal(parsed.code, "INTERNAL_ERROR");
  });

  it("handles non-Error thrown value", () => {
    const result = errorResult("string error");
    assert.equal(result.isError, true);
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    const parsed = JSON.parse(text);
    assert.equal(parsed.error, "Unknown error");
  });
});
