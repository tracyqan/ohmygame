import type { AgentModelRef, ConversationSummary, ProjectState } from "../shared/contracts.js";

/** What picking a conversation's model needs, from the conversation manager. */
export interface ConversationSource {
  list(project: ProjectState): Promise<readonly ConversationSummary[]>;
  get(project: ProjectState, conversationId: string): Promise<ConversationSourceEntry | undefined>;
  model(project: ProjectState, conversation: ConversationSourceEntry): Promise<AgentModelRef | undefined>;
}

interface ConversationSourceEntry {
  summary: ConversationSummary;
}

export interface LastActiveConversation {
  conversationId: string;
  updatedAt: string;
  model: AgentModelRef;
}

/**
 * The project's most recently active conversation and the model it uses: the
 * last one someone wrote in, or the newest empty one while the project is new.
 * A conversation that never settled on a model is passed over.
 */
export async function lastActiveConversationModel(
  conversations: ConversationSource,
  project: ProjectState,
): Promise<LastActiveConversation | undefined> {
  const ordered = [...await conversations.list(project)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const written = ordered.filter((summary) => summary.messageCount > 0);
  for (const summary of written.length ? written : ordered) {
    const conversation = await conversations.get(project, summary.id);
    if (!conversation) continue;
    const model = await conversations.model(project, conversation);
    if (model) return { conversationId: summary.id, updatedAt: summary.updatedAt, model };
  }
  return undefined;
}
