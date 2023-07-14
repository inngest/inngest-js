import { TSESTree } from "@typescript-eslint/utils";

export const hasParent = (
  node: TSESTree.Node,
  predicate: (node: TSESTree.Node) => boolean
): boolean => {
  let parent: TSESTree.Node | undefined = node.parent;

  while (parent) {
    if (predicate(parent)) {
      return true;
    }

    parent = parent.parent;
  }

  return false;
};
