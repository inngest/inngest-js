import { inngest } from "@/lib/inngest";
import { db, campaigns, contacts, contactSegments, segments } from "@/lib/db";
import { segmentContacts } from "@/lib/openai";
import { eq } from "drizzle-orm";
// import { sendEmail } from "@/lib/resend";
import { channel, topic } from "@inngest/realtime";
import { z } from "zod";

export const contactImport = inngest.createFunction(
  { id: "contact-import" },
  { event: "app/contact.import" },
  async ({ event, step }) => {
    // 1. Parse contacts from event data
    const contactList = event.data.contacts;
    if (!Array.isArray(contactList) || contactList.length === 0) {
      return { success: false, message: "No contacts provided" };
    }
    // Require email for each contact
    if (contactList.some((c) => !c.email)) {
      return { success: false, message: "All contacts must have an email" };
    }
    // 2. Insert contacts into the database
    const inserted = await step.run("insert-contacts", async () => {
      return db.insert(contacts).values(contactList).returning();
    });

    // 3. Segment contacts using OpenAI (as an Inngest step)
    const segmentation = await segmentContacts(inserted, step);

    await step.run("save-segments-and-assignments", async () => {
      // 1. Insert segments (if not already present)
      //    For simplicity, insert all segments and ignore conflicts (e.g., on name)
      await db
        .insert(segments)
        .values(
          segmentation.segments.map((s) => ({
            name: s.name,
            description: s.description ?? null,
          }))
        )
        .onConflictDoNothing()
        .returning();

      // 2. Fetch all segments to get their IDs (by name)
      const allSegments = await db.select().from(segments);
      const segmentNameToId = Object.fromEntries(
        allSegments.map((s) => [s.name, s.id])
      );

      // 3. Insert assignments into contact_segments
      await db
        .insert(contactSegments)
        .values(
          segmentation.assignments.map((a) => ({
            contactId: a.contactId,
            segmentId: segmentNameToId[a.segmentName],
          }))
        )
        .onConflictDoNothing();
    });

    // 4. Return summary
    return {
      success: true,
      imported: inserted.length,
      contactIds: inserted.map((c) => c.id),
      segmentation,
    };
  }
);

// create a channel for each user, given a user ID. A channel is a namespace for one or more topics of streams.
export const campaignSendChannel = channel(
  (campaignId: string) => `campaign-send:${campaignId}`
)
  // Add a specific topic, eg. "ai" for all AI data within the user's channel
  .addTopic(
    topic("progress").schema(
      z.object({
        message: z.string(),
        // Transforms are supported for realtime data
        complete: z.boolean(),
      })
    )
  );

export const campaignSend = inngest.createFunction(
  { id: "campaign-send" },
  { event: "app/campaign.send" },
  async ({ event, step, publish }) => {
    const {
      campaignId,
      segmentId,
      scheduledAt,
      subject: eventSubject,
      content: eventContent,
    } = event.data;

    await publish(
      campaignSendChannel(campaignId).progress({
        message: "Preparing the campaign...",
        complete: false,
      })
    );

    // 1. Fetch campaign
    const [campaign] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, campaignId));
    if (!campaign) {
      return { success: false, message: "Campaign not found", campaignId };
    }

    // 2. Fetch contacts in the segment (with email)
    const segmentContacts = await db
      .select({
        id: contacts.id,
        firstname: contacts.firstname,
        lastname: contacts.lastname,
        email: contacts.email,
      })
      .from(contacts)
      .innerJoin(contactSegments, eq(contactSegments.contactId, contacts.id))
      .where(eq(contactSegments.segmentId, segmentId));

    await publish(
      campaignSendChannel(campaignId).progress({
        message: `Sending ${campaign.name} to ${segmentContacts.length} contacts`,
        complete: false,
      })
    );

    // 3. (Placeholder) Generate email content (optionally with OpenAI)
    // TODO: Use OpenAI to personalize content per contact
    const emailSubject = eventSubject || campaign.subject;
    // const emailContent = eventContent || campaign.content;

    // 4. Send emails using Resend
    // const results = [];
    for (let i = 0; i < segmentContacts.length; i++) {
      const contact = segmentContacts[i];
      // try {
      //   const res = await sendEmail({
      //     to: contact.email,
      //     subject: emailSubject,
      //     html: emailContent,
      //   });
      //   results.push({
      //     contactId: contact.id,
      //     email: contact.email,
      //     status: "sent",
      //     messageId: res.data?.id,
      //   });
      // } catch (err) {
      //   results.push({
      //     contactId: contact.id,
      //     email: contact.email,
      //     status: "error",
      //     error: String(err),
      //   });
      // }
      // Every 5 contacts, pause and publish progress
      if ((i + 1) % 5 === 0 || i === segmentContacts.length - 1) {
        await step.sleep("wait-1s", 1000);
        await publish(
          campaignSendChannel(campaignId).progress({
            message: `Sent ${i + 1} of ${segmentContacts.length} contacts... (Subject: ${emailSubject})`,
            complete: false,
          })
        );
      }
    }

    await campaignSendChannel(campaignId).progress({
      message: `The ${campaign.name} is now sent! (Subject: ${emailSubject})`,
      complete: true,
    });

    // 5. Return summary
    return {
      success: true,
      campaignId,
      segmentId,
      scheduledAt,
      // sent: results.filter((r) => r.status === "sent").length,
      // failed: results.filter((r) => r.status === "error").length,
      // results,
      message: "Campaign send job completed",
    };
  }
);
