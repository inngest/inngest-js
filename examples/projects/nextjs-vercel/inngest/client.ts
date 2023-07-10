import { Inngest } from "inngest";

import type { Events } from "./types";

export const inngest = new Inngest<Events>({ name: "My Next.js app" });
