import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { TASK_FILE, taskFileTemplate } from "../shared/task-file.js";
import type { ProjectManager } from "./projects.js";

/**
 * The task file's one write. Everything else about `TASKS.md` is the agent's
 * business: this only makes sure the file exists and starts with the format,
 * because an empty file tells an agent nothing about what to put in it.
 */
export function registerTaskRoutes(app: FastifyInstance, options: { projects: ProjectManager }): void {
  app.post<{ Params: { projectId: string }; Querystring: { language?: string } }>(
    "/projects/:projectId/tasks",
    { schema: { querystring: { type: "object", additionalProperties: false, properties: {
      language: { type: "string", maxLength: 20 },
    } } } },
    async (request, reply) => {
      const project = options.projects.get(request.params.projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const file = path.join(project.workspacePath, TASK_FILE);
      const text = taskFileTemplate(request.query.language);
      try {
        await writeFile(file, text, { encoding: "utf8", flag: "wx" });
        return reply.code(201).send({ path: TASK_FILE, written: true });
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      }
      // A file that is only whitespace is as unhelpful as none, so it gets the
      // format too; a file with anything in it is never touched.
      const existing = await readFile(file, "utf8").catch(() => undefined);
      if (existing?.trim()) return { path: TASK_FILE, written: false };
      await writeFile(file, text, "utf8");
      return { path: TASK_FILE, written: true };
    },
  );
}
