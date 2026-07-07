import type { CanvasNodeRecord } from "../components/canvas/types";
import type { FieldType } from "./canvas-hybrid-runtime";

export const NODE_LOCAL_INPUTS_DATA_KEY = "localInputFields";

export interface CanvasLocalVariableField {
  name: string;
  type: FieldType;
}

function isValidLocalName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function normalizeFieldType(raw: unknown): FieldType {
  return raw === "integer" ||
    raw === "boolean" ||
    raw === "string[]" ||
    raw === "number" ||
    raw === "json"
    ? raw
    : "string";
}

export function normalizeCanvasLocalVariableFields(
  raw: unknown
): CanvasLocalVariableField[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const seen = new Set<string>();
  const fields: CanvasLocalVariableField[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const candidate = entry as {
      name?: unknown;
      type?: unknown;
    };
    const name =
      typeof candidate.name === "string" ? candidate.name.trim() : "";
    if (!isValidLocalName(name) || seen.has(name)) {
      continue;
    }

    seen.add(name);
    fields.push({
      name,
      type: normalizeFieldType(candidate.type),
    });
  }

  return fields;
}

export function readNodeLocalInputFields(
  node: Pick<CanvasNodeRecord, "data">
): CanvasLocalVariableField[] {
  return normalizeCanvasLocalVariableFields(
    node.data?.[NODE_LOCAL_INPUTS_DATA_KEY]
  );
}
