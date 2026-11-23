// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectActivitySnapshot, ProjectAgentActivity } from "../src/shared/contracts.js";

let activity: ProjectAgentActivity[] = [];
const streams = new Set<{ signal: AbortSignal; onSnapshot: (snapshot: ProjectActivitySnapshot) => void }>();
// Like the daemon's: a new stream gets the current snapshot, and changes reach every open one.
const streamActivity = vi.fn(async (signal: AbortSignal, onSnapshot: (snapshot: ProjectActivitySnapshot) => void) => {
  const stream = { signal, onSnapshot };
  streams.add(stream);
  onSnapshot({ activity, names: [] });
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  streams.delete(stream);
});
vi.doMock(path.resolve("src/renderer/api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  streamProjectActivity: streamActivity,
}));

const push = (next: ProjectAgentActivity[]) => {
  activity = next;
  for (const stream of streams) stream.onSnapshot({ activity, names: [] });
};

const status = await import("../src/renderer/project-status.js");

// React reads this flag when deciding whether act() is supported.
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

let root: ReturnType<typeof createRoot>, container: HTMLDivElement;

/** The marks both the rail and the project list read, as "running|unread". */
function Marks() {
  status.useProjectStatusStream();
  const { running, unread } = status.useProjectStatus();
  return <span>{`${[...running.keys()].sort().join(",")}|${[...unread].sort().join(",")}`}</span>;
}

const marks = () => container.textContent;

beforeEach(async () => {
  localStorage.clear();
  activity = [];
  streams.clear();
  streamActivity.mockClear();
  status.setViewedProject(undefined);
  status.markProjectSeen("a");
  status.markProjectSeen("b");
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<Marks />);
  });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe("project status marks", () => {
  it("shows its agent working, then a dot once the task finishes", async () => {
    await act(async () => {
      push([{ projectId: "a", status: "running" }]);
    });
    expect(marks()).toBe("a|");

    await act(async () => {
      push([]);
    });
    expect(marks()).toBe("|a");
    // The dot survives a reload, so it is kept beside the app's other settings.
    expect(JSON.parse(localStorage.getItem("ohmygame:project-unread") ?? "[]")).toEqual(["a"]);

    await act(async () => {
      status.markProjectSeen("a");
    });
    expect(marks()).toBe("|");
    expect(JSON.parse(localStorage.getItem("ohmygame:project-unread") ?? "[]")).toEqual([]);
  });

  it("leaves the project on screen unmarked when its task finishes", async () => {
    status.setViewedProject("a");
    await act(async () => {
      push([{ projectId: "a", status: "running" }]);
    });
    await act(async () => {
      push([]);
    });
    expect(marks()).toBe("|");
  });

  it("marks only the project that finished", async () => {
    await act(async () => {
      push([
        { projectId: "a", status: "running" },
        { projectId: "b", status: "running" },
      ]);
    });
    // "b" comes back to idle first; "a" is still working.
    await act(async () => {
      push([{ projectId: "a", status: "running" }]);
    });
    expect(marks()).toBe("a|b");
  });

  it("opens one stream for every icon watching it", async () => {
    expect(streamActivity).toHaveBeenCalledTimes(1);
  });
});
