import type { ToolDispatchResult } from "@airlab/canvas-compiler/tool-types";
import {
  looksLikeXmlFeed,
  parseXmlFeed,
  resolveFeedMaxItems,
} from "./xml-feed";

const MAX_RESPONSE_BYTES = 64_000;

export interface InterpolatedUrlSuccess {
  ok: true;
  url: string;
}

export interface InterpolatedUrlFailure {
  ok: false;
  error: string;
  missingKeys: string[];
}

export type InterpolatedUrlResult =
  | InterpolatedUrlSuccess
  | InterpolatedUrlFailure;

export function interpolateUrl(template: string, args: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const value = args[key];
    if (value === undefined || value === null) return "";
    return encodeURIComponent(String(value));
  });
}

export function resolveInterpolatedUrl(
  template: string,
  args: Record<string, unknown>
): InterpolatedUrlResult {
  const placeholderMatches = template.matchAll(/\{(\w+)\}/g);
  const missingKeys = Array.from(
    new Set(
      Array.from(placeholderMatches, (match) => match[1]).filter((key) => {
        const value = args[key];
        return value === undefined || value === null;
      })
    )
  );

  if (missingKeys.length > 0) {
    return {
      ok: false,
      error:
        `Tool URL template requires value${missingKeys.length === 1 ? "" : "s"} for ` +
        `${missingKeys.map((key) => `"${key}"`).join(", ")}. ` +
        `Template: ${template}`,
      missingKeys,
    };
  }

  return {
    ok: true,
    url: interpolateUrl(template, args),
  };
}

export async function fetchHttp(
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
      headers: { Accept: "application/json" },
    });
    const text = await response.text();
    const truncated = text.slice(0, MAX_RESPONSE_BYTES);

    if (!response.ok) {
      return {
        ok: false,
        error: `HTTP ${response.status}: ${truncated.slice(0, 500)}`,
      };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (looksLikeXmlFeed(contentType, truncated)) {
      const items = parseXmlFeed(truncated, resolveFeedMaxItems(finalUrl));
      if (items.length > 0) {
        return { ok: true, data: { items } };
      }
    }

    if (contentType.includes("application/json")) {
      try {
        return { ok: true, data: JSON.parse(truncated) };
      } catch {
        return { ok: true, data: truncated };
      }
    }
    return { ok: true, data: truncated };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Unknown fetch error",
    };
  }
}
