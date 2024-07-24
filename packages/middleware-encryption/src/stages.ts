import { type MiddlewareRegisterReturn } from "inngest";
import {
  type EncryptionMiddlewareOptions,
  EncryptionService,
} from "./middleware";
import { LEGACY_V0Service } from "./strategies/legacy";
import { LibSodiumEncryptionService } from "./strategies/libSodium";

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
  /**
   * The keys used to encrypt and decrypt data. If multiple keys are provided,
   * the first key will be used to encrypt data and all keys will be tried when
   * decrypting data.
   *
   * We perform this internally to make the way users provide these keys to us
   * much more explicit; it is confusing to add a new key to the end of a keys
   * array as the first part of a migration.
   */
  const keys = [opts.key, ...(opts.fallbackDecryptionKeys ?? [])].filter(
    Boolean
  );

  const service =
    opts.encryptionService || new LibSodiumEncryptionService(keys);

  let __v0LegacyService: LEGACY_V0Service | undefined;
  /**
   * Lazy-load the V0 service. This is used to ensure that the V0 service is
   * only loaded if it's needed.
   */
  const getV0LegacyService = (): LEGACY_V0Service => {
    return (__v0LegacyService ??= new LEGACY_V0Service({
      key: keys,
      forceEncryptWithV0: Boolean(opts.legacyV0Service?.forceEncryptWithV0),
      ...opts.legacyV0Service,
    }));
  };

  const encryptValue = async (
    value: unknown
  ): Promise<EncryptionService.PartialEncryptedValue> => {
    // Show a warning if we believe the value is already encrypted. This may
    // happen if user accidentally adds encryption middleware at both the
    // client and function levels.
    if (isEncryptedValue(value) || isV0EncryptedValue(value)) {
      console.warn(
        "Encryption middleware is encrypting a value that appears to be already encrypted. Did you add the middleware twice?"
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
    eventData: Record<string, unknown>
  ): Promise<unknown> => {
    if (opts.legacyV0Service?.forceEncryptWithV0) {
      return getV0LegacyService().encryptEventData(eventData);
    }

    const encryptedEntries = await Promise.all(
      Object.keys(eventData).map<Promise<[string, unknown]>>(async (key) => {
        const value = fieldShouldBeEncrypted(key)
          ? await encryptValue(eventData[key])
          : eventData[key];

        return [key, value];
      })
    );

    const encryptedData = encryptedEntries.reduce<Record<string, unknown>>(
      (acc, [key, value]) => {
        return { ...acc, [key]: value };
      },
      {}
    );

    return encryptedData;
  };

  const decryptEventData = async (
    eventData: Record<string, unknown>
  ): Promise<unknown> => {
    const decryptedEntries = await Promise.all(
      Object.keys(eventData).map<Promise<[string, unknown]>>(async (key) => {
        return [key, await decryptValue(eventData[key])];
      })
    );

    const decryptedData = decryptedEntries.reduce<Record<string, unknown>>(
      (acc, [key, value]) => {
        return { ...acc, [key]: value };
      },
      {}
    );

    return decryptedData;
  };

  return {
    encrypt: {
      onFunctionRun: () => {
        if (opts.decryptOnly) {
          return {};
        }

        return {
          transformOutput: async (ctx) => {
            return {
              result: {
                data: ctx.result.data && (await encryptValue(ctx.result.data)),
              },
            };
          },
        };
      },

      onSendEvent: () => {
        return {
          transformInput: async ({ payloads }) => {
            return {
              payloads: await Promise.all(
                payloads.map(async (payload) => ({
                  ...payload,
                  data: payload.data && (await encryptEventData(payload.data)),
                }))
              ),
            };
          },
        };
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
    EncryptionService.STRATEGY_MARKER in value &&
    typeof value[EncryptionService.STRATEGY_MARKER] === "string"
  );
};

export const isV0EncryptedValue = (
  value: unknown
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
