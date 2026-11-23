import { describe, expect, it } from "vitest";
import { parseTaskFile, priorityRank, remainingOf, sortedByPriority } from "../src/renderer/task-file.js";

const FILE = `# 计划

## 本轮交付

- [x] L1 地形高度场
- [ ] 势力与道路连通 !高
- [ ] 键控随机与稳定格 ID
- 这行是注释，不是任务

## 下一层

- [ ] 动态刷新 !中
- [ ] 完整存档 !低
`;

describe("parseTaskFile", () => {
  it("reads tasks under their headings, marking the done ones", () => {
    const list = parseTaskFile(FILE);
    expect(list.total).toBe(5);
    expect(list.done).toBe(1);
    expect(list.groups.map((group) => group.title)).toEqual(["本轮交付", "下一层"]);
    expect(list.groups[0].tasks.map((task) => task.text)).toEqual([
      "L1 地形高度场",
      "势力与道路连通",
      "键控随机与稳定格 ID",
    ]);
    expect(list.tasks[0].done).toBe(true);
    // The line number points at the file, not at the task's position in the list.
    expect(FILE.split("\n")[list.tasks[0].line]).toContain("L1 地形高度场");
  });

  it("takes the priority out of the text", () => {
    const list = parseTaskFile("- [ ] 写第一章 !高\n- [ ] 画地图 !低\n- [ ] 找人校对 !medium");
    expect(list.tasks.map((task) => task.priority)).toEqual(["high", "low", "medium"]);
    expect(list.tasks.map((task) => task.text)).toEqual(["写第一章", "画地图", "找人校对"]);
  });

  it("keeps tasks before the first heading, with no group", () => {
    const list = parseTaskFile("- [ ] 先做这个\n\n## 之后\n- [ ] 再做那个");
    expect(list.groups.map((group) => group.title)).toEqual(["", "之后"]);
    expect(list.tasks[0].group).toBe("");
  });

  it("ignores a checklist inside a fenced block", () => {
    const list = parseTaskFile("```\n- [ ] 这是示例，不是任务\n```\n- [ ] 真正的任务");
    expect(list.tasks.map((task) => task.text)).toEqual(["真正的任务"]);
  });

  it("reads nothing from text without checkboxes", () => {
    expect(parseTaskFile("## 只是笔记\n\n随便写点什么。").total).toBe(0);
  });
});

describe("sortedByPriority", () => {
  it("puts the highest first and keeps file order within a level", () => {
    const list = parseTaskFile("- [ ] 普通一\n- [ ] 低 !低\n- [ ] 高 !高\n- [ ] 普通二\n- [ ] 高又一条 !高");
    expect(sortedByPriority(list.tasks).map((task) => task.text)).toEqual([
      "高",
      "高又一条",
      "低",
      "普通一",
      "普通二",
    ]);
  });

  it("ranks an unmarked task below every marked one", () => {
    expect(priorityRank("high")).toBeLessThan(priorityRank("medium"));
    expect(priorityRank("low")).toBeLessThan(priorityRank(undefined));
  });
});

describe("remainingOf", () => {
  it("counts what is still open", () => {
    expect(remainingOf(parseTaskFile(FILE))).toBe(4);
    expect(remainingOf(undefined)).toBeUndefined();
  });
});
