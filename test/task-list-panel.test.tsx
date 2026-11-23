// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceFileContent } from "../src/shared/contracts.js";

const readFile = vi.fn<(projectId: string, filePath: string) => Promise<WorkspaceFileContent>>();
const writeTasks = vi.fn(async (_path: string) => ({ path: "TASKS.md", written: true }));

vi.doMock(path.resolve("src/renderer/api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  getWorkspaceFile: readFile,
  request: writeTasks,
}));

const { TaskListPanel } = await import("../src/renderer/task-list-panel.js");
const { resetTaskList } = await import("../src/renderer/task-list-data.js");
const { ApiError } = await import("../src/renderer/api.js");

const FILE = `## 本轮交付

- [x] 地形高度场
- [ ] 势力与道路 !高
- [ ] 键控随机

## 下一层

- [ ] 完整存档 !低
`;

function content(text: string): WorkspaceFileContent {
  return { path: "TASKS.md", size: text.length, binary: false, content: text };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  resetTaskList();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => root.render(<TaskListPanel projectId="p1" />));
}

const rows = () => [...container.querySelectorAll<HTMLElement>(".task-list-row")];
const texts = () => rows().map((row) => row.querySelector(".task-list-text")?.textContent);
const radio = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button[role='radio']")].find((button) =>
    button.textContent?.startsWith(label),
  )!;

describe("TaskListPanel", () => {
  it("shows the open tasks, highest priority first", async () => {
    readFile.mockResolvedValue(content(FILE));
    await render();

    expect(container.querySelector(".task-list-count")?.textContent).toBe("1 / 4");
    expect(texts()).toEqual(["势力与道路", "完整存档", "键控随机"]);
    // The priority mark is a badge, not part of the text.
    expect(rows()[0].querySelector(".task-list-priority")?.textContent).toBe("High");
  });

  it("filters to what is done and back to everything", async () => {
    readFile.mockResolvedValue(content(FILE));
    await render();

    await act(async () => radio("Done").click());
    expect(texts()).toEqual(["地形高度场"]);

    await act(async () => radio("All").click());
    expect(texts()).toEqual(["势力与道路", "完整存档", "地形高度场", "键控随机"]);
  });

  it("keeps file order when asked, and the heading with each group", async () => {
    readFile.mockResolvedValue(content(FILE));
    await render();
    await act(async () => radio("All").click());
    await act(async () => radio("File order").click());

    expect(texts()).toEqual(["地形高度场", "势力与道路", "键控随机", "完整存档"]);
    expect([...container.querySelectorAll(".task-list-group-title")].map((title) => title.textContent))
      .toEqual(["本轮交付", "下一层"]);
  });

  it("writes the file with its format the first time the panel opens", async () => {
    let created = false;
    readFile.mockImplementation(async () => {
      if (!created) throw new ApiError("File not found", 400);
      return content("# Tasks\n\n## Now\n");
    });
    writeTasks.mockImplementation(async () => {
      created = true;
      return { path: "TASKS.md", written: true };
    });

    await render();

    expect(writeTasks).toHaveBeenCalledWith("/projects/p1/tasks?language=en", { method: "POST" });
    expect(container.textContent).toContain("No tasks yet");
  });

  it("says why it cannot read the file instead of showing an empty list", async () => {
    readFile.mockRejectedValue(new ApiError("The disk is not ready", 500));
    await render();

    expect(container.textContent).toContain("TASKS.md cannot be read");
    expect(container.textContent).toContain("The disk is not ready");
    expect(rows()).toHaveLength(0);
  });
});
