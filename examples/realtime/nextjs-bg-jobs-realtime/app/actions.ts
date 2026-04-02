"use server";

import { inngest } from "@/lib/inngest";
import { campaignSendChannel } from "@/src/inngest/functions";
import { getClientSubscriptionToken } from "inngest/react";

export const fetchSubscriptionToken = async (campaignId: string) => {
  return getClientSubscriptionToken(inngest, {
    channel: campaignSendChannel({ campaignId }),
    topics: ["progress"],
  });
};
