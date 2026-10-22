/**
 * What the renderers return and the parts they share: a check's content, its
 * buttons, and the links every state can offer.
 *
 * @module
 */

/** A button on a check, which GitHub sends back as `requested_action`. */
export interface CheckAction {
  label: string;
  description: string;
  identifier: string;
}

/** Everything a check shows, ready to send. */
export interface CheckPayload {
  title: string;
  summary: string;
  /** Long output, shown below the summary. */
  text?: string;
  /** At most three. */
  actions: CheckAction[];
}

/** The links most states can offer, each optional. */
export interface CheckLinks {
  /** The run on Inngest, which is also where it is cancelled. */
  run: string;
  /** The step that failed or is running, when it has a link of its own. */
  step?: string;
  commit?: { sha: string; url: string };
  pullRequest?: { number: number; url: string };
}

export const cancelAction: CheckAction = {
  label: "Cancel",
  description: "Stop this run",
  identifier: "cancel",
};

export const rerunFreshAction: CheckAction = {
  label: "Re-run, no cache",
  description: "Run again from scratch",
  identifier: "rerun-fresh",
};

export const rerunAllAction: CheckAction = {
  label: "Re-run all",
  description: "Start the whole pipeline again",
  identifier: "rerun-all",
};

/** Markdown table cell text: one line, with no pipe to end the cell. */
export const cell = (text: string): string => {
  return text.replaceAll("|", "\\|").replaceAll(/\s*\n\s*/g, " ");
};
