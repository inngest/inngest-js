---
"inngest": minor
---

Add support for [Temporal](https://tc39.es/proposal-temporal/) APIs.

```ts
inngest.createFunction({
  id: "my-fn",
}, {
  event: "test/hello.world",
}, async ({ event, step }) => {
  // sleep with a `Temporal.Duration`
  await step.sleep("😴", Temporal.Duration.from({ seconds: 10 }));
  await step.sleep("😴", Temporal.Duration.from({ minutes: 5 }));
  await step.sleep("😴", Temporal.Duration.from({ hours: 1 }));

  // sleepUntil using a `Temporal.Instant` or `Temporal.ZonedDateTime`
  await step.sleepUntil("😴", Temporal.Instant.from("2025-03-19T12:00:00Z"));
  await step.sleepUntil(
    "😴",
    Temporal.ZonedDateTime.from("2025-03-19T12:00[Europe/London]"),
  );

  // sleepUntil also works with relative time
  const now = Temporal.Instant.from(event.user.createdAtISO);
  await step.sleepUntil("😴", now.add(Temporal.Duration.from({ minutes: 30 })));
});
```
