/**
 * What a build does about the name its snapshot would be taken under, as one
 * value rather than flags carried by every shape that describes a build.
 *
 * @module
 */

/**
 * How a build treats its snapshot's name. A snapshot it must `exclude` wouldn't
 * start, so it is never reused.
 */
export type NamePolicy =
  /** Take the name, or adopt whoever got it first. */
  | { kind: "take" }
  /** Replace the excluded snapshot, deleting it first to free the name. */
  | { kind: "replace"; exclude: string; deleteHolder: boolean }
  /** Leave the name alone and take a snapshot of the build's own. */
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

/** A policy as the three flags a build request carries over the wire. */
export interface NameFlags {
  exclude?: string;
  broken?: boolean;
  unnamed?: boolean;
}

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

export const policyToFlags = (policy: NamePolicy): NameFlags => {
  if (policy.kind === "take") {
    return {};
  }

  return policy.kind === "unnamed"
    ? { exclude: policy.exclude, unnamed: true }
    : {
        exclude: policy.exclude,
        ...(policy.deleteHolder ? { broken: true } : {}),
      };
};
