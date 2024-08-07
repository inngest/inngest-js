/**
 * Returns the value of an enum from a string value.
 *
 * If the value given is not a value from the enum, `undefined` is returned.
 */
export const enumFromValue = <T extends Record<string, unknown>>(
  enumType: T,
  value: unknown
): T[keyof T] | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const enumValue = enumType[value as keyof T];

  if (typeof enumValue === "undefined") {
    return undefined;
  }

  return enumValue;
};
