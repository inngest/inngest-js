import express from 'express';
import { serve } from 'inngest/express';
import { functions, inngest } from './inngest';

const app = express();

// Parse JSON bodies
app.use(
  express.json({
    limit: '5mb',
  })
);

app.use('/api/inngest', serve({ client: inngest, functions }));

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
