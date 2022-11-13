import { envKeys } from "../helpers/consts";
import { devServerAvailable, devServerUrl } from "../helpers/devserver";
import { devServerHost, hasProcessEnv, isProd } from "../helpers/env";
import type {
  PartialK,
  SendEventPayload,
  SingleOrArray,
  ValueOf,
} from "../helpers/types";
import type {
  ClientOptions,
  EventPayload,
  FunctionOptions,
  Handler,
  TriggerOptions,
} from "../types";
import { version } from "../version";
import { InngestFunction } from "./InngestFunction";

/**
 * A client used to interact with the Inngest API by sending or reacting to
 * events.
 *
 * To provide event typing, make sure to pass in your generated event types as
 * the first generic.
 *
 * ```ts
 * const inngest = new Inngest<Events>({ name: "My App" });
 *
 * // or to provide custom events too
 * const inngest = new Inngest<
 *   Events & {
 *     "app/user.created": {
 *       name: "app/user.created";
 *       data: {
 *         foo: boolean;
 *       };
 *     };
 *   }
 * >({ name: "My App" });
 * ```
 *
 * @public
 */
export class Inngest<Events extends Record<string, EventPayload>> {
  /**
   * The name of this instance, most commonly the name of the application it
   * resides in.
   */
  public readonly name: string;

  /**
   * Inngest event key, used to send events to Inngest Cloud.
   */
  private readonly eventKey: string;

  /**
   * Base URL for Inngest Cloud.
   */
  public readonly inngestBaseUrl: URL;

  /**
   * The absolute URL of the Inngest Cloud API.
   */
  private readonly inngestApiUrl: URL;

  private readonly headers: Record<string, string>;

  /**
   * A client used to interact with the Inngest API by sending or reacting to
   * events.
   *
   * To provide event typing, make sure to pass in your generated event types as
   * the first generic.
   *
   * ```ts
   * const inngest = new Inngest<Events>({ name: "My App" });
   *
   * // or to provide custom events too
   * const inngest = new Inngest<
   *   Events & {
   *     "app/user.created": {
   *       name: "app/user.created";
   *       data: {
   *         foo: boolean;
   *       };
   *     };
   *   }
   * >({ name: "My App" });
   * ```
   */
  constructor({
    name,
    eventKey,
    inngestBaseUrl = "https://inn.gs/",
  }: ClientOptions) {
    if (!name) {
      throw new Error("A name must be passed to create an Inngest instance.");
    }

    if (!eventKey) {
      throw new Error(
        "An event key must be passed to create an Inngest instance."
      );
    }

    this.name = name;

    this.eventKey =
      eventKey || (hasProcessEnv() ? process.env[envKeys.EventKey] || "" : "");

    this.inngestBaseUrl = new URL(inngestBaseUrl);
    this.inngestApiUrl = new URL(`e/${this.eventKey}`, this.inngestBaseUrl);

    this.headers = {
      "Content-Type": "application/json",
      "User-Agent": `InngestJS v${version}`,
    };
  }

  /**
   * Given a response from Inngest, relay the error to the caller.
   */
  async #getResponseError(response: globalThis.Response): Promise<Error> {
    let errorMessage = "Unknown error";
    switch (response.status) {
      case 401:
        errorMessage = "Event key Not Found";
        break;
      case 400:
        errorMessage = "Cannot process event payload";
        break;
      case 403:
        errorMessage = "Forbidden";
        break;
      case 404:
        errorMessage = "Event key not found";
        break;
      case 406:
        errorMessage = `${JSON.stringify(await response.json())}`;
        break;
      case 409:
      case 412:
        errorMessage = "Event transformation failed";
        break;
      case 413:
        errorMessage = "Event payload too large";
        break;
      case 500:
        errorMessage = "Internal server error";
        break;
    }
    return new Error(`Inngest API Error: ${response.status} ${errorMessage}`);
  }

  /**
   * Send one or many events to Inngest. Takes a known event from this Inngest
   * instance based on the given `name`.
   *
   * ```ts
   * await inngest.send("app/user.created", { data: { id: 123 } });
   * ```
   *
   * Returns a promise that will resolve if the event(s) were sent successfully,
   * else throws with an error explaining what went wrong.
   *
   * If you wish to send an event with custom types (i.e. one that hasn't been
   * generated), make sure to add it when creating your Inngest instance, like
   * so:
   *
   * ```ts
   * const inngest = new Inngest<Events & {
   *   "my/event": {
   *     name: "my/event";
   *     data: { bar: string; };
   *   }
   * }>("My App", "API_KEY");
   * ```
   */
  public async send<Event extends keyof Events>(
    name: Event,
    payload: SingleOrArray<PartialK<Omit<Events[Event], "name" | "v">, "ts">>
  ): Promise<void>;
  /**
   * Send one or many events to Inngest. Takes an entire payload (including
   * name) as each input.
   *
   * ```ts
   * await inngest.send({ name: "app/user.created", data: { id: 123 } });
   * ```
   *
   * Returns a promise that will resolve if the event(s) were sent successfully,
   * else throws with an error explaining what went wrong.
   *
   * If you wish to send an event with custom types (i.e. one that hasn't been
   * generated), make sure to add it when creating your Inngest instance, like
   * so:
   *
   * ```ts
   * const inngest = new Inngest<Events & {
   *   "my/event": {
   *     name: "my/event";
   *     data: { bar: string; };
   *   }
   * }>("My App", "API_KEY");
   * ```
   */
  public async send<Payload extends SendEventPayload<Events>>(
    payload: Payload
  ): Promise<void>;
  public async send<Event extends keyof Events>(
    nameOrPayload:
      | Event
      | SingleOrArray<
          ValueOf<{
            [K in keyof Events]: PartialK<Omit<Events[K], "v">, "ts">;
          }>
        >,
    maybePayload?: SingleOrArray<
      PartialK<Omit<Events[Event], "name" | "v">, "ts">
    >
  ): Promise<void> {
    let payloads: ValueOf<Events>[];

    if (typeof nameOrPayload === "string") {
      /**
       * Add our payloads and ensure they all have a name.
       */
      payloads = (
        Array.isArray(maybePayload)
          ? maybePayload
          : maybePayload
          ? [maybePayload]
          : []
      ).map((payload) => ({
        ...payload,
        name: nameOrPayload,
      })) as typeof payloads;
    } else {
      /**
       * Grab our payloads straight from the args.
       */
      payloads = (
        Array.isArray(nameOrPayload)
          ? nameOrPayload
          : nameOrPayload
          ? [nameOrPayload]
          : []
      ) as typeof payloads;
    }

    /**
     * The two overload types should never allow this to happen, but in the case
     * the user is in JS Land and it does, let's throw.
     */
    if (!payloads.length) {
      throw new Error(
        "Provided a name but no events to send; make sure to send an event payload too"
      );
    }

    // When sending events, check if the dev server is available.  If so, use the
    // dev server.
    let url = this.inngestApiUrl.href;

    if (!isProd()) {
      const host = devServerHost();
      // If the dev server host env var has been set we always want to use
      // the dev server - even if it's down.  Otherwise, optimistically use
      // it for non-prod services.
      if (host !== undefined || (await devServerAvailable(host, fetch))) {
        url = devServerUrl(host, `e/${this.eventKey}`).href;
      }
    }

    const response = await fetch(url, {
      method: "POST",
      body: JSON.stringify(payloads),
      headers: { ...this.headers },
    });

    if (response.status >= 200 && response.status < 300) {
      return;
    }

    throw await this.#getResponseError(response);
  }

  public createFunction<
    Trigger extends TriggerOptions<keyof Events & string>,
    NameOrOpts extends string | FunctionOptions
  >(
    nameOrOpts: NameOrOpts,
    trigger: Trigger,
    fn: Handler<
      Events,
      Trigger extends string
        ? Trigger
        : Trigger extends { event: string }
        ? Trigger["event"]
        : string,
      NameOrOpts extends FunctionOptions ? NameOrOpts : never
    >
  ): InngestFunction<Events> {
    return new InngestFunction<Events>(
      typeof nameOrOpts === "string" ? { name: nameOrOpts } : nameOrOpts,
      typeof trigger === "string" ? { event: trigger } : trigger,
      fn
    );
  }
}
