/**
 * @module
 * Hands each event of the tour's stream to the part of the site that wants
 * it. A fake's change and an area's own topic become window events, so a
 * panel listens for its own without the page knowing about it.
 */
import type { TourEvent } from "../../shared/types.ts";

export interface AreaEventDetail {
  area: string;
  topic: string;
  data?: unknown;
}

/**
 * Sends the stream events that are not the page's own (logs, status and
 * runs) to `target`: `tour:fakes` with the topic, and `tour:area` with the
 * area, topic and data. Returns true when it sent one.
 */
export const routeStreamEvent = (event: TourEvent, target: EventTarget) => {
  if (event.type === "fakes") {
    target.dispatchEvent(new CustomEvent("tour:fakes", { detail: event.topic }));

    return true;
  }

  if (event.type === "area") {
    const detail: AreaEventDetail = {
      area: event.area,
      topic: event.topic,
      data: event.data,
    };

    target.dispatchEvent(new CustomEvent("tour:area", { detail }));

    return true;
  }

  return false;
};
