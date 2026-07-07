// Reserved prompt/local flow variables shared by the runtime and inspector.
export const CARRIED_OUTPUT_PROMPT_VALUE_NAME = "carried_output";
export const FINALIZED_ASSISTANT_MESSAGE_PROMPT_VALUE_NAME =
  "finalized_assistant_message";
export const AGENT_LATEST_OBSERVATION_PROMPT_VALUE_NAME =
  "agent_latest_observation";
export const AGENT_LATEST_REWARD_PROMPT_VALUE_NAME = "agent_latest_reward";
export const LATEST_SIMULATION_TRANSCRIPT_PROMPT_VALUE_NAME =
  "latest_simulation_transcript";
export const LATEST_SIMULATION_ERROR_PROMPT_VALUE_NAME =
  "latest_simulation_error";
export const CANVAS_CODE_NODE_ERROR_PROMPT_VALUE_NAME =
  "canvas_code_node_error";
export const CANVAS_TOOL_CALL_ERROR_PROMPT_VALUE_NAME =
  "canvas_tool_call_error";

export function buildObservationIngressPromptValues(value: string): Record<string, string> {
  return {
    [AGENT_LATEST_OBSERVATION_PROMPT_VALUE_NAME]: value,
  };
}

export function buildPrimaryAgentIngressPromptValues(args: {
  latestObservation: string;
  latestReward?: string | null;
}): Record<string, string> {
  return {
    [AGENT_LATEST_OBSERVATION_PROMPT_VALUE_NAME]: args.latestObservation,
    ...(args.latestReward !== undefined
      ? {
          [AGENT_LATEST_REWARD_PROMPT_VALUE_NAME]: args.latestReward ?? "",
        }
      : {}),
  };
}

export function buildEnvironmentAgentIngressPromptValues(args: {
  latestObservation: string;
  latestReward?: string | null;
}): Record<string, string> {
  return buildPrimaryAgentIngressPromptValues(args);
}

export const RESERVED_PROMPT_VALUE_NAMES = [
  CARRIED_OUTPUT_PROMPT_VALUE_NAME,
  FINALIZED_ASSISTANT_MESSAGE_PROMPT_VALUE_NAME,
  AGENT_LATEST_OBSERVATION_PROMPT_VALUE_NAME,
  AGENT_LATEST_REWARD_PROMPT_VALUE_NAME,
  LATEST_SIMULATION_TRANSCRIPT_PROMPT_VALUE_NAME,
  LATEST_SIMULATION_ERROR_PROMPT_VALUE_NAME,
  CANVAS_CODE_NODE_ERROR_PROMPT_VALUE_NAME,
  CANVAS_TOOL_CALL_ERROR_PROMPT_VALUE_NAME,
] as const;
