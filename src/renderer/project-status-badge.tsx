import { LoaderCircle } from "./icons.js";
import { t } from "./i18n.js";

/** What a project's icon shows at its corner. */
export type ProjectStatusMark = "running" | "unread";

/**
 * A project's mark: its agent is working, or a task finished since the project
 * was last opened. Working wins, so a dot never hides a spinner.
 */
export function projectStatusMark(
  projectId: string,
  running: ReadonlyMap<string, unknown> | ReadonlySet<string>,
  unread: ReadonlySet<string>,
): ProjectStatusMark | undefined {
  if (running.has(projectId)) return "running";
  return unread.has(projectId) ? "unread" : undefined;
}

/** The mark's name, for the label the icon carries. */
export function projectStatusLabel(mark: ProjectStatusMark | undefined): string | undefined {
  return mark === "running" ? t("sidebar.projectRunning") : mark === "unread" ? t("sidebar.projectUnread") : undefined;
}

/** Decorative: the icon's own label already carries the mark's name. */
export function ProjectStatusBadge({ status }: { status?: ProjectStatusMark }) {
  if (!status) return null;
  return (
    <span className={`sidebar-badge is-${status}`} aria-hidden="true">
      {status === "running" ? <LoaderCircle className="spin" size={9} /> : null}
    </span>
  );
}
