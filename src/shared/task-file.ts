/**
 * The task file a project keeps at its workspace root. Shared because the
 * daemon writes it once and the panel reads it: both must agree on the name,
 * and the text it starts with is what tells an agent how to write the rest.
 */

export const TASK_FILE = "TASKS.md";

const TEMPLATES = {
  en: `# Tasks

> One task per line: \`- [ ]\` open, \`- [x]\` done.
> Priority goes at the end of the line: \`!high\`, \`!medium\` or \`!low\`.
> A \`##\` line starts a group. The agent keeps this file; OhMyGame's Tasks panel only reads it.

## Now

## Later
`,
  "zh-CN": `# 任务清单

> 一行一个任务：\`- [ ]\` 未完成，\`- [x]\` 已完成。
> 优先级写在行尾：\`!高\`、\`!中\`、\`!低\`（也认 \`!high\`、\`!medium\`、\`!low\`）。
> 以 \`##\` 开头的一行是分组。这个文件由 agent 维护，OhMyGame 的任务清单面板只读它。

## 本轮

## 以后
`,
} as const;

export type TaskFileLanguage = keyof typeof TEMPLATES;

/** What a new task file says, in the language the person reads. */
export function taskFileTemplate(language: string | undefined): string {
  return TEMPLATES[language === "zh-CN" ? "zh-CN" : "en"];
}
