// Wikipedia API helpers backing the in-repo MCP server (app/api/mcp/wikipedia).
// These mirror the public `wikipedia-mcp` server's two tools — `search` and
// `readArticle` — so the policy binding works against either, and hit only the
// public Wikipedia API (no extra dependencies, runs anywhere including edge).

const API_URL = "https://en.wikipedia.org/w/api.php";
// Wikipedia asks API clients to identify themselves.
const USER_AGENT =
  "AirLabSandbox/1.0 (https://theairlab.example; wikipedia MCP demo)";
const MAX_ARTICLE_CHARS = 8_000;

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function articleUrl(title: string): string {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

async function wikiApi(params: Record<string, string>): Promise<unknown> {
  const url = new URL(API_URL);
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (!res.ok) throw new Error(`Wikipedia API HTTP ${res.status}`);
  return res.json();
}

interface SearchHit {
  title: string;
  snippet?: string;
  pageid?: number;
}

export async function searchWikipedia(query: string): Promise<string> {
  const data = (await wikiApi({
    action: "query",
    list: "search",
    srsearch: query,
    srlimit: "5",
  })) as { query?: { search?: SearchHit[] } };

  const hits = data.query?.search ?? [];
  if (hits.length === 0) return `No Wikipedia results found for "${query}".`;

  return hits
    .map((h) => {
      const snippet = h.snippet ? stripHtml(h.snippet) : "";
      return `- ${h.title} — ${articleUrl(h.title)}${snippet ? `\n  ${snippet}` : ""}`;
    })
    .join("\n");
}

interface ArticlePage {
  title?: string;
  extract?: string;
  missing?: boolean;
}

export async function readWikipediaArticle(opts: {
  title?: string;
  pageId?: number;
}): Promise<string> {
  const params: Record<string, string> = {
    action: "query",
    prop: "extracts",
    explaintext: "1",
    redirects: "1",
  };
  if (opts.title) params.titles = opts.title;
  else if (opts.pageId !== undefined) params.pageids = String(opts.pageId);

  const data = (await wikiApi(params)) as { query?: { pages?: ArticlePage[] } };
  const page = data.query?.pages?.[0];
  if (!page || page.missing || !page.extract) {
    return `No Wikipedia article found for ${opts.title ?? `page ${opts.pageId}`}.`;
  }

  const title = page.title ?? opts.title ?? "";
  const body = page.extract.slice(0, MAX_ARTICLE_CHARS);
  const truncated = page.extract.length > MAX_ARTICLE_CHARS ? "\n\n…(truncated)" : "";
  return `# ${title}\n${articleUrl(title)}\n\n${body}${truncated}`;
}
