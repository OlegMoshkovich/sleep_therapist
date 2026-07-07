import vm from "node:vm";
import ts from "typescript";
import type {
  FieldType,
  PromptValueSnapshot,
  RuntimeStateField,
  StateSnapshot,
} from "./canvas-hybrid-runtime";

const CODE_SCRIPT_TIMEOUT_MS = 25;
const VALID_LOCAL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

interface CodeScriptContext {
  state: Record<string, JsonValue>;
  locals: PromptValueSnapshot;
  stateSchema: Array<{
    fieldName: string;
    type: FieldType;
  }>;
}

interface CodeScriptResult {
  setState?: Record<string, JsonValue>;
  setLocals?: Record<string, JsonValue>;
  clearLocals?: string[];
}

class CodeScriptFailError extends Error {}

const transpiledScriptCache = new Map<string, string>();
const CODE_SCRIPT_WRAPPER_PREFIX_LINE_COUNT = 2;
const CODE_SCRIPT_RETURN_PREVIEW_MAX_LENGTH = 160;

function isPlainObject(
  value: unknown
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  if (Object.prototype.toString.call(value) !== "[object Object]") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype === Object.prototype || prototype === null) {
    return true;
  }

  // Accept object literals created inside the VM sandbox, whose prototype is a
  // different realm's Object.prototype.
  return Object.getPrototypeOf(prototype) === null;
}

function cloneValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      deepFreeze(entry);
    }
    return Object.freeze(value);
  }

  for (const entry of Object.values(value as Record<string, unknown>)) {
    deepFreeze(entry);
  }
  return Object.freeze(value);
}

function normalizeJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJsonValue(entry));
  }

  if (isPlainObject(value)) {
    const next: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) {
        continue;
      }
      next[key] = normalizeJsonValue(entry);
    }
    return next;
  }

  throw new Error("Code scripts may only return JSON-serializable values.");
}

function decodeStateFieldValue(
  raw: string,
  type: FieldType
): JsonValue {
  const trimmed = raw.trim();
  if (!trimmed) {
    return type === "string[]" ? [] : null;
  }

  if (type === "boolean") {
    return /^(yes|true|1)$/i.test(trimmed);
  }

  if (type === "integer") {
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (type === "number") {
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (type === "string[]") {
    return trimmed
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  if (type === "json") {
    try {
      return normalizeJsonValue(JSON.parse(trimmed));
    } catch {
      return trimmed;
    }
  }

  return trimmed;
}

function encodeStateFieldValue(
  value: JsonValue,
  type: FieldType
): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (type === "boolean") {
    if (typeof value === "boolean") {
      return value ? "Yes" : "";
    }
    if (typeof value === "string") {
      return /^(yes|true|1)$/i.test(value.trim()) ? "Yes" : "";
    }
    return "";
  }

  if (type === "string[]") {
    if (Array.isArray(value)) {
      return value
        .map((entry) => String(entry).trim())
        .filter((entry) => entry.length > 0)
        .join(", ");
    }
    return typeof value === "string" ? value.trim() : String(value);
  }

  if (type === "integer" || type === "number") {
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
    return typeof value === "string" ? value.trim() : "";
  }

  if (type === "json") {
    if (typeof value === "string") {
      return value.trim();
    }
    return JSON.stringify(value);
  }

  return typeof value === "string" ? value.trim() : String(value);
}

function findFieldType(
  stateSchema: RuntimeStateField[],
  fieldName: string
): FieldType {
  return (
    stateSchema.find((field) => field.fieldName === fieldName)?.type ?? "string"
  );
}

function buildDecodedState(
  currentState: StateSnapshot,
  stateSchema: RuntimeStateField[]
): Record<string, JsonValue> {
  const fieldNames = new Set<string>([
    ...Object.keys(currentState),
    ...stateSchema.map((field) => field.fieldName),
  ]);
  const decoded: Record<string, JsonValue> = {};

  for (const fieldName of fieldNames) {
    decoded[fieldName] = decodeStateFieldValue(
      currentState[fieldName] ?? "",
      findFieldType(stateSchema, fieldName)
    );
  }

  return decoded;
}

function formatCodeScriptReturnValueType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function formatCodeScriptReturnValuePreview(value: unknown): string {
  let preview = "";
  if (typeof value === "string") {
    preview = JSON.stringify(value);
  } else {
    try {
      preview = JSON.stringify(value);
    } catch {
      preview = String(value);
    }
  }
  const trimmed = preview.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.length > CODE_SCRIPT_RETURN_PREVIEW_MAX_LENGTH
    ? `${trimmed.slice(0, CODE_SCRIPT_RETURN_PREVIEW_MAX_LENGTH - 1)}...`
    : trimmed;
}

function normalizeScriptLocalsMap(
  raw: Record<string, unknown>,
  errorContext: string
): Record<string, JsonValue> {
  const nextLocals: Record<string, JsonValue> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!VALID_LOCAL_NAME.test(name)) {
      throw new Error(`Invalid local variable name "${name}" in ${errorContext}.`);
    }
    nextLocals[name] = normalizeJsonValue(value);
  }
  return nextLocals;
}

function normalizeScriptResult(raw: unknown): CodeScriptResult {
  if (raw === null || raw === undefined) {
    return {};
  }
  if (!isPlainObject(raw)) {
    const type = formatCodeScriptReturnValueType(raw);
    const preview = formatCodeScriptReturnValuePreview(raw);
    throw new Error(
      [
        "Code scripts must return a plain object with optional setState, setLocals, or clearLocals.",
        `Received ${type}.`,
        preview ? `Value: ${preview}` : "",
        'If you want to publish a computed value, wrap it like return { setLocals: { my_value: value } }.',
      ]
        .filter(Boolean)
        .join(" ")
    );
  }

  const result: CodeScriptResult = {};
  const hasExplicitMutationShape =
    raw.setState !== undefined ||
    raw.setLocals !== undefined ||
    raw.clearLocals !== undefined;

  if (!hasExplicitMutationShape) {
    result.setLocals = normalizeScriptLocalsMap(
      raw,
      "top-level code-script return object"
    );
    return result;
  }

  if (raw.setState !== undefined) {
    if (!isPlainObject(raw.setState)) {
      throw new Error("setState must be a plain object.");
    }
    const nextState: Record<string, JsonValue> = {};
    for (const [fieldName, value] of Object.entries(raw.setState)) {
      nextState[fieldName] = normalizeJsonValue(value);
    }
    result.setState = nextState;
  }

  if (raw.setLocals !== undefined) {
    if (!isPlainObject(raw.setLocals)) {
      throw new Error("setLocals must be a plain object.");
    }
    result.setLocals = normalizeScriptLocalsMap(
      raw.setLocals,
      "setLocals"
    );
  }

  if (raw.clearLocals !== undefined) {
    if (!Array.isArray(raw.clearLocals)) {
      throw new Error("clearLocals must be an array of local variable names.");
    }
    result.clearLocals = raw.clearLocals.map((entry) => {
      const name = typeof entry === "string" ? entry.trim() : "";
      if (!VALID_LOCAL_NAME.test(name)) {
        throw new Error(`Invalid local variable name "${String(entry)}".`);
      }
      return name;
    });
  }

  return result;
}

function transpileCodeBody(source: string): string {
  const cached = transpiledScriptCache.get(source);
  if (cached) {
    return cached;
  }

  const wrappedSource = [
    "((ctx, api) => {",
    '"use strict";',
    source,
    "})(__ctx, __api);",
  ].join("\n");
  const transpileResult = ts.transpileModule(wrappedSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      isolatedModules: true,
      strict: false,
    },
    reportDiagnostics: true,
  });
  const diagnostics = (transpileResult.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
  );
  if (diagnostics.length > 0) {
    const first = diagnostics[0];
    const message = ts.flattenDiagnosticMessageText(first.messageText, "\n").trim();
    if (first.file && typeof first.start === "number") {
      const position = first.file.getLineAndCharacterOfPosition(first.start);
      const sourceLineNumber =
        position.line + 1 - CODE_SCRIPT_WRAPPER_PREFIX_LINE_COUNT;
      const sourceColumnNumber = position.character + 1;
      const sourceLine =
        source.split("\n")[Math.max(sourceLineNumber - 1, 0)]?.trim() ?? "";
      const location =
        sourceLineNumber > 0
          ? `line ${sourceLineNumber}, column ${sourceColumnNumber}`
          : `column ${sourceColumnNumber}`;
      throw new Error(
        sourceLine
          ? `${message} (${location}). Source: ${sourceLine}`
          : `${message} (${location}).`
      );
    }
    throw new Error(message || "Code script compilation failed.");
  }
  const transpiled = transpileResult.outputText;

  transpiledScriptCache.set(source, transpiled);
  return transpiled;
}

export function executeTypeScriptCodeStep(args: {
  source: string;
  currentState: StateSnapshot;
  stateSchema: RuntimeStateField[];
  promptValues: PromptValueSnapshot;
}): { nextState: StateSnapshot; nextPromptValues: PromptValueSnapshot } {
  const normalizedSource = args.source.trim();
  if (!normalizedSource) {
    return {
      nextState: { ...args.currentState },
      nextPromptValues: { ...args.promptValues },
    };
  }

  if (/\bctx\.latestUserMessage\b/.test(normalizedSource)) {
    throw new Error(
      "ctx.latestUserMessage is no longer provided. Read ctx.locals.agent_latest_observation instead."
    );
  }

  if (
    /ctx\.locals\s*(?:\.\s*latest_user_message|\[\s*["']latest_user_message["']\s*\])/.test(
      normalizedSource
    )
  ) {
    throw new Error(
      "ctx.locals.latest_user_message is no longer provided. Read ctx.locals.agent_latest_observation instead."
    );
  }

  if (/\bctx\.currentBuild\b/.test(normalizedSource)) {
    throw new Error(
      "ctx.currentBuild is no longer provided. Read ctx.state.current_build instead."
    );
  }

  const scriptContext: CodeScriptContext = deepFreeze({
    state: deepFreeze(buildDecodedState(args.currentState, args.stateSchema)),
    locals: deepFreeze(cloneValue(args.promptValues)),
    stateSchema: args.stateSchema.map((field) => ({
      fieldName: field.fieldName,
      type: field.type,
    })),
  });
  const api = deepFreeze({
    fail(message: string): never {
      throw new CodeScriptFailError(message);
    },
  });

  const sandbox = {
    __ctx: scriptContext,
    __api: api,
    fetch: undefined,
    process: undefined,
    require: undefined,
    setTimeout: undefined,
    clearTimeout: undefined,
    setInterval: undefined,
    clearInterval: undefined,
    queueMicrotask: undefined,
    console: undefined,
  } as Record<string, unknown>;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox, {
    codeGeneration: {
      strings: false,
      wasm: false,
    },
  });

  try {
    const script = new vm.Script(transpileCodeBody(normalizedSource), {
      filename: "canvas-code-node.ts",
    });
    const rawResult = script.runInContext(context, {
      timeout: CODE_SCRIPT_TIMEOUT_MS,
    });
    const result = normalizeScriptResult(rawResult);
    const nextState = { ...args.currentState };
    const nextPromptValues = { ...args.promptValues };

    for (const localName of result.clearLocals ?? []) {
      delete nextPromptValues[localName];
    }

    for (const [fieldName, value] of Object.entries(result.setState ?? {})) {
      if (
        !(fieldName in nextState) &&
        !args.stateSchema.some((field) => field.fieldName === fieldName)
      ) {
        throw new Error(`Code script attempted to set unknown state field "${fieldName}".`);
      }
      nextState[fieldName] = encodeStateFieldValue(
        value,
        findFieldType(args.stateSchema, fieldName)
      );
    }

    for (const [localName, value] of Object.entries(result.setLocals ?? {})) {
      nextPromptValues[localName] = value;
    }

    return {
      nextState,
      nextPromptValues,
    };
  } catch (error) {
    if (error instanceof CodeScriptFailError) {
      throw new Error(error.message);
    }

    throw new Error(
      error instanceof Error ? error.message : "Code script execution failed."
    );
  }
}
