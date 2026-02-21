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

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
