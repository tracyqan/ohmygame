import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { ProjectState } from "../shared/contracts.js";
import { conversationItems, type AgentManager } from "./agent.js";
import {
  CHECKPOINT_UNDONE_ENTRY,
  TURN_END_ENTRY,
} from "./checkpoint-extension.js";
import type {
  ConversationManager,
  StoredConversation,
} from "./conversations.js";

type TaskStatus =
  "starting" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
interface ConversationTask {
  version: 1;
  taskId: string;
  projectId: string;
  conversationId: string;
  requestId: string;
  promptHash: string;
  turnId: string;
  status: TaskStatus;
  createdAt: string;
  error?: string;
  cancelRequested?: boolean;
}

export interface ConversationTaskOptions {
  dataDirectory: string;
  conversations: ConversationManager;
  agents: () => AgentManager;
  prepare: (
    project: ProjectState,
    conversation: StoredConversation,
  ) => Promise<void>;
}

/** 外部聊天任务独立于 MCP 连接；先落盘绑定，再允许模型执行。 */
export class ConversationTasks {
  readonly #directory: string;
  readonly #tasks = new Map<string, ConversationTask>();
  #loaded = false;

  constructor(private readonly options: ConversationTaskOptions) {
    this.#directory = path.join(
      options.dataDirectory,
      "external-mcp",
      "conversation-tasks",
    );
  }

  #load(): void {
    if (this.#loaded) return;
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    const loaded: ConversationTask[] = [];
    for (const file of readdirSync(this.#directory).filter((name) =>
      name.endsWith(".json"),
    )) {
      const task = JSON.parse(
        readFileSync(path.join(this.#directory, file), "utf8"),
      ) as ConversationTask;
      if (
        task.version !== 1 ||
        ![
          "taskId",
          "projectId",
          "conversationId",
          "requestId",
          "promptHash",
          "turnId",
          "createdAt",
        ].every(
          (key) => typeof task[key as keyof ConversationTask] === "string",
        ) ||
        file !== `${task.taskId}.json` ||
        ![
          "starting",
          "running",
          "succeeded",
          "failed",
          "cancelled",
          "interrupted",
        ].includes(task.status)
      ) {
        throw new Error(
          "Unreadable conversation task store; it was not replaced",
        );
      }
      loaded.push(task);
    }
    for (const task of loaded) {
      if (task.status === "starting" || task.status === "running") {
        task.status = "interrupted";
        task.error =
          "Daemon restarted before a durable final outcome; execution outcome is unknown. Do not automatically resend.";
        this.#persist(task);
      }
      this.#tasks.set(task.taskId, task);
    }
    this.#loaded = true;
  }

  #persist(task: ConversationTask): void {
    const target = path.join(this.#directory, `${task.taskId}.json`);
    const temporary = `${target}.tmp`;
    const fd = openSync(temporary, "w", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(task)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, target);
    if (process.platform !== "win32") {
      const directory = openSync(this.#directory, "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
  }

  async #conversation(
    project: ProjectState,
    conversationId: string,
  ): Promise<StoredConversation> {
    const conversation = await this.options.conversations.get(
      project,
      conversationId,
    );
    if (!conversation || conversation.summary.projectId !== project.id)
      throw new Error("Conversation not found in project");
    this.options
      .agents()
      .restorePlanState(
        conversation,
        await this.options.conversations.planState(project, conversation),
      );
    return conversation;
  }

  async list(project: ProjectState) {
    const summaries = await this.options.conversations.list(project);
    return {
      projectId: project.id,
      conversations: await Promise.all(
        summaries.map(async (summary) => {
          const conversation = await this.#conversation(project, summary.id);
          return {
            ...summary,
            readiness: this.options
              .agents()
              .conversationReadiness(conversation),
          };
        }),
      ),
    };
  }

  async get(project: ProjectState, conversationId: string) {
    this.#load();
    const conversation = await this.#conversation(project, conversationId);
    const agents = this.options.agents();
    let start = agents.activeStart(project.id, conversationId);
    let ends = agents.turnEndsRecorded(project.id, conversationId);
    let branch;
    for (;;) {
      branch = (
        await this.options.conversations.view(project, conversation)
      ).getBranch();
      const current = agents.activeStart(project.id, conversationId);
      const currentEnds = agents.turnEndsRecorded(project.id, conversationId);
      if (start?.id === current?.id && ends === currentEnds) break;
      start = current;
      ends = currentEnds;
    }
    const items = [
      ...conversationItems(
        start
          ? branch.filter(
              (entry) =>
                entry.timestamp < start.timestamp ||
                (entry.type === "custom" &&
                  [TURN_END_ENTRY, CHECKPOINT_UNDONE_ENTRY].includes(
                    entry.customType,
                  )),
            )
          : branch,
        !start,
      ),
      ...(start ? agents.activeItems(project.id, conversationId) : []),
    ];
    return {
      projectId: project.id,
      conversation: conversation.summary,
      readiness: agents.conversationReadiness(conversation),
      agent: agents.agentState(conversation),
      plan: agents.planState(conversation),
      items,
      tasks: [...this.#tasks.values()]
        .filter(
          (task) =>
            task.projectId === project.id &&
            task.conversationId === conversationId,
        )
        .map((task) => this.#snapshot(task, conversation)),
    };
  }

  async send(
    project: ProjectState,
    conversationId: string,
    requestId: string,
    prompt: string,
  ) {
    this.#load();
    const conversation = await this.#conversation(project, conversationId);
    const promptHash = createHash("sha256").update(prompt).digest("hex");
    const existing = [...this.#tasks.values()].find(
      (task) => task.projectId === project.id && task.requestId === requestId,
    );
    if (existing) {
      if (
        existing.conversationId !== conversationId ||
        existing.promptHash !== promptHash
      )
        throw new Error(
          "requestId is already bound to a different conversation or message",
        );
      return this.#snapshot(existing, conversation);
    }
    const agents = this.options.agents();
    const readiness = agents.conversationReadiness(conversation);
    if (readiness !== "ready")
      throw new Error(`Conversation is not ready: ${readiness}`);
    const task: ConversationTask = {
      version: 1,
      taskId: randomUUID(),
      projectId: project.id,
      conversationId,
      requestId,
      promptHash,
      turnId: randomUUID(),
      status: "starting",
      createdAt: new Date().toISOString(),
    };
    this.#persist(task);
    this.#tasks.set(task.taskId, task);
    try {
      const turn = await agents.promptStrict(
        project,
        conversation,
        prompt,
        task.turnId,
        async () => {
          await this.options.prepare(project, conversation);
          if (task.cancelRequested)
            throw new Error("Task cancelled before model execution");
        },
      );
      task.status = "running";
      void turn.result
        .then(
          (result) =>
            this.#finish(
              task,
              result === "cancelled" ? "cancelled" : "succeeded",
            ),
          (cause: unknown) =>
            this.#finish(
              task,
              "failed",
              cause instanceof Error ? cause.message : String(cause),
            ),
        )
        .catch((cause: unknown) => {
          task.status = "interrupted";
          task.error = `Could not persist final outcome: ${String(cause)}`;
        });
    } catch (cause) {
      this.#finish(
        task,
        task.cancelRequested ? "cancelled" : "failed",
        cause instanceof Error ? cause.message : String(cause),
      );
    }
    return this.#snapshot(task, conversation);
  }

  #finish(task: ConversationTask, status: TaskStatus, error?: string): void {
    task.status = status;
    if (error) task.error = error;
    this.#persist(task);
  }

  #snapshot(task: ConversationTask, conversation: StoredConversation) {
    const { promptHash: _, version: _version, ...publicTask } = task;
    const readiness = this.options.agents().conversationReadiness(conversation);
    const active = task.status === "starting" || task.status === "running";
    return {
      ...publicTask,
      status:
        active && task.cancelRequested
          ? "cancelling"
          : active && readiness !== "ready" && readiness !== "busy"
            ? readiness
            : task.status,
      readiness,
    };
  }

  async task(
    project: ProjectState,
    conversationId: string,
    taskId: string,
    timeoutSeconds = 0,
    cancel = false,
    signal?: AbortSignal,
  ) {
    this.#load();
    const task = this.#tasks.get(taskId);
    if (
      task &&
      (task.projectId !== project.id || task.conversationId !== conversationId)
    )
      throw new Error("Task does not belong to project and conversation");
    const conversation = await this.#conversation(project, conversationId);
    if (!task)
      return {
        taskId,
        projectId: project.id,
        conversationId,
        status: "unknown",
        error: "No durable task record; execution outcome is unknown",
      };
    if (cancel && (task.status === "starting" || task.status === "running")) {
      task.cancelRequested = true;
      this.#persist(task);
      await this.options
        .agents()
        .cancel(project.id, conversationId, task.turnId);
    }
    const deadline = Date.now() + Math.min(timeoutSeconds, 45) * 1_000;
    while (task.status === "running" || task.status === "starting") {
      const state = this.options.agents().conversationReadiness(conversation);
      if (
        state.startsWith("waiting_") ||
        Date.now() >= deadline ||
        signal?.aborted
      )
        break;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, Math.min(50, deadline - Date.now()));
        signal?.addEventListener("abort", done, { once: true });
      });
    }
    const snapshot = this.#snapshot(task, conversation);
    const detail = await this.get(project, conversationId);
    return {
      ...snapshot,
      items: detail.items.filter((item) => item.turnId === task.turnId),
    };
  }
}
