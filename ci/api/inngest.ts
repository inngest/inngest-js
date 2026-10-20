/**
 * The endpoint Inngest Cloud calls to run the pipelines, deployed on Vercel
 * from this folder. It is the same app as `server.ts`, behind Vercel's
 * Node.js runtime, and streams so a long step isn't cut off.
 *
 * @module
 */

import { serve } from "inngest/edge";

import { ci, inngest } from "../client.ts";
import "../pipelines/pr.ts";

const handler = serve({
  client: inngest,
  functions: ci.functions(),
  streaming: true,
});

export const GET = handler;

export const POST = handler;

export const PUT = handler;
