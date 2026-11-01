/**
 * @module
 * Format: formats a file the reader is editing with the repo's Biome. Run
 * formats first and the Format button calls the same route.
 */
import type { AreaFactory } from "../area.ts";
import { formatWithBiome } from "../biome.ts";
import { HttpError } from "../http-error.ts";

export const area: AreaFactory = (ctx) => {
  return {
    name: "format",
    routes: [
      {
        method: "POST",
        path: "/api/format",
        handle: ({ body }) => {
          if (
            typeof body.name !== "string" ||
            typeof body.content !== "string"
          ) {
            throw new HttpError(400, {
              error: "Send the file's name and content",
            });
          }

          return formatWithBiome(ctx.root, body.name, body.content);
        },
      },
    ],
  };
};
