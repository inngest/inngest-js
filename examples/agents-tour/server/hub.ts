/**
 * @module
 * The tour's event stream to the browsers: connected clients, the status
 * line and the console log that a new client is caught up with.
 */
import type { ServerResponse } from "node:http";
import type { TourEvent } from "../shared/types.ts";

type StatusEvent = Extract<TourEvent, { type: "status" }>;

export class Hub {
  readonly clients = new Set<ServerResponse>();
  readonly log: TourEvent[] = [];
  status: StatusEvent = {
    type: "status",
    state: "idle",
    text: "Starting the Dev Server...",
  };

  broadcast(event: TourEvent) {
    const line = `data: ${JSON.stringify(event)}\n\n`;

    for (const client of this.clients) {
      client.write(line);
    }
  }

  emit(event: TourEvent) {
    if (event.type === "log") {
      this.log.push(event);
    } else if (event.type === "clear") {
      this.log.length = 0;
    } else if (event.type === "status") {
      this.status = event;
    }

    this.broadcast(event);
  }

  info(text: string) {
    this.emit({ type: "log", kind: "info", text });
  }

  setStatus(state: StatusEvent["state"], text: string) {
    this.emit({ type: "status", state, text });
  }

  /**
   * Opens the stream for a browser, first catching it up with `replay`.
   */
  open(res: ServerResponse, replay: TourEvent[]) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    for (const event of [this.status, ...this.log, ...replay]) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    this.clients.add(res);
    res.on("close", () => {
      this.clients.delete(res);
    });
  }

  close() {
    for (const client of this.clients) {
      client.end();
    }
  }
}
