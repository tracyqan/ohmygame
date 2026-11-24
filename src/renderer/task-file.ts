/**
 * The task list a project keeps in one fixed file. The panel only reads it:
 * the file belongs to the agent that plans and updates the work, so this
 * module never writes it back and cannot drift from what the agent sees.
 */

/** At the workspace root, where any agent finds it without being told, and git tracks it. */
export { TASK_FILE } from "../shared/task-file.js";

export type TaskPriority = "high" | "medium" | "low";

export interface ProjectTask {
  /** What it says, without its marks. */
  text: string;
  done: boolean;
  /** `- [!]`: waiting on a decision from the person, so nobody writes code yet. */
  deciding: boolean;
  priority?: TaskPriority;
  /** The `##` heading above it; empty before the first one. */
  group: string;
  /** Its line in the file, counting from zero. */
  line: number;
}

export interface TaskGroup {
  title: string;
  tasks: ProjectTask[];
}

export interface TaskList {
  /** In file order, one per heading that holds a task. */
  groups: TaskGroup[];
  /** Every task, in file order. */
  tasks: ProjectTask[];
  done: number;
  deciding: number;
  total: number;
}

/** `- [ ]` open, `- [x]` done, `- [!]` waiting on a decision, indented under a heading. */
const TASK_LINE = /^\s*[-*+]\s+\[([ xX!])\]\s+(.*)$/;
/** A heading groups the tasks under it; `#` alone is the file's own title. */
const HEADING = /^\s*#{2,6}\s+(.+?)\s*#*\s*$/;
/** The marks that name a priority, longest first so `!high` is not read as `!h`. */
const MARKS: readonly (readonly [string, TaskPriority])[] = [
  ["!high", "high"], ["!medium", "medium"], ["!low", "low"],
  ["!高", "high"], ["!中", "medium"], ["!低", "low"],
];

/** Highest first, which is the order the panel shows by default. */
export const PRIORITIES: readonly TaskPriority[] = ["high", "medium", "low"];

/** Where a priority sorts: the highest first, an unmarked task last. */
export function priorityRank(priority: TaskPriority | undefined): number {
  return priority ? PRIORITIES.indexOf(priority) : PRIORITIES.length;
}

/** The text and the priority a task line carries, once its mark is taken out. */
function readMarks(body: string): Pick<ProjectTask, "text" | "priority"> {
  let text = body;
  let priority: TaskPriority | undefined;
  for (const [mark, level] of MARKS) {
    const pattern = new RegExp(`(^|\\s)${mark}(?=\\s|$)`);
    if (!pattern.test(text)) continue;
    text = text.replace(pattern, "$1");
    priority ??= level;
  }
  return { text: text.replace(/\s+/g, " ").trim(), priority };
}

/**
 * Reads a task file. Everything that is not a task or a heading is left alone
 * and shown nowhere, so notes and checklists inside fenced code never appear
 * as tasks.
 */
export function parseTaskFile(markdown: string): TaskList {
  const groups: TaskGroup[] = [];
  const tasks: ProjectTask[] = [];
  let heading = "";
  let group: TaskGroup | undefined;
  let fenced = false;
  for (const [line, raw] of markdown.split(/\r?\n/).entries()) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const title = HEADING.exec(raw)?.[1];
    if (title) {
      heading = title;
      group = undefined;
      continue;
    }
    const match = TASK_LINE.exec(raw);
    if (!match) continue;
    const { text, priority } = readMarks(match[2]);
    if (!text) continue;
    const mark = match[1];
    const task: ProjectTask = { text, done: mark === "x" || mark === "X", deciding: mark === "!", priority, group: heading, line };
    if (!group) {
      group = { title: heading, tasks: [] };
      groups.push(group);
    }
    group.tasks.push(task);
    tasks.push(task);
  }
  return {
    groups,
    tasks,
    done: tasks.filter((task) => task.done).length,
    deciding: tasks.filter((task) => task.deciding).length,
    total: tasks.length,
  };
}

/** The same tasks from the highest priority down, keeping file order within a level. */
export function sortedByPriority(tasks: readonly ProjectTask[]): ProjectTask[] {
  return [...tasks].sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.line - b.line);
}

/** What the tab shows: everything still open, or nothing while there is none. */
export function remainingOf(list: TaskList | undefined): number | undefined {
  return list ? list.total - list.done : undefined;
}
