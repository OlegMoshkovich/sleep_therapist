import { buildCanvasSubtreeText, buildCanvasText, generatePseudocode } from "./compiler";
import type { CanvasDoc, CanvasEntry, CompilerFn } from "./types";

export type StateFieldType =
  | "string"
  | "integer"
  | "boolean"
  | "string[]"
  | "number"
  | "json";

export interface StateExtractionField {
  name: string;
  type: StateFieldType;
  initialValue: string;
}

function isDefaultStartLabel(label: string): boolean {
  const trimmed = label.trim().toLowerCase();
  return trimmed === "" || trimmed === "start";
}

function renderStateFieldShape(field: StateExtractionField): string {
  const initialValue = field.initialValue.trim();
  if (initialValue && initialValue.toLowerCase() !== "null") {
    if (field.type === "boolean" && /^(true|false)$/i.test(initialValue)) {
      return initialValue.toLowerCase();
    }
    if ((field.type === "integer" || field.type === "number") && /^-?\d+(?:\.\d+)?$/.test(initialValue)) {
      return initialValue;
    }
    if (field.type === "string[]") {
      try {
        const parsed = JSON.parse(initialValue);
        if (Array.isArray(parsed)) {
          return initialValue;
        }
      } catch {
        // Fall back to the type placeholder when the initial value is not JSON.
      }
    }
    if (field.type === "json") {
      try {
        JSON.parse(initialValue);
        return initialValue;
      } catch {
        // Fall back to the type placeholder when the initial value is not JSON.
      }
    }
    if (field.type === "string") {
      return JSON.stringify(initialValue);
    }
  }

  switch (field.type) {
    case "boolean":
      return "boolean";
    case "integer":
      return "integer";
    case "number":
      return "number";
    case "string[]":
      return "string[]";
    case "json":
      return "json";
    case "string":
    default:
      return "string";
  }
}

function buildStateExtractionInstruction(fields: StateExtractionField[]): string {
  const lines = fields
    .map((field) => ({ ...field, name: field.name.trim() }))
    .filter((field) => field.name.length > 0)
    .map((field) => `  ${JSON.stringify(field.name)}: ${renderStateFieldShape(field)}`);

  const schemaShape = lines.length > 0 ? lines.join(",\n") : "  ...";
  return [
    "Return exactly a JSON object of this form and nothing else:",
    "{",
    schemaShape,
    "}",
  ].join("\n");
}

function rewriteCanvasEntry(
  entry: CanvasEntry,
  stateInstruction: string
): CanvasEntry {
  const startNode = entry.graph.nodes.find((node) => node.type === "start");
  if (!startNode) {
    return entry;
  }

  const rawLabel = typeof startNode.data?.label === "string" ? startNode.data.label : "";
  const baseLabel = isDefaultStartLabel(rawLabel) ? "" : rawLabel.trim();
  const nextLabel = baseLabel ? `${baseLabel}\n\n${stateInstruction}` : stateInstruction;

  return {
    ...entry,
    graph: {
      ...entry.graph,
      nodes: entry.graph.nodes.map((node) =>
        node.id === startNode.id
          ? {
              ...node,
              data: {
                ...node.data,
                label: nextLabel,
              },
            }
          : node
      ),
    },
  };
}

function rewriteDoc(doc: CanvasDoc, fields: StateExtractionField[]): CanvasDoc {
  const stateInstruction = buildStateExtractionInstruction(fields);
  return {
    ...doc,
    canvases: doc.canvases.map((entry) => rewriteCanvasEntry(entry, stateInstruction)),
  };
}

export function compileStateExtractionPrompt(
  doc: CanvasDoc,
  fields: StateExtractionField[]
): string {
  return buildCanvasText(rewriteDoc(doc, fields));
}

export function compileStateExtractionSubtreePrompt(
  doc: CanvasDoc,
  fields: StateExtractionField[],
  canvasId: string,
  rootNodeId?: string,
  promptContextDoc?: CanvasDoc
): string {
  const rewrittenDoc = rewriteDoc(doc, fields);
  const rewrittenPromptContextDoc = promptContextDoc
    ? rewriteDoc(promptContextDoc, fields)
    : undefined;
  return buildCanvasSubtreeText(
    rewrittenDoc,
    canvasId,
    rootNodeId,
    rewrittenPromptContextDoc
  );
}

export function createStateExtractionCompiler(
  fields: StateExtractionField[]
): CompilerFn<string> {
  return (doc) => {
    const rewrittenDoc = rewriteDoc(doc, fields);
    const active =
      rewrittenDoc.canvases.find((entry) => entry.id === rewrittenDoc.activeId) ??
      rewrittenDoc.canvases[0] ??
      null;

    return {
      output: buildCanvasText(rewrittenDoc),
      preview: active ? generatePseudocode(active, rewrittenDoc) : "",
    };
  };
}
