import type { CanvasNodeRecord } from "../components/canvas/types";
import type { FieldType } from "./canvas-hybrid-runtime";

export const NODE_EXECUTABLE_CODE_LANGUAGE_DATA_KEY = "codeLanguage";
export const NODE_EXECUTABLE_CODE_SOURCE_DATA_KEY = "codeSource";
export const NODE_EXECUTABLE_CODE_LOCAL_OUTPUTS_DATA_KEY =
  "codeLocalOutputFields";

export type CanvasCodeExecutionLanguage = "visual" | "typescript";

export interface CanvasCodeLocalOutputField {
  name: string;
  type: FieldType;
}

const MIN_ESCAPED_NEWLINE_SEQUENCES_FOR_MULTILINE_NORMALIZATION = 2;

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

function countTrailingBackslashes(value: string, index: number): number {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    count += 1;
  }
  return count;
}

function isStandaloneBackslash(value: string, index: number): boolean {
  return countTrailingBackslashes(value, index) % 2 === 0;
}

function countStandaloneEscapedNewlineSequences(value: string): number {
  let count = 0;

  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "\\" || !isStandaloneBackslash(value, index)) {
      continue;
    }

    if (value[index + 1] === "n") {
      count += 1;
      index += 1;
      continue;
    }

    if (value[index + 1] === "r" && value[index + 2] === "\\" && value[index + 3] === "n") {
      count += 1;
      index += 3;
      continue;
    }
  }

  return count;
}

function decodeStandaloneEscapedWhitespaceSequences(value: string): string {
  let decoded = "";

  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "\\" || !isStandaloneBackslash(value, index)) {
      decoded += value[index];
      continue;
    }

    const next = value[index + 1];
    if (next === "r" && value[index + 2] === "\\" && value[index + 3] === "n") {
      decoded += "\n";
      index += 3;
      continue;
    }
    if (next === "n") {
      decoded += "\n";
      index += 1;
      continue;
    }
    if (next === "r") {
      decoded += "\r";
      index += 1;
      continue;
    }
    if (next === "t") {
      decoded += "\t";
      index += 1;
      continue;
    }

    decoded += value[index];
  }

  return decoded;
}

export function normalizeNodeExecutableCodeSourceValue(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value || value.includes("\n") || value.includes("\r")) {
    return value;
  }

  if (
    countStandaloneEscapedNewlineSequences(value) <
    MIN_ESCAPED_NEWLINE_SEQUENCES_FOR_MULTILINE_NORMALIZATION
  ) {
    return value;
  }

  const decoded = decodeStandaloneEscapedWhitespaceSequences(value);
  return decoded.includes("\n") || decoded.includes("\r") ? decoded : value;
}

export function readNodeCodeExecutionLanguage(
  node: Pick<CanvasNodeRecord, "data">
): CanvasCodeExecutionLanguage {
  const raw =
    typeof node.data?.[NODE_EXECUTABLE_CODE_LANGUAGE_DATA_KEY] === "string"
      ? node.data[NODE_EXECUTABLE_CODE_LANGUAGE_DATA_KEY].trim()
      : "";
  return raw === "typescript" ? "typescript" : "visual";
}

export function readNodeExecutableCodeSource(
  node: Pick<CanvasNodeRecord, "data">
): string {
  return normalizeNodeExecutableCodeSourceValue(
    node.data?.[NODE_EXECUTABLE_CODE_SOURCE_DATA_KEY]
  );
}

export function normalizeNodeExecutableCodeSourceNode<T extends CanvasNodeRecord>(
  node: T
): T {
  const raw = node.data?.[NODE_EXECUTABLE_CODE_SOURCE_DATA_KEY];
  if (typeof raw !== "string") {
    return node;
  }

  const normalized = normalizeNodeExecutableCodeSourceValue(raw);
  if (normalized === raw) {
    return node;
  }

  return {
    ...node,
    data: {
      ...node.data,
      [NODE_EXECUTABLE_CODE_SOURCE_DATA_KEY]: normalized,
    },
  };
}

export function nodeHasExecutableCodeSource(
  node: Pick<CanvasNodeRecord, "data">
): boolean {
  return readNodeExecutableCodeSource(node).length > 0;
}

export function normalizeNodeCodeLocalOutputFields(
  raw: unknown
): CanvasCodeLocalOutputField[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }

      const candidate = entry as {
        name?: unknown;
        type?: unknown;
      };
      const name =
        typeof candidate.name === "string" ? candidate.name.trim() : "";
      if (!isValidLocalName(name)) {
        return null;
      }

      return {
        name,
        type: normalizeFieldType(candidate.type),
      } satisfies CanvasCodeLocalOutputField;
    })
    .filter(
      (field): field is CanvasCodeLocalOutputField => field !== null
    );
}

export function readNodeCodeLocalOutputFields(
  node: Pick<CanvasNodeRecord, "data">
): CanvasCodeLocalOutputField[] {
  return normalizeNodeCodeLocalOutputFields(
    node.data?.[NODE_EXECUTABLE_CODE_LOCAL_OUTPUTS_DATA_KEY]
  );
}
