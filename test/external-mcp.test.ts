import { defineTool, SessionManager, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { AgentManager, type CodingSession } from "../src/daemon/agent.js";
import { ConversationManager } from "../src/daemon/conversations.js";
import { ConversationTasks } from "../src/daemon/conversation-tasks.js";
import { RuntimeEventBus } from "../src/shared/events.js";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { ExternalMcpService, type ExternalMcpOptions } from "../src/daemon/external-mcp.js";
import type { AgentModelRef, ProjectState } from "../src/shared/contracts.js";
import type {
  ExternalMcpCatalog,
  ExternalMcpEndpoint,
} from "../src/shared/external-mcp.js";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function temporaryDirectory() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "ohmygame-external-mcp-"),
  );
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function project(
  id: string,
  workspacePath: string,
  type: ProjectState["type"] = "web-game",
): ProjectState {
  return {
    id,
    name: id,
    type,
    updatedAt: "",
    workspacePath,
    preview: { status: "stopped" },
  };
}

async function fixture(conversationOptions?: { conversations: ConversationManager; agents: AgentManager; prepare?: () => Promise<void> }, mcp: Partial<Pick<ExternalMcpOptions, "createConversation" | "lastConversationModel">> = {}) {
  const root = await temporaryDirectory();
  const game = path.join(root, "game");
  const story = path.join(root, "story");
  await mkdir(path.join(game, "src"), { recursive: true });
  await mkdir(story);
  const projects = [
    { ...project("game", game), storagePath: path.join(root, "game-storage") },
    { ...project("story", story, "interactive-story"), storagePath: path.join(root, "story-storage") },
  ];
  const released: string[] = [];
  const signals: AbortSignal[] = [];
  let finish: (() => void) | undefined;
  const tools = (current: ProjectState) => [
    defineTool({
      name: "generate_image",
      label: "Generate Image",
      description: "Generate an image",
      parameters: Type.Object({ prompt: Type.String() }),
      execute: async (_id, input, signal) => {
        signals.push(signal!);
        await new Promise<void>((resolve, reject) => {
          finish = resolve;
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
        return {
          content: [
            { type: "text", text: `image of ${input.prompt} in ${current.id}` },
          ],
          details: {},
        };
      },
    }),
    defineTool({
      name: "canvas_check",
      label: "Check Canvas",
      description: "Check the canvas",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: `canvas of ${current.id}` }],
        details: {},
      }),
    }),
    defineTool({
      name: "questionnaire",
      label: "Ask",
      description: "Ask the user",
      parameters: Type.Object({}),
      execute: async () => ({ content: [], details: {} }),
    }),
    ...(current.type === "interactive-story"
      ? [
          defineTool({
            name: "playable_check",
            label: "Check Story",
            description: "Check the story",
            parameters: Type.Object({}),
            execute: async () => ({
              content: [{ type: "text", text: "story ok" }],
              details: {},
            }),
          }),
        ]
      : []),
  ];
  const tasks = conversationOptions && new ConversationTasks({ dataDirectory: root, conversations: conversationOptions.conversations, agents: () => conversationOptions.agents, prepare: conversationOptions.prepare ?? (async () => {}) });
  const service = new ExternalMcpService({
    dataDirectory: root,
    conversations: tasks,
    ...mcp,
    projects: () => projects,
    tools: (current) => tools(current),
    catalog: () => tools(projects[1]!),
    pluginTools: async (current) =>
      current.id === "game"
        ? [
            defineTool({
              name: "acme__tiles__where",
              label: "Tiles: where",
              description: "Say which project the plugin runs in",
              parameters: Type.Object({ detail: Type.Optional(Type.String()) }),
              execute: async () => ({
                content: [{ type: "text", text: `tiles in ${current.id}` }],
                details: {},
              }),
            }),
          ]
        : [],
    release: (projectId, sessionId) => {
      released.push(`${projectId}:${sessionId}`);
    },
    waitMs: 20,
  });
  cleanup.push(() => service.close());
  await service.load();
  await service.listening("http://127.0.0.1:1/external-mcp");
  await service.setEnabled(true);
  const endpoint = JSON.parse(
    await readFile(path.join(root, "external-mcp", "endpoint.json"), "utf8"),
  ) as ExternalMcpEndpoint;
  const authorization = `Bearer ${endpoint.token}`;
  let id = 0;
  const rpc = async (
    session: string | undefined,
    method: string,
    params: Record<string, unknown> = {},
    roots?: string[],
  ) =>
    service.handle({
      authorization,
      sessionId: session,
      roots: roots ? JSON.stringify(roots) : undefined,
      body: { jsonrpc: "2.0", id: ++id, method, params },
    });
  const open = async (roots?: string[]) => {
    const answer = await rpc(
      undefined,
      "initialize",
      { protocolVersion: "2025-06-18" },
      roots,
    );
    return answer.headers!["mcp-session-id"]!;
  };
  const call = async (
    session: string,
    name: string,
    args: Record<string, unknown> = {},
    roots?: string[],
  ) => {
    const answer = await rpc(
      session,
      "tools/call",
      { name, arguments: args },
      roots,
    );
    const result = (
      answer.body as {
        result: { content: Array<{ text: string }>; isError?: boolean };
      }
    ).result;
    return {
      text: result.content.map((item) => item.text).join("\n"),
      isError: result.isError === true,
    };
  };
  return {
    root,
    game,
    story,
    projects,
    tasks,
    service,
    endpoint,
    authorization,
    rpc,
    open,
    call,
    released,
    signals,
    finish: () => finish?.(),
  };
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

it("严格发送复用既有会话，跨项目并行，收尾前不成功，重连保持幂等和归属", async () => {
  const conversations = new ConversationManager();
  const runs = new Map<string, ReturnType<typeof gate>>();
  const closing = gate();
  const followUp = vi.fn(async () => {});
  const agents = new AgentManager(new RuntimeEventBus(), {
    createSession: async (project, conversation) => {
      const manager = conversations.open(project, conversation);
      let listener: ((event: AgentSessionEvent) => void) | undefined;
      const run = gate();
      runs.set(conversation.summary.id, run);
      const session: CodingSession = {
        messages: [], sessionManager: manager, followUp,
        subscribe: (next) => { listener = next; return () => { listener = undefined; }; },
        prompt: async (prompt) => {
          manager.appendMessage({ role: "user", content: prompt, timestamp: Date.now() });
          listener?.({ type: "message_end", message: { role: "user", content: prompt, timestamp: Date.now() } } as AgentSessionEvent);
          await run.promise;
        },
        abort: async () => run.resolve(), dispose: () => {},
      };
      return session;
    },
    onRunFinished: async (project) => { if (project.id === "game") await closing.promise; },
  });
  cleanup.push(async () => { closing.resolve(); for (const run of runs.values()) run.resolve(); await agents.close(); });
  const { projects, root, tasks, game, open, call } = await fixture({ conversations, agents });
  const first = await conversations.create(projects[0]!);
  const second = await conversations.create(projects[0]!);
  const other = await conversations.create(projects[1]!);
  const session = await open();
  const input = { project: "game", conversationId: first.summary.id, requestId: "req-1", prompt: "测试文本" };
  expect((await call(session, "send_conversation_message", { conversationId: first.summary.id, requestId: "x", prompt: "x" })).isError).toBe(true);
  expect((await call(session, "send_conversation_message", { ...input, project: "story" })).isError).toBe(true);
  const [sent, duplicate] = await Promise.all([call(session, "send_conversation_message", input), call(session, "send_conversation_message", input)]);
  const task = JSON.parse(sent.text);
  expect(task).toMatchObject({ projectId: "game", conversationId: first.summary.id, status: "running" });
  expect(JSON.parse(duplicate.text).taskId).toBe(task.taskId);
  expect((await call(session, "send_conversation_message", { ...input, prompt: "不同文本" })).isError).toBe(true);
  expect((await call(session, "send_conversation_message", { ...input, conversationId: second.summary.id, requestId: "req-2" })).isError).toBe(true);
  const parallel = JSON.parse((await call(session, "send_conversation_message", { ...input, project: "story", conversationId: other.summary.id })).text);
  expect(parallel.status).toBe("running");
  await vi.waitFor(() => expect(runs.size).toBe(2));
  expect(followUp).not.toHaveBeenCalled();
  const query = { project: "game", conversationId: first.summary.id, taskId: task.taskId, timeoutSeconds: 0 };
  expect((await call(session, "wait_conversation_task", { ...query, project: "story", conversationId: other.summary.id })).isError).toBe(true);
  expect((await call(session, "wait_conversation_task", { ...query, timeoutSeconds: 46 })).isError).toBe(true);
  runs.get(first.summary.id)!.resolve();
  await vi.waitFor(() => expect(agents.conversationReadiness(first)).toBe("closing"));
  expect(JSON.parse((await call(session, "wait_conversation_task", query)).text).status).toBe("closing");
  expect((await call(session, "send_conversation_message", { ...input, requestId: "closing" })).isError).toBe(true);
  closing.resolve();
  await vi.waitFor(async () => expect(JSON.parse((await call(session, "wait_conversation_task", query)).text).status).toBe("succeeded"));
  const reconnected = await open();
  await call(reconnected, "open_project", { project: "story" });
  expect(JSON.parse((await call(reconnected, "send_conversation_message", { ...input, project: game })).text).taskId).toBe(task.taskId);
  const detail = JSON.parse((await call(reconnected, "get_conversation", { project: "game", conversationId: first.summary.id })).text);
  expect(detail.items.find((item: { type: string }) => item.type === "userMessage").turnId).toBe(task.turnId);
  const continued = JSON.parse((await call(reconnected, "send_conversation_message", { ...input, requestId: "continue", prompt: "继续测试" })).text);
  expect(continued.taskId).not.toBe(task.taskId);
  expect(continued.conversationId).toBe(first.summary.id);
  await vi.waitFor(async () => expect(JSON.parse((await call(reconnected, "wait_conversation_task", { ...query, taskId: continued.taskId })).text).status).toBe("succeeded"));
  expect(JSON.parse((await call(reconnected, "cancel_conversation_task", { project: query.project, conversationId: query.conversationId, taskId: query.taskId })).text).status).toBe("succeeded");
  const restarted = new ConversationTasks({ dataDirectory: root, conversations, agents: () => agents, prepare: async () => {} });
  expect(await restarted.task(projects[0]!, first.summary.id, task.taskId)).toMatchObject({ status: "succeeded" });
  expect(await restarted.task(projects[1]!, other.summary.id, parallel.taskId)).toMatchObject({ status: "interrupted" });
  expect(await tasks!.task(projects[0]!, first.summary.id, "missing")).toMatchObject({ status: "unknown" });
  expect((await conversations.list(projects[0]!)).length).toBe(2);
});

it("等待审批、输入和计划时只报告阻塞，取消不批准", async () => {
  const conversations = new ConversationManager();
  const running = gate();
  const agents = new AgentManager(new RuntimeEventBus(), {
    createSession: async () => ({ messages: [], prompt: async () => running.promise, abort: async () => running.resolve(), dispose: () => {}, subscribe: () => () => {} }),
  });
  cleanup.push(async () => { running.resolve(); await agents.close(); });
  const { projects, open, call } = await fixture({ conversations, agents });
  const conversation = await conversations.create(projects[0]!);
  const session = await open();
  const base = { project: "game", conversationId: conversation.summary.id };
  const task = JSON.parse((await call(session, "send_conversation_message", { ...base, requestId: "approval", prompt: "测试" })).text);
  const approval = agents.askApproval("game", conversation.summary.id, "tool", { kind: "command", command: "true" } as never);
  const query = { ...base, taskId: task.taskId };
  expect(JSON.parse((await call(session, "wait_conversation_task", query)).text).status).toBe("waiting_approval");
  expect((await call(session, "send_conversation_message", { ...base, requestId: "blocked", prompt: "测试" })).isError).toBe(true);
  await call(session, "cancel_conversation_task", query);
  await expect(approval).resolves.toBe("deny");
  await vi.waitFor(async () => expect(JSON.parse((await call(session, "wait_conversation_task", { ...query, timeoutSeconds: 0 })).text).status).toBe("cancelled"));
  agents.restorePlanState(conversation, { mode: "awaiting_approval" });
  const planConversation = await conversations.create(projects[1]!);
  agents.restorePlanState(planConversation, { mode: "awaiting_approval" });
  expect((await call(session, "send_conversation_message", { project: "story", conversationId: planConversation.summary.id, requestId: "plan", prompt: "测试" })).isError).toBe(true);
});

it("准备中的任务可取消且不会调用模型，未知或损坏的存储不被覆盖", async () => {
  const conversations = new ConversationManager();
  const prepared = gate();
  const createSession = vi.fn(async () => { throw new Error("不应创建模型会话"); });
  const agents = new AgentManager(new RuntimeEventBus(), { createSession });
  cleanup.push(() => agents.close());
  const { projects, root, tasks } = await fixture({ conversations, agents, prepare: () => prepared.promise });
  const conversation = await conversations.create(projects[0]!);
  const sending = tasks!.send(projects[0]!, conversation.summary.id, "preparing", "测试");
  await vi.waitFor(() => expect(agents.isProjectBusy("game")).toBe(true));
  const detail = await tasks!.get(projects[0]!, conversation.summary.id);
  const task = detail.tasks[0]!;
  expect(await tasks!.task(projects[0]!, conversation.summary.id, task.taskId, 0, true)).toMatchObject({ status: "cancelling" });
  prepared.resolve();
  expect(await sending).toMatchObject({ status: "cancelled" });
  expect(createSession).not.toHaveBeenCalled();
  const file = path.join(root, "external-mcp", "conversation-tasks", `${task.taskId}.json`);
  const damaged = '{"version":999}';
  await writeFile(file, damaged);
  const restarted = new ConversationTasks({ dataDirectory: root, conversations, agents: () => agents, prepare: async () => {} });
  await expect(restarted.send(projects[0]!, conversation.summary.id, "new", "测试")).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe(damaged);
});

it("通过真实 daemon 接线复用 provider 防护与现有会话，不使用 app token 发 MCP", async () => {
  const dataDirectory = await temporaryDirectory();
  const createSession = vi.fn(async (project: ProjectState, conversation: import("../src/daemon/conversations.js").StoredConversation): Promise<CodingSession> => {
    const manager = SessionManager.open(conversation.sessionPath, undefined, project.workspacePath);
    return { messages: [], sessionManager: manager, subscribe: () => () => {}, abort: async () => {}, dispose: () => {}, prompt: async (prompt) => { manager.appendMessage({ role: "user", content: prompt, timestamp: Date.now() }); } };
  });
  const app = createApp({ dataDirectory, piAgentDirectory: path.join(dataDirectory, "pi"), accessToken: "private-app-token", createSession });
  cleanup.push(() => app.close());
  await app.listen({ host: "127.0.0.1", port: 0 });
  const internal = async (method: "POST" | "PUT", url: string, payload: object) => app.inject({ method, url, payload, headers: { authorization: "Bearer private-app-token" } });
  const project = (await internal("POST", "/projects", { name: "MCP fixture" })).json<ProjectState>();
  const manager = SessionManager.create(project.workspacePath, path.join(project.storagePath!, "session"));
  manager.appendModelChange("fixture-disabled", "fixture-model");
  manager.appendMessage({ role: "user", content: "已有测试会话", timestamp: Date.now() });
  const conversationId = manager.getSessionId();
  await internal("PUT", "/settings/external-agents", { enabled: true });
  const endpoint = JSON.parse(await readFile(path.join(dataDirectory, "external-mcp", "endpoint.json"), "utf8")) as ExternalMcpEndpoint;
  const rpc = async (method: string, params: object = {}, session?: string) => app.inject({ method: "POST", url: "/external-mcp", payload: { jsonrpc: "2.0", id: 1, method, params }, headers: { authorization: `Bearer ${endpoint.token}`, ...(session ? { "mcp-session-id": session } : {}) } });
  const session = (await rpc("initialize")).headers["mcp-session-id"] as string;
  const call = async (name: string, args: object) => (await rpc("tools/call", { name, arguments: args }, session)).json().result;
  const base = { project: project.id, conversationId };
  expect((await call("list_conversations", { project: project.id })).content[0].text).toContain(conversationId);
  const sent = await call("send_conversation_message", { ...base, requestId: "daemon", prompt: "纯测试文本" });
  expect(sent.isError).not.toBe(true);
  const task = JSON.parse(sent.content[0].text);
  await vi.waitFor(async () => expect(JSON.parse((await call("wait_conversation_task", { ...base, taskId: task.taskId, timeoutSeconds: 0 })).content[0].text).status).toBe("succeeded"));
  expect(createSession).toHaveBeenCalledOnce();
  const history = JSON.parse((await call("get_conversation", base)).content[0].text);
  expect(history.items.some((item: { turnId: string }) => item.turnId === task.turnId)).toBe(true);
  expect(JSON.stringify(history)).not.toContain("private-app-token");
  const disabled = SessionManager.create(project.workspacePath, path.join(project.storagePath!, "session"));
  disabled.appendModelChange("claude-code-cli", "fixture");
  disabled.appendMessage({ role: "user", content: "已有禁用模型会话", timestamp: Date.now() });
  await app.inject({ method: "PATCH", url: "/agent-runtimes/claude-code-cli", payload: { enabled: false }, headers: { authorization: "Bearer private-app-token" } });
  const refused = JSON.parse((await call("send_conversation_message", { project: project.id, conversationId: disabled.getSessionId(), requestId: "disabled", prompt: "测试" })).content[0].text);
  expect(refused).toMatchObject({ status: "failed", error: expect.stringContaining("provider is disabled") });
  expect(createSession).toHaveBeenCalledOnce();
});

it("publishes a token only while enabled and revokes it when turned off", async () => {
  const { root, service, endpoint, authorization, open, rpc } = await fixture();
  const file = path.join(root, "external-mcp", "endpoint.json");
  expect(endpoint).toMatchObject({
    version: 1,
    url: "http://127.0.0.1:1/external-mcp",
    contractVersion: 1,
  });
  if (process.platform !== "win32")
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  const catalog = JSON.parse(
    await readFile(path.join(root, "external-mcp", "tools.json"), "utf8"),
  ) as ExternalMcpCatalog;
  expect(catalog).toMatchObject({
    version: 1,
    contractVersion: 1,
    instructions: expect.stringContaining("wait_job"),
  });
  expect(catalog.tools.map((tool) => tool.name)).toContain("generate_image");
  expect(
    await service.handle({
      authorization: "Bearer wrong",
      sessionId: undefined,
      roots: undefined,
      body: {},
    }),
  ).toMatchObject({ status: 401 });
  const session = await open();
  expect((await rpc(session, "ping")).status).toBe(200);

  await service.setEnabled(false);
  await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    await service.handle({
      authorization,
      sessionId: session,
      roots: undefined,
      body: { jsonrpc: "2.0", id: 1, method: "ping" },
    }),
  ).toMatchObject({ status: 401 });

  await service.setEnabled(true);
  const renewed = JSON.parse(
    await readFile(file, "utf8"),
  ) as ExternalMcpEndpoint;
  expect(renewed.token).not.toBe(endpoint.token);
  expect(
    JSON.parse(
      await readFile(path.join(root, "external-mcp", "settings.json"), "utf8"),
    ),
  ).toEqual({ version: 1, enabled: true });
});

it("requires an initialized session", async () => {
  const { service, authorization, rpc, open } = await fixture();
  expect(await rpc(undefined, "tools/list")).toMatchObject({ status: 400 });
  expect(await rpc("unknown", "tools/list")).toMatchObject({ status: 404 });
  const session = await open();
  const notified = await service.handle({
    authorization,
    sessionId: session,
    roots: undefined,
    body: { jsonrpc: "2.0", method: "notifications/initialized" },
  });
  expect(notified.status).toBe(202);
  expect(notified.body).toBeUndefined();
});

it("lists the public tools only, the same before a project is chosen", async () => {
  const { open, rpc } = await fixture();
  const session = await open();
  const answer = await rpc(session, "tools/list");
  const tools = (
    answer.body as {
      result: { tools: Array<{ name: string; _meta?: unknown }> };
    }
  ).result.tools;
  expect(tools.map((tool) => tool.name)).toEqual([
    "list_conversations",
    "create_conversation",
    "get_last_conversation_model",
    "get_conversation",
    "send_conversation_message",
    "wait_conversation_task",
    "cancel_conversation_task",
    "list_projects",
    "open_project",
    "get_project",
    "get_job",
    "wait_job",
    "cancel_job",
    "generate_image",
    "canvas_check",
    "playable_check",
  ]);
  expect(tools.some((tool) => tool._meta)).toBe(false);
});

it("binds the project containing the client's folder, until one is opened explicitly", async () => {
  const { game, story, open, call } = await fixture();
  const unbound = await open();
  expect(await call(unbound, "canvas_check")).toMatchObject({
    isError: true,
    text: expect.stringContaining("list_projects"),
  });

  const session = await open([path.join(game, "src")]);
  expect(await call(session, "canvas_check")).toEqual({
    isError: false,
    text: "canvas of game",
  });
  expect(JSON.parse((await call(session, "get_project")).text)).toMatchObject({
    id: "game",
    type: "web-game",
  });

  expect(
    JSON.parse((await call(session, "open_project", { project: story })).text),
  ).toMatchObject({ id: "story" });
  expect(await call(session, "canvas_check", {}, [`file://${game}`])).toEqual({
    isError: false,
    text: "canvas of story",
  });
  const listed = JSON.parse((await call(session, "list_projects")).text) as {
    projects: Array<{ id: string; current: boolean }>;
  };
  expect(listed.projects.find((item) => item.current)?.id).toBe("story");
});

it("refuses tools outside the public list and those the project does not have", async () => {
  const { game, open, call } = await fixture();
  const session = await open([game]);
  expect(await call(session, "questionnaire")).toMatchObject({
    isError: true,
    text: "Tool questionnaire is not available",
  });
  expect(await call(session, "playable_check")).toMatchObject({
    isError: true,
    text: "Tool playable_check is not available for project game (web-game). It needs an Interactive Story project.",
  });
  expect(
    await call(session, "open_project", { project: "missing" }),
  ).toMatchObject({ isError: true });
});

it("remembers which clients connected and how many tools they called", async () => {
  const { game, rpc, call, service, authorization } = await fixture();
  const answer = await rpc(undefined, "initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code", version: "2.1.0" } }, [game]);
  const session = answer.headers!["mcp-session-id"]!;
  await call(session, "canvas_check");
  await call(session, "canvas_check");
  await rpc(undefined, "initialize", { protocolVersion: "2025-06-18" });
  expect(service.recentClients()).toEqual([
    { name: "claude-code", lastUsedAt: expect.any(String), calls: 2, active: true },
  ]);
  await service.end(authorization, session);
  expect(service.recentClients()).toMatchObject([{ name: "claude-code", calls: 2, active: false }]);
});

it("turns slow generations into jobs that outlive the request", async () => {
  const { game, open, call, signals, finish } = await fixture();
  const session = await open([game]);
  const started = await call(session, "generate_image", { prompt: "a fox" });
  expect(started.isError).toBe(false);
  const jobId = started.text.match(/job ([0-9a-f-]+)/)?.[1];
  expect(jobId).toBeTruthy();
  expect((await call(session, "get_job", { jobId })).text).toContain(
    "still running",
  );

  // Another session, such as a reconnected client, can still collect the result.
  const later = await open();
  finish();
  expect(await call(later, "wait_job", { jobId, timeoutSeconds: 1 })).toEqual({
    isError: false,
    text: "image of a fox in game",
  });
  expect(signals[0]!.aborted).toBe(false);
  expect(await call(later, "get_job", { jobId: "missing" })).toMatchObject({
    isError: true,
  });
});

it("cancels a job", async () => {
  const { game, open, call, signals } = await fixture();
  const session = await open([game]);
  const jobId = (
    await call(session, "generate_image", { prompt: "a fox" })
  ).text.match(/job ([0-9a-f-]+)/)?.[1];
  expect(await call(session, "cancel_job", { jobId })).toMatchObject({
    isError: true,
    text: `Job ${jobId} was cancelled`,
  });
  expect(signals[0]!.aborted).toBe(true);
});

it("releases a session's playtest windows when it ends or changes project", async () => {
  const { game, story, service, authorization, open, call, released } =
    await fixture();
  const session = await open([game]);
  await call(session, "open_project", { project: story });
  expect(released).toEqual([`game:${session}`]);
  expect(await service.end(authorization, session)).toBe(204);
  expect(released).toEqual([`game:${session}`, `story:${session}`]);
  expect(await service.end(authorization, session)).toBe(404);
});

it("serves the public contract from the daemon without the app token", async () => {
  const dataDirectory = await temporaryDirectory();
  const app = createApp({
    dataDirectory,
    piAgentDirectory: path.join(dataDirectory, "pi-agent"),
    accessToken: "app-token",
  });
  cleanup.push(() => app.close());
  await app.listen({ host: "127.0.0.1", port: 0 });
  const settings = await app.inject({
    method: "PUT",
    url: "/settings/external-agents",
    headers: { authorization: "Bearer app-token" },
    payload: { enabled: true },
  });
  expect(settings.json()).toMatchObject({ enabled: true });
  const endpoint = JSON.parse(
    await readFile(
      path.join(dataDirectory, "external-mcp", "endpoint.json"),
      "utf8",
    ),
  ) as ExternalMcpEndpoint;
  expect(endpoint.url).toBe(
    `http://127.0.0.1:${(app.server.address() as { port: number }).port}/external-mcp`,
  );

  const post = (
    payload: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method: "POST",
      url: "/external-mcp",
      headers: { authorization: `Bearer ${endpoint.token}`, ...headers },
      payload,
    });
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/external-mcp",
        headers: { authorization: "Bearer app-token" },
        payload: {},
      })
    ).statusCode,
  ).toBe(401);
  const initialized = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });
  expect(initialized.json()).toMatchObject({
    result: { serverInfo: { name: "ohmygame-studio", version: "1" } },
  });
  const session = initialized.headers["mcp-session-id"] as string;
  const listed = await post(
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { "mcp-session-id": session },
  );
  const names = (
    listed.json() as { result: { tools: Array<{ name: string }> } }
  ).result.tools.map((tool) => tool.name);
  // Additive tools are compatible; retain every existing tool, see docs/external-agents.md.
  expect(names).toEqual([
    "list_conversations",
    "create_conversation",
    "get_last_conversation_model",
    "get_conversation",
    "send_conversation_message",
    "wait_conversation_task",
    "cancel_conversation_task",
    "list_projects",
    "open_project",
    "get_project",
    "get_job",
    "wait_job",
    "cancel_job",
    "generate_image",
    "generate_3d_asset",
    "animate_3d_asset",
    "generate_video",
    "generate_audio",
    "playable_add_node",
    "playable_check",
    "canvas_check",
    "canvas_initialize",
    "generate_canvas_media",
    "game_use",
  ]);
  expect(
    (
      await app.inject({
        method: "DELETE",
        url: "/external-mcp",
        headers: {
          authorization: `Bearer ${endpoint.token}`,
          "mcp-session-id": session,
        },
      })
    ).statusCode,
  ).toBe(204);

  await app.close();
  await expect(
    stat(path.join(dataDirectory, "external-mcp", "endpoint.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("lists and runs the plugin tools of the project a session uses", async () => {
  const { game, story, open, rpc, call } = await fixture();
  const names = async (session: string) =>
    (
      (await rpc(session, "tools/list")).body as {
        result: { tools: Array<{ name: string }> };
      }
    ).result.tools.map((tool) => tool.name);
  const unbound = await open();
  expect(await names(unbound)).not.toContain("acme__tiles__where");
  expect(await call(unbound, "acme__tiles__where")).toMatchObject({
    isError: true,
  });

  const inGame = await open([game]);
  expect(await names(inGame)).toContain("acme__tiles__where");
  expect(await call(inGame, "acme__tiles__where")).toEqual({
    text: "tiles in game",
    isError: false,
  });
  // The plugin's schema is checked like any other tool's.
  expect(await call(inGame, "acme__tiles__where", { detail: 1 })).toMatchObject(
    { isError: true },
  );

  const inStory = await open([story]);
  expect(await names(inStory)).not.toContain("acme__tiles__where");
  expect((await call(inStory, "acme__tiles__where")).text).toContain(
    "not available for project",
  );
});

it("新建会话时用调用方给的模型，或把最近活跃会话的模型留给他读", async () => {
  const createConversation = vi.fn(async (current: ProjectState, model?: AgentModelRef) => ({
    conversationId: "fresh",
    projectId: current.id,
    title: "Untitled",
    model: model ?? { provider: "pi", id: "claude" },
    modelSource: model ? "explicit" : "inherited",
  }));
  const lastConversationModel = vi.fn(async () => ({
    conversationId: "previous",
    updatedAt: "2026-01-01T00:00:00Z",
    model: { provider: "pi", id: "claude" },
  }));
  const { call, open } = await fixture(undefined, { createConversation, lastConversationModel });
  const session = await open();

  // 不给模型：把选择权交给 app 层，那里沿用最近活跃会话的模型。
  expect(JSON.parse((await call(session, "create_conversation", { project: "game" })).text)).toMatchObject({
    conversationId: "fresh",
    modelSource: "inherited",
  });
  expect(createConversation).toHaveBeenLastCalledWith(expect.objectContaining({ id: "game" }), undefined);

  // 给了模型就原样传下去。
  const explicit = await call(session, "create_conversation", {
    project: "game",
    model: { provider: "pi", id: "gpt" },
  });
  expect(JSON.parse(explicit.text)).toMatchObject({
    model: { provider: "pi", id: "gpt" },
    modelSource: "explicit",
  });
  expect(createConversation).toHaveBeenLastCalledWith(expect.objectContaining({ id: "game" }), { provider: "pi", id: "gpt" });

  // 最近活跃会话的模型可以单独读，不必先建会话。
  expect(JSON.parse((await call(session, "get_last_conversation_model", { project: "game" })).text)).toEqual({
    conversationId: "previous",
    updatedAt: "2026-01-01T00:00:00Z",
    model: { provider: "pi", id: "claude" },
  });
});

it("建不了会话时把原因带回给调用方", async () => {
  const { call, open } = await fixture(undefined, {
    createConversation: async () => {
      throw new Error("No model to start on: pass model");
    },
    lastConversationModel: async () => null,
  });
  const session = await open();

  const failed = await call(session, "create_conversation", { project: "game" });
  expect(failed.isError).toBe(true);
  expect(failed.text).toContain("No model to start on");
  // 还没有会话时读到的是 null，而不是错误。
  expect((await call(session, "get_last_conversation_model", { project: "game" })).text).toBe("null");
  // 项目必须先存在。
  expect((await call(session, "create_conversation", { project: "/nowhere" })).isError).toBe(true);
});

it("在自己还活着时补回被删掉的端点文件，token 不变", async () => {
  const { root, service, endpoint } = await fixture();
  const file = path.join(root, "external-mcp", "endpoint.json");
  await rm(file, { force: true });

  // 任何一次 publish（这里用 listening）都应把文件写回来。
  await service.listening("http://127.0.0.1:1/external-mcp");
  const restored = JSON.parse(await readFile(file, "utf8")) as ExternalMcpEndpoint;
  expect(restored.token).toBe(endpoint.token);
  expect(restored.pid).toBe(process.pid);
});

it("关掉时不删别的 daemon 发布的端点文件", async () => {
  const { root, service } = await fixture();
  const file = path.join(root, "external-mcp", "endpoint.json");
  const other: ExternalMcpEndpoint = {
    version: 1,
    url: "http://127.0.0.1:9/external-mcp",
    token: "another-daemons-token",
    contractVersion: 1,
    pid: 1,
  };
  await writeFile(file, `${JSON.stringify(other, null, 2)}\n`);

  await service.close();
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual(other);
});
