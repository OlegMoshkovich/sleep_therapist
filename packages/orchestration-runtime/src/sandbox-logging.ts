import { isAsyncRuntimeJobInProgress } from "./async-job-runtime";
import type {
  ToolDispatchConfig,
  ToolDispatchContext,
  ToolDispatchResult,
} from "@airlab/canvas-compiler/tool-types";

export interface SandboxToolLoggingSupabaseClient {
  from: (table: string) => any;
}

export type SandboxToolLoggingSupabaseFactory =
  () => SandboxToolLoggingSupabaseClient;

let sandboxToolLoggingSupabaseFactory:
  | SandboxToolLoggingSupabaseFactory
  | null = null;

export function registerSandboxToolLoggingSupabaseFactory(
  factory: SandboxToolLoggingSupabaseFactory | null
): void {
  sandboxToolLoggingSupabaseFactory = factory;
}

function createSandboxToolLoggingSupabaseClient(): SandboxToolLoggingSupabaseClient {
  if (!sandboxToolLoggingSupabaseFactory) {
    throw new Error("Sandbox tool logging Supabase factory is not registered.");
  }
  return sandboxToolLoggingSupabaseFactory();
}

const KNOWLEDGE_BLOCK_CONTENT_LIMIT = 8_000;

function previewArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    parts.push(`${k}=${typeof v === "string" ? `"${v.slice(0, 40)}"` : JSON.stringify(v)}`);
    if (parts.join(", ").length > 80) break;
  }
  return parts.join(", ");
}

function serializeResult(data: unknown): string {
  if (data === undefined || data === null) return "";
  if (typeof data === "string") return data.slice(0, KNOWLEDGE_BLOCK_CONTENT_LIMIT);
  try {
    return JSON.stringify(data, null, 2).slice(0, KNOWLEDGE_BLOCK_CONTENT_LIMIT);
  } catch {
    return String(data).slice(0, KNOWLEDGE_BLOCK_CONTENT_LIMIT);
  }
}

/**
 * Inserts a row into sandbox_tool_call_logs and, if the tool succeeded and
 * the config has promoteToKnowledge=true, also inserts a row into
 * sandbox_knowledge_blocks linked back to the log.
 *
 * All errors are caught and logged — this is a side effect on top of the
 * tool result and must never throw into the caller.
 */
export async function recordToolCall(
  config: ToolDispatchConfig,
  args: Record<string, unknown>,
  result: ToolDispatchResult,
  context: ToolDispatchContext
): Promise<void> {
  if (!context.configId) return;

  try {
    const supabase = createSandboxToolLoggingSupabaseClient();

    const { data: logRow, error: logError } = await supabase
      .from("sandbox_tool_call_logs")
      .insert({
        config_id: context.configId,
        canvas_id: context.canvasId ?? null,
        tool_name: context.toolName,
        source_type: config.sourceType,
        args,
        result: result.ok ? result.data ?? null : null,
        ok: result.ok,
        error: result.ok ? null : result.error ?? null,
      })
      .select("id")
      .single();

    if (logError) {
      console.error("[sandbox-logging] log insert failed:", logError.message);
      return;
    }

    // Skip the auto-promote step for knowledge_save — the dispatch itself
    // already wrote the knowledge block; promoting again would duplicate it.
    if (
      !result.ok ||
      !config.promoteToKnowledge ||
      config.sourceType === "knowledge_save" ||
      isAsyncRuntimeJobInProgress(result.data)
    ) {
      return;
    }

    const argsPreview = previewArgs(args);
    const topic = argsPreview
      ? `${context.toolName}(${argsPreview})`
      : context.toolName;

    const { error: knowledgeError } = await supabase
      .from("sandbox_knowledge_blocks")
      .insert({
        config_id: context.configId,
        topic,
        content: serializeResult(result.data),
        sort_order: Math.floor(Date.now() / 1000),
        source_tool_call_id: logRow?.id ?? null,
      });

    if (knowledgeError) {
      console.error(
        "[sandbox-logging] knowledge insert failed:",
        knowledgeError.message
      );
    }
  } catch (err) {
    console.error(
      "[sandbox-logging] unexpected error:",
      err instanceof Error ? err.message : err
    );
  }
}
