import { LoaderCircle } from "./icons.js";
import { t } from "./i18n.js";
import "./project-running-mark.css";

/** The agent is working in this project, where the attention mark sits. */
export function ProjectRunningMark() {
  return (
    <span aria-hidden="true" title={runningLabel()} className="project-running-mark">
      <LoaderCircle className="spin" size={11} />
    </span>
  );
}

/** What the spinner means, for the label a button carries. */
export function runningLabel(): string {
  return t("sidebar.projectRunning");
}
