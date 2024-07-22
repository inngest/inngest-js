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
  const service =
    opts.encryptionService || new LibSodiumEncryptionService(opts.key);

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
    eventData: Record<string, unknown>
  ): Promise<unknown> => {
    // are we forced to use v0?
    if (opts.legacyV0Service?.forceEncryptWithV0) {
      return v0Legacy.encryptEventData(eventData);
    }

    // Get the encrypted field if we have it.
    if (!eventHasEncryptedField(eventData)) {
      return eventData;
    }

    // if we're not forced to use v0, use the current encryption service
    return {
      ...eventData,
      [EncryptionService.ENCRYPTED_EVENT_FIELD]: await encryptValue(
        eventData[EncryptionService.ENCRYPTED_EVENT_FIELD]
      ),
    };
  };

  const decryptEventData = async (
    eventData: Record<string, unknown>
  ): Promise<unknown> => {
    // See if we have an encrypted field. If so, decrypt it.
    if (eventHasEncryptedField(eventData)) {
      if (
        !isEncryptedValue(eventData[EncryptionService.ENCRYPTED_EVENT_FIELD])
      ) {
        // No need to decrypt, but will warn as it's strange to receive this
        // value unencrypted
        console.warn(
          `Received unencrypted "${EncryptionService.ENCRYPTED_EVENT_FIELD}" field in event payload; is there a service that's not yet encrypting event data?`
        );

        return eventData;
      }

      if (
        service.identifier !==
        eventData.encrypted[EncryptionService.STRATEGY_MARKER]
      ) {
        throw new Error(
          `Mismatched encryption service; received an event payload using "${
            eventData.encrypted[EncryptionService.STRATEGY_MARKER]
          }", but the configured encryption service is "${service.identifier}"`
        );
      }

      return {
        ...eventData,
        [EncryptionService.ENCRYPTED_EVENT_FIELD]: await decryptValue(
          eventData[EncryptionService.ENCRYPTED_EVENT_FIELD]
        ),
      };
    }

    // if we didn't find an `encrypted` field, it could still be a v0 encrypted
    // event. v0 will only differ if it has specified an `eventEncryptionField`
    // option, so check that here or return
    if (!opts.legacyV0Service?.eventEncryptionField) {
      return v0Legacy.decryptEventData(eventData);
    }

    return eventData;
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
    (!(EncryptionService.STRATEGY_MARKER in value) ||
      typeof value[EncryptionService.STRATEGY_MARKER] === "string")
  );
};

const eventHasEncryptedField = (
  eventData: unknown
): eventData is { encrypted: unknown } => {
  return (
    typeof eventData === "object" &&
    eventData !== null &&
    EncryptionService.ENCRYPTED_EVENT_FIELD in eventData
  );
};
