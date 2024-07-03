import { EncryptionMiddlewareOptions, isEncryptedValue } from "../middleware";
import { AESEncryptionService } from "./aes";

/**
 * The default field used to store encrypted data in events.
 */
export const LEGACY_DEFAULT_EVENT_ENCRYPTION_FIELD = "encrypted";

/**
 * Available types to control the top-level fields of the event that will be
 * encrypted. Can be a single field name, an array of field names, a function
 * that returns `true` if a field should be encrypted, or `false` to disable all
 * event encryption.
 */
export type LEGACY_EventEncryptionFieldInput =
  | string
  | string[]
  | ((field: string) => boolean)
  | false;

export namespace LEGACY_V0Service {
  export interface Options {
    /**
     * The key or keys used to encrypt and decrypt data. If multiple keys are
     * provided, the first key will be used to encrypt data and all keys will be
     * tried when decrypting data.
     */
    key: EncryptionMiddlewareOptions["key"];

    /**
     * If `true`, the encryption middleware will only encrypt using the legacy
     * V0 AES encryption service. This is useful for transitioning all services
     * to using the new encryption service before then removing the flag and
     * moving all encryption to LibSodium.
     */
    forceEncryptWithV0: boolean;

    /**
     * The top-level fields of the event that will be encrypted. Can be a single
     * field name, an array of field names, a function that returns `true` if a
     * field should be encrypted, or `false` to disable all event encryption.
     *
     * By default, the top-level field named `"encrypted"` will be encrypted
     * (exported as `DEFAULT_ENCRYPTION_FIELD`).
     */
    eventEncryptionField?: LEGACY_EventEncryptionFieldInput;
  }
}

export class LEGACY_V0Service {
  protected readonly AESService: AESEncryptionService;

  constructor(protected options: LEGACY_V0Service.Options) {
    this.AESService = new AESEncryptionService(this.options.key);
  }

  public fieldShouldBeEncrypted(field: string): boolean {
    if (typeof this.options.eventEncryptionField === "undefined") {
      return field === LEGACY_DEFAULT_EVENT_ENCRYPTION_FIELD;
    }

    if (typeof this.options.eventEncryptionField === "function") {
      return this.options.eventEncryptionField(field);
    }

    if (Array.isArray(this.options.eventEncryptionField)) {
      return this.options.eventEncryptionField.includes(field);
    }

    return this.options.eventEncryptionField === field;
  }

  public encryptEventData(data: Record<string, unknown>): unknown {
    const encryptedData = Object.keys(data).reduce((acc, key) => {
      if (this.fieldShouldBeEncrypted(key)) {
        return { ...acc, [key]: this.AESService.encrypt(data[key]) };
      }

      return { ...acc, [key]: data[key] };
    }, {});

    return encryptedData;
  }

  public decryptEventData(data: Record<string, unknown>): unknown {
    const decryptedData = Object.keys(data).reduce((acc, key) => {
      if (isEncryptedValue(data[key])) {
        return { ...acc, [key]: this.AESService.decrypt(data[key].data) };
      }

      return { ...acc, [key]: data[key] };
    }, {});

    return decryptedData;
  }
}
