/**
 * @module
 * A small Markdown subset for lesson text: paragraphs (each line stays its
 * own line), `code`, **bold**, *italic*, literal `<kbd>` tags, and key hints
 * such as `{Run}` (see `shared/hints.ts`). Everything else is escaped.
 */

import { replaceHints } from "../../shared/hints.ts";
import { hintOf } from "../../shared/keys.ts";
import { keys } from "./keytable.ts";
import { isMac } from "./platform.ts";

const escapeHtml = (text: string) => {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
};

const inline = (line: string) => {
  const kept: string[] = [];
  const hold = (html: string) => {
    kept.push(html);

    return `@@${kept.length - 1}@@`;
  };

  let text = line.replace(/<kbd>(.*?)<\/kbd>/g, (_all, key: string) => {
    return hold(`<kbd>${escapeHtml(key)}</kbd>`);
  });

  text = text.replace(/`([^`]+)`/g, (_all, code: string) => {
    return hold(`<code>${escapeHtml(code)}</code>`);
  });
  text = replaceHints(text, keys, (action) => {
    const spec = action.inField[0] ?? action.outside[0] ?? "";

    return hold(
      `<strong>${escapeHtml(action.label)}</strong> <kbd>${escapeHtml(hintOf(spec, isMac))}</kbd>`,
    );
  });
  text = escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");

  return text.replace(/@@(\d+)@@/g, (_all, index: string) => {
    return kept[Number(index)] ?? "";
  });
};

export const renderMarkdown = (markdown: string) => {
  return markdown
    .split(/\n{2,}/)
    .map((paragraph) => {
      const lines = paragraph.split("\n").map(inline).join("<br>");

      return `<p>${lines}</p>`;
    })
    .join("\n");
};
