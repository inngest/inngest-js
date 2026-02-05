/**
 * Exa Search Integration
 *
 * Provides web search functionality using the Exa API.
 * https://exa.ai/
 */

import Exa from "exa-js";
import type { Source } from "./types";

// Initialize Exa client
const exa = new Exa(process.env.EXA_API_KEY || "");

/**
 * Search for sources using Exa's neural search
 *
 * @param query - The search query
 * @returns Array of sources with title, URL, content, and metadata
 */
export async function searchExa(query: string): Promise<Source[]> {
  const results = await exa.searchAndContents(query, {
    numResults: 5,
    useAutoprompt: true,
    text: { maxCharacters: 2000 },
  });

  return results.results.map((r) => ({
    title: r.title || "Untitled",
    url: r.url,
    content: r.text || "",
    publishedDate: r.publishedDate || undefined,
    favicon: r.favicon || undefined,
  }));
}
