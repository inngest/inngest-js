import { Middleware } from "inngest";
import { LEGACY_V0Service } from "./strategies/legacy";
import { LibSodiumEncryptionService } from "./strategies/libSodium";

/**
 * Options used to configure the encryption middleware.
 */
export interface EncryptionMiddlewareOptions {
  /**
   * The key used to encrypt and decrypt data. If you are rotating keys, you can
   * add `fallbackDecryptionKeys` to allow the middleware to decrypt data with
   * multiple keys.
   *
   * This key will always be used to encrypt.
   */
  key: string;

  /**
   * If you are rotating keys, you can add `fallbackDecryptionKeys` to allow the
   * middleware to decrypt data with multiple keys.
   *
   * None of these keys will be used for encryption.
   */
  fallbackDecryptionKeys?: string[];

  /**
   * Puts the encryption middleware into a mode where it only decrypts data and
   * does not encrypt it.
   *
   * This is useful for adding the middleware to many services (or the same
   * service with rolling deploys) before enabling encryption, so that all
   * services are ready to decrypt data when it is encrypted.
   *
   * It can also be used to slowly phase out E2E encryption so that it can be
   * safely removed from services once no more data from current runs is
   * encrypted.
   */
  decryptOnly?: boolean;

  /**
   * The encryption service used to encrypt and decrypt data. If not provided, a
   * default encryption service will be used.
   */
  encryptionService?: EncryptionService;

  /**
   * The name of the top-level field of the event that will be encrypted.
   *
   * By default, the top-level field named `"encrypted"` will be encrypted.
   */
  eventEncryptionField?: string;

  /**
   * If set and `enabled` is `true, the encryption middleware will only encrypt
   * using the legacy V0 AES encryption service. This is useful for
   * transitioning all services to using the new encryption service before then
   * removing the flag and moving all encryption to LibSodium.
   *
   * If you used a custom `encryptionService` beforehand, continue using that.
   */
  legacyV0Service?: Omit<LEGACY_V0Service.Options, "key">;
}

/**
 * Encrypts and decrypts data sent to and from Inngest.
 */
export const encryptionMiddleware = (
  /**
   * Options used to configure the encryption middleware. If a custom
   * `encryptionService` is not provided, the `key` option is required.
   */
  opts: EncryptionMiddlewareOptions,
): Middleware.Class => {
  const keys = [opts.key, ...(opts.fallbackDecryptionKeys ?? [])].filter(
    Boolean,
  );

  const service =
    opts.encryptionService || new LibSodiumEncryptionService(keys);

  let __v0LegacyService: LEGACY_V0Service | undefined;

  const getV0LegacyService = (): LEGACY_V0Service => {
    if (!__v0LegacyService) {
      __v0LegacyService = new LEGACY_V0Service({
        key: keys,
        forceEncryptWithV0: Boolean(opts.legacyV0Service?.forceEncryptWithV0),
        ...opts.legacyV0Service,
      });
    }

    return __v0LegacyService;
  };

  const encryptValue = async (
    value: unknown,
  ): Promise<EncryptionService.PartialEncryptedValue> => {
    if (isEncryptedValue(value) || isV0EncryptedValue(value)) {
      console.warn(
        "Encryption middleware is encrypting a value that appears to be already encrypted. Did you add the middleware twice?",
      );
    }

    if (opts.legacyV0Service?.forceEncryptWithV0) {
      return {
        [EncryptionService.ENCRYPTION_MARKER]: true,
        data: getV0LegacyService().service.encrypt(value),
      };
    }

    return {
      [EncryptionService.ENCRYPTION_MARKER]: true,
      [EncryptionService.STRATEGY_MARKER]: service.identifier,
      data: await service.encrypt(value),
    };
  };

  const decryptValue = async (value: unknown): Promise<unknown> => {
    if (isEncryptedValue(value)) {
      return service.decrypt(value.data);
    }

    if (isV0EncryptedValue(value)) {
      return getV0LegacyService().service.decrypt(value.data);
    }

    return value;
  };

  const fieldShouldBeEncrypted = (field: string): boolean => {
    if (typeof opts.eventEncryptionField === "undefined") {
      return field === EncryptionService.DEFAULT_ENCRYPTED_EVENT_FIELD;
    }

    return opts.eventEncryptionField === field;
  };

  const encryptEventData = async (
    eventData: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    if (opts.legacyV0Service?.forceEncryptWithV0) {
      const result = getV0LegacyService().encryptEventData(eventData);

      if (!isRecord(result)) {
        return eventData;
      }

      return result;
    }

    const encryptedEntries = await Promise.all(
      Object.keys(eventData).map<Promise<[string, unknown]>>(async (key) => {
        let value: unknown = eventData[key];
        if (fieldShouldBeEncrypted(key)) {
          value = await encryptValue(eventData[key]);
        }

        return [key, value];
      }),
    );

    const encryptedData = encryptedEntries.reduce<Record<string, unknown>>(
      (acc, [key, value]) => {
        return { ...acc, [key]: value };
      },
      {},
    );

    return encryptedData;
  };

  const decryptEventData = async (
    eventData: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const decryptedEntries = await Promise.all(
      Object.keys(eventData).map<Promise<[string, unknown]>>(async (key) => {
        return [key, await decryptValue(eventData[key])];
      }),
    );

    const decryptedData = decryptedEntries.reduce<Record<string, unknown>>(
      (acc, [key, value]) => {
        return { ...acc, [key]: value };
      },
      {},
    );

    return decryptedData;
  };

  class EncryptionMiddleware extends Middleware.BaseMiddleware {
    // Decrypt event data before it reaches the function handler.
    // IMPORTANT: Do not decrypt step data here. That won't work with
    // checkpointing because we don't "enter" the function once per step.
    override async transformFunctionInput(
      arg: Middleware.TransformFunctionInputArgs,
    ): Promise<Middleware.TransformFunctionInputArgs> {
      const decryptedEvent = arg.ctx.event?.data
        ? {
          ...arg.ctx.event,
          data: await decryptEventData(arg.ctx.event.data),
        }
        : arg.ctx.event;

      const decryptedEvents = arg.ctx.events
        ? await Promise.all(
          arg.ctx.events.map(async (event) => ({
            ...event,
            data: event.data
              ? await decryptEventData(event.data)
              : event.data,
          })),
        )
        : arg.ctx.events;

      return {
        ...arg,
        ctx: {
          ...arg.ctx,
          event: decryptedEvent,
          // @ts-expect-error - OK to override events
          events: decryptedEvents,
        },
      };
    }

    // Encrypt the `step.invoke` input data.
    override async transformStepInput(
      arg: Middleware.TransformStepInputArgs,
    ): Promise<Middleware.TransformStepInputArgs> {
      if (opts.decryptOnly) {
        return arg;
      }

      // `step.invoke` is the only step whose input needs to be encrypted. We'll
      // encrypt `step.sendEvent` using the `transformSendEvent` hook.
      if (arg.stepInfo.stepType !== "invoke") {
        return arg;
      }

      const encryptedInput = await Promise.all(
        arg.input.map(async (item) => {
          if (!isRecord(item)) {
            return item;
          }

          const { payload } = item;

          if (!isRecord(payload)) {
            return item;
          }

          const { data } = payload;

          if (!isRecord(data)) {
            return item;
          }

          return {
            ...item,
            payload: {
              ...payload,
              // Encrypt invoke data as if it's an event (i.e. only encrypt the
              // specific field)
              data: await encryptEventData(data),
            },
          };
        }),
      );

      return { ...arg, input: encryptedInput };
    }

    // Encrypt the Inngest function's return value before it's sent to the server.
    override async wrapFunctionHandler({
      next,
    }: Middleware.WrapFunctionHandlerArgs) {
      const output = await next();

      if (opts.decryptOnly) {
        return output;
      }

      if (output != null) {
        return encryptValue(output);
      }

      return output;
    }

    // Encrypt step output before it's sent to the server.
    override async wrapStepHandler({ next }: Middleware.WrapStepHandlerArgs) {
      const output = await next();

      if (opts.decryptOnly) {
        return output;
      }

      if (output != null) {
        return encryptValue(output);
      }

      return output;
    }

    // Decrypt memoized step data before it's returned into the Inngest function
    // handler.
    override async wrapStep({ next }: Middleware.WrapStepArgs) {
      return decryptValue(await next());
    }

    // Encrypt event data before sending to the server.
    override async transformSendEvent(
      arg: Middleware.TransformSendEventArgs,
    ): Promise<Middleware.TransformSendEventArgs> {
      if (opts.decryptOnly) {
        return arg;
      }

      const encryptedEvents = await Promise.all(
        arg.events.map(async (event) => {
          let data = undefined;
          if (event.data) {
            data = await encryptEventData(event.data);
          }

          return {
            ...event,
            data,
          };
        }),
      );

      return {
        ...arg,
        events: encryptedEvents,
      };
    }
  }

  return EncryptionMiddleware;
};

export type MaybePromise<T> = T | Promise<T>;

/**
 * A service that encrypts and decrypts data. You can implement this abstract
 * class to provide your own encryption service, or use the default encryption
 * service provided by this package.
 */
export abstract class EncryptionService {
  /**
   * A unique identifier for this encryption service. This is used to identify
   * the encryption service when serializing and deserializing encrypted values.
   */
  public abstract identifier: string;

  /**
   * Given an `unknown` value, encrypts it and returns the the encrypted value.
   */
  public abstract encrypt(value: unknown): MaybePromise<string>;

  /**
   * Given an encrypted `string`, decrypts it and returns the decrypted value as
   * any value.
   */
  public abstract decrypt(value: string): MaybePromise<unknown>;
}

export namespace EncryptionService {
  /**
   * A marker used to identify encrypted values without having to guess.
   */
  export const ENCRYPTION_MARKER = "__ENCRYPTED__";

  /**
   * A marker used to identify the strategy used for encryption.
   */
  export const STRATEGY_MARKER = "__STRATEGY__";

  /**
   * The default field used to store encrypted values in events.
   */
  export const DEFAULT_ENCRYPTED_EVENT_FIELD = "encrypted";

  /**
   * The encrypted value as it will be sent to Inngest.
   */
  export interface EncryptedValue {
    [ENCRYPTION_MARKER]: true;
    [STRATEGY_MARKER]: string | undefined;
    data: string;
  }

  /**
   * A V0 encrypted value, which only contains the encrypted data.
   */
  export interface V0EncryptedValue {
    [ENCRYPTION_MARKER]: true;
    data: string;
  }

  /**
   * A partial encrypted value, allowing an encryption service to specify the
   * data and any other metadata needed to decrypt the value.
   */
  export interface PartialEncryptedValue
    extends Omit<
      EncryptedValue,
      typeof ENCRYPTION_MARKER | typeof STRATEGY_MARKER
    > {
    [key: string]: unknown;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

export const isEncryptedValue = (
  value: unknown,
): value is EncryptionService.EncryptedValue => {
  return (
    typeof value === "object" &&
    value !== null &&
    EncryptionService.ENCRYPTION_MARKER in value &&
    value[EncryptionService.ENCRYPTION_MARKER] === true &&
    "data" in value &&
    typeof value["data"] === "string" &&
    EncryptionService.STRATEGY_MARKER in value &&
    typeof value[EncryptionService.STRATEGY_MARKER] === "string"
  );
};

export const isV0EncryptedValue = (
  value: unknown,
): value is EncryptionService.V0EncryptedValue => {
  return (
    typeof value === "object" &&
    value !== null &&
    EncryptionService.ENCRYPTION_MARKER in value &&
    value[EncryptionService.ENCRYPTION_MARKER] === true &&
    "data" in value &&
    typeof value["data"] === "string" &&
    !(EncryptionService.STRATEGY_MARKER in value)
  );
};
