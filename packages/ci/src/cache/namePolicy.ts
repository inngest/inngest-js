/**
 * What a build does about the name a snapshot would be taken under, as one
 * value: it takes the name, replaces a snapshot that holds it, or leaves it
 * alone. A build that replaces a snapshot is rebuilding one that wouldn't
 * start, and must never find it again.
 *
 * @module
 */

/** How a build treats its snapshot's name. */
export type NamePolicy =
  /** Take the name, or adopt whoever got it first. */
  | { kind: "take" }
  /**
   * Replace a snapshot that wouldn't start: it is never reused, and with
   * `deleteHolder` it is deleted to free the name.
   */
  | { kind: "replace"; exclude: string; deleteHolder: boolean }
  /**
   * Leave the name alone and take a snapshot of the build's own, as when
   * another build is still taking it or the holder can't be deleted. `exclude`
   * is still never reused.
   */
  | { kind: "unnamed"; exclude: string };

export const takeName: NamePolicy = { kind: "take" };

/** The snapshot a build must not reuse, if it was asked to replace one. */
export const excludedBy = (policy: NamePolicy): string | undefined => {
  return policy.kind === "take" ? undefined : policy.exclude;
};

/** Whether the build deletes the snapshot it replaces. */
export const deletesHolder = (policy: NamePolicy): boolean => {
  return policy.kind === "replace" && policy.deleteHolder;
};

/** The three flags a build request carries over the wire. */
export interface NameFlags {
  exclude?: string;
  broken?: boolean;
  unnamed?: boolean;
}

/** The policy a request's flags ask for. */
export const policyFromFlags = ({
  exclude,
  broken,
  unnamed,
}: NameFlags): NamePolicy => {
  if (unnamed) {
    return { kind: "unnamed", exclude: exclude ?? "" };
  }

  return exclude
    ? { kind: "replace", exclude, deleteHolder: Boolean(broken) }
    : takeName;
};

/** A policy as the flags a request carries over the wire. */
export const policyToFlags = (policy: NamePolicy): NameFlags => {
  switch (policy.kind) {
    case "take":
      return {};

    case "replace":
      return {
        exclude: policy.exclude,
        ...(policy.deleteHolder ? { broken: true } : {}),
      };

    case "unnamed":
      return { exclude: policy.exclude, unnamed: true };
  }
};
