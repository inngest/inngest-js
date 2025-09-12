import { createServerFileRoute } from '@tanstack/react-start/server'

import { serve } from "inngest/edge";
import { inngest } from "~/inngest/client";
import { helloWorld } from "~/inngest/helloWorld";

const handler = serve({ client: inngest, functions: [helloWorld] });
    
export const ServerRoute = createServerFileRoute('/api/inngest').methods({
  GET: async ({ request }) => handler(request),
  POST: async ({ request }) => handler(request),
  PUT: async ({ request }) => handler(request)
})
