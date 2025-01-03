import { createAPIFileRoute } from '@tanstack/start/api';
import { serve } from 'inngest/tanstack';
import { inngest, functions } from 'app/inngest';

export const APIRoute = createAPIFileRoute('/api/inngest')(
  serve({
    client: inngest,
    functions,
  }),
);
