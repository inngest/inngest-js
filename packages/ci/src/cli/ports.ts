/**
 * Finding free loopback ports for the Dev Server, the app and the reporter.
 *
 * @module
 */

import { createServer, type Server } from "node:net";

const listen = (server: Server): Promise<number> => {
  return new Promise((resolve, reject) => {
    server.once("error", reject);

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
};

const close = (server: Server): Promise<void> => {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
};

/**
 * Reserve `count` distinct ports by listening on all of them at once, then
 * release them. Holding every listener until the end is what keeps the ports
 * distinct.
 */
export const freePorts = async (count: number): Promise<number[]> => {
  const servers = Array.from({ length: count }, () => {
    return createServer();
  });

  try {
    return await Promise.all(servers.map(listen));
  } finally {
    await Promise.all(
      servers.map((server) => {
        return server.listening ? close(server) : Promise.resolve();
      }),
    );
  }
};
