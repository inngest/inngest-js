/**
 * @module
 * Remembers when the reader last posted something, so a fake changing right
 * after is the reader's own post and not the agent replying.
 */
let last = -1e9;

export const ownPost = () => {
  last = performance.now();
};

export const justPosted = () => {
  return performance.now() - last < 1500;
};
