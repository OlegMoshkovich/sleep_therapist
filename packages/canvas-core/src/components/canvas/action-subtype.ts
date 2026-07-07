export type ActionSubtype =
  | "default"
  | "prompt"
  | "code"
  | "tool_call"
  | "display"
  | "prompt_transform";

export type PromptNodeSubtype = Extract<
  ActionSubtype,
  "prompt" | "prompt_transform"
>;

export type DisplayNodeType = "text" | "video";

export function normalizeActionSubtype(
  rawActionType: unknown
): ActionSubtype {
  const actionType =
    typeof rawActionType === "string" ? rawActionType.trim() : "";

  if (
    actionType === "prompt" ||
    actionType === "tool_call" ||
    actionType === "display" ||
    actionType === "code"
  ) {
    return actionType;
  }

  if (actionType === "prompt_transform" || actionType === "summarize") {
    return "prompt_transform";
  }

  return "default";
}

export function normalizePromptNodeSubtype(
  rawPromptType: unknown
): PromptNodeSubtype {
  const normalized = normalizeActionSubtype(rawPromptType);
  return normalized === "prompt_transform"
    ? normalized
    : "prompt";
}

export function normalizeDisplayNodeType(
  rawDisplayType: unknown
): DisplayNodeType {
  return rawDisplayType === "video" ? "video" : "text";
}

export function getNodeActionSubtype(node: {
  type?: string | null;
  data?: Record<string, unknown> | null;
}): ActionSubtype {
  if (node.type === "prompt") {
    return normalizePromptNodeSubtype(node.data?.actionType);
  }
  if (node.type === "code") {
    return "code";
  }
  if (node.type === "tool_call") {
    return "tool_call";
  }
  if (node.type === "display") {
    return "display";
  }
  return normalizeActionSubtype(node.data?.actionType);
}

export function isPromptLikeNode(node: {
  type?: string | null;
  data?: Record<string, unknown> | null;
}): boolean {
  if (node.type === "prompt") {
    return true;
  }
  if (node.type !== "action") {
    return false;
  }
  const subtype = getNodeActionSubtype(node);
  return (
    subtype === "default" ||
    subtype === "prompt" ||
    subtype === "prompt_transform"
  );
}
