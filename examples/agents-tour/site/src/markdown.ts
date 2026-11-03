/**
 * @module
 * A small Markdown subset for lesson text: paragraphs (each line stays its
 * own line), `code`, **bold**, *italic*, literal `<kbd>` tags, and key hints
 * such as `{Run}` (see `shared/hints.ts`). Everything else is escaped.
 */

import { replaceHints } from "../../shared/hints.ts";
import { hintOf } from "../../shared/keys.ts";
import { type LinkFile, resolveSpan } from "../../shared/links.ts";
import { keys } from "./keytable.ts";
import { isMac } from "./platform.ts";

const escapeHtml = (text: string) => {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
};

// Inline code that names code in the page's files is a link; `data-link`
// says where it resolves, for the page check.
const codeHtml = (code: string, files: readonly LinkFile[]) => {
  const target = resolveSpan(code, files);

  if (!target) {
    return `<code>${escapeHtml(code)}</code>`;
  }

  const where = `${target.file}${target.line > 0 ? `:${target.line}` : ""}`;

  return `<code class="code-link" role="link" tabindex="0" data-code="${escapeHtml(code).replaceAll('"', "&quot;")}" data-link="${where}">${escapeHtml(code)}</code>`;
};

const inline = (line: string, files: readonly LinkFile[]) => {
  const kept: string[] = [];
  const hold = (html: string) => {
    kept.push(html);

    return `@@${kept.length - 1}@@`;
  };

  let text = line.replace(/<kbd>(.*?)<\/kbd>/g, (_all, key: string) => {
    return hold(`<kbd>${escapeHtml(key)}</kbd>`);
  });

  text = text.replace(/`([^`]+)`/g, (_all, code: string) => {
    return hold(codeHtml(code, files));
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

export const renderMarkdown = (
  markdown: string,
  files: readonly LinkFile[] = [],
) => {
  return markdown
    .split(/\n{2,}/)
    .map((paragraph) => {
      const lines = paragraph
        .split("\n")
        .map((line) => {
          return inline(line, files);
        })
        .join("<br>");

      return `<p>${lines}</p>`;
    })
    .join("\n");
};
