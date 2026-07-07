export interface FeedItem {
  title?: string;
  link?: string;
  pubDate?: string;
  description?: string;
}

const DEFAULT_MAX_ITEMS = 20;
const HARD_MAX_ITEMS = 100;

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function stripTags(text: string): string {
  return decodeEntities(
    text
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function extractTag(tag: string, block: string): string | undefined {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!match) {
    return undefined;
  }
  return stripTags(match[1]);
}

function extractAtomHref(block: string): string | undefined {
  const match = block.match(/<link\b[^>]*\bhref="([^"]+)"[^>]*\/?>/i);
  return match?.[1]?.trim() || undefined;
}

function extractLink(block: string): string | undefined {
  const atomHref = extractAtomHref(block);
  if (atomHref) {
    return atomHref;
  }

  const inlineLink = extractTag("link", block);
  if (inlineLink) {
    return inlineLink;
  }

  const id = extractTag("id", block);
  return id || undefined;
}

export function looksLikeXmlFeed(contentType: string, text: string): boolean {
  const normalizedType = contentType.toLowerCase();
  if (
    normalizedType.includes("application/atom+xml") ||
    normalizedType.includes("application/rss+xml")
  ) {
    return true;
  }

  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("<rss") ||
    trimmed.startsWith("<?xml") ||
    /<feed\b/i.test(trimmed) ||
    /<entry\b/i.test(trimmed) ||
    /<item\b/i.test(trimmed)
  );
}

export function resolveFeedMaxItems(finalUrl: string): number {
  try {
    const url = new URL(finalUrl);
    const candidates = [
      url.searchParams.get("max_results"),
      url.searchParams.get("pagesize"),
      url.searchParams.get("limit"),
      url.searchParams.get("count"),
    ];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      const parsed = Number.parseInt(candidate, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        return Math.min(parsed, HARD_MAX_ITEMS);
      }
    }
  } catch {
    // Ignore URL parsing issues and fall back to the default cap.
  }

  return DEFAULT_MAX_ITEMS;
}

export function parseXmlFeed(xml: string, maxItems: number): FeedItem[] {
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/gi) ?? [];
  const entryBlocks = xml.match(/<entry[\s\S]*?<\/entry>/gi) ?? [];
  const blocks = itemBlocks.length > 0 ? itemBlocks : entryBlocks;

  return blocks.slice(0, maxItems).map((block) => ({
    title: extractTag("title", block),
    link: extractLink(block),
    pubDate:
      extractTag("pubDate", block) ??
      extractTag("updated", block) ??
      extractTag("published", block),
    description:
      extractTag("description", block) ??
      extractTag("summary", block),
  }));
}
