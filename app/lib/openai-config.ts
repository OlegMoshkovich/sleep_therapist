export const OPENAI_MODEL = "gpt-5.4";

export function resolveOptionalOpenAiApiKey(): string | null {
  return (
    process.env.AIRLAB_OPENAI_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    null
  );
}

export function resolveOpenAiApiKey(): string {
  const apiKey = resolveOptionalOpenAiApiKey();
  if (!apiKey) {
    throw new Error("Set AIRLAB_OPENAI_API_KEY or OPENAI_API_KEY.");
  }
  return apiKey;
}

export const DAEMON_BUILDER_MAX_COMPLETION_TOKENS = 4000;

export const DAEMON_BUILDER_TOKEN_BUDGETS = {
  initialCanvasStructureMaterialization: 2800,
  canvasRuleIssueDetection: 1800,
  canvasRuleRepair: 2400,
} as const;
export const DAEMON_ACTION_CLASSIFIER_MAX_COMPLETION_TOKENS = 3000;
export const DAEMON_OPENING_MESSAGE_MAX_COMPLETION_TOKENS = 180;
export const DAEMON_ENVIRONMENT_TURN_MAX_COMPLETION_TOKENS = 900;

export const SIMULATION_TOKEN_BUDGETS = {
  stateUpdate: 500,
  stateExtraction: 500,
  primaryPolicyDecision: 450,
  primaryPolicySubtree: 450,
  primaryPolicySubtreeExtraction: 500,
  primaryPolicyTransform: 450,
  primaryPolicyExtraction: 450,
  environmentPolicyDecision: 500,
  environmentPolicySubtree: 500,
  environmentPolicySubtreeExtraction: 550,
  environmentPolicyTransform: 500,
  environmentPolicyExtraction: 450,
} as const;

export const LIVE_SESSION_TOKEN_BUDGETS = {
  stateUpdate: 500,
  stateSubtreeUpdate: 500,
  stateExtraction: 450,
  policyDecision: 450,
  policySubtree: 450,
  policySubtreeExtraction: 500,
  policyTransform: 450,
  policyExtraction: 450,
  expandPrompt: 450,
  fallbackAssistantMessage: 450,
} as const;
