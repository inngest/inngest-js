import { functions, inngest } from '$lib/inngest';
import { serve } from 'inngest/sveltekit';

export const { GET, POST, PUT } = serve({ client: inngest, functions });
