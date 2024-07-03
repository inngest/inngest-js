import {
  InngestMiddleware,
  type MiddlewareOptions,
  type MiddlewareRegisterReturn,
} from "inngest";
import { LEGACY_V0Service } from "./strategies/legacy";
import { LibSodiumEncryptionService } from "./strategies/libSodium";

/**
 * A marker used to identify encrypted values without having to guess.
 */
const ENCRYPTION_MARKER = "__ENCRYPTED__";

/**
 * A marker used to identify the strategy used for encryption.
 */
const STRATEGY_MARKER = "__STRATEGY__";

/**
 * Options used to configure the encryption middleware.
 */
export interface EncryptionMiddlewareOptions {
  /**
   * The key or keys used to encrypt and decrypt data. If multiple keys are
   * provided, the first key will be used to encrypt data and all keys will be
   * tried when decrypting data.
   */
  key?: string | string[];

  /**
   * The encryption service used to encrypt and decrypt data. If not provided, a
   * default encryption service will be used.
   */
  encryptionService?: EncryptionService;

  /**
   * If `true`, the encryption middleware will encrypt all event data, otherwise
   * only step data will be encrypted.
   *
   * Note that this is opt-in as other services consuming events must then use
   * an encryption middleware.
   */
  encryptEventData?: boolean;

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
  opts: EncryptionMiddlewareOptions
): InngestMiddleware<MiddlewareOptions> => {
  const service =
    opts.encryptionService || new LibSodiumEncryptionService(opts.key);

  const shouldEncryptEvents = Boolean(opts.encryptEventData);

  const v0Legacy = new LEGACY_V0Service({
    key: opts.key,
    forceEncryptWithV0: Boolean(opts.legacyV0Service?.forceEncryptWithV0),
    ...opts.legacyV0Service,
  });

  const encryptValue = (value: unknown): EncryptedValue => {
    return {
      [ENCRYPTION_MARKER]: true,
      [STRATEGY_MARKER]: service.identifier,
      data: service.encrypt(value),
    };
  };

  const decryptValue = (value: unknown): unknown => {
    if (isEncryptedValue(value)) {
      return service.decrypt(value.data);
    }

    return value;
  };

  const encryptEventData = (data: Record<string, unknown>): unknown => {
    // if we're not supposed to be encrypted events, don't do it. this should be
    // checked elsewhere but we'll be super safe
    if (!shouldEncryptEvents) {
      return data;
    }

    // are we forced to use v0?
    if (opts.legacyV0Service?.forceEncryptWithV0) {
      return v0Legacy.encryptEventData(data);
    }

    // if we're not forced to use v0, use the current encryption service
    return encryptValue(data);
  };

  const decryptEventData = (data: Record<string, unknown>): unknown => {
    // if the entire value is encrypted, match it and decrypt
    if (isEncryptedValue(data)) {
      if (service.identifier !== data[STRATEGY_MARKER]) {
        throw new Error(
          `Mismatched encryption service; received an event payload using "${data[STRATEGY_MARKER]}", but the configured encryption service is "${service.identifier}"`
        );
      }

      return decryptValue(data);
    }

    // if the entire value isn't encrypted, also check each top-level field in
    // case it's a v0 encryption.
    return v0Legacy.decryptEventData(data);
  };

  return new InngestMiddleware({
    name: "@inngest/middleware-encryption",
    init: () => {
      const registration: MiddlewareRegisterReturn = {
        onFunctionRun: () => {
          return {
            transformInput: ({ ctx, steps }) => {
              const inputTransformer: InputTransformer = {
                steps: steps.map((step) => ({
                  ...step,
                  data: step.data && decryptValue(step.data),
                })),
                ctx: {
                  event: ctx.event && {
                    ...ctx.event,
                    data: ctx.event.data && decryptEventData(ctx.event.data),
                  },
                  events:
                    ctx.events &&
                    ctx.events?.map((event) => ({
                      ...event,
                      data: event.data && decryptEventData(event.data),
                    })),
                } as {},
              };

              return inputTransformer;
            },
            transformOutput: (ctx) => {
              if (!ctx.step) {
                return;
              }

              return {
                result: {
                  data: ctx.result.data && encryptValue(ctx.result.data),
                },
              };
            },
          };
        },
      };

      if (shouldEncryptEvents) {
        registration.onSendEvent = () => {
          return {
            transformInput: ({ payloads }) => {
              return {
                payloads: payloads.map((payload) => ({
                  ...payload,
                  data: payload.data && encryptEventData(payload.data),
                })),
              };
            },
          };
        };
      }

      return registration;
    },
  });
};

/**
 * The encrypted value as it will be sent to Inngest.
 */
export interface EncryptedValue {
  [ENCRYPTION_MARKER]: true;
  [STRATEGY_MARKER]: string | undefined;
  data: string;
}

type InputTransformer = NonNullable<
  Awaited<
    ReturnType<
      NonNullable<
        Awaited<
          ReturnType<NonNullable<MiddlewareRegisterReturn["onFunctionRun"]>>
        >["transformInput"]
      >
    >
  >
>;

export const isEncryptedValue = (value: unknown): value is EncryptedValue => {
  return (
    typeof value === "object" &&
    value !== null &&
    ENCRYPTION_MARKER in value &&
    value[ENCRYPTION_MARKER] === true &&
    "data" in value &&
    typeof value["data"] === "string" &&
    (!(STRATEGY_MARKER in value) || typeof value[STRATEGY_MARKER] === "string")
  );
};

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
   * Given an `unknown` value, encrypts it and returns the encrypted value as a
   * `string`.
   */
  public abstract encrypt(value: unknown): string;

  /**
   * Given an encrypted `string`, decrypts it and returns the decrypted value as
   * any value.
   */
  public abstract decrypt(value: string): unknown;
}
