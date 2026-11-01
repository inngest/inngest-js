/**
 * @module
 * What the reader typed, kept per file. A saved edit belongs to one file of
 * one page and is dropped when that file's starting code changes.
 */
import type { Page, PageFile } from "../../shared/types.ts";
import { hash } from "./hash.ts";

export interface EditStore {
  get: (key: string) => string | null;
  set: (key: string, value: string) => void;
  remove: (key: string) => void;
}

const keyOf = (page: Page, file: PageFile) => {
  return `tour:edit:${page.id}:${file.name}:${hash(file.content)}`;
};

/**
 * The page's files with each editable one replaced by its saved edit.
 */
export const withEdits = (page: Page, store: EditStore) => {
  return page.files.map((file) => {
    const saved = file.editable ? store.get(keyOf(page, file)) : null;

    return saved === null ? file : { ...file, content: saved };
  });
};

/**
 * Saves the value of every editable file in `values`.
 */
export const saveEdits = (
  page: Page,
  values: Record<string, string>,
  store: EditStore,
) => {
  for (const file of page.files) {
    const value = values[file.name];

    if (file.editable && value !== undefined) {
      store.set(keyOf(page, file), value);
    }
  }
};

export const clearEdits = (page: Page, store: EditStore) => {
  for (const file of page.files) {
    store.remove(keyOf(page, file));
  }
};
