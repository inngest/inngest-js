/**
 * @module
 * The MCP server at `/mcp`: the code the read-only `mcp.ts` tab shows. It
 * wants a bearer token when `TOUR_MCP_TOKEN` is set.
 */
import { handleMcp } from "../../lessons/_shared/mcp.ts";
import type { AreaFactory } from "../area.ts";

const readBody = async (req: AsyncIterable<Buffer>) => {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
};

export const area: AreaFactory = () => {
  return {
    name: "mcp",
    raw: async (req, res) => {
      if (req.url !== "/mcp" || req.method !== "POST") {
        return false;
      }

      const headers = new Headers();

      for (const [name, value] of Object.entries(req.headers)) {
        headers.set(name, String(value));
      }

      const answer = await handleMcp(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers,
          body: await readBody(req),
        }),
        process.env.TOUR_MCP_TOKEN,
      );

      res.writeHead(answer.status, {
        "content-type": answer.headers.get("content-type") ?? "text/plain",
      });

      res.end(Buffer.from(await answer.arrayBuffer()));

      return true;
    },
  };
};
