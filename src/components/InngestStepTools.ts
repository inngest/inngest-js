import { EventPayload, StepOpGenerator } from "../types";

export class InngestStepTools<Events extends Record<string, EventPayload>> {
  /**
   * Publically, this returns the event's data so that a generator function can
   * appropriately use its typing.
   *
   * Internally, this returns [StepOpCode, string] so that we can decide on how
   * to fill the data in later.
   */
  public *waitForEvent<Event extends keyof Events>(
    event: Event
  ): StepOpGenerator<Events[Event]> {
    yield null as unknown as Events[Event];
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return null as unknown as any;
    // return { name: "", data: { foo: "bar" }, ts: 123 } as Events[Event];
  }
}
