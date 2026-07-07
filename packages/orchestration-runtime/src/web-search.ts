import type { ToolDispatchResult } from "@airlab/canvas-compiler/tool-types";

type WebSearchProvider = "tavily" | "brave" | "serpapi";

interface WebSearchArgs {
  query: string;
  limit: number;
  includeContent: boolean;
  timeRange?: string;
}

interface NormalizedWebSearchResult {
  title: string;
  url: string;
  snippet: string;
  content?: string;
  score?: number;
  source?: string;
  publishedDate?: string;
}

interface WebSearchPayload {
  provider: WebSearchProvider;
  query: string;
  results: NormalizedWebSearchResult[];
  answer?: string;
  usage?: unknown;
}

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const MAX_SNIPPET_CHARS = 1200;
const MAX_CONTENT_CHARS = 4000;

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "yes" || normalized === "1";
  }
  return false;
}

function readLimit(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.trunc(parsed), MAX_LIMIT);
}

function clip(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1).trim()}...` : normalized;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = readString(value);
    if (text) return text;
  }
  return "";
}

function parseArgs(args: Record<string, unknown>): WebSearchArgs | { error: string } {
  const query = firstString(args.query, args.q, args.search);
  if (!query) {
    return { error: 'web_search requires a "query" string.' };
  }

  const timeRange = firstString(args.time_range, args.timeRange, args.freshness);
  return {
    query,
    limit: readLimit(args.limit ?? args.count ?? args.max_results ?? args.maxResults),
    includeContent: readBoolean(
      args.include_content ?? args.includeContent ?? args.include_raw_content ?? args.includeRawContent
    ),
    timeRange: timeRange || undefined,
  };
}

function configuredProvider(): WebSearchProvider | null {
  const preferred = process.env.WEB_SEARCH_PROVIDER?.trim().toLowerCase();
  if (preferred === "tavily" && process.env.TAVILY_API_KEY?.trim()) return "tavily";
  if (preferred === "brave" && process.env.BRAVE_SEARCH_API_KEY?.trim()) return "brave";
  if (preferred === "serpapi" && process.env.SERPAPI_API_KEY?.trim()) return "serpapi";

  if (process.env.TAVILY_API_KEY?.trim()) return "tavily";
  if (process.env.BRAVE_SEARCH_API_KEY?.trim()) return "brave";
  if (process.env.SERPAPI_API_KEY?.trim()) return "serpapi";
  return null;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function failFromResponse(provider: WebSearchProvider, response: Response, data: unknown): ToolDispatchResult {
  const body =
    typeof data === "string"
      ? data
      : (() => {
          try {
            return JSON.stringify(data);
          } catch {
            return String(data);
          }
        })();
  return {
    ok: false,
    error: `${provider} search failed with HTTP ${response.status}: ${body.slice(0, 500)}`,
  };
}

async function searchTavily(input: WebSearchArgs): Promise<ToolDispatchResult> {
  const apiKey = process.env.TAVILY_API_KEY?.trim();
  if (!apiKey) return { ok: false, error: "TAVILY_API_KEY is not configured." };

  const body: Record<string, unknown> = {
    query: input.query,
    max_results: input.limit,
    search_depth: "basic",
    include_answer: false,
    include_raw_content: input.includeContent ? "text" : false,
    include_usage: true,
  };
  if (input.timeRange) {
    body.time_range = input.timeRange;
  }

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await readJson(response);
  if (!response.ok) return failFromResponse("tavily", response, data);

  const root = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const rawResults = Array.isArray(root.results) ? root.results : [];
  const results = rawResults
    .map((item): NormalizedWebSearchResult | null => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      const url = readString(row.url);
      if (!url) return null;
      const snippet = firstString(row.content, row.snippet, row.description);
      const rawContent = firstString(row.raw_content);
      const score = typeof row.score === "number" && Number.isFinite(row.score) ? row.score : undefined;
      return {
        title: firstString(row.title, url),
        url,
        snippet: clip(snippet, MAX_SNIPPET_CHARS),
        ...(rawContent ? { content: clip(rawContent, MAX_CONTENT_CHARS) } : {}),
        ...(score !== undefined ? { score } : {}),
        source: "tavily",
      };
    })
    .filter((result): result is NormalizedWebSearchResult => Boolean(result));

  const payload: WebSearchPayload = {
    provider: "tavily",
    query: input.query,
    results,
    ...(readString(root.answer) ? { answer: readString(root.answer) } : {}),
    ...(root.usage !== undefined ? { usage: root.usage } : {}),
  };
  return { ok: true, data: payload };
}

function braveFreshness(timeRange: string | undefined): string | undefined {
  if (!timeRange) return undefined;
  const normalized = timeRange.trim().toLowerCase();
  if (normalized === "day" || normalized === "d") return "pd";
  if (normalized === "week" || normalized === "w") return "pw";
  if (normalized === "month" || normalized === "m") return "pm";
  if (normalized === "year" || normalized === "y") return "py";
  return timeRange;
}

async function searchBrave(input: WebSearchArgs): Promise<ToolDispatchResult> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
  if (!apiKey) return { ok: false, error: "BRAVE_SEARCH_API_KEY is not configured." };

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", input.query);
  url.searchParams.set("count", String(input.limit));
  url.searchParams.set("extra_snippets", "true");
  const freshness = braveFreshness(input.timeRange);
  if (freshness) {
    url.searchParams.set("freshness", freshness);
  }

  const response = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey,
    },
  });
  const data = await readJson(response);
  if (!response.ok) return failFromResponse("brave", response, data);

  const root = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const web = root.web && typeof root.web === "object" ? (root.web as Record<string, unknown>) : {};
  const rawResults = Array.isArray(web.results) ? web.results : [];
  const results = rawResults
    .map((item): NormalizedWebSearchResult | null => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      const urlValue = readString(row.url);
      if (!urlValue) return null;
      const extraSnippets = Array.isArray(row.extra_snippets)
        ? row.extra_snippets.map(readString).filter(Boolean)
        : [];
      const snippet = [readString(row.description), ...extraSnippets].filter(Boolean).join(" ");
      return {
        title: firstString(row.title, urlValue),
        url: urlValue,
        snippet: clip(snippet, MAX_SNIPPET_CHARS),
        source: firstString(row.profile && typeof row.profile === "object" ? (row.profile as Record<string, unknown>).name : undefined, "brave"),
        publishedDate: firstString(row.age, row.page_age) || undefined,
      };
    })
    .filter((result): result is NormalizedWebSearchResult => Boolean(result));

  return {
    ok: true,
    data: {
      provider: "brave",
      query: input.query,
      results,
    } satisfies WebSearchPayload,
  };
}

async function searchSerpApi(input: WebSearchArgs): Promise<ToolDispatchResult> {
  const apiKey = process.env.SERPAPI_API_KEY?.trim();
  if (!apiKey) return { ok: false, error: "SERPAPI_API_KEY is not configured." };

  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google");
  url.searchParams.set("q", input.query);
  url.searchParams.set("num", String(input.limit));
  url.searchParams.set("api_key", apiKey);

  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
  });
  const data = await readJson(response);
  if (!response.ok) return failFromResponse("serpapi", response, data);

  const root = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const rawResults = Array.isArray(root.organic_results) ? root.organic_results : [];
  const results = rawResults
    .map((item): NormalizedWebSearchResult | null => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      const urlValue = firstString(row.link, row.url);
      if (!urlValue) return null;
      return {
        title: firstString(row.title, urlValue),
        url: urlValue,
        snippet: clip(firstString(row.snippet, row.description), MAX_SNIPPET_CHARS),
        source: firstString(row.source, row.displayed_link, "serpapi"),
      };
    })
    .filter((result): result is NormalizedWebSearchResult => Boolean(result));

  return {
    ok: true,
    data: {
      provider: "serpapi",
      query: input.query,
      results,
    } satisfies WebSearchPayload,
  };
}

export async function searchWeb(args: Record<string, unknown>): Promise<ToolDispatchResult> {
  const parsed = parseArgs(args);
  if ("error" in parsed) {
    return { ok: false, error: parsed.error };
  }

  const provider = configuredProvider();
  if (!provider) {
    return {
      ok: false,
      error:
        "No web search provider is configured. Set WEB_SEARCH_PROVIDER plus one of TAVILY_API_KEY, BRAVE_SEARCH_API_KEY, or SERPAPI_API_KEY.",
    };
  }

  try {
    switch (provider) {
      case "tavily":
        return searchTavily(parsed);
      case "brave":
        return searchBrave(parsed);
      case "serpapi":
        return searchSerpApi(parsed);
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Unknown web search error",
    };
  }
}
