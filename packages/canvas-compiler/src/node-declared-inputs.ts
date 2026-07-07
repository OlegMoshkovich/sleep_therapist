import { readNodeLocalInputFields } from "@airlab/canvas-core/lib/canvas-node-local-fields";
import { CARRIED_OUTPUT_PROMPT_VALUE_NAME } from "@airlab/canvas-core/lib/canvas-flow-values";
import { getNodeActionSubtype } from "@airlab/canvas-core/components/canvas/action-subtype";
import type { CanvasNodeRecord } from "./types";

export interface CanvasDeclaredInputField {
  name: string;
  type: string;
  origin: string;
}

export function getCanvasNodeDeclaredInputFields(
  node: Pick<CanvasNodeRecord, "data"> & Partial<Pick<CanvasNodeRecord, "type">>
): CanvasDeclaredInputField[] {
  const displayInput = readDisplayInputField(node);
  const promptTransformInput = readPromptTransformInputField(node);
  const fields = readNodeLocalInputFields(node).map((field) => ({
    name: field.name,
    type: field.type,
    origin: "declared local input",
  }));

  return dedupeDeclaredInputs([
    ...(displayInput ? [displayInput] : []),
    ...(promptTransformInput ? [promptTransformInput] : []),
    ...fields,
  ]);
}

function readDisplayInputField(
  node: Pick<CanvasNodeRecord, "data"> & Partial<Pick<CanvasNodeRecord, "type">>
): CanvasDeclaredInputField | null {
  const actionType =
    typeof node.data?.actionType === "string" ? node.data.actionType.trim() : "";
  if (node.type !== "display" && actionType !== "display") {
    return null;
  }

  const displayType = node.data?.displayType === "video" ? "video" : "text";
  const videoUrl =
    typeof node.data?.videoUrl === "string" ? node.data.videoUrl.trim() : "";
  if (displayType === "video" && videoUrl) {
    return null;
  }

  const raw =
    typeof node.data?.inputVariable === "string"
      ? node.data.inputVariable.trim()
      : "";
  return {
    name: raw || CARRIED_OUTPUT_PROMPT_VALUE_NAME,
    type: "string",
    origin: "display value source",
  };
}

function readPromptTransformInputField(
  node: Pick<CanvasNodeRecord, "data"> & Partial<Pick<CanvasNodeRecord, "type">>
): CanvasDeclaredInputField | null {
  if (getNodeActionSubtype(node) !== "prompt_transform") {
    return null;
  }

  const raw =
    typeof node.data?.inputVariable === "string"
      ? node.data.inputVariable.trim()
      : "";
  return {
    name: raw || CARRIED_OUTPUT_PROMPT_VALUE_NAME,
    type: "string",
    origin: "prompt transform value source",
  };
}

function dedupeDeclaredInputs(
  fields: CanvasDeclaredInputField[]
): CanvasDeclaredInputField[] {
  const seen = new Set<string>();
  const deduped: CanvasDeclaredInputField[] = [];
  for (const field of fields) {
    const name = field.name.trim();
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    deduped.push({
      ...field,
      name,
    });
  }
  return deduped;
}
