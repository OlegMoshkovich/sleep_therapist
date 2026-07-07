export type PromptOutputFieldType =
  | "string"
  | "integer"
  | "boolean"
  | "string[]"
  | "number"
  | "json";

export interface PromptOutputFieldConfig {
  name: string;
  type: PromptOutputFieldType;
  instruction: string;
}

export function normalizePromptOutputFieldType(raw: unknown): PromptOutputFieldType {
  return raw === "integer" ||
    raw === "boolean" ||
    raw === "string[]" ||
    raw === "number" ||
    raw === "json"
    ? raw
    : "string";
}

export function normalizePromptOutputFields(raw: unknown): PromptOutputFieldConfig[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((field) => {
      if (!field || typeof field !== "object") {
        return null;
      }

      const candidate = field as {
        name?: unknown;
        type?: unknown;
        instruction?: unknown;
      };
      const name =
        typeof candidate.name === "string" ? candidate.name.trim() : "";
      const instruction =
        typeof candidate.instruction === "string"
          ? candidate.instruction.trim()
          : "";

      if (!name || !instruction) {
        return null;
      }

      return {
        name,
        type: normalizePromptOutputFieldType(candidate.type),
        instruction,
      };
    })
    .filter((field): field is PromptOutputFieldConfig => field !== null);
}
