import { InngestMiddleware } from "inngest";

const encryptionMarker = "__ENCRYPTED__";
type EncryptedValue = { [encryptionMarker]: true; data: string };

export const encryptionMiddleware = (
  key: string = process.env.INNGEST_ENCRYPTION_KEY as string
) => {
  if (!key) {
    throw new Error("Missing INNGEST_ENCRYPTION_KEY environment variable");
  }

  // Some internal functions that we'll use to encrypt and decrypt values.
  // In practice, you'll want to use the `key` passed in to handle encryption
  // properly.
  const isEncryptedValue = (value: unknown): value is EncryptedValue => {
    return (
      typeof value === "object" &&
      value !== null &&
      encryptionMarker in value &&
      value[encryptionMarker] === true &&
      "data" in value &&
      typeof value["data"] === "string"
    );
  };

  const encrypt = (value: unknown): EncryptedValue => {
    return {
      [encryptionMarker]: true,
      data: JSON.stringify(value).split("").reverse().join(""),
    };
  };

  const decrypt = <T>(value: T): T => {
    if (isEncryptedValue(value)) {
      return JSON.parse(value.data.split("").reverse().join("")) as T;
    }

    return value;
  };

  return new InngestMiddleware({
    name: "Full Encryption Middleware",
    init: () => ({
      onSendEvent: () => ({
        transformInput: ({ payloads }) => ({
          payloads: payloads.map((payload) => ({
            ...payload,
            data: payload.data && encrypt(payload.data),
          })),
        }),
      }),
      onFunctionRun: () => ({
        transformInput: ({ ctx, steps }) => ({
          steps: steps.map((step) => ({
            ...step,
            data: step.data && decrypt(step.data),
          })),
          ctx: {
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
          } as {},
        }),
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
      }),
    }),
  });
};
