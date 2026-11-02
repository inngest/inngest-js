/**
 * @module
 * The scripted model `tour:verify` runs pages with: a model that answers
 * from the script in the page's manifest (`verify.model`), so a page that
 * needs a model works with no key and no download, and says the same thing
 * every time. The tour server sets `TOUR_MODEL=scripted` and the script in
 * `TOUR_MODEL_SCRIPT` when verify starts the tour; `models.ts` asks
 * `isScripted()` and returns `scriptedModel()` when it is true.
 */
import { script } from "inngest/experimental/agents/testing";

type Steps = Parameters<typeof script>[0];

export const isScripted = () => {
  return process.env.TOUR_MODEL === "scripted";
};

export const scriptedModel = () => {
  return script(JSON.parse(process.env.TOUR_MODEL_SCRIPT ?? "[]") as Steps);
};
