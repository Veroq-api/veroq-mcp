import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  registerHook,
  clearHooks,
  getHookCounts,
  runPreExecuteHooks,
  runPostExecuteHooks,
  runVerificationHooks,
  runEscalationHooks,
  runErrorHooks,
} from "../src/hooks/index.js";

const ctx = () => ({ toolName: "veroq_ask", params: { question: "test" }, timestamp: new Date().toISOString() });

describe("hooks", () => {
  beforeEach(() => { clearHooks(); });

  it("registers and counts hooks", () => {
    registerHook("preExecute", () => {});
    registerHook("postExecute", () => {});
    registerHook("postExecute", () => {});
    const counts = getHookCounts();
    assert.equal(counts.preExecute, 1);
    assert.equal(counts.postExecute, 2);
    assert.equal(counts.onVerification, 0);
  });

  it("clearHooks removes all", () => {
    registerHook("preExecute", () => {});
    registerHook("onEscalation", () => {});
    clearHooks();
    const counts = getHookCounts();
    assert.equal(counts.preExecute, 0);
    assert.equal(counts.onEscalation, 0);
  });

  it("preExecute can block execution", async () => {
    registerHook("preExecute", (c) => {
      if (c.toolName.includes("trading")) return { block: "Trading disabled" };
    });
    const r1 = await runPreExecuteHooks({ ...ctx(), toolName: "veroq_generate_trading_signal" });
    assert.equal(r1.blocked, true);
    assert.equal(r1.reason, "Trading disabled");

    const r2 = await runPreExecuteHooks({ ...ctx(), toolName: "veroq_ask" });
    assert.equal(r2.blocked, false);
  });

  it("preExecute can modify params", async () => {
    registerHook("preExecute", () => ({ params: { question: "modified" } }));
    const r = await runPreExecuteHooks(ctx());
    assert.equal(r.blocked, false);
    assert.equal(r.params.question, "modified");
  });

  it("postExecute fires without blocking", () => {
    let called = false;
    registerHook("postExecute", () => { called = true; });
    runPostExecuteHooks({ ...ctx(), result: { data: "test" }, durationMs: 100 });
    assert.equal(called, true);
  });

  it("onVerification fires with verdict data", () => {
    let captured: any = null;
    registerHook("onVerification", (c) => { captured = c; });
    runVerificationHooks({ ...ctx(), verdict: "supported", confidence: 0.85, corrections: [] });
    assert.ok(captured);
    assert.equal(captured.verdict, "supported");
    assert.equal(captured.confidence, 0.85);
  });

  it("onEscalation fires with reason", () => {
    let reason = "";
    registerHook("onEscalation", (c) => { reason = c.reason; });
    runEscalationHooks({ ...ctx(), reason: "Trade signal 92/100 exceeds threshold" });
    assert.ok(reason.includes("92/100"));
  });

  it("onError fires with error object", () => {
    let err: any = null;
    registerHook("onError", (c) => { err = c.error; });
    runErrorHooks({ ...ctx(), error: new Error("API timeout") });
    assert.ok(err);
    assert.equal(err.message, "API timeout");
  });

  it("hooks survive individual hook failures", async () => {
    let secondCalled = false;
    registerHook("preExecute", () => { throw new Error("hook crash"); });
    registerHook("preExecute", () => { secondCalled = true; });
    const r = await runPreExecuteHooks(ctx());
    assert.equal(r.blocked, false);
    // Second hook still ran despite first crashing
  });

  it("multiple preExecute hooks chain params", async () => {
    registerHook("preExecute", () => ({ params: { question: "step1" } }));
    registerHook("preExecute", (c) => ({ params: { ...c.params, extra: "step2" } }));
    const r = await runPreExecuteHooks(ctx());
    assert.equal(r.params.question, "step1");
    assert.equal(r.params.extra, "step2");
  });
});
