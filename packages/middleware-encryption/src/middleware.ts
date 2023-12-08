import AES from "crypto-js/aes";
import CryptoJSUtf8 from "crypto-js/enc-utf8";
import { InngestMiddleware, type MiddlewareRegisterReturn } from "inngest";

/**
 * A marker used to identify encrypted values without having to guess.
 */
const ENCRYPTION_MARKER = "__ENCRYPTED__";

/**
 * Options used to configure the encryption middleware.
 */
export interface EncryptionMiddlewareOptions {
  /**
   * The key or keys used to encrypt and decrypt data. If multiple keys are
   * provided, the first key will be used to encrypt data and all keys will
   * be tried when decrypting data.
   */
  key?: string | string[];

  /**
   * The encryption service used to encrypt and decrypt data. If not provided,
   * a default encryption service will be used.
   */
  encryptionService?: EncryptionService;

  /**
   * Whether to encrypt events sent to Inngest. Defaults to `false`.
   *
   * Encrypting event data can impact the features available to you in terms
   * of querying and filtering events in the Inngest dashboard, or using
   * composability tooling such as `step.waitForEvent()`. Only enable this
   * feature if you are absolutely sure that you need it.
   */
  encryptEvents?: boolean;
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
) => {
  const service =
    opts.encryptionService || new DefaultEncryptionService(opts.key);

  const encrypt = (value: unknown): EncryptedValue => {
    return {
      [ENCRYPTION_MARKER]: true,
      data: service.encrypt(value),
    };
  };

  const decrypt = (value: unknown): unknown => {
    if (isEncryptedValue(value)) {
      return service.decrypt(value.data);
    }

    return value;
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
                  data: step.data && decrypt(step.data),
                })),
              };

              if (opts.encryptEvents) {
                inputTransformer.ctx = {
                  event: ctx.event && {
                    ...ctx.event,
                    data: ctx.event.data && decrypt(ctx.event.data),
                  },
                  events:
                    ctx.events &&
                    ctx.events?.map((event) => ({
                      ...event,
                      data: event.data && decrypt(event.data),
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
                  data: ctx.result.data && encrypt(ctx.result.data),
                },
              };
            },
          };
        },
      };

      if (opts.encryptEvents) {
        registration.onSendEvent = () => {
          return {
            transformInput: ({ payloads }) => {
              return {
                payloads: payloads.map((payload) => ({
                  ...payload,
                  data: payload.data && encrypt(payload.data),
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
  public abstract encrypt(value: unknown): string;
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
