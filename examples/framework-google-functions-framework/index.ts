import * as ff from '@google-cloud/functions-framework';
import { serve } from 'inngest/express';

import { inngest, functions } from './inngest';

ff.http(
  'inngest',
  serve({
    client: inngest,
    functions,
  })
);
