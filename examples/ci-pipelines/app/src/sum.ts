/**
 * The tiny app this example's pipelines build and test.
 */
export const sum = (values: number[]): number =>
  values.reduce((total, value) => total + value, 0);

export const mean = (values: number[]): number =>
  values.length === 0 ? 0 : sum(values) / values.length;
