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

/**
 * Resolves the base origin for tool URLs that are written as a relative path
 * (e.g. "/api/tools/market"). Node's fetch requires an absolute URL, so a
 * relative path can't be used directly — but hardcoding "http://localhost:3000"
 * in a canvas breaks the moment the app is deployed. Preferring an explicit
 * override, then Vercel's deployment host, then a localhost fallback keeps the
 * same canvas working in dev and in production.
 */
function resolveAppBaseUrl(): string {
  const explicit =
    process.env.APP_BASE_URL || process.env.NEXT_PUBLIC_APP_BASE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");

  const vercelHost =
    process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (vercelHost) {
    return `https://${vercelHost.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  }

  const port = process.env.PORT || "3000";
  return `http://localhost:${port}`;
}

/**
 * Turns a possibly-relative tool URL into an absolute one. Absolute URLs
 * (http/https) are returned unchanged; a leading-slash path is resolved against
 * {@link resolveAppBaseUrl}.
 */
export function toAbsoluteToolUrl(url: string): string {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("/")) return `${resolveAppBaseUrl()}${trimmed}`;
  return trimmed;
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

  const finalUrl = toAbsoluteToolUrl(resolvedUrl.url);
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
