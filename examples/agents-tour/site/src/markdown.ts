/**
 * @module
 * A small Markdown subset for lesson text: paragraphs (each line stays its
 * own line), `code`, **bold**, *italic*, and literal `<kbd>` tags. Everything
 * else is escaped.
 */
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
