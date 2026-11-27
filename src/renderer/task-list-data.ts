import { useEffect, useState } from "react";
import { ApiError, getWorkspaceFile, request } from "./api.js";
import { language } from "./i18n.js";
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
  /** The project itself is gone: reading it again can only 404, so the poll stops. */
  | { status: "gone" }
  | { status: "error"; message: string };

/** Fast enough that a task the agent completes shows up while you watch. */
const POLL_MS = 4_000;
/** After this many failed reads the poll slows down, so a sick daemon is not hit every 4s. */
const FAILURES_BEFORE_BACKOFF = 3;
const BACKOFF_MS = 30_000;

interface Reading {
  state: TaskListState;
  timer?: ReturnType<typeof setInterval>;
  busy: boolean;
  /** How many mounted views show this project; the poll stops when it reaches zero. */
  viewers: number;
  failures: number;
  lastAttempt: number;
}

const readings = new Map<string, Reading>();
/** Seeding is once per project per page, even if the panel is closed and opened again. */
const seededProjects = new Set<string>();
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

function stopPolling(reading: Reading): void {
  if (reading.timer) clearInterval(reading.timer);
  reading.timer = undefined;
}

function startPolling(projectId: string, reading: Reading): void {
  // A project that is gone stays gone for the life of this view: no timer at all.
  if (reading.timer || reading.state.status === "gone") return;
  reading.timer = setInterval(() => {
    // A hidden window has nobody looking, and the file is read again on return.
    if (document.visibilityState === "hidden") return;
    if (reading.failures >= FAILURES_BEFORE_BACKOFF && Date.now() - reading.lastAttempt < BACKOFF_MS) return;
    void load(projectId, false);
  }, POLL_MS);
}

async function load(projectId: string, seed: boolean): Promise<void> {
  const reading = readings.get(projectId);
  if (!reading || reading.busy) return;
  // Terminal: the project was deleted or replaced, so every read would be a 404.
  if (reading.state.status === "gone") return;
  reading.busy = true;
  reading.lastAttempt = Date.now();
  try {
    // The first time the panel opens in a project, the file is asked for even
    // when one is there: the daemon leaves its content alone but fills a file
    // that is empty, which is what an older build of this panel left behind.
    if (seed && !seededProjects.has(projectId)) {
      seededProjects.add(projectId);
      await request(`/projects/${encodeURIComponent(projectId)}/tasks?language=${encodeURIComponent(language)}`, { method: "POST" })
        .catch(() => undefined);
    }
    const file = await readTaskFile(projectId);
    reading.failures = 0;
    publish(projectId, file
      ? { status: "ready", list: parseTaskFile(file.content ?? ""), truncated: file.truncated === true }
      : { status: "missing" });
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 404) {
      // The project itself is gone. Retrying every 4s would only log a 404 for ever.
      stopPolling(reading);
      publish(projectId, { status: "gone" });
    } else {
      reading.failures += 1;
      publish(projectId, { status: "error", message: messageOf(cause) });
    }
  } finally {
    reading.busy = false;
  }
}

/** Starts reading a project once, and keeps the reading fresh for as long as anything shows it. */
function readingFor(projectId: string, seed: boolean): Reading {
  let reading = readings.get(projectId);
  const first = !reading;
  if (!reading) {
    reading = { state: { status: "loading" }, busy: false, viewers: 0, failures: 0, lastAttempt: 0 };
    readings.set(projectId, reading);
  }
  reading.viewers += 1;
  if (first) {
    void load(projectId, seed);
    startPolling(projectId, reading);
  }
  return reading;
}

/** One view stopped showing the project; the last one out takes the timer with it. */
function release(projectId: string): void {
  const reading = readings.get(projectId);
  if (!reading) return;
  reading.viewers -= 1;
  if (reading.viewers > 0) return;
  stopPolling(reading);
  readings.delete(projectId);
}

/** Reads the file again now, for the retry button and for a window coming back. */
export function refreshTaskList(projectId: string): void {
  const reading = readings.get(projectId);
  if (!reading) return;
  // A person asking again clears the backoff: it exists for automatic polls only.
  reading.failures = 0;
  reading.lastAttempt = 0;
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
      release(projectId);
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
  for (const reading of readings.values()) stopPolling(reading);
  readings.clear();
  seededProjects.clear();
  watchers.clear();
}
