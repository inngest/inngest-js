/**
 * @module
 * The play pane's panels. A panel is a file `panels/<id>.panel.tsx` that
 * calls `registerPanel` with its tab, its key and its component; the page
 * loads every such file, so a new panel edits no other file.
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
  // The name a manifest lists in `panels`.
  id: string;
  label: string;
  // The key that opens this tab.
  key: ActionId;
  // What to focus once the tab is open.
  focus: string;
  // Keys of the panel's own: each opens the tab and is handed to the panel.
  actions?: ActionId[];
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
