/**
 * @module
 * What an area of the tour server is. An area is one file in `areas/` that
 * exports `area`: a function from the shared context to the routes it
 * answers, the event-stream events a new browser should get, and what it
 * does when a page is opened or Run is pressed. The server
 * loads every file in `areas/`, so a new area touches no other file.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Start, TourEvent, TourIndex } from "../shared/types.ts";
import type { DevServer } from "./devserver.ts";
import type { Hub } from "./hub.ts";
import type { LoadedPage } from "./lessons.ts";
import type { Worker } from "./worker.ts";

export interface Call {
  url: URL;
  // The JSON body of a POST; empty for a GET.
  body: Record<string, unknown>;
}

export interface Route {
  method: "GET" | "POST";
  path: string;
  // The JSON answer. Throw an `HttpError` for any other status.
  handle: (call: Call) => unknown | Promise<unknown>;
}

export interface Area {
  name: string;
  routes?: Route[];
  // A route that needs the raw request, such as a fake's own REST API.
  // Return true when it answered.
  raw?: (
    req: IncomingMessage,
    res: ServerResponse,
  ) => boolean | Promise<boolean>;
  // Events a browser gets when it opens the event stream.
  replay?: () => TourEvent[];
  // A page was opened, Run was pressed, or the tour was reset.
  reset?: () => void | Promise<void>;
  // A `start` entry of a manifest: return true when this area sent it.
  send?: (start: Start) => boolean | Promise<boolean>;
}

export interface TourContext {
  root: string;
  publicUrl: string;
  dataDir: string;
  devServer: DevServer;
  worker: Worker;
  hub: Hub;
  pages: LoadedPage[];
  index: TourIndex;
  // Every loaded area, once all of them are made.
  areas: () => Area[];
  // Runs every area's `reset`.
  resetAreas: () => Promise<void>;
}

export type AreaFactory = (ctx: TourContext) => Area;
