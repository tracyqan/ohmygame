import { useEffect, useState } from "react";
import { ApiError, createWorkspaceEntry, getWorkspaceFile } from "./api.js";
import { TASK_FILE, parseTaskFile, remainingOf, type TaskList } from "./task-file.js";

/**
 * One read of a project's `TASKS.md`, shared by the panel and the tab badge:
 * the file is small and local, so it is polled rather than watched, and every
 * window that shows it reads the same copy.
 */

export type TaskListState =
  | { status: "loading" }
  | { status: "ready"; list: TaskList; truncated: boolean }
  /** The file was deleted or renamed after the project had it. */
  | { status: "missing" }
  | { status: "error"; message: string };

/** Fast enough that a task the agent completes shows up while you watch. */
const POLL_MS = 4_000;

interface Reading {
  state: TaskListState;
  /** Made once, when the panel is first opened: an empty file, for the agent to fill. */
  seeded: boolean;
  timer?: ReturnType<typeof setInterval>;
  busy: boolean;
}

const readings = new Map<string, Reading>();
/** Everything that shows a count, told again whenever any reading changes. */
const watchers = new Set<() => void>();

function publish(projectId: string, state: TaskListState): void {
  const reading = readings.get(projectId);
  if (!reading) return;
  reading.state = state;
  for (const watcher of watchers) watcher();
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** A file that is not there yet reads as `undefined`; a broken one still throws. */
async function readTaskFile(projectId: string) {
  try {
    return await getWorkspaceFile(projectId, TASK_FILE);
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 400 && /not found/i.test(cause.message)) return undefined;
    throw cause;
  }
}

async function load(projectId: string, seed: boolean): Promise<void> {
  const reading = readings.get(projectId);
  if (!reading || reading.busy) return;
  reading.busy = true;
  try {
    let file = await readTaskFile(projectId);
    // The first time the panel opens in a project, a missing file is made so
    // there is somewhere for the agent to write, with no dialog to click through.
    if (!file && seed && !reading.seeded) {
      reading.seeded = true;
      await createWorkspaceEntry(projectId, "", TASK_FILE, "file").catch(() => undefined);
      file = await readTaskFile(projectId);
    }
    publish(projectId, file
      ? { status: "ready", list: parseTaskFile(file.content ?? ""), truncated: file.truncated === true }
      : { status: "missing" });
  } catch (cause) {
    publish(projectId, { status: "error", message: messageOf(cause) });
  } finally {
    reading.busy = false;
  }
}

/** Starts reading a project once, and keeps the reading fresh for as long as anything shows it. */
function readingFor(projectId: string, seed: boolean): Reading {
  let reading = readings.get(projectId);
  if (!reading) {
    reading = { state: { status: "loading" }, seeded: false, busy: false };
    readings.set(projectId, reading);
    void load(projectId, seed);
    reading.timer = setInterval(() => {
      // A hidden window has nobody looking, and the file is read again on return.
      if (document.visibilityState === "hidden") return;
      void load(projectId, false);
    }, POLL_MS);
    return reading;
  }
  return reading;
}

/** Reads the file again now, for the retry button and for a window coming back. */
export function refreshTaskList(projectId: string): void {
  void load(projectId, false);
}

/** A project's tasks, kept current while the panel is open. */
export function useTaskList(projectId: string | undefined): TaskListState {
  const [state, setState] = useState<TaskListState>({ status: "loading" });
  useEffect(() => {
    if (!projectId) return;
    const reading = readingFor(projectId, true);
    const read = () => setState(reading.state);
    read();
    watchers.add(read);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load(projectId, false);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      watchers.delete(read);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [projectId]);
  return projectId ? state : { status: "loading" };
}

/** How many tasks a project has left, for the tab; nothing until the panel has read the file. */
export function useTaskRemaining(projectId: string | undefined): number | undefined {
  const [remaining, setRemaining] = useState<number | undefined>();
  useEffect(() => {
    if (!projectId) return setRemaining(undefined);
    // Read through the map each time: the panel may only open after this mounts.
    const read = () => {
      const state = readings.get(projectId)?.state;
      setRemaining(state?.status === "ready" ? remainingOf(state.list) : undefined);
    };
    read();
    watchers.add(read);
    return () => {
      watchers.delete(read);
    };
  }, [projectId]);
  return remaining;
}

/** Test seam: forget every reading, timers included. */
export function resetTaskList(): void {
  for (const reading of readings.values()) if (reading.timer) clearInterval(reading.timer);
  readings.clear();
  watchers.clear();
}
