"use server";

import { inngest } from "@/lib/inngest";
import { campaignSendChannel } from "@/src/inngest/functions";
import { getSubscriptionToken, Realtime } from "@inngest/realtime";

// securely fetch an Inngest Realtime subscription token from the server as a server action
export async function fetchSubscriptionToken(
  campaignId: string
): Promise<Realtime.Token<typeof campaignSendChannel, ["progress"]>> {
  const token = await getSubscriptionToken(inngest, {
    channel: campaignSendChannel(campaignId),
    topics: ["progress"],
  });

  return token;
}
