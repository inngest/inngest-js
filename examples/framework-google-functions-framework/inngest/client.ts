import { Inngest } from 'inngest';
import { schemas } from './types';

export const inngest = new Inngest({ id: 'my-gcp-functions-app', schemas });
