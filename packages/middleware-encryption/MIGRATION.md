# Migration

This covers how to migrate between the major versions of this middleware

## v1 -> v2

Encryption/decryption behavior is fully backwards compatible with v1. It's safe to do a rolling deploy, where v1 and v2 coexist.

## v0 -> v1

We've changed some tooling and standards in v1 to align with other languages,
ensuring we can provide easier cross-language E2E encryption.

If you only use the middleware on a single service/app and only passed a `key`
as required, you can upgrade with no changes. Otherwise, read on.

### Customizing field-level event encryption changed

In v0, you could customize which fields in an event would be encrypted. By
default this was the `encrypted` field, but you could choose any top-level
fields.

For v1 we want to simplify this config to ensure it's easy to understand and
replicate when also adding the middleware to other services and languages.
Therefore, only `string` is allowed when customizing this field and `string[]`,
`(field: string) => boolean`, and `false` have been removed.

If you customized field-level encryption in v0, move the option to the new
`v0Legacy` object, which will continue to decrypt those fields.

> [!NOTE]
> Any events encrypted with v1 (without `forceEncryptWithV0` set) will use the
> new top-level `eventEncryptionField` and _not_ this option.

```ts
const mw = encryptionMiddleware({
  // ...
  legacyV0Service: {
    eventEncryptionField: ["my", "custom", "fields"],
  },
});
```

### Changing multiple apps

If multiple apps used the v0 encryption middleware, you can slowly migrate to
the new Sodium standard by forcing encryption to use the v0 strategy but still
be able to decrypt with the new one.

> [!NOTE]
> Note that if you use a custom encryption service, you won't have to perform
> any upgrades here; this is only as we are changing the default strategy.

To force encryption using the v0 strategy, set the `forceEncryptWithV0` option:

```ts
const mw = encryptionMiddleware({
  // ...
  legacyV0Service: {
    forceEncryptWithV0: true,
  },
});
```

Then, your rollout is:

1. Update all apps to use v1 with `forceEncryptWithV0: true`
2. Once all apps are updated and deployed, remove the `forceEncryptWithV0` flag
   or set it to `false`

### Encryption service identifiers

Each encryption service now requires an `identifier`, used to ensure the correct
strategy is being used to decrypt data when it is received.

If you're not using a custom encryption service, no change is needed here.
