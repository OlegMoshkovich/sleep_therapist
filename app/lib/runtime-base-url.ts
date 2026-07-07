// Resolve the app's own base URL at runtime so server-side code can reach the
// app's in-repo API routes (e.g. the hosted MCP servers under /api/mcp/*) with
// an absolute URL. Resolution order:
//   1. an explicit base-url env (AIRLAB_BASE_URL / NEXT_PUBLIC_APP_URL / _SITE_URL)
//   2. VERCEL_URL (set automatically on Vercel deployments)
//   3. PORT (a self-hosted Node server binds here)
//   4. dev default http://127.0.0.1:3000; null in production (force explicit config)
export function resolveRuntimeBaseUrl(): string | null {
  const explicitBaseUrl =
    process.env.AIRLAB_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicitBaseUrl) {
    const normalizedBaseUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(explicitBaseUrl)
      ? explicitBaseUrl
      : `https://${explicitBaseUrl}`;
    try {
      return new URL(normalizedBaseUrl).toString();
    } catch {
      return explicitBaseUrl;
    }
  }

  const vercelUrl = process.env.VERCEL_URL?.trim();
  if (vercelUrl) {
    return `https://${vercelUrl.replace(/^https?:\/\//, "")}`;
  }

  const port = process.env.PORT?.trim();
  if (port) {
    return `http://127.0.0.1:${port}`;
  }

  return process.env.NODE_ENV === "production" ? null : "http://127.0.0.1:3000";
}
