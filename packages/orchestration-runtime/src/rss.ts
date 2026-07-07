import type { ToolDispatchResult } from "@airlab/canvas-compiler/tool-types";
import { resolveInterpolatedUrl } from "./http";
import { parseXmlFeed, resolveFeedMaxItems } from "./xml-feed";

export async function fetchRss(
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
    const response = await fetch(finalUrl, {
      headers: { Accept: "application/rss+xml, application/atom+xml, application/xml" },
    });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    const xml = await response.text();
    return { ok: true, data: { items: parseXmlFeed(xml, resolveFeedMaxItems(finalUrl)) } };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Unknown fetch error",
    };
  }
}
