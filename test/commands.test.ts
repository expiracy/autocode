import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAutoCodeCommand } from "../src/commands.ts";

test("recognizes the canonical configuration command", () => {
  assert.equal(parseAutoCodeCommand("config"), "config");
});

test("recognizes a full slash command regardless of whitespace and case", () => {
  assert.equal(parseAutoCodeCommand("  /AutoCode   CONFIG  "), "config");
});

test("a bare command opens help", () => {
  assert.equal(parseAutoCodeCommand("autocode"), "help");
});

test("recognizes the review log command", () => {
  assert.equal(parseAutoCodeCommand("log"), "log");
});

test("recognizes the effective status command", () => {
  assert.equal(parseAutoCodeCommand("status"), "status");
});

test("recognizes the explicit help command", () => {
  assert.equal(parseAutoCodeCommand("help"), "help");
});

test("accepts empty native arguments as help", () => {
  assert.equal(parseAutoCodeCommand("  "), "help");
});

test("rejects the removed settings alias", () => {
  assert.equal(parseAutoCodeCommand("settings"), undefined);
});

test("rejects unknown arguments and extra command tokens", () => {
  assert.equal(parseAutoCodeCommand("config extra"), undefined);
  assert.equal(parseAutoCodeCommand("autocoder config"), undefined);
});
