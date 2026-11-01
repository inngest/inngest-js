/**
 * @module
 * A short hash of a text, for keys that change when the text does.
 */
export const hash = (text: string) => {
  let value = 5381;

  for (let i = 0; i < text.length; i += 1) {
    value = ((value << 5) + value + text.charCodeAt(i)) | 0;
  }

  return (value >>> 0).toString(36);
};
