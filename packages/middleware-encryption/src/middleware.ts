import AES from "crypto-js/aes.js";
import CryptoJSUtf8 from "crypto-js/enc-utf8.js";
import {
  InngestMiddleware,
  type MiddlewareOptions,
  type MiddlewareRegisterReturn,
} from "inngest";

/**
 * A marker used to identify encrypted values without having to guess.
 */
const ENCRYPTION_MARKER = "__ENCRYPTED__";

/**
 * The default field used to store encrypted data in events.
 */
export const DEFAULT_ENCRYPTION_FIELD = "encrypted";

/**
 * Available types to control the top-level fields of the event that will be
 * encrypted. Can be a single field name, an array of field names, a function
 * that returns `true` if a field should be encrypted, or `false` to disable all
 * event encryption.
 */
export type EventEncryptionFieldInput =
  | string
  | string[]
  | ((field: string) => boolean)
  | false;

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
   * The top-level fields of the event that will be encrypted. Can be a single
   * field name, an array of field names, a function that returns `true` if a
   * field should be encrypted, or `false` to disable all event encryption.
   *
   * By default, the top-level field named `"encrypted"` will be encrypted
   * (exported as `DEFAULT_ENCRYPTION_FIELD`).
   */
  eventEncryptionField?: EventEncryptionFieldInput;
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
    opts.encryptionService || new DefaultEncryptionService(opts.key);
  const shouldEncryptEvents = Boolean(
    opts.eventEncryptionField ?? DEFAULT_ENCRYPTION_FIELD
  );

  const encryptValue = (value: unknown): EncryptedValue => {
    return {
      [ENCRYPTION_MARKER]: true,
      data: service.encrypt(value),
    };
  };

  const decryptValue = (value: unknown): unknown => {
    if (isEncryptedValue(value)) {
      return service.decrypt(value.data);
    }

    return value;
  };

  const fieldShouldBeEncrypted = (field: string): boolean => {
    if (typeof opts.eventEncryptionField === "undefined") {
      return field === DEFAULT_ENCRYPTION_FIELD;
    }

    if (typeof opts.eventEncryptionField === "function") {
      return opts.eventEncryptionField(field);
    }

    if (Array.isArray(opts.eventEncryptionField)) {
      return opts.eventEncryptionField.includes(field);
    }

    return opts.eventEncryptionField === field;
  };

  const encryptEventData = (data: Record<string, unknown>): unknown => {
    const encryptedData = Object.keys(data).reduce((acc, key) => {
      if (fieldShouldBeEncrypted(key)) {
        return { ...acc, [key]: encryptValue(data[key]) };
      }

      return { ...acc, [key]: data[key] };
    }, {});

    return encryptedData;
  };

  const decryptEventData = (data: Record<string, unknown>): unknown => {
    const decryptedData = Object.keys(data).reduce((acc, key) => {
      if (isEncryptedValue(data[key])) {
        return { ...acc, [key]: decryptValue(data[key]) };
      }

      return { ...acc, [key]: data[key] };
    }, {});

    return decryptedData;
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
              };

              if (shouldEncryptEvents) {
                inputTransformer.ctx = {
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
                } as {};
              }

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

const isEncryptedValue = (value: unknown): value is EncryptedValue => {
  return (
    typeof value === "object" &&
    value !== null &&
    ENCRYPTION_MARKER in value &&
    value[ENCRYPTION_MARKER] === true &&
    "data" in value &&
    typeof value["data"] === "string"
  );
};

/**
 * A service that encrypts and decrypts data. You can implement this abstract
 * class to provide your own encryption service, or use the default encryption
 * service provided by this package.
 */
export abstract class EncryptionService {
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

/**
 * The default encryption service used by the encryption middleware.
 *
 * This service uses AES encryption to encrypt and decrypt data. It supports
 * multiple keys, so that you can rotate keys without breaking existing
 * encrypted data.
 */
export class DefaultEncryptionService extends EncryptionService {
  private readonly keys: [string, ...string[]];

  constructor(key: string | string[] | undefined) {
    super();

    if (!key) {
      throw new Error("Missing encryption key(s) in encryption middleware");
    }

    const keys = (Array.isArray(key) ? key : [key])
      .map((s) => s.trim())
      .filter(Boolean);

    if (!keys.length) {
      throw new Error("Missing encryption key(s) in encryption middleware");
    }

    this.keys = keys as [string, ...string[]];
  }

  encrypt(value: unknown): string {
    return AES.encrypt(JSON.stringify(value), this.keys[0]).toString();
  }

  decrypt(value: string): unknown {
    let err: unknown;

    for (const key of this.keys) {
      try {
        const decrypted = AES.decrypt(value, key).toString(CryptoJSUtf8);
        return JSON.parse(decrypted);
      } catch (decryptionError) {
        err = decryptionError;
        continue;
      }
    }

    throw (
      err ||
      new Error("Unable to decrypt value; no keys were able to decrypt it")
    );
  }
}
