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
