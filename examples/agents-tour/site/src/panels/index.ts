/**
 * @module
 * Loads every `*.panel.tsx` so each registers itself.
 */
import.meta.glob("./*.panel.tsx", { eager: true });

export type { PanelDef, PanelProps } from "./registry.ts";
export { allPanels, panelOf } from "./registry.ts";
