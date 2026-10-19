/**
 * The loopback HTTP server the app reports to. It parses each `LocalMessage`
 * the app `POST`s and hands it to a listener.
 *
 * @module
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import type { LocalManifest, LocalMessage } from "../local/protocol.ts";

export interface ReporterServer {
  /** Where the app sends messages, as `http://127.0.0.1:<port>`. */
  url: string;

  /** Resolves with the first manifest the app sends. */
  manifest: Promise<LocalManifest>;

  close(): Promise<void>;
}

/** Start the server. `onMessage` is called with every message, in order. */
export const startReporterServer = async (
  onMessage: (message: LocalMessage) => void,
): Promise<ReporterServer> => {
  let resolveManifest: (manifest: LocalManifest) => void = () => {};

  const manifest = new Promise<LocalManifest>((resolve) => {
    resolveManifest = resolve;
  });

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));

        if (typeof message?.kind !== "string") {
          throw new Error("Not a message");
        }

        if (message.kind === "manifest") {
          resolveManifest(message.manifest);
        }

        onMessage(message as LocalMessage);

        res.writeHead(204).end();
      } catch {
        res.writeHead(400).end();
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    manifest,
    close: () => {
      return new Promise((resolve) => {
        server.close(() => {
          resolve();
        });

        server.closeAllConnections();
      });
    },
  };
};
