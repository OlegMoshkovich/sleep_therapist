import type { ToolDispatchResult } from "@airlab/canvas-compiler/tool-types";
import { resolveInterpolatedUrl } from "./http";

const MAX_RESPONSE_BYTES = 64_000;
const MAX_PAGE_TEXT_CHARS = 12_000;
const DEFAULT_SCHOLAR_PAPERS = 25;
const MAX_SCHOLAR_PAPERS = 100;

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = decodeHtmlEntities((match?.[1] ?? "").replace(/\s+/g, " ").trim());
  return title || null;
}

function stripHtmlNoise(html: string): string {
  return html
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

function extractReadableText(body: string): string {
  return decodeHtmlEntities(
    stripHtmlNoise(body)
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  ).slice(0, MAX_PAGE_TEXT_CHARS);
}

function looksLikeScholarCitationsPage(url: URL): boolean {
  return url.hostname === "scholar.google.com" && url.pathname === "/citations";
}

function getScholarPaperLimit(url: URL): number {
  const raw = url.searchParams.get("pagesize");
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SCHOLAR_PAPERS;
  }
  return Math.min(parsed, MAX_SCHOLAR_PAPERS);
}

function extractScholarPapers(
  html: string,
  parsedUrl: URL,
  finalUrl: string,
  title: string | null
): string | null {
  const cleaned = stripHtmlNoise(html);
  const rowPattern = /<tr[^>]*class="[^"]*\bgsc_a_tr\b[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
  const papers: string[] = [];
  const paperLimit = getScholarPaperLimit(parsedUrl);

  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowPattern.exec(cleaned)) && papers.length < paperLimit) {
    const row = rowMatch[1];
    const paperTitle = decodeHtmlEntities(
      (row.match(/<a[^>]*class="[^"]*\bgsc_a_at\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    );
    if (!paperTitle) {
      continue;
    }

    const grayMatches = [...row.matchAll(/<div[^>]*class="[^"]*\bgs_gray\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)];
    const authors = decodeHtmlEntities(
      (grayMatches[0]?.[1] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    );
    const venue = decodeHtmlEntities(
      (grayMatches[1]?.[1] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    );
    const citedBy = decodeHtmlEntities(
      (row.match(/<a[^>]*class="[^"]*\bgsc_a_ac\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    );
    const year = decodeHtmlEntities(
      (row.match(/<span[^>]*class="[^"]*\bgsc_a_h\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ??
        row.match(/<td[^>]*class="[^"]*\bgsc_a_y\b[^"]*"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i)?.[1] ??
        "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    );

    const details = [authors, venue, year ? `year ${year}` : "", citedBy ? `cited by ${citedBy}` : ""]
      .filter((part) => part.length > 0)
      .join(" | ");
    papers.push(details ? `- ${paperTitle} — ${details}` : `- ${paperTitle}`);
  }

  if (papers.length === 0) {
    return null;
  }

  const heading = title ? `Title: ${title}` : null;
  return [
    `URL: ${finalUrl}`,
    heading,
    "Papers:",
    ...papers,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export async function fetchPage(
  url: string,
  args: Record<string, unknown>
): Promise<ToolDispatchResult> {
  const resolvedUrl = resolveInterpolatedUrl(url, args);
  if (!resolvedUrl.ok) {
    return {
      ok: false,
      error: resolvedUrl.error,
    };
  }

  const finalUrl = resolvedUrl.url;
  try {
    const parsedUrl = new URL(finalUrl);
    const response = await fetch(finalUrl, {
      headers: { Accept: "text/html, text/plain, application/xhtml+xml" },
    });
    const rawText = (await response.text()).slice(0, MAX_RESPONSE_BYTES);

    if (!response.ok) {
      return {
        ok: false,
        error: `HTTP ${response.status}: ${rawText.slice(0, 500)}`,
      };
    }

    const title = extractTitle(rawText);
    if (looksLikeScholarCitationsPage(parsedUrl)) {
      const scholarPayload = extractScholarPapers(rawText, parsedUrl, finalUrl, title);
      if (scholarPayload) {
        return { ok: true, data: scholarPayload };
      }
    }

    const pageText = extractReadableText(rawText);
    const payload = [
      `URL: ${finalUrl}`,
      title ? `Title: ${title}` : null,
      pageText ? `Content: ${pageText}` : "Content: (empty page)",
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");

    return { ok: true, data: payload };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Unknown fetch error",
    };
  }
}
