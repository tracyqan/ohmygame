import { describe, expect, it } from "vitest";
import { lastActiveConversationModel, type ConversationSource } from "../src/daemon/conversation-model.js";
import type { AgentModelRef, ConversationSummary, ProjectState } from "../src/shared/contracts.js";

const project: ProjectState = {
  id: "game",
  name: "Game",
  type: "web-game",
  updatedAt: "",
  workspacePath: "/tmp/game",
  preview: { status: "stopped" },
};

const conversation = (id: string, updatedAt: string, messageCount: number): ConversationSummary => ({
  id,
  projectId: project.id,
  title: id,
  createdAt: updatedAt,
  updatedAt,
  messageCount,
});

function source(
  listed: ConversationSummary[],
  models: Record<string, AgentModelRef | undefined>,
): ConversationSource {
  return {
    list: async () => listed,
    get: async (_project, conversationId) => {
      const found = listed.find((item) => item.id === conversationId);
      return found ? { summary: found } : undefined;
    },
    model: async (_project, entry) => models[entry.summary.id],
  };
}

describe("the last active conversation's model", () => {
  it("takes the newest conversation someone wrote in, not a newer empty one", async () => {
    const listed = [
      conversation("empty", "2026-03-01T00:00:00Z", 0),
      conversation("written", "2026-02-01T00:00:00Z", 4),
    ];
    const picked = await lastActiveConversationModel(source(listed, {
      empty: undefined,
      written: { provider: "pi", id: "claude" },
    }), project);
    expect(picked).toEqual({
      conversationId: "written",
      updatedAt: "2026-02-01T00:00:00Z",
      model: { provider: "pi", id: "claude" },
    });
  });

  it("starts from the newest empty conversation while the project is new", async () => {
    const listed = [
      conversation("older", "2026-01-01T00:00:00Z", 0),
      conversation("newer", "2026-02-01T00:00:00Z", 0),
    ];
    const picked = await lastActiveConversationModel(source(listed, {
      older: { provider: "pi", id: "old" },
      newer: { provider: "pi", id: "fresh" },
    }), project);
    expect(picked?.conversationId).toBe("newer");
    expect(picked?.model).toEqual({ provider: "pi", id: "fresh" });
  });

  it("passes over a conversation that never settled on a model", async () => {
    const listed = [
      conversation("bare", "2026-03-01T00:00:00Z", 2),
      conversation("settled", "2026-02-01T00:00:00Z", 1),
    ];
    const picked = await lastActiveConversationModel(source(listed, {
      bare: undefined,
      settled: { provider: "claude-code", id: "opus" },
    }), project);
    expect(picked?.conversationId).toBe("settled");
  });

  it("has nothing to offer without conversations", async () => {
    expect(await lastActiveConversationModel(source([], {}), project)).toBeUndefined();
  });
});
