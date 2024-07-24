import { InngestMiddleware, type MiddlewareOptions } from "inngest";
import { getEncryptionStages } from "./stages";
import { type LEGACY_V0Service } from "./strategies/legacy";

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
  opts: EncryptionMiddlewareOptions
): InngestMiddleware<MiddlewareOptions> => {
  const { encrypt, decrypt } = getEncryptionStages(opts);

  return new InngestMiddleware({
    name: "@inngest/middleware-encryption",
    init: () => {
      return {
        onFunctionRun: (...args) => {
          return {
            ...encrypt.onFunctionRun(...args),
            ...decrypt.onFunctionRun(...args),
          };
        },
        onSendEvent: encrypt.onSendEvent,
      };
    },
  });
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
  public abstract encrypt(
    value: unknown
  ): MaybePromise<EncryptionService.PartialEncryptedValue>;

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
