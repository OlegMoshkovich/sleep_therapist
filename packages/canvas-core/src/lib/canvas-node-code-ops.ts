import type { CanvasNodeRecord } from "../components/canvas/types";
import type {
  RuntimeStateField,
  StateCodeOperation,
  StateValueSource,
} from "./canvas-hybrid-runtime";

export const NODE_EXECUTABLE_CODE_OPS_DATA_KEY = "executableCodeOps";

function isValidLocalName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function normalizeKey(text: string): string {
  return text.trim().toLowerCase().replace(/[_\s-]+/g, " ");
}

function resolveCanonicalFieldName(
  rawField: unknown,
  stateSchema: RuntimeStateField[]
): string | null {
  const fieldName = typeof rawField === "string" ? rawField.trim() : "";
  if (!fieldName) {
    return null;
  }

  const exactMatch =
    stateSchema.find((field) => field.fieldName === fieldName)?.fieldName ?? null;
  if (exactMatch) {
    return exactMatch;
  }

  return (
    stateSchema.find(
      (field) => normalizeKey(field.fieldName) === normalizeKey(fieldName)
    )?.fieldName ?? null
  );
}

function normalizeConstantValue(
  rawValue: unknown
): string | number | boolean | null | string[] | null {
  if (
    rawValue === null ||
    typeof rawValue === "string" ||
    typeof rawValue === "number" ||
    typeof rawValue === "boolean"
  ) {
    return rawValue;
  }

  if (
    Array.isArray(rawValue) &&
    rawValue.every((entry) => typeof entry === "string")
  ) {
    return rawValue.map((entry) => entry.trim());
  }

  return null;
}

function normalizeStateValueSource(raw: unknown): StateValueSource | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const source = raw as Record<string, unknown>;
  const kind = typeof source.kind === "string" ? source.kind.trim() : "";

  if (kind === "constant") {
    const value = normalizeConstantValue(source.value);
    return value === null && source.value !== null
      ? null
      : {
          kind: "constant",
          value,
        };
  }

  if (kind === "prompt_variable") {
    const name = typeof source.name === "string" ? source.name.trim() : "";
    return name ? { kind: "prompt_variable", name } : null;
  }

  if (
    kind === "current_build_snapshot" ||
    kind === "conversation_turns" ||
    kind === "latest_user_turn" ||
    kind === "latest_assistant_turn" ||
    kind === "latest_observation_event" ||
    kind === "latest_observation_and_reward_event" ||
    kind === "latest_primary_action_event" ||
    kind === "agent_latest_observation" ||
    kind === "extract_age" ||
    kind === "extract_gender"
  ) {
    return { kind };
  }

  if (kind === "regex_capture") {
    const pattern =
      typeof source.pattern === "string" ? source.pattern.trim() : "";
    if (!pattern) {
      return null;
    }

    const normalized: StateValueSource = {
      kind: "regex_capture",
      pattern,
    };
    if (typeof source.flags === "string" && source.flags.trim()) {
      normalized.flags = source.flags.trim();
    }
    if (typeof source.group === "number" && Number.isInteger(source.group)) {
      normalized.group = source.group;
    }
    return normalized;
  }

  if (kind === "boolean_from_regex") {
    const pattern =
      typeof source.pattern === "string" ? source.pattern.trim() : "";
    if (!pattern) {
      return null;
    }

    return {
      kind: "boolean_from_regex",
      pattern,
      flags:
        typeof source.flags === "string" && source.flags.trim()
          ? source.flags.trim()
          : undefined,
    };
  }

  return null;
}

function normalizeStateCodeOperation(
  raw: unknown,
  stateSchema: RuntimeStateField[]
): StateCodeOperation | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const operation = raw as Record<string, unknown>;
  const kind =
    typeof operation.kind === "string" ? operation.kind.trim() : "";
  const field = resolveCanonicalFieldName(operation.field, stateSchema);

  if (!field) {
    return null;
  }

  if (kind === "clear_field") {
    return {
      kind: "clear_field",
      field,
    };
  }

  if (kind === "set_field") {
    const source = normalizeStateValueSource(operation.source);
    if (!source) {
      return null;
    }

    return {
      kind: "set_field",
      field,
      source,
      only_if_empty:
        typeof operation.only_if_empty === "boolean"
          ? operation.only_if_empty
          : undefined,
    };
  }

  if (kind === "set_local") {
    const name =
      typeof operation.name === "string" ? operation.name.trim() : "";
    const source = normalizeStateValueSource(operation.source);
    if (!isValidLocalName(name) || !source) {
      return null;
    }

    return {
      kind: "set_local",
      name,
      source,
      only_if_empty:
        typeof operation.only_if_empty === "boolean"
          ? operation.only_if_empty
          : undefined,
    };
  }

  if (kind === "append_list_item") {
    const hasValue = Object.prototype.hasOwnProperty.call(operation, "value");
    const hasSource = Object.prototype.hasOwnProperty.call(operation, "source");
    if (hasValue === hasSource) {
      return null;
    }

    if (hasValue) {
      const value = typeof operation.value === "string" ? operation.value : null;
      if (value === null) {
        return null;
      }

      return {
        kind: "append_list_item",
        field,
        value,
        unique:
          typeof operation.unique === "boolean" ? operation.unique : undefined,
      };
    }

    const source = normalizeStateValueSource(operation.source);
    if (!source) {
      return null;
    }

    return {
      kind: "append_list_item",
      field,
      source,
      unique:
        typeof operation.unique === "boolean" ? operation.unique : undefined,
    };
  }

  return null;
}

export function normalizeNodeExecutableStateCodeOps(
  raw: unknown,
  stateSchema: RuntimeStateField[]
): StateCodeOperation[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }

  const operations = raw.map((entry) =>
    normalizeStateCodeOperation(entry, stateSchema)
  );
  if (
    operations.length === 0 ||
    operations.some((operation) => operation === null)
  ) {
    return null;
  }

  return operations as StateCodeOperation[];
}

export function readExplicitNodeExecutableStateCodeOps(
  node: Pick<CanvasNodeRecord, "data">,
  stateSchema: RuntimeStateField[]
): StateCodeOperation[] | null {
  return normalizeNodeExecutableStateCodeOps(
    node.data?.[NODE_EXECUTABLE_CODE_OPS_DATA_KEY],
    stateSchema
  );
}

export function readExplicitNodeLocalOutputNames(
  node: Pick<CanvasNodeRecord, "data">
): string[] {
  if (!Array.isArray(node.data?.[NODE_EXECUTABLE_CODE_OPS_DATA_KEY])) {
    return [];
  }

  const names = new Set<string>();
  for (const entry of node.data?.[NODE_EXECUTABLE_CODE_OPS_DATA_KEY] as unknown[]) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const operation = entry as Record<string, unknown>;
    const kind = typeof operation.kind === "string" ? operation.kind.trim() : "";
    const name = typeof operation.name === "string" ? operation.name.trim() : "";
    if (kind === "set_local" && isValidLocalName(name)) {
      names.add(name);
    }
  }

  return Array.from(names);
}
