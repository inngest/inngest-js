/**
 * @module
 * The play pane's panels. A panel is a file `panels/<id>.panel.tsx` that
 * calls `registerPanel` with its id, label and component; the page loads every
 * such file, so a new panel edits no other file. The panel's id is also the
 * action in `shared/keys/` that opens its tab, and the actions that list the
 * panel in `panels` belong to it.
 */
import type { ComponentType } from "react";
import type { ActionId } from "../../../shared/keys.ts";
import type { Page } from "../../../shared/types.ts";

export interface PanelProps {
  page: Page;
  // True while the reader's app is live.
  live: boolean;
}

export interface PanelDef {
  // The name a manifest lists in `panels`, and the action that opens the tab.
  id: ActionId;
  label: string;
  // What to focus once the tab is open.
  focus: string;
  component: ComponentType<PanelProps>;
}

const defs = new Map<string, PanelDef>();

export const registerPanel = (def: PanelDef) => {
  defs.set(def.id, def);
};

export const panelOf = (id: string) => {
  return defs.get(id);
};

export const allPanels = () => {
  return [...defs.values()];
};
