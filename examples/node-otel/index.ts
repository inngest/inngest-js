// Import the client first
import { inngest } from './inngest';

// Then import everything else
import { createServer } from 'inngest/node';
import { functions } from './inngest';

const server = createServer({ client: inngest, functions });

server.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
