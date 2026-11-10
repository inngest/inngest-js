import { describe, expect, it } from "vitest";
import { sentryEventSpanAttributes } from "./event-span-attributes";

const event = {
  id: "01JF",
  name: "user.created",
  data: { email: "person@example.com", name: "Ada" },
};

describe("sentryEventSpanAttributes", () => {
  it("keeps id and name and omits the payload by default", () => {
    expect(sentryEventSpanAttributes(event, false)).toEqual({
      "inngest.event.id": "01JF",
      "inngest.event.name": "user.created",
    });
    expect(JSON.stringify(sentryEventSpanAttributes(event, false))).not.toContain(
      "person@example.com",
    );
  });

  it("adds the full event JSON when includeEventPayload is true", () => {
    expect(sentryEventSpanAttributes(event, true)).toEqual({
      "inngest.event.id": "01JF",
      "inngest.event.name": "user.created",
      "inngest.event": JSON.stringify(event),
    });
  });
});
