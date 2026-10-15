import assert from "node:assert/strict";
import { test } from "node:test";
import { parseOptions } from "../src/config.ts";

test("uses inherited model and bounded defaults when options are omitted", () => {
  assert.deepEqual(parseOptions({}), {
    enabled: true,
    timeoutMs: 30_000,
    maxContextChars: 64_000,
  });
});

test("can disable automatic approval", () => {
  assert.equal(parseOptions({ enabled: false }).enabled, false);
});

test("rejects a nonboolean enabled setting", () => {
  assert.throws(() => parseOptions({ enabled: "false" }), {
    name: "TypeError", message: /enabled.*boolean/,
  });
});

test("rejects misspelled options with the valid names", () => {
  assert.throws(() => parseOptions({ timoutMs: 100 }), {
    name: "TypeError", message: /timoutMs.*enabled.*model.*timeoutMs.*maxContextChars/,
  });
});

test("selects a provider/model override without splitting slashes inside the model ID", () => {
  assert.deepEqual(parseOptions({ model: "openrouter/vendor/model" }).model, {
    providerID: "openrouter", id: "vendor/model",
  });
});

test("accepts an explicit inherit model setting", () => {
  assert.equal(Object.hasOwn(parseOptions({ model: "inherit" }), "model"), false);
});

test("accepts a model object and preserves its reasoning variant", () => {
  assert.deepEqual(parseOptions({ model: {
    providerID: "provider", id: "model", variant: "high",
  } }).model, { providerID: "provider", id: "model", variant: "high" });
});

test("rejects a provider/model string without its provider", () => {
  assert.throws(() => parseOptions({ model: "/model" }), {
    name: "TypeError", message: /model.*provider\/model/,
  });
});

test("rejects whitespace inside model identifiers", () => {
  assert.throws(() => parseOptions({ model: "provider/model name" }), {
    name: "TypeError", message: /model.*whitespace/,
  });
});

test("rejects model objects that omit the model ID", () => {
  assert.throws(() => parseOptions({ model: { providerID: "provider" } }), {
    name: "TypeError", message: /model\.id.*nonempty string/,
  });
});

test("rejects misspelled model object keys", () => {
  assert.throws(() => parseOptions({ model: {
    providerID: "provider", id: "model", varient: "high",
  } }), { name: "TypeError", message: /model.*varient.*providerID.*id.*variant/ });
});

test("rejects a null model instead of silently inheriting", () => {
  assert.throws(() => parseOptions({ model: null }), {
    name: "TypeError", message: /model.*inherit.*provider\/model/,
  });
});

test("accepts an explicit command review timeout", () => {
  assert.equal(parseOptions({ timeoutMs: 45_000 }).timeoutMs, 45_000);
});

test("rejects a fractional command review timeout", () => {
  assert.throws(() => parseOptions({ timeoutMs: 1.5 }), {
    name: "TypeError", message: /timeoutMs.*integer.*1.*300000/,
  });
});

test("accepts an explicit context character budget", () => {
  assert.equal(parseOptions({ maxContextChars: 1000 }).maxContextChars, 1000);
});

test("rejects slash-separated provider IDs in model objects", () => {
  assert.throws(() => parseOptions({ model: { providerID: "provider/model", id: "model" } }), {
    name: "TypeError", message: /model\.providerID.*slash/,
  });
});

test("rejects non-object plugin options with an actionable message", () => {
  assert.throws(() => parseOptions(null as unknown as Record<string, unknown>), {
    name: "TypeError", message: /autocode.*options.*object/,
  });
});

test("rejects review timeouts above five minutes", () => {
  assert.throws(() => parseOptions({ timeoutMs: 300_001 }), { name: "TypeError", message: /timeoutMs.*1.*300000/ });
});

test("rejects a zero review timeout", () => {
  assert.throws(() => parseOptions({ timeoutMs: 0 }), { name: "TypeError", message: /timeoutMs.*1.*300000/ });
});

test("accepts the maximum review timeout", () => {
  assert.equal(parseOptions({ timeoutMs: 300_000 }).timeoutMs, 300_000);
});

test("rejects context budgets below one thousand characters", () => {
  assert.throws(() => parseOptions({ maxContextChars: 999 }), { name: "TypeError", message: /maxContextChars.*1000.*1000000/ });
});

test("rejects context budgets above one million characters", () => {
  assert.throws(() => parseOptions({ maxContextChars: 1_000_001 }), { name: "TypeError", message: /maxContextChars.*1000.*1000000/ });
});

test("accepts the maximum context character budget", () => {
  assert.equal(parseOptions({ maxContextChars: 1_000_000 }).maxContextChars, 1_000_000);
});

test("rejects an empty reasoning variant", () => {
  assert.throws(() => parseOptions({ model: { providerID: "provider", id: "model", variant: "" } }), { name: "TypeError", message: /model\.variant.*nonempty string/ });
});

test("accepts a model object without a reasoning variant", () => {
  assert.deepEqual(parseOptions({ model: { providerID: "provider", id: "model" } }).model, { providerID: "provider", id: "model" });
});

test("rejects a model string without a provider separator", () => {
  assert.throws(() => parseOptions({ model: "model" }), { name: "TypeError", message: /model.*provider\/model/ });
});

test("rejects a scalar model setting", () => {
  assert.throws(() => parseOptions({ model: false }), { name: "TypeError", message: /model.*inherit.*provider\/model/ });
});

test("rejects a numeric string timeout instead of coercing it", () => {
  assert.throws(() => parseOptions({ timeoutMs: "30000" }), { name: "TypeError", message: /timeoutMs.*integer/ });
});

test("rejects an infinite context budget", () => {
  assert.throws(() => parseOptions({ maxContextChars: Infinity }), { name: "TypeError", message: /maxContextChars.*integer/ });
});
