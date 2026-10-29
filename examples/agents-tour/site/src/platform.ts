/**
 * @module
 * Platform and storage helpers.
 */
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

export const store = {
  get: (key: string) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Storage can be blocked; the tour works without it.
    }
  },
  remove: (key: string) => {
    try {
      localStorage.removeItem(key);
    } catch {
      // See above.
    }
  },
};

export const hash = (text: string) => {
  let value = 5381;

  for (let i = 0; i < text.length; i += 1) {
    value = ((value << 5) + value + text.charCodeAt(i)) | 0;
  }

  return (value >>> 0).toString(36);
};
