import {
  PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME,
  PRIMARY_AGENT_LATEST_OBSERVATION_FIELD_NAME,
  PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME,
  findOrchestrationFieldByCanonicalName,
  type OrchestrationField,
} from "./general-orchestration";

// Single source of truth for the run-contract text that the simulate and
// live-session routes layer on top of the user-authored canvases. The values
// below are only seed defaults. Runs should consume an explicit
// `project.interactionProtocol` object that has already been materialized onto
// the draft, not silently fall back inside route code.

export const DEFAULT_ENVIRONMENT_OBSERVATION =
  "The environment did not produce a clear observation.";
const LEGACY_DEFAULT_ENVIRONMENT_REWARD = "No explicit reward returned.";
export const DEFAULT_ENVIRONMENT_REWARD = "0";

export const PRIMARY_ACTION_PROTOCOL_INSTRUCTION =
  `Return the source agent's next concrete action or message to the connected target agent. Plain text is treated as the action. If returning JSON, use ${PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME} for the action and a numeric scalar "reward" for the reward delivered to the target agent's ${PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME}.`;
const LEGACY_PRIMARY_ACTION_PROTOCOL_INSTRUCTION =
  "Return only the primary agent's next concrete action or message to the environment.";
const OUTDATED_PRIMARY_ACTION_PROTOCOL_INSTRUCTION =
  `Return the source agent's next concrete action or message to the connected target agent. Plain text is treated as the action. If returning JSON, use ${PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME} for the action and "reward" for the reward delivered to the target agent's ${PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME}.`;

export const LIVE_SESSION_ACTION_PROTOCOL_INSTRUCTION =
  "Return only the primary agent's next concrete text action or reply.";

export const DEFAULT_ENVIRONMENT_REPLY_OBSERVATION_KEY =
  PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME;
export const DEFAULT_ENVIRONMENT_REPLY_REWARD_KEY = "reward";
export const DEFAULT_ENVIRONMENT_REPLY_NOTES_KEY = "environment_notes";
export const DEFAULT_SIMULATION_ENVIRONMENT_PLAYER_ID = "first";
export const DEFAULT_SIMULATION_OPENING_SPEAKER = "environment";
export const DEFAULT_SIMULATION_TURN_COUNT = "4";
export const SIMULATION_TURN_COUNT_MIN = 1;
export const SIMULATION_TURN_COUNT_MAX = 8;

export type SimulationOpeningSpeaker = "environment" | "primary";

export const ENVIRONMENT_REPLY_PROTOCOL_INSTRUCTION = [
  "Respond as the environment.",
  "Return only JSON matching the Environment reply output schema in the Run Contract.",
  "The observation field should be what the primary agent perceives next.",
  `The reward field must be a numeric scalar delivered to the source agent's ${PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME}; it is not the target agent's own ${PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME}.`,
  "The notes field can briefly explain the environment's reasoning.",
].join("\n");
const OUTDATED_ENVIRONMENT_REPLY_PROTOCOL_INSTRUCTION = [
  "Respond as the environment.",
  "Return only JSON matching the Environment reply output schema in the Run Contract.",
  "The observation field should be what the primary agent perceives next.",
  `The reward field is delivered to the source agent's ${PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME}; it is not the target agent's own ${PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME}.`,
  "The notes field can briefly explain the environment's reasoning.",
].join("\n");

function isLegacyEnvironmentReplyInstruction(value: string): boolean {
  return (
    value.includes("Return only JSON in this exact shape") &&
    value.includes('"observation"') &&
    value.includes('"reward"') &&
    value.includes('"notes"')
  );
}

function isOutdatedEnvironmentReplyInstruction(value: string): boolean {
  return (
    value.includes("Return only JSON matching the Environment reply output schema") &&
    value.includes(
      "The reward field should describe the reward or evaluation signal from the environment."
    )
  );
}

function normalizeDefaultProtocolFieldValue(
  key: keyof InteractionProtocolConfig,
  value: string,
  defaults: InteractionProtocolConfig
): string {
  if (
    key === "primaryActionInstruction" &&
    (value.trim() === LEGACY_PRIMARY_ACTION_PROTOCOL_INSTRUCTION ||
      value.trim() === OUTDATED_PRIMARY_ACTION_PROTOCOL_INSTRUCTION)
  ) {
    return defaults[key];
  }

  if (
    key === "environmentReplyInstruction" &&
    (value.trim() === OUTDATED_ENVIRONMENT_REPLY_PROTOCOL_INSTRUCTION ||
      isLegacyEnvironmentReplyInstruction(value) ||
      isOutdatedEnvironmentReplyInstruction(value))
  ) {
    return defaults[key];
  }

  if (
    key === "environmentReplyRewardKey" &&
    value.trim() === PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME
  ) {
    return defaults[key];
  }

  if (
    key === "defaultEnvironmentReward" &&
    value.trim() === LEGACY_DEFAULT_ENVIRONMENT_REWARD
  ) {
    return defaults[key];
  }

  return value;
}

export const SIMULATION_STATE_WIRING_DESCRIPTION = [
  `After each source-agent turn, the runtime copies that agent's ${PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME} into the connected target agent's ${PRIMARY_AGENT_LATEST_OBSERVATION_FIELD_NAME} and delivers the numeric scalar source output reward into the target agent's ${PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME}.`,
  `After each target-agent turn, it copies that agent's ${PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME} into the source agent's ${PRIMARY_AGENT_LATEST_OBSERVATION_FIELD_NAME} and delivers the numeric scalar target output reward into the source agent's ${PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME}.`,
  `Each participant has its own ${PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME}; the two reward fields are not mirrored to each other.`,
].join("\n");

export const LIVE_SESSION_STATE_WIRING_DESCRIPTION = [
  `Your message is written into the primary agent's ${PRIMARY_AGENT_LATEST_OBSERVATION_FIELD_NAME}.`,
  `The reply shown in the chat is read from ${PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME} when the policy canvas sets it.`,
].join("\n");

/**
 * The editable half of the interaction protocol. Stored on the draft
 * (`project.interactionProtocol`) so the panel shows exactly the strings the
 * simulate and live-session routes will inject. Missing fields are materialized
 * at create/load boundaries; blank fields remain blank and make runs invalid.
 */
export interface InteractionProtocolConfig {
  /** Appended to the primary agent's policy prompts during simulations. */
  primaryActionInstruction: string;
  /** Appended to the environment agent's policy prompts during simulations. */
  environmentReplyInstruction: string;
  /** JSON key for the environment output that becomes the primary observation. */
  environmentReplyObservationKey: string;
  /** JSON key for the environment output that becomes the primary reward. */
  environmentReplyRewardKey: string;
  /** JSON key for environment-side notes shown in simulation transcripts. */
  environmentReplyNotesKey: string;
  /** Appended to the primary agent's policy prompts during live sessions. */
  liveSessionActionInstruction: string;
  /** Transcript fallback when no observation is produced. */
  defaultEnvironmentObservation: string;
  /** Transcript fallback when no reward is produced. */
  defaultEnvironmentReward: string;
  /** Environment agent id selected for simulation, or "first". */
  simulationEnvironmentPlayerId: string;
  /** Project graph connection selected for simulation. Blank means infer/fallback. */
  simulationConnectionId: string;
  /** Project graph target agent selected for simulation. Blank means infer/fallback. */
  simulationTargetAgentId: string;
  /** Which side speaks first when a simulation starts. */
  simulationOpeningSpeaker: string;
  /** Number of primary/environment turn pairs to run. Stored as text for editing. */
  simulationTurnCount: string;
}

export const DEFAULT_INTERACTION_PROTOCOL: InteractionProtocolConfig = {
  primaryActionInstruction: PRIMARY_ACTION_PROTOCOL_INSTRUCTION,
  environmentReplyInstruction: ENVIRONMENT_REPLY_PROTOCOL_INSTRUCTION,
  environmentReplyObservationKey: DEFAULT_ENVIRONMENT_REPLY_OBSERVATION_KEY,
  environmentReplyRewardKey: DEFAULT_ENVIRONMENT_REPLY_REWARD_KEY,
  environmentReplyNotesKey: DEFAULT_ENVIRONMENT_REPLY_NOTES_KEY,
  liveSessionActionInstruction: LIVE_SESSION_ACTION_PROTOCOL_INSTRUCTION,
  defaultEnvironmentObservation: DEFAULT_ENVIRONMENT_OBSERVATION,
  defaultEnvironmentReward: DEFAULT_ENVIRONMENT_REWARD,
  simulationEnvironmentPlayerId: DEFAULT_SIMULATION_ENVIRONMENT_PLAYER_ID,
  simulationConnectionId: "",
  simulationTargetAgentId: "",
  simulationOpeningSpeaker: DEFAULT_SIMULATION_OPENING_SPEAKER,
  simulationTurnCount: DEFAULT_SIMULATION_TURN_COUNT,
};

export function deriveEnvironmentReplyProtocolDefaults(
  environmentFields?: OrchestrationField[] | null
): Pick<
  InteractionProtocolConfig,
  | "environmentReplyObservationKey"
  | "environmentReplyRewardKey"
  | "environmentReplyNotesKey"
> {
  const findFieldName = (canonicalName: string, fallback: string) =>
    environmentFields
      ? findOrchestrationFieldByCanonicalName(environmentFields, canonicalName)
          ?.name || fallback
      : fallback;

  return {
    environmentReplyObservationKey: findFieldName(
      PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME,
      DEFAULT_ENVIRONMENT_REPLY_OBSERVATION_KEY
    ),
    environmentReplyRewardKey: findFieldName(
      DEFAULT_ENVIRONMENT_REPLY_REWARD_KEY,
      DEFAULT_ENVIRONMENT_REPLY_REWARD_KEY
    ),
    environmentReplyNotesKey:
      environmentFields?.find(
        (field) =>
          field.name.trim().toLowerCase() ===
          DEFAULT_ENVIRONMENT_REPLY_NOTES_KEY
      )?.name || DEFAULT_ENVIRONMENT_REPLY_NOTES_KEY,
  };
}

export function createInteractionProtocolDefaults(args?: {
  environmentFields?: OrchestrationField[] | null;
}): InteractionProtocolConfig {
  return {
    ...DEFAULT_INTERACTION_PROTOCOL,
    ...deriveEnvironmentReplyProtocolDefaults(args?.environmentFields),
  };
}

export const INTERACTION_PROTOCOL_KEYS = Object.keys(
  DEFAULT_INTERACTION_PROTOCOL
) as Array<keyof InteractionProtocolConfig>;

// Snake-case aliases let the resolver read rows persisted by
// serializeInteractionProtocol as well as in-memory camelCase projects.
const STORED_PROTOCOL_KEY_ALIASES: Record<keyof InteractionProtocolConfig, string> = {
  primaryActionInstruction: "primary_action_instruction",
  environmentReplyInstruction: "environment_reply_instruction",
  environmentReplyObservationKey: "environment_reply_observation_key",
  environmentReplyRewardKey: "environment_reply_reward_key",
  environmentReplyNotesKey: "environment_reply_notes_key",
  liveSessionActionInstruction: "live_session_action_instruction",
  defaultEnvironmentObservation: "default_environment_observation",
  defaultEnvironmentReward: "default_environment_reward",
  simulationEnvironmentPlayerId: "simulation_environment_player_id",
  simulationConnectionId: "simulation_connection_id",
  simulationTargetAgentId: "simulation_target_agent_id",
  simulationOpeningSpeaker: "simulation_opening_speaker",
  simulationTurnCount: "simulation_turn_count",
};

function readProtocolField(
  record: Record<string, unknown>,
  key: keyof InteractionProtocolConfig
): string | undefined {
  const candidate = record[key] ?? record[STORED_PROTOCOL_KEY_ALIASES[key]];
  return typeof candidate === "string" ? candidate : undefined;
}

function readProtocolRecord(raw: unknown): Record<string, unknown> {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      value = null;
    }
  }

  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Materializes the Run Contract onto a draft while preserving intentionally
 * blank strings. Missing fields are filled from defaults only at create/load
 * boundaries so the defaults become visible draft data before a run starts.
 */
export function resolveInteractionProtocol(
  raw: unknown,
  args?: {
    environmentFields?: OrchestrationField[] | null;
  }
): InteractionProtocolConfig {
  const record = readProtocolRecord(raw);
  const defaults = createInteractionProtocolDefaults(args);

  return INTERACTION_PROTOCOL_KEYS.reduce((acc, key) => {
    const value = readProtocolField(record, key);
    acc[key] =
      typeof value === "string"
        ? normalizeDefaultProtocolFieldValue(key, value, defaults)
        : defaults[key];
    return acc;
  }, {} as InteractionProtocolConfig);
}

export function parseExplicitInteractionProtocol(raw: unknown): {
  protocol: InteractionProtocolConfig | null;
  issues: string[];
} {
  const record = readProtocolRecord(raw);
  const issues: string[] = [];
  const protocol = resolveInteractionProtocol(raw);

  for (const descriptor of INTERACTION_PROTOCOL_FIELD_DESCRIPTORS) {
    const rawValue = readProtocolField(record, descriptor.key);
    if (rawValue === undefined) {
      issues.push(`${descriptor.title} is missing.`);
      continue;
    }

    const value = rawValue.trim();
    if (!value) {
      issues.push(`${descriptor.title} is blank.`);
      continue;
    }

    protocol[descriptor.key] = normalizeDefaultProtocolFieldValue(
      descriptor.key,
      value,
      protocol
    );
  }

  const outputKeys = [
    protocol.environmentReplyObservationKey,
    protocol.environmentReplyRewardKey,
    protocol.environmentReplyNotesKey,
  ].filter(Boolean);
  const uniqueOutputKeys = new Set(outputKeys.map((key) => key.trim()));
  if (outputKeys.length === 3 && uniqueOutputKeys.size !== outputKeys.length) {
    issues.push("Environment reply output keys must be unique.");
  }

  return {
    protocol: issues.length === 0 ? protocol : null,
    issues,
  };
}

export function getInteractionProtocolIssues(raw: unknown): string[] {
  return parseExplicitInteractionProtocol(raw).issues;
}

export interface ParsedSimulationSettings {
  environmentPlayerId: string;
  environmentIndex: number;
  connectionId: string;
  targetAgentId: string;
  openingSpeaker: SimulationOpeningSpeaker;
  turnCount: number;
}

export function parseExplicitSimulationSettings(
  raw: unknown,
  environmentPlayers: Array<{ id: string }>,
  graphTargets: Array<{ connectionId: string; targetAgentId: string }> = []
): {
  settings: ParsedSimulationSettings | null;
  issues: string[];
} {
  const record = readProtocolRecord(raw);
  const issues: string[] = [];
  const environmentPlayerIdRaw = readProtocolField(
    record,
    "simulationEnvironmentPlayerId"
  );
  const connectionIdRaw = readProtocolField(record, "simulationConnectionId");
  const targetAgentIdRaw = readProtocolField(record, "simulationTargetAgentId");
  const openingSpeakerRaw = readProtocolField(
    record,
    "simulationOpeningSpeaker"
  );
  const turnCountRaw = readProtocolField(record, "simulationTurnCount");

  let environmentIndex = -1;
  let environmentPlayerId = "";
  let connectionId = "";
  let targetAgentId = "";
  const selectedConnection = connectionIdRaw?.trim() ?? "";
  const selectedTargetAgent = targetAgentIdRaw?.trim() ?? "";
  const selectedEnvironment = environmentPlayerIdRaw?.trim();
  if (selectedConnection) {
    const target = graphTargets.find(
      (candidate) => candidate.connectionId === selectedConnection
    );
    if (!target) {
      issues.push("Selected agent connection no longer exists.");
    } else {
      connectionId = target.connectionId;
      targetAgentId = target.targetAgentId;
      environmentPlayerId = targetAgentId;
      environmentIndex = environmentPlayers.findIndex(
        (player) => player.id === targetAgentId
      );
    }
  } else if (selectedTargetAgent) {
    const target = graphTargets.find(
      (candidate) => candidate.targetAgentId === selectedTargetAgent
    );
    if (!target) {
      issues.push("Selected target agent no longer exists.");
    } else {
      connectionId = target.connectionId;
      targetAgentId = target.targetAgentId;
      environmentPlayerId = targetAgentId;
      environmentIndex = environmentPlayers.findIndex(
        (player) => player.id === targetAgentId
      );
    }
  } else if (
    selectedEnvironment === DEFAULT_SIMULATION_ENVIRONMENT_PLAYER_ID &&
    environmentPlayers.length === 0 &&
    graphTargets.length === 1
  ) {
    connectionId = graphTargets[0].connectionId;
    targetAgentId = graphTargets[0].targetAgentId;
    environmentPlayerId = targetAgentId;
    environmentIndex = -1;
  } else if (selectedEnvironment === undefined) {
    issues.push("Selected target agent is missing.");
  } else if (!selectedEnvironment) {
    issues.push("Selected target agent is blank.");
  } else if (selectedEnvironment !== DEFAULT_SIMULATION_ENVIRONMENT_PLAYER_ID) {
    const target = graphTargets.find(
      (candidate) => candidate.targetAgentId === selectedEnvironment
    );
    if (target) {
      connectionId = target.connectionId;
      targetAgentId = target.targetAgentId;
      environmentPlayerId = targetAgentId;
      environmentIndex = environmentPlayers.findIndex(
        (player) => player.id === targetAgentId
      );
    } else if (environmentPlayers.length === 0) {
      issues.push("Selected target agent no longer exists.");
    } else {
      environmentIndex = environmentPlayers.findIndex(
        (player) => player.id === selectedEnvironment
      );
      environmentPlayerId = selectedEnvironment;
      targetAgentId = selectedEnvironment;
      if (environmentIndex < 0) {
        issues.push("Selected target agent no longer exists.");
      }
    }
  } else if (environmentPlayers.length === 0) {
    if (graphTargets.length > 1) {
      issues.push("Select a target agent or connection for simulation.");
    } else {
      issues.push("Simulation requires at least one connected target agent.");
    }
  } else if (
    selectedEnvironment === DEFAULT_SIMULATION_ENVIRONMENT_PLAYER_ID
  ) {
    environmentIndex = 0;
    environmentPlayerId = environmentPlayers[0]?.id ?? "";
    const target = graphTargets.find(
      (candidate) => candidate.targetAgentId === environmentPlayerId
    );
    connectionId = target?.connectionId ?? "";
    targetAgentId = target?.targetAgentId ?? environmentPlayerId;
  } else {
    environmentIndex = environmentPlayers.findIndex(
      (player) => player.id === selectedEnvironment
    );
    environmentPlayerId = selectedEnvironment;
    const target = graphTargets.find(
      (candidate) => candidate.targetAgentId === selectedEnvironment
    );
    connectionId = target?.connectionId ?? "";
    targetAgentId = target?.targetAgentId ?? selectedEnvironment;
    if (environmentIndex < 0) {
      issues.push("Selected target agent no longer exists.");
    }
  }

  const openingSpeaker = openingSpeakerRaw?.trim();
  if (openingSpeaker === undefined) {
    issues.push("Opening speaker is missing.");
  } else if (!openingSpeaker) {
    issues.push("Opening speaker is blank.");
  } else if (openingSpeaker !== "environment" && openingSpeaker !== "primary") {
    issues.push("Opening speaker must be environment or primary.");
  }

  const turnCountText = turnCountRaw?.trim();
  const turnCount = turnCountText ? Number(turnCountText) : Number.NaN;
  if (turnCountRaw === undefined) {
    issues.push("Turn count is missing.");
  } else if (!turnCountText) {
    issues.push("Turn count is blank.");
  } else if (
    !Number.isInteger(turnCount) ||
    turnCount < SIMULATION_TURN_COUNT_MIN ||
    turnCount > SIMULATION_TURN_COUNT_MAX
  ) {
    issues.push(
      `Turn count must be a whole number from ${SIMULATION_TURN_COUNT_MIN} to ${SIMULATION_TURN_COUNT_MAX}.`
    );
  }

  const fallbackObservation = readProtocolField(
    record,
    "defaultEnvironmentObservation"
  );
  if (fallbackObservation === undefined) {
    issues.push("Fallback observation is missing.");
  } else if (!fallbackObservation.trim()) {
    issues.push("Fallback observation is blank.");
  }

  const fallbackReward = readProtocolField(record, "defaultEnvironmentReward");
  if (fallbackReward === undefined) {
    issues.push("Fallback reward is missing.");
  } else if (!fallbackReward.trim()) {
    issues.push("Fallback reward is blank.");
  }

  const validOpeningSpeaker =
    openingSpeaker === "environment" || openingSpeaker === "primary"
      ? openingSpeaker
      : null;

  return {
    settings:
      issues.length === 0 && validOpeningSpeaker
        ? {
            environmentPlayerId,
            environmentIndex,
            connectionId,
            targetAgentId,
            openingSpeaker: validOpeningSpeaker,
            turnCount,
          }
        : null,
    issues,
  };
}

export function getSimulationSettingsIssues(
  raw: unknown,
  environmentPlayers: Array<{ id: string }>,
  graphTargets: Array<{ connectionId: string; targetAgentId: string }> = []
): string[] {
  return parseExplicitSimulationSettings(raw, environmentPlayers, graphTargets)
    .issues;
}

export function serializeInteractionProtocol(
  raw: unknown,
  args?: {
    environmentFields?: OrchestrationField[] | null;
  }
) {
  const protocol = resolveInteractionProtocol(raw, args);
  return {
    primary_action_instruction: protocol.primaryActionInstruction,
    environment_reply_instruction: protocol.environmentReplyInstruction,
    environment_reply_observation_key: protocol.environmentReplyObservationKey,
    environment_reply_reward_key: protocol.environmentReplyRewardKey,
    environment_reply_notes_key: protocol.environmentReplyNotesKey,
    live_session_action_instruction: protocol.liveSessionActionInstruction,
    default_environment_observation: protocol.defaultEnvironmentObservation,
    default_environment_reward: protocol.defaultEnvironmentReward,
    simulation_environment_player_id: protocol.simulationEnvironmentPlayerId,
    simulation_connection_id: protocol.simulationConnectionId,
    simulation_target_agent_id: protocol.simulationTargetAgentId,
    simulation_opening_speaker: protocol.simulationOpeningSpeaker,
    simulation_turn_count: protocol.simulationTurnCount,
  };
}

export function buildEnvironmentReplyJsonShape(
  protocol: Pick<
    InteractionProtocolConfig,
    | "environmentReplyObservationKey"
    | "environmentReplyRewardKey"
    | "environmentReplyNotesKey"
  >
): string {
  return JSON.stringify({
    [protocol.environmentReplyObservationKey]: "string",
    [protocol.environmentReplyRewardKey]: "number",
    [protocol.environmentReplyNotesKey]: "string",
  });
}

export function buildEnvironmentReplySchemaInstruction(
  protocol: Pick<
    InteractionProtocolConfig,
    | "environmentReplyObservationKey"
    | "environmentReplyRewardKey"
    | "environmentReplyNotesKey"
  >
): string {
  return [
    "Environment reply output schema:",
    buildEnvironmentReplyJsonShape(protocol),
    "",
    `${protocol.environmentReplyObservationKey}: what the primary agent perceives next.`,
    `${protocol.environmentReplyRewardKey}: numeric scalar reward delivered to the source agent.`,
    `${protocol.environmentReplyNotesKey}: optional environment-side reasoning notes for the transcript.`,
  ].join("\n");
}

export interface InteractionProtocolEntry {
  title: string;
  description: string;
  text: string;
}

/**
 * Descriptors for the editable protocol fields, shared by the panel editor and
 * the run-modal disclosure so both always describe the same strings.
 */
export const INTERACTION_PROTOCOL_FIELD_DESCRIPTORS: Array<{
  key: keyof InteractionProtocolConfig;
  title: string;
  description: string;
}> = [
  {
    key: "primaryActionInstruction",
    title: "Primary policy instruction (simulation)",
    description: `Appended to the primary agent's policy prompts. The reply text becomes the action only when the policy canvas does not set ${PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME} itself; JSON output may also include a reward delivered to the target agent.`,
  },
  {
    key: "environmentReplyInstruction",
    title: "Environment policy instruction (simulation)",
    description: `Appended to the target agent's policy prompts. The JSON reply is parsed with the Environment reply output keys below, unless the policy canvas sets its own ${PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME} directly.`,
  },
  {
    key: "environmentReplyObservationKey",
    title: "Environment output key: observation",
    description: `JSON key for what the source agent perceives next. Defaults to the target agent's visible ${PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME} state field.`,
  },
  {
    key: "environmentReplyRewardKey",
    title: "Environment output key: reward",
    description: `JSON key for the reward passed back to the source agent. This is delivered into the source agent's ${PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME}, not mirrored from the target agent's own ${PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME}.`,
  },
  {
    key: "environmentReplyNotesKey",
    title: "Environment output key: notes",
    description:
      "JSON key for optional environment-side reasoning notes shown in simulation transcripts.",
  },
  {
    key: "liveSessionActionInstruction",
    title: "Primary policy instruction (live session)",
    description: `Appended to the primary agent's policy prompts in live sessions. The reply text is used only when the policy canvas does not set ${PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME} itself.`,
  },
];

export function buildSimulationInteractionProtocolEntries(
  protocol: InteractionProtocolConfig
): InteractionProtocolEntry[] {
  return [
    {
      title: "Simulation settings",
      description:
        "Draft-owned settings consumed by the simulation route before the canvases run.",
      text: [
        `Legacy target fallback: ${protocol.simulationEnvironmentPlayerId}`,
        `Selected connection: ${protocol.simulationConnectionId || "(infer)"}`,
        `Selected target agent: ${protocol.simulationTargetAgentId || "(infer)"}`,
        `Opening speaker: ${protocol.simulationOpeningSpeaker}`,
        `Turn count: ${protocol.simulationTurnCount}`,
      ].join("\n"),
    },
    {
      title: "State wiring",
      description:
        "Applied deterministically by the simulation runtime every turn, outside the canvases.",
      text: SIMULATION_STATE_WIRING_DESCRIPTION,
    },
    {
      title: "Primary policy instruction",
      description: `Appended to the primary agent's policy prompts. The reply text becomes the action only when the policy canvas does not set ${PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME} itself.`,
      text: protocol.primaryActionInstruction,
    },
    {
      title: "Environment policy instruction",
      description: `Appended to the environment agent's policy prompts. The JSON reply is parsed with the visible Environment reply output schema below.`,
      text: protocol.environmentReplyInstruction,
    },
    {
      title: "Environment reply output schema",
      description:
        "Visible JSON shape used by simulation prompts and parser when the environment canvas returns a reply object.",
      text: buildEnvironmentReplySchemaInstruction(protocol),
    },
    {
      title: "Fallback transcript values",
      description:
        "Shown in the transcript (marked as fallback) when neither the canvases nor the reply produced an observation or reward. Never written into agent state.",
      text: [
        protocol.defaultEnvironmentObservation,
        protocol.defaultEnvironmentReward,
      ].join("\n"),
    },
  ];
}

export function buildLiveSessionInteractionProtocolEntries(
  protocol: InteractionProtocolConfig
): InteractionProtocolEntry[] {
  return [
    {
      title: "State wiring",
      description:
        "Applied deterministically by the live-session runtime every turn, outside the canvases.",
      text: LIVE_SESSION_STATE_WIRING_DESCRIPTION,
    },
    {
      title: "Primary policy instruction",
      description: `Appended to the primary agent's policy prompts. The reply text is used only when the policy canvas does not set ${PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME} itself.`,
      text: protocol.liveSessionActionInstruction,
    },
  ];
}
