import { describe, expect, it } from "vitest";
import { isUpdatePlanTool, planFromToolResult } from "../src/daemon/plan-tool.js";

const PLAN = { explanation: "分两步", steps: [{ step: "先读文件", status: "completed" }, { step: "再改", status: "in_progress" }] };

describe("isUpdatePlanTool", () => {
  it("reads the name OhMyGame's own runtime uses", () => {
    expect(isUpdatePlanTool("update_plan")).toBe(true);
  });

  it("reads the name an agent's tool server gives it", () => {
    // Claude Code, Codex and CLI agents prefix the server onto the tool.
    expect(isUpdatePlanTool("mcp__ohmygame__update_plan")).toBe(true);
    expect(isUpdatePlanTool("ohmygame__update_plan")).toBe(true);
    expect(isUpdatePlanTool("ohmygame:update_plan")).toBe(true);
  });

  it("leaves anything else alone", () => {
    expect(isUpdatePlanTool("update_plan_draft")).toBe(false);
    expect(isUpdatePlanTool("my_update_plan")).toBe(false);
    expect(isUpdatePlanTool("questionnaire")).toBe(false);
    expect(isUpdatePlanTool(undefined)).toBe(false);
  });
});

describe("planFromToolResult", () => {
  it("reads the plan inside details, as OhMyGame's runtime returns it", () => {
    expect(planFromToolResult({ content: [], details: { plan: PLAN } })).toEqual(PLAN);
  });

  it("reads a plan returned as details itself, as a tool server may", () => {
    expect(planFromToolResult({ content: [], details: PLAN })).toEqual(PLAN);
  });

  it("refuses a result that carries no plan", () => {
    expect(planFromToolResult({ content: [{ type: "text", text: "Plan updated" }] })).toBeUndefined();
    expect(planFromToolResult(undefined)).toBeUndefined();
  });

  it("refuses a plan with a step it cannot read", () => {
    expect(planFromToolResult({ details: { plan: { steps: [{ step: "ok", status: "pending" }, { status: "pending" }] } } })).toBeUndefined();
    expect(planFromToolResult({ details: { plan: { steps: [{ step: "x", status: "done" }] } } })).toBeUndefined();
  });
});
