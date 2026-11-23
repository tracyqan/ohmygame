import { useMemo, useState } from "react";
import { Check, ClipboardList, LoaderCircle, TriangleAlert } from "./icons.js";
import { Button, Empty, SegmentedControl } from "./ui/index.js";
import { t } from "./i18n.js";
import { sortedByPriority, type ProjectTask } from "./task-file.js";
import { refreshTaskList, useTaskList } from "./task-list-data.js";
import "./task-list-panel.css";

type Filter = "open" | "all" | "done";
type Order = "priority" | "file";

/**
 * Tasks: the project's `TASKS.md`, read but never written here. The agent
 * plans and ticks it off; this shows the plan as it stands, so the file stays
 * the one place a person, an editor and an agent all agree on.
 */
export function TaskListPanel({ projectId }: { projectId: string }) {
  const state = useTaskList(projectId);
  const [filter, setFilter] = useState<Filter>("open");
  const [order, setOrder] = useState<Order>("priority");

  const list = state.status === "ready" ? state.list : undefined;
  const kept = useMemo(() => {
    const keep = (task: ProjectTask) => filter === "all" || (filter === "done" ? task.done : !task.done);
    if (!list) return [];
    return order === "priority"
      ? [{ title: "", tasks: sortedByPriority(list.tasks).filter(keep) }]
      : list.groups
        .map((group) => ({ title: group.title, tasks: group.tasks.filter(keep) }))
        .filter((group) => group.tasks.length > 0);
  }, [list, filter, order]);

  if (state.status === "loading") return <div className="task-list-loading"><LoaderCircle className="spin" size={16} /></div>;

  if (state.status === "error") return <div className="task-list-notice">
    <Empty icon={<TriangleAlert size={20} />} title={t("taskList.errorTitle")} description={state.message}
      action={<Button size="sm" onClick={() => refreshTaskList(projectId)}>{t("taskList.retry")}</Button>} />
  </div>;

  if (state.status === "missing") return <div className="task-list-notice">
    <Empty icon={<ClipboardList size={20} />} title={t("taskList.missingTitle")} description={t("taskList.missingBody")}
      action={<Button size="sm" onClick={() => refreshTaskList(projectId)}>{t("taskList.retry")}</Button>} />
  </div>;

  const { list: tasks, truncated } = state;
  if (tasks.total === 0) return <div className="task-list-notice">
    <Empty icon={<ClipboardList size={20} />} title={t("taskList.emptyTitle")} description={t("taskList.emptyBody")} />
  </div>;

  const open = tasks.total - tasks.done;
  const urgent = tasks.tasks.filter((task) => !task.done && task.priority === "high").length;
  const percent = tasks.total ? Math.round((tasks.done / tasks.total) * 100) : 0;

  return (
    <div className="task-list">
      <header className="task-list-head">
        <div className="task-list-bar" role="progressbar" aria-valuemin={0} aria-valuemax={tasks.total} aria-valuenow={tasks.done}
          aria-label={t("taskList.progress", { done: tasks.done, total: tasks.total })}>
          <span style={{ width: `${percent}%` }} />
        </div>
        <span className="task-list-count">{tasks.done} / {tasks.total}</span>
        {urgent ? <span className="task-list-urgent">{t("taskList.high", { count: urgent })}</span> : null}
        <span className="task-list-file" title={t("taskList.fileHint")}>TASKS.md</span>
      </header>

      <div className="task-list-controls">
        <SegmentedControl label={t("taskList.filterLabel")} size="sm" value={filter} onChange={setFilter} options={[
          { value: "open", label: t("taskList.filterOpen", { count: open }) },
          { value: "all", label: t("taskList.filterAll", { count: tasks.total }) },
          { value: "done", label: t("taskList.filterDone", { count: tasks.done }) },
        ]} />
        <SegmentedControl label={t("taskList.orderLabel")} size="sm" value={order} onChange={setOrder} options={[
          { value: "priority", label: t("taskList.orderPriority") },
          { value: "file", label: t("taskList.orderFile") },
        ]} />
      </div>

      <div className="task-list-body">
        {truncated ? <p className="task-list-note">{t("taskList.truncated")}</p> : null}
        {kept.length === 0 ? <p className="task-list-none">{t("taskList.noMatch")}</p> : kept.map((group) => (
          <section key={`${group.title}-${group.tasks[0]?.line ?? 0}`} className="task-list-section">
            {group.title ? <h3 className="task-list-group-title">{group.title}</h3> : null}
            <ul className="task-list-rows">
              {group.tasks.map((task) => (
                <li key={task.line} className={`task-list-row${task.done ? " is-done" : ""}`}>
                  <span className="task-list-check" role="checkbox" aria-checked={task.done} aria-disabled="true" aria-label={task.text}>
                    {task.done ? <Check size={10} /> : null}
                  </span>
                  <span className="task-list-text">{task.text}</span>
                  {task.priority ? <span className={`task-list-priority is-${task.priority}`}>{t(`taskList.priority.${task.priority}`)}</span> : null}
                  {order === "priority" && task.group ? <span className="task-list-belonging">{task.group}</span> : null}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <footer className="task-list-foot">{t("taskList.readOnly")}</footer>
    </div>
  );
}
