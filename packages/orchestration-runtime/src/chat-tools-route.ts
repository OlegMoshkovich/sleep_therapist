import OpenAI from "openai";

import { dispatchTool as defaultDispatchTool } from "./dispatch";
import { resolveInterpolatedUrl } from "./http";
import type {
  ToolDispatchConfig,
  ToolDispatchContext,
  ToolDispatchResult,
} from "@airlab/canvas-compiler/tool-types";

type TraceEvent =
  | {
      kind: "openai_request";
      loop: number;
      model: string;
      messages: Array<{ role: string; preview: string; toolCalls?: number; toolCallId?: string }>;
      tools: Array<{ name: string; description?: string }>;
    }
  | {
      kind: "openai_response";
      loop: number;
      content: string;
      toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
      finishReason: string | null;
    }
  | {
      kind: "tool_dispatch";
      loop: number;
      tool: string;
      sourceType: string;
      urlTemplate: string;
      resolvedUrl: string;
      args: Record<string, unknown>;
    }
  | {
      kind: "tool_poll";
      loop: number;
      tool: string;
      jobId: string;
      status: "queued" | "running";
      pollCount: number;
      summary?: string;
      preview?: string;
    }
  | {
      kind: "tool_result";
      loop: number;
      tool: string;
      ok: boolean;
      bytes: number;
      preview: string;
      error?: string;
      transport?: "mcp" | "rest" | "internal" | "openclaw";
      transportNote?: string;
    };

type RequestMessageSummary = {
  role: string;
  preview: string;
  toolCalls?: number;
  toolCallId?: string;
};

export interface ChatToolsAuthResult {
  userId?: string | null;
}

export type ChatToolsAuthenticator = (
  request: Request
) => Promise<ChatToolsAuthResult>;

export type ChatToolsDispatcher = (
  config: ToolDispatchConfig,
  args: Record<string, unknown>,
  context?: ToolDispatchContext
) => Promise<ToolDispatchResult>;

export interface CreateChatToolsRouteOptions {
  authenticate: ChatToolsAuthenticator;
  dispatchTool?: ChatToolsDispatcher;
  logger?: Pick<Console, "error">;
  openAiApiKey?: () => string | undefined;
}

function traceTargetsForTool(
  config: ToolDispatchConfig,
  args: Record<string, unknown>
): { urlTemplate: string; resolvedUrl: string } {
  switch (config.sourceType) {
    case "knowledge_save": {
      const target =
        config.saveTarget === "dataset" && config.datasetName
          ? `sandbox://dataset/${config.datasetName}`
          : "sandbox://knowledge_blocks";
      return { urlTemplate: target, resolvedUrl: target };
    }
    case "dataset_read": {
      const target = `sandbox://dataset/${config.datasetName ?? "(unset)"}`;
      return { urlTemplate: target, resolvedUrl: target };
    }
    case "mcp": {
      const target = config.mcp
        ? `mcp://${config.mcp.server}/${config.mcp.remoteTool}`
        : "mcp://(unresolved)";
      return { urlTemplate: target, resolvedUrl: target };
    }
    case "openclaw": {
      const target = config.openclaw?.agentId
        ? `openclaw://${config.openclaw.agentId}`
        : "openclaw://backend";
      return { urlTemplate: target, resolvedUrl: config.url };
    }
    case "web_search": {
      const target = `web_search://${process.env.WEB_SEARCH_PROVIDER?.trim() || "auto"}`;
      return { urlTemplate: target, resolvedUrl: target };
    }
    default: {
      const resolved = resolveInterpolatedUrl(config.url, args);
      return {
        urlTemplate: config.url,
        resolvedUrl: resolved.ok
          ? resolved.url
          : `${config.url} [${resolved.error}]`,
      };
    }
  }
}

function summarizeMessages(
  msgs: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
): RequestMessageSummary[] {
  return msgs.map((m) => {
    let content: string;
    if (typeof m.content === "string") {
      // Tool messages carry JSON; pretty-print for readability.
      if (m.role === "tool") {
        try {
          content = JSON.stringify(JSON.parse(m.content), null, 2);
        } catch {
          content = m.content;
        }
      } else {
        content = m.content;
      }
    } else {
      content = JSON.stringify(m.content ?? "", null, 2);
    }
    const base: RequestMessageSummary = {
      role: m.role,
      preview: content,
    };
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      base.toolCalls = m.tool_calls.length;
    }
    if (m.role === "tool") {
      base.toolCallId = (m as { tool_call_id?: string }).tool_call_id;
    }
    return base;
  });
}

const OPENAI_MODEL = "gpt-5.4";
const OPENAI_MAX_TOKENS = 1024;
const MAX_TOOL_LOOPS = 5;

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface ToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
    };
  };
  config: ToolDispatchConfig;
}

interface RequestBody {
  messages: ChatMessage[];
  tools: ToolDef[];
  systemPrompt?: string;
  conversationId?: string;
  /** Optional: sandbox config row id, enables tool-call logging + promote-to-knowledge. */
  configId?: string;
  /** Optional: sandbox canvas row id, recorded with each log entry. */
  canvasId?: string;
}

function safeParseArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function statusForEvent(event: TraceEvent): string {
  switch (event.kind) {
    case "openai_request":
      return `Calling OpenAI · loop ${event.loop}`;
    case "openai_response":
      if (event.toolCalls.length > 0) {
        return `Model called ${event.toolCalls.map((c) => c.name).join(", ")}`;
      }
      return `Model answered (${event.content.length.toLocaleString()} chars)`;
    case "tool_dispatch":
      return `Running ${event.tool} · ${event.sourceType}`;
    case "tool_poll":
      return event.pollCount > 0
        ? `Waiting on ${event.tool} · ${event.status} · poll ${event.pollCount}`
        : `Waiting on ${event.tool} · ${event.status}`;
    case "tool_result":
      return event.ok
        ? `${event.tool} returned ${event.bytes.toLocaleString()} bytes`
        : `${event.tool} failed`;
  }
}

export function createChatToolsPostHandler(options: CreateChatToolsRouteOptions) {
  return async function POST(request: Request): Promise<Response> {
    const { userId } = await options.authenticate(request);
    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json()) as RequestBody;
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return Response.json({ error: "messages is required" }, { status: 400 });
    }

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        function send(payload: object) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        }
        function emitTrace(event: TraceEvent) {
          trace.push(event);
          send({ type: "event", event });
          send({ type: "status", text: statusForEvent(event) });
        }

        const trace: TraceEvent[] = [];

        try {
          const toolsByName = new Map<string, ToolDef>();
          for (const t of body.tools ?? []) toolsByName.set(t.function.name, t);

          const openaiTools = (body.tools ?? []).map((t) => ({
            type: t.type,
            function: t.function,
          }));

          const openai = new OpenAI({
            apiKey: options.openAiApiKey?.() ?? process.env.AIRLAB_OPENAI_API_KEY,
          });

          const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
          if (body.systemPrompt?.trim()) {
            messages.push({ role: "system", content: body.systemPrompt.trim() });
          }
          for (const m of body.messages) {
            messages.push({ role: m.role, content: m.content });
          }

          for (let loop = 0; loop < MAX_TOOL_LOOPS; loop += 1) {
            emitTrace({
              kind: "openai_request",
              loop,
              model: OPENAI_MODEL,
              messages: summarizeMessages(messages),
              tools: openaiTools.map((t) => ({
                name: t.function.name,
                description: t.function.description,
              })),
            });

            const completion = await openai.chat.completions.create({
              model: OPENAI_MODEL,
              max_completion_tokens: OPENAI_MAX_TOKENS,
              messages,
              tools: openaiTools.length > 0 ? openaiTools : undefined,
            });

            const choice = completion.choices[0];
            const msg = choice?.message;
            if (!msg) {
              send({ type: "error", message: "Empty completion", trace });
              controller.close();
              return;
            }

            const toolCalls = msg.tool_calls ?? [];
            emitTrace({
              kind: "openai_response",
              loop,
              content: msg.content ?? "",
              toolCalls: toolCalls
                .filter((c) => c.type === "function")
                .map((c) => ({
                  name: c.function.name,
                  args: safeParseArgs(c.function.arguments),
                })),
              finishReason: choice?.finish_reason ?? null,
            });

            if (toolCalls.length === 0) {
              send({ type: "done", content: msg.content ?? "", trace });
              controller.close();
              return;
            }

            messages.push({
              role: "assistant",
              content: msg.content ?? "",
              tool_calls: toolCalls,
            });

            for (const call of toolCalls) {
              if (call.type !== "function") continue;
              const def = toolsByName.get(call.function.name);
              const args = safeParseArgs(call.function.arguments);

              let resultPayload: ToolDispatchResult;
              if (!def) {
                resultPayload = { ok: false, error: `Unknown tool: ${call.function.name}` };
                emitTrace({
                  kind: "tool_dispatch",
                  loop,
                  tool: call.function.name,
                  sourceType: "(unknown)",
                  urlTemplate: "",
                  resolvedUrl: "",
                  args,
                });
              } else {
                const { urlTemplate, resolvedUrl } = traceTargetsForTool(def.config, args);
                emitTrace({
                  kind: "tool_dispatch",
                  loop,
                  tool: call.function.name,
                  sourceType: def.config.sourceType,
                  urlTemplate,
                  resolvedUrl,
                  args,
                });
                const dispatch = options.dispatchTool ?? defaultDispatchTool;
                resultPayload = await dispatch(def.config, args, {
                  configId: body.configId,
                  canvasId: body.canvasId,
                  conversationId: body.conversationId,
                  userId,
                  toolName: call.function.name,
                  awaitOpenClawCompletion: true,
                  onOpenClawStatus: (update) => {
                    emitTrace({
                      kind: "tool_poll",
                      loop,
                      tool: call.function.name,
                      jobId: update.jobId,
                      status: update.status,
                      pollCount: update.pollCount,
                      summary:
                        typeof update.summary === "string" ? update.summary : undefined,
                      preview:
                        typeof update.preview === "string" ? update.preview : undefined,
                    });
                  },
                });
              }

              const serialized = JSON.stringify(resultPayload);
              emitTrace({
                kind: "tool_result",
                loop,
                tool: call.function.name,
                ok: resultPayload.ok,
                bytes: serialized.length,
                preview: resultPayload.ok
                  ? JSON.stringify(resultPayload.data ?? "", null, 2)
                  : resultPayload.error ?? "",
                error: resultPayload.ok ? undefined : resultPayload.error,
                transport: resultPayload.transport,
                transportNote: resultPayload.transportNote,
              });

              messages.push({
                role: "tool",
                tool_call_id: call.id,
                content: serialized,
              });
            }
          }

          send({
            type: "error",
            message: `Exceeded MAX_TOOL_LOOPS (${MAX_TOOL_LOOPS})`,
            trace,
          });
          controller.close();
        } catch (err) {
          (options.logger ?? console).error("[/api/chat/tools] error:", err);
          send({
            type: "error",
            message: err instanceof Error ? err.message : "Internal server error",
            trace,
          });
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  };
}
