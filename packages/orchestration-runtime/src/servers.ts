import type { McpAuth, ServerRef } from "@airlab/canvas-compiler/tool-types";

const DEFAULT_IN_REPO_MCP_ROUTES: Record<string, string> = {
  memory: "/api/mcp/memory",
  corpus: "/api/mcp/corpus",
};

export interface ResolvedServer {
  url?: string;
  auth?: McpAuth;
  command?: string;
  args?: string[];
}

export interface ServerResolverOptions {
  servers: Record<string, ServerRef>;
  resolveRuntimeBaseUrl?: () => string | null;
  inRepoRoutes?: Record<string, string>;
}

function resolveValue(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.startsWith("env:")) {
    const fromEnv = process.env[trimmed.slice(4)]?.trim();
    return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
  }
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveServerWithOptions(
  logicalName: string,
  options: ServerResolverOptions
): ResolvedServer {
  const ref = options.servers[logicalName];
  if (!ref) return {};

  const url = ref.url ? resolveValue(ref.url) : undefined;

  let auth: McpAuth | undefined = ref.auth;
  if (auth?.type === "bearer") {
    const token = resolveValue(auth.token);
    auth = token ? { type: "bearer", token } : { type: "none" };
  }

  // A resolved remote url wins; otherwise fall back to the local stdio command.
  if (url) return { url, auth };
  if (ref.command) return { command: ref.command, args: ref.args ?? [] };

  // Last resort for in-repo servers: target the app's own route so the demo
  // runs without any env wiring. Resolved to an absolute URL (the MCP client
  // needs one); skipped if no runtime base URL is known (e.g. prod with nothing
  // configured), which then degrades exactly as an unconfigured server.
  const inRepoRoutes = options.inRepoRoutes ?? DEFAULT_IN_REPO_MCP_ROUTES;
  const inRepoPath = inRepoRoutes[logicalName];
  if (inRepoPath) {
    const baseUrl = options.resolveRuntimeBaseUrl?.();
    if (baseUrl) {
      return { url: new URL(inRepoPath, baseUrl).toString(), auth };
    }
  }

  return {};
}

export function createServerResolver(options: ServerResolverOptions) {
  return (
    logicalName: string,
    servers: Record<string, ServerRef> = options.servers
  ): ResolvedServer =>
    resolveServerWithOptions(logicalName, {
      ...options,
      servers,
    });
}
