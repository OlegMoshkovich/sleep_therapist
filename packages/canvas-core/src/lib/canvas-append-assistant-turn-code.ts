import {
  CARRIED_OUTPUT_PROMPT_VALUE_NAME,
  FINALIZED_ASSISTANT_MESSAGE_PROMPT_VALUE_NAME,
} from "./canvas-flow-values";
import {
  LEGACY_NEW_CONVERSATIONS_FIELD_NAME,
  NEW_EVENTS_FIELD_NAME,
} from "./conversation-memory";
import {
  NODE_EXECUTABLE_CODE_LANGUAGE_DATA_KEY,
  NODE_EXECUTABLE_CODE_LOCAL_OUTPUTS_DATA_KEY,
  NODE_EXECUTABLE_CODE_SOURCE_DATA_KEY,
} from "./canvas-node-code-script";

export const BUILTIN_CODE_TEMPLATE_ID_DATA_KEY = "codeTemplateId";
export const APPEND_ASSISTANT_TURN_CODE_TEMPLATE_ID =
  "policy_turn_commit";
export const APPEND_ASSISTANT_TURN_CODE_LABEL =
  "Commit the finalized agent action to agent_latest_action and new_events.";
const PRIMARY_AGENT_LATEST_OBSERVATION_FIELD_NAME = "agent_latest_observation";
const PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME = "agent_latest_reward";
const PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME = "agent_latest_action";

export const APPEND_ASSISTANT_TURN_CODE_SOURCE = [
  "const collapseWhitespace = (value: string): string =>",
  '  value.replace(/\\s+/g, " ").trim();',
  "",
  "const normalizeText = (value: unknown): string =>",
  '  typeof value === "string"',
  "    ? collapseWhitespace(value)",
  "    : collapseWhitespace(String(value ?? \"\"));",
  "",
  "const normalizeReward = (value: unknown): string | number => {",
  "  if (typeof value === \"number\" && Number.isFinite(value)) {",
  "    return value;",
  "  }",
  "  return normalizeText(value);",
  "};",
  "",
  "const normalizeEvent = (raw: unknown) => {",
  "  if (!raw || typeof raw !== \"object\" || Array.isArray(raw)) {",
  "    return null;",
  "  }",
  "",
  "  const record = raw as Record<string, unknown>;",
  "  return {",
  "    action: normalizeText(record.action),",
  "    observation: normalizeText(record.observation),",
  "    reward: normalizeReward(record.reward),",
  "  };",
  "};",
  "",
  "const parseLegacyTurns = (raw: string) => {",
  "  const turns = raw",
  '    .split("||")',
  "    .map((turn) => collapseWhitespace(turn))",
  "    .filter(Boolean);",
  "  const events: Array<{ action: string; observation: string; reward: string | number }> = [];",
  "",
  "  for (const turn of turns) {",
  "    if (/^USER:/i.test(turn)) {",
  "      events.push({",
  "        action: \"\",",
  '        observation: collapseWhitespace(turn.replace(/^USER:/i, "")),',
  "        reward: \"\",",
  "      });",
  "      continue;",
  "    }",
  "",
  "    if (/^ASSISTANT:/i.test(turn)) {",
  '      const action = collapseWhitespace(turn.replace(/^ASSISTANT:/i, ""));',
  "      const latestEvent = events[events.length - 1];",
  "",
  "      if (latestEvent && !latestEvent.action) {",
  "        latestEvent.action = action;",
  "      } else {",
  "        events.push({",
  "          action,",
  "          observation: \"\",",
  "          reward: \"\",",
  "        });",
  "      }",
  "    }",
  "  }",
  "",
  "  return events;",
  "};",
  "",
  "const parseEvents = (raw: unknown) => {",
  "  let parsed = raw;",
  "",
  '  if (typeof parsed === "string") {',
  "    const trimmed = parsed.trim();",
  "    if (!trimmed) {",
  "      return [];",
  "    }",
  "",
  "    try {",
  "      parsed = JSON.parse(trimmed);",
  "    } catch {",
  "      return parseLegacyTurns(trimmed);",
  "    }",
  "  }",
  "",
  "  if (!Array.isArray(parsed)) {",
  "    return [];",
  "  }",
  "",
  "  return parsed",
  "    .map((entry) => normalizeEvent(entry))",
  "    .filter((entry) => entry !== null);",
  "};",
  "",
  "const readAssistantTurn = (raw: unknown): string => {",
  "  if (typeof raw === \"string\") {",
  "    const trimmed = raw.trim();",
  "    if (!trimmed) {",
  "      return \"\";",
  "    }",
  "",
  "    try {",
  "      const parsed = JSON.parse(trimmed);",
  "      if (parsed && typeof parsed === \"object\" && !Array.isArray(parsed)) {",
  "        const record = parsed as Record<string, unknown>;",
  "        const assistantMessage = normalizeText(record.assistantMessage);",
  "        if (assistantMessage) {",
  "          return assistantMessage;",
  "        }",
  `        const latestAction = normalizeText(record[${JSON.stringify(
    PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME
  )}]);`,
  "        if (latestAction) {",
  "          return latestAction;",
  "        }",
  "        const observation = normalizeText(record.observation);",
  "        if (observation) {",
  "          return observation;",
  "        }",
  "        const action = normalizeText(record.action);",
  "        if (action) {",
  "          return action;",
  "        }",
  "      }",
  "    } catch {}",
  "",
  "    return normalizeText(trimmed);",
  "  }",
  "",
  "  if (raw && typeof raw === \"object\" && !Array.isArray(raw)) {",
  "    const record = raw as Record<string, unknown>;",
  "    const assistantMessage = normalizeText(record.assistantMessage);",
  "    if (assistantMessage) {",
  "      return assistantMessage;",
  "    }",
  `    const latestAction = normalizeText(record[${JSON.stringify(
    PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME
  )}]);`,
  "    if (latestAction) {",
  "      return latestAction;",
  "    }",
  "    const observation = normalizeText(record.observation);",
  "    if (observation) {",
  "      return observation;",
  "    }",
  "    const action = normalizeText(record.action);",
  "    if (action) {",
  "      return action;",
  "    }",
  "  }",
  "",
  "  return \"\";",
  "};",
  "",
  `const assistantTurn = readAssistantTurn(ctx.locals[${JSON.stringify(
    FINALIZED_ASSISTANT_MESSAGE_PROMPT_VALUE_NAME
  )}]) || readAssistantTurn(ctx.locals[${JSON.stringify(
    CARRIED_OUTPUT_PROMPT_VALUE_NAME
  )}]);`,
  "if (!assistantTurn) {",
  "  return {};",
  "}",
  "",
  "const fieldNames = Object.keys(ctx.state);",
  "const memoryFieldName =",
  `  fieldNames.find((name) => name.trim().toLowerCase() === ${JSON.stringify(
    NEW_EVENTS_FIELD_NAME
  )}) ??`,
  `  fieldNames.find((name) => name.trim().toLowerCase() === ${JSON.stringify(
    LEGACY_NEW_CONVERSATIONS_FIELD_NAME
  )}) ??`,
  "  null;",
  "",
"const latestActionFieldName =",
`  fieldNames.find((name) => name.trim().toLowerCase() === ${JSON.stringify(
  PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME
)}) ??`,
"  null;",
"",
"const latestObservationFieldName =",
`  fieldNames.find((name) => name.trim().toLowerCase() === ${JSON.stringify(
  PRIMARY_AGENT_LATEST_OBSERVATION_FIELD_NAME
)}) ??`,
"  null;",
"const latestRewardFieldName =",
`  fieldNames.find((name) => name.trim().toLowerCase() === ${JSON.stringify(
  PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME
)}) ??`,
"  null;",
"const latestObservation = latestObservationFieldName",
"  ? normalizeText(ctx.state[latestObservationFieldName])",
"  : \"\";",
"const latestReward = latestRewardFieldName",
"  ? normalizeReward(ctx.state[latestRewardFieldName])",
"  : \"\";",
"",
"if (!memoryFieldName) {",
"  if (!latestActionFieldName) {",
"    return {};",
"  }",
"",
"  return {",
"    setState: {",
"      [latestActionFieldName]: assistantTurn,",
"    },",
"  };",
"}",
"",
"const events = parseEvents(ctx.state[memoryFieldName]);",
"const latestEvent = events[events.length - 1];",
"",
"if (latestEvent && !normalizeText(latestEvent.action)) {",
"  latestEvent.action = assistantTurn;",
"  if (!normalizeText(latestEvent.observation) && latestObservation) {",
"    latestEvent.observation = latestObservation;",
"  }",
"  if (!normalizeText(latestEvent.reward) && normalizeText(latestReward)) {",
"    latestEvent.reward = latestReward;",
"  }",
"} else {",
  "  events.push({",
  "    action: assistantTurn,",
  "    observation: latestObservation,",
  "    reward: latestReward,",
  "  });",
  "}",
  "",
"return {",
"  setState: {",
"    [memoryFieldName]: JSON.stringify(events),",
"    ...(latestActionFieldName ? { [latestActionFieldName]: assistantTurn } : {}),",
"  },",
"};",
].join("\\n");

const ASSISTANT_TURN_FALLBACK_BLOCK = [
  `const assistantTurn = readAssistantTurn(ctx.locals[${JSON.stringify(
    FINALIZED_ASSISTANT_MESSAGE_PROMPT_VALUE_NAME
  )}]) || readAssistantTurn(ctx.locals[${JSON.stringify(
    CARRIED_OUTPUT_PROMPT_VALUE_NAME
  )}]);`,
  "if (!assistantTurn) {",
  "  return {};",
  "}",
].join("\n");

const STRICT_FINALIZED_ASSISTANT_TURN_BLOCK = [
  `const rawAssistantTurn = ctx.locals[${JSON.stringify(
    FINALIZED_ASSISTANT_MESSAGE_PROMPT_VALUE_NAME
  )}];`,
  "const assistantTurn =",
  "  (typeof rawAssistantTurn === \"string\"",
  "    ? normalizeText(rawAssistantTurn)",
  "    : \"\") || \"No assistant message...\";",
].join("\n");

export const STRICT_FINALIZED_ASSISTANT_TURN_CODE_SOURCE =
  APPEND_ASSISTANT_TURN_CODE_SOURCE.replace(
    ASSISTANT_TURN_FALLBACK_BLOCK,
    STRICT_FINALIZED_ASSISTANT_TURN_BLOCK
  );

type NodeDataLike = Record<string, unknown> | null | undefined;

export function buildAppendAssistantTurnCodeNodeData(
  existingData?: NodeDataLike,
  options: { strictFinalizedAssistantMessage?: boolean } = {}
): Record<string, unknown> {
  const nextData = {
    ...(existingData ?? {}),
  };
  delete nextData.nonEditable;
  delete nextData.nonEditableReason;
  delete nextData[NODE_EXECUTABLE_CODE_LOCAL_OUTPUTS_DATA_KEY];

  return {
    ...nextData,
    label:
      typeof nextData.label === "string" && nextData.label.trim()
        ? nextData.label
        : APPEND_ASSISTANT_TURN_CODE_LABEL,
    actionType: "code",
    actionTypeSource: "manual",
    [NODE_EXECUTABLE_CODE_LANGUAGE_DATA_KEY]: "typescript",
    [NODE_EXECUTABLE_CODE_SOURCE_DATA_KEY]:
      options.strictFinalizedAssistantMessage
        ? STRICT_FINALIZED_ASSISTANT_TURN_CODE_SOURCE
        : APPEND_ASSISTANT_TURN_CODE_SOURCE,
    [BUILTIN_CODE_TEMPLATE_ID_DATA_KEY]:
      APPEND_ASSISTANT_TURN_CODE_TEMPLATE_ID,
  };
}
