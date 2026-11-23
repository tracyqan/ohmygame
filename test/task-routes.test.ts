import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect, it } from "vitest";
import { registerTaskRoutes } from "../src/daemon/task-routes.js";
import type { ProjectManager } from "../src/daemon/projects.js";

let root: string;
let app: FastifyInstance;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ohmygame-tasks-"));
  app = Fastify();
  registerTaskRoutes(app, { projects: { get: (id: string) => id === "p" ? { workspacePath: root } : undefined } as unknown as ProjectManager });
});

afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

const file = () => path.join(root, "TASKS.md");

it("writes a task file that says what the format is", async () => {
  const response = await app.inject({ method: "POST", url: "/projects/p/tasks" });
  expect(response.statusCode).toBe(201);
  expect(response.json()).toEqual({ path: "TASKS.md", written: true });

  const text = await readFile(file(), "utf8");
  // The point of the file: an agent opening it learns the format without being told.
  expect(text).toContain("- [ ]");
  expect(text).toContain("!high");
  expect(text).toContain("##");
});

it("writes the Chinese format when the window is in Chinese", async () => {
  await app.inject({ method: "POST", url: "/projects/p/tasks?language=zh-CN" });
  const text = await readFile(file(), "utf8");
  expect(text).toContain("!高");
  expect(text).toContain("一行一个任务");
});

it("never overwrites a file the agent has written", async () => {
  await writeFile(file(), "## 本轮\n\n- [ ] 已存在的任务 !高\n", "utf8");
  const response = await app.inject({ method: "POST", url: "/projects/p/tasks" });
  expect(response.json()).toEqual({ path: "TASKS.md", written: false });
  expect(await readFile(file(), "utf8")).toContain("已存在的任务");
});

it("fills a file that is only whitespace, which tells an agent nothing", async () => {
  await writeFile(file(), "\n\n  \n", "utf8");
  const response = await app.inject({ method: "POST", url: "/projects/p/tasks" });
  expect(response.json()).toEqual({ path: "TASKS.md", written: true });
  expect(await readFile(file(), "utf8")).toContain("!high");
});

it("answers 404 for a project it does not know", async () => {
  const response = await app.inject({ method: "POST", url: "/projects/nope/tasks" });
  expect(response.statusCode).toBe(404);
});
