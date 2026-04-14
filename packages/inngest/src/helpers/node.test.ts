import { Buffer } from "node:buffer";
import http from "node:http";
import { Socket } from "node:net";
import { expect, test } from "vitest";
import { readRequestBody } from "./node.ts";

test("multi-byte UTF-8 characters split across chunks", async () => {
  // Ensure that we correctly reconstruct a multi-byte UTF-8 character even when
  // it's split across chunks.

  const socket = new Socket();
  const req = new http.IncomingMessage(socket);

  // "é" 2 bytes in UTF-8
  const full = Buffer.from("é", "utf8");
  expect(full.length).toBe(2);
  const chunk1 = full.subarray(0, 1);
  const chunk2 = full.subarray(1);

  // Demonstrates the problem (concatenating with a string corrupts the
  // character)
  expect(
    // @ts-expect-error
    chunk1 + chunk2,
  ).toBe("��");

  req.push(chunk1);
  req.push(chunk2);
  req.push(null);

  const body = await readRequestBody(req);
  expect(body).toBe("é");
  expect(body).not.toContain("�");
});

test("stream error rejects the promise", async () => {
  const socket = new Socket();
  const req = new http.IncomingMessage(socket);
  const promise = readRequestBody(req);
  req.destroy(new Error("connection reset"));

  await expect(promise).rejects.toThrow("connection reset");
});
