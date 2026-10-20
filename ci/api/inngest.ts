/**
 * The endpoint Inngest Cloud calls to run the pipelines, deployed on Vercel
 * from this folder. It is the same app as `server.ts`, as web handlers on
 * Vercel's Node.js runtime, streaming so a long step isn't cut off.
 *
 * @module
 */

import { serve } from "inngest/next";

import { ci, inngest } from "../client.ts";
import "../pipelines/pr.ts";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: ci.functions(),
  streaming: true,
});
