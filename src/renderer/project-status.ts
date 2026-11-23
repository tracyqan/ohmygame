import { useEffect, useSyncExternalStore } from "react";
import type { ProjectActivitySnapshot, ProjectAgentActivity } from "../shared/contracts.js";
import { streamProjectActivity } from "./api.js";

// A project's agent activity, for anywhere its icon shows: the sidebar rail,
// the expanded list and the project cards. One stream feeds all of them, and
// it remembers which projects finished while the person was elsewhere.

const UNREAD_KEY = "ohmygame:project-unread";

export interface ProjectStatusState {
  /** The projects whose agent is working right now. */
  running: ReadonlyMap<string, ProjectAgentActivity["status"]>;
  /** The projects that finished a task you haven't opened since. */
  unread: ReadonlySet<string>;
  /** Names the daemon settled on, for the pages that show theirs. */
  names: ProjectActivitySnapshot["names"];
}

// Read on first use: node tests import this module without a browser.
let state: ProjectStatusState | undefined;
const listeners = new Set<() => void>();
/** The project on screen; its task finishing is not news. */
let viewed: string | undefined;

function emit(): void {
  for (const listener of listeners) listener();
}

function loadUnread(): ReadonlySet<string> {
  try {
    const saved = JSON.parse(localStorage.getItem(UNREAD_KEY) ?? "[]") as unknown;
    if (Array.isArray(saved)) return new Set(saved.filter((id): id is string => typeof id === "string"));
  } catch {
    // A damaged or unavailable record starts over.
  }
  return new Set();
}

function saveUnread(unread: ReadonlySet<string>): void {
  try {
    localStorage.setItem(UNREAD_KEY, JSON.stringify([...unread]));
  } catch {
    // Out of space, or storage blocked: the dot still lives for this run.
  }
}

function read(): ProjectStatusState {
  state ??= { running: new Map(), unread: loadUnread(), names: [] };
  return state;
}

function update(change: Partial<ProjectStatusState>): void {
  state = { ...read(), ...change };
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Every project's agent activity, as the last snapshot said it. */
export function useProjectStatus(): ProjectStatusState {
  return useSyncExternalStore(subscribe, read, read);
}

/** Clears a project's finished mark, such as when it is opened. */
export function markProjectSeen(projectId: string): void {
  const { unread } = read();
  if (!unread.has(projectId)) return;
  const next = new Set(unread);
  next.delete(projectId);
  saveUnread(next);
  update({ unread: next });
}

/** The project on screen: a task finishing here reads as seen, not as a dot. */
export function setViewedProject(projectId: string | undefined): void {
  viewed = projectId;
  if (projectId) markProjectSeen(projectId);
}

function applySnapshot(snapshot: ProjectActivitySnapshot): void {
  const { running: previous, unread, names } = read();
  const running = new Map(snapshot.activity.map(({ projectId, status }) => [projectId, status] as const));
  const unchanged = running.size === previous.size && [...running].every(([projectId, status]) => previous.get(projectId) === status);
  // A project that left the running set finished, failed or was stopped: all
  // three are worth a dot until the project is opened.
  const finished = [...previous.keys()].filter((projectId) => !running.has(projectId) && projectId !== viewed);
  let nextUnread = unread;
  if (finished.length) {
    nextUnread = new Set([...unread, ...finished]);
    saveUnread(nextUnread);
  }
  const sameNames = names.length === snapshot.names.length &&
    names.every((name, at) => name.id === snapshot.names[at]?.id && name.name === snapshot.names[at]?.name);
  if (unchanged && sameNames && nextUnread === unread) return;
  update({ running: unchanged ? previous : running, unread: nextUnread, names: sameNames ? names : snapshot.names });
}

// One stream, however many icons watch it: the first caller starts it and the
// last one to leave stops it.
let watchers = 0;
let stream: AbortController | undefined;

/** Follows every project's activity, while a component that shows it is mounted. */
export function useProjectStatusStream(enabled = true): void {
  useEffect(() => {
    if (!enabled) return undefined;
    watchers += 1;
    if (!stream) {
      const controller = new AbortController();
      stream = controller;
      void streamProjectActivity(controller.signal, applySnapshot);
    }
    return () => {
      watchers -= 1;
      if (watchers > 0 || !stream) return;
      stream.abort();
      stream = undefined;
    };
  }, [enabled]);
}
