import { useEffect, type Dispatch, type SetStateAction } from "react";
import type { ProjectAgentActivity, ProjectState } from "../shared/contracts.js";
import { useProjectStatus, useProjectStatusStream } from "./project-status.js";

type ProjectActivity = ReadonlyMap<string, ProjectAgentActivity["status"]>;

/**
 * Follow activity for all project cards together over the app's one stream.
 * The sidebar shows the same activity on the project icons, so the stream and
 * what it last said live in `project-status`.
 */
export function useProjectActivity(enabled: boolean, setProjects?: Dispatch<SetStateAction<ProjectState[]>>): ProjectActivity {
  useProjectStatusStream(enabled);
  const { running, names } = useProjectStatus();

  useEffect(() => {
    if (!setProjects || !names.length) return;
    const latest = new Map(names.map((project) => [project.id, project]));
    setProjects((previous) => {
      let changed = false;
      const next = previous.map((project) => {
        const named = latest.get(project.id);
        if (project.nameSource !== "default" || !named?.nameSource || named.nameSource === "default") return project;
        changed = true;
        return { ...project, name: named.name, nameSource: named.nameSource };
      });
      return changed ? next : previous;
    });
  }, [names, setProjects]);

  return running;
}
