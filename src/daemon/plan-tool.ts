import type { PlanState } from "../shared/contracts.js";

/**
 * How a plan tool and its result are recognised, whichever runtime ran them.
 * OhMyGame's own runtime calls the tool `update_plan`; an agent that reaches
 * it through a tool server reports the same tool with that server's prefix
 * (`mcp__ohmygame__update_plan`, `ohmygame:update_plan`), and the plan it
 * carries is the same plan.
 */
export function isUpdatePlanTool(name: string | undefined): boolean {
  if (!name) return false;
  return name === "update_plan" || /(?:[.:]|__)update_plan$/.test(name);
}

/** The plan a tool result carries, however its runtime wrapped it. */
export function planFromToolResult(result: unknown): PlanState | undefined {
  const details = result && typeof result === "object" && "details" in result
    ? (result as { details?: unknown }).details
    : undefined;
  const value = details && typeof details === "object" && "plan" in details
    ? (details as { plan?: unknown }).plan
    : details;
  if (!value || typeof value !== "object" || !Array.isArray((value as { steps?: unknown }).steps)) return undefined;
  const candidate = value as { explanation?: unknown; steps: unknown[] };
  const steps: PlanState["steps"] = candidate.steps.flatMap((step) => {
    if (!step || typeof step !== "object") return [];
    const item = step as { step?: unknown; status?: unknown };
    if (typeof item.step !== "string" || !item.step.trim()) return [];
    const status = item.status;
    if (status !== "pending" && status !== "in_progress" && status !== "completed") return [];
    return [{ step: item.step, status }];
  });
  if (steps.length !== candidate.steps.length || steps.length === 0) return undefined;
  return {
    ...(typeof candidate.explanation === "string" && candidate.explanation ? { explanation: candidate.explanation } : {}),
    steps,
  };
}
