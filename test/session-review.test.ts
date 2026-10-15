import assert from "node:assert/strict";
import { test } from "node:test";
import type { Plugin } from "@opencode/plugin";
import type { SessionGenerate } from "@opencode/plugin/promise/session";
import { REVIEW_POLICY } from "../src/policy.ts";
import { createSessionReviewer } from "../src/session-review.ts";

function harness() {
  let hook: ((event: SessionGenerate) => Promise<void> | void) | undefined;
  const requests: Array<{ sessionID: string; prompt: string; signal: AbortSignal | undefined }> = [];
  const events: SessionGenerate[] = [];
  const state = {
    response: '{"decision":"allow","reason":"The user requested this command."}',
    runHook: true,
    generate: undefined as undefined | ((event: SessionGenerate) => Promise<{ text: string }>),
  };
  function event(sessionID: string, prompt: string): SessionGenerate {
    return {
      sessionID, agent: "build", model: { providerID: "opencode", id: "deepseek", variant: "high" },
      system: [{ type: "text", text: "You are a coding agent with tools." }],
      messages: [
        { role: "user", content: [{ type: "text", text: "Run tests." }] },
        { role: "assistant", content: [{ type: "text", text: "Coding history." }] },
        { role: "user", content: [{ type: "text", text: prompt }] },
      ],
      options: { maxTokens: 8000, temperature: 0.2 },
      tools: { shell: { description: "Run a command", input: {} } },
    } as unknown as SessionGenerate;
  }
  const ctx = {
    session: {
      async hook(name: string, callback: typeof hook) {
        assert.equal(name, "generate");
        hook = callback;
        return { async dispose() {} };
      },
      async generate(input: { sessionID: string; prompt: string }, options?: { signal?: AbortSignal }) {
        requests.push({ ...input, signal: options?.signal });
        const generated = event(input.sessionID, input.prompt);
        events.push(generated);
        if (state.runHook) await hook?.(generated);
        return state.generate ? state.generate(generated) : { text: state.response };
      },
    },
  };
  return {
    ctx: ctx as unknown as Plugin.Context, state, requests, events, event,
    async emit(generated: SessionGenerate) { await hook?.(generated); },
  };
}

test("isolates an owned session review from coding instructions, history, and tools while retaining the model", async () => {
  const h = harness();
  const review = await createSessionReviewer(h.ctx);
  const signal = new AbortController().signal;
  const data = JSON.stringify({ request: { command: "npm test" }, messages: [{ type: "user", text: "Run tests." }] });

  assert.deepEqual(await review({ sessionID: "coding-session", data, signal }), { text: h.state.response });

  assert.equal(h.requests[0]?.sessionID, "coding-session");
  assert.equal(h.requests[0]?.signal, signal);
  assert.deepEqual(h.events[0]?.system, [{ type: "text", text: REVIEW_POLICY }]);
  assert.deepEqual(h.events[0]?.messages, [{ role: "user", content: [{ type: "text", text: `REVIEW_DATA_JSON\n${data}` }] }]);
  assert.deepEqual(h.events[0]?.tools, {});
  assert.deepEqual(h.events[0]?.model, { providerID: "opencode", id: "deepseek", variant: "high" });
  assert.deepEqual(h.events[0]?.options, { maxTokens: 8000, temperature: 0.2 });
});

test("rejects a provider result when the review isolation hook did not run", async () => {
  const h = harness();
  h.state.runHook = false;
  const review = await createSessionReviewer(h.ctx);
  await assert.rejects(
    review({ sessionID: "coding-session", data: "{}", signal: new AbortController().signal }),
    /AutoCode review context could not be isolated\./,
  );
});

test("does not change unrelated generation requests while a review is pending", async () => {
  const h = harness();
  let finish!: (value: { text: string }) => void;
  h.state.generate = () => new Promise((resolve) => { finish = resolve; });
  const review = await createSessionReviewer(h.ctx);
  const pending = review({ sessionID: "coding-session", data: "{}", signal: new AbortController().signal });
  await new Promise((resolve) => setImmediate(resolve));
  const prompt = h.requests[0]!.prompt;
  for (const generated of [
    h.event("coding-session", "Summarize this coding session."),
    h.event("another-session", prompt),
    h.event("coding-session", `${prompt}\nmore data`),
    { ...h.event("coding-session", prompt), messages: [{ role: "assistant" as const, content: [{ type: "text" as const, text: prompt }] }] },
  ]) {
    const original = structuredClone(generated);
    await h.emit(generated);
    assert.deepEqual(generated, original);
  }
  finish({ text: h.state.response });
  await pending;
});

test("keeps simultaneous reviews in the same session isolated from each other", async () => {
  const h = harness();
  const finish: Array<(value: { text: string }) => void> = [];
  h.state.generate = () => new Promise((resolve) => { finish.push(resolve); });
  const review = await createSessionReviewer(h.ctx);
  const first = review({ sessionID: "coding-session", data: '{"command":"first"}', signal: new AbortController().signal });
  const second = review({ sessionID: "coding-session", data: '{"command":"second"}', signal: new AbortController().signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(h.requests[0]!.prompt.split("\n")[0], h.requests[1]!.prompt.split("\n")[0]);
  assert.deepEqual(h.events.map((generated) => generated.messages), [
    [{ role: "user", content: [{ type: "text", text: 'REVIEW_DATA_JSON\n{"command":"first"}' }] }],
    [{ role: "user", content: [{ type: "text", text: 'REVIEW_DATA_JSON\n{"command":"second"}' }] }],
  ]);
  finish[1]!({ text: "second verdict" });
  assert.deepEqual(await second, { text: "second verdict" });
  finish[0]!({ text: "first verdict" });
  assert.deepEqual(await first, { text: "first verdict" });
});

test("forgets a completed review so its marker cannot affect later generation", async () => {
  const h = harness();
  const review = await createSessionReviewer(h.ctx);
  await review({ sessionID: "coding-session", data: "{}", signal: new AbortController().signal });
  const later = h.event("coding-session", h.requests[0]!.prompt);
  const original = structuredClone(later);
  await h.emit(later);
  assert.deepEqual(later, original);
});

test("forgets a failed review while preserving the provider error", async () => {
  const h = harness();
  const failure = new Error("provider unavailable");
  h.state.generate = async () => { throw failure; };
  const review = await createSessionReviewer(h.ctx);
  await assert.rejects(review({ sessionID: "coding-session", data: "{}", signal: new AbortController().signal }), failure);
  const later = h.event("coding-session", h.requests[0]!.prompt);
  const original = structuredClone(later);
  await h.emit(later);
  assert.deepEqual(later, original);
});

test("does not start generation when the review is already cancelled", async () => {
  const h = harness();
  const review = await createSessionReviewer(h.ctx);
  const controller = new AbortController();
  const reason = new Error("review deadline elapsed");
  controller.abort(reason);
  await assert.rejects(review({ sessionID: "coding-session", data: "{}", signal: controller.signal }), reason);
  assert.equal(h.requests.length, 0);
});

test("rejects a result delivered after cancellation even when the provider ignores the signal", async () => {
  const h = harness();
  let finish!: (value: { text: string }) => void;
  h.state.generate = () => new Promise((resolve) => { finish = resolve; });
  const review = await createSessionReviewer(h.ctx);
  const controller = new AbortController();
  const pending = review({ sessionID: "coding-session", data: "{}", signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  const reason = new Error("review deadline elapsed");
  controller.abort(reason);
  finish({ text: h.state.response });
  await assert.rejects(pending, reason);
});

test("forgets a cancelled frame before its unresponsive provider request finishes", async () => {
  const h = harness();
  let finish!: (value: { text: string }) => void;
  h.state.generate = () => new Promise((resolve) => { finish = resolve; });
  const review = await createSessionReviewer(h.ctx);
  const controller = new AbortController();
  const pending = review({ sessionID: "coding-session", data: "{}", signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  const reason = new Error("review deadline elapsed");
  controller.abort(reason);
  const later = h.event("coding-session", h.requests[0]!.prompt);
  const original = structuredClone(later);
  await h.emit(later);
  finish({ text: h.state.response });
  await assert.rejects(pending, reason);
  assert.deepEqual(later, original);
});
