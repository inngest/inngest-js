import { type MiddlewareRegisterReturn } from "inngest";
import { EncryptionService } from "./middleware";
import { LEGACY_V0Service } from "./strategies/legacy";
import { LibSodiumEncryptionService } from "./strategies/libSodium";

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
export const getEncryptionStages = (
  /**
   * Options used to configure the encryption middleware. If a custom
   * `encryptionService` is not provided, the `key` option is required.
   */
  opts: EncryptionMiddlewareOptions
): {
  encrypt: { onFunctionRun: FunctionRunHook; onSendEvent: SendEventHook };
  decrypt: { onFunctionRun: FunctionRunHook };
} => {
  const service =
    opts.encryptionService || new LibSodiumEncryptionService(opts.key);

  const shouldEncryptEvents = Boolean(opts.encryptEventData);

  const v0Legacy = new LEGACY_V0Service({
    key: opts.key,
    forceEncryptWithV0: Boolean(opts.legacyV0Service?.forceEncryptWithV0),
    ...opts.legacyV0Service,
  });

  const encryptValue = async (
    value: unknown
  ): Promise<EncryptionService.PartialEncryptedValue> => {
    return {
      [EncryptionService.ENCRYPTION_MARKER]: true,
      [EncryptionService.STRATEGY_MARKER]: service.identifier,
      ...(await service.encrypt(value)),
    };
  };

  const decryptValue = async (value: unknown): Promise<unknown> => {
    if (isEncryptedValue(value)) {
      return service.decrypt(value.data);
    }

    return value;
  };

  const encryptEventData = async (
    data: Record<string, unknown>
  ): Promise<unknown> => {
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

  const decryptEventData = async (
    data: Record<string, unknown>
  ): Promise<unknown> => {
    // if the entire value is encrypted, match it and decrypt
    if (isEncryptedValue(data)) {
      if (service.identifier !== data[EncryptionService.STRATEGY_MARKER]) {
        throw new Error(
          `Mismatched encryption service; received an event payload using "${
            data[EncryptionService.STRATEGY_MARKER]
          }", but the configured encryption service is "${service.identifier}"`
        );
      }

      return decryptValue(data);
    }

    // if the entire value isn't encrypted, also check each top-level field in
    // case it's a v0 encryption.
    return v0Legacy.decryptEventData(data);
  };

  return {
    encrypt: {
      onFunctionRun: () => {
        return {
          transformOutput: async (ctx) => {
            if (!ctx.step) {
              return;
            }
            return {
              result: {
                data: ctx.result.data && (await encryptValue(ctx.result.data)),
              },
            };
          },
        };
      },

      onSendEvent: () => {
        if (shouldEncryptEvents) {
          return {
            transformInput: async ({ payloads }) => {
              return {
                payloads: await Promise.all(
                  payloads.map(async (payload) => ({
                    ...payload,
                    data:
                      payload.data && (await encryptEventData(payload.data)),
                  }))
                ),
              };
            },
          };
        }

        return {};
      },
    },

    decrypt: {
      onFunctionRun: () => {
        return {
          transformInput: async ({ ctx, steps }) => {
            const decryptedSteps = Promise.all(
              steps.map(async (step) => ({
                ...step,
                data: step.data && (await decryptValue(step.data)),
              }))
            );

            const decryptedEvent =
              ctx.event &&
              (async () => ({
                ...ctx.event,
                data:
                  ctx.event.data && (await decryptEventData(ctx.event.data)),
              }))();

            const decryptedEvents =
              ctx.events &&
              Promise.all(
                ctx.events?.map(async (event) => ({
                  ...event,
                  data: event.data && (await decryptEventData(event.data)),
                }))
              );

            const inputTransformer: InputTransformer = {
              steps: await decryptedSteps,
              ctx: {
                event: await decryptedEvent,
                events: await decryptedEvents,
              } as {},
            };

            return inputTransformer;
          },
        };
      },
    },
  };
};

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

type FunctionRunHook = NonNullable<MiddlewareRegisterReturn["onFunctionRun"]>;

type SendEventHook = NonNullable<MiddlewareRegisterReturn["onSendEvent"]>;

export const isEncryptedValue = (
  value: unknown
): value is EncryptionService.EncryptedValue => {
  return (
    typeof value === "object" &&
    value !== null &&
    EncryptionService.ENCRYPTION_MARKER in value &&
    value[EncryptionService.ENCRYPTION_MARKER] === true &&
    "data" in value &&
    typeof value["data"] === "string" &&
    (!(EncryptionService.STRATEGY_MARKER in value) ||
      typeof value[EncryptionService.STRATEGY_MARKER] === "string")
  );
};
