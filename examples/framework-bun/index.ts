import { serve } from 'inngest/edge';
import { inngest, functions } from './inngest';

const server = Bun.serve({
  port: 3000,
  fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === '/api/inngest') {
      return serve({ client: inngest, functions })(request);
    }

    return new Response('Server');
  },
});

console.log(`Listening on ${server.hostname}:${server.port}`);
