import type http from "node:http";

/**
 * Read the incoming message request body as text.
 */
export async function readRequestBody(
  req: http.IncomingMessage,
): Promise<string> {
  return new Promise((resolve) => {
    // IMPORTANT: Do not collect chunks into a string, as it will corrupt
    // multi-byte UTF-8 characters at chunk boundaries.
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}
