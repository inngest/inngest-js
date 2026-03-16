import { Inngest } from 'inngest';
import { realtimeMiddleware } from '@inngest/realtime/middleware';

// You can configure your app id and other options here
export const inngest = new Inngest({
  id: 'nextjs-starter-app',
  middleware: [realtimeMiddleware()],
});
