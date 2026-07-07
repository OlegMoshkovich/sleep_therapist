import {
  createEmptyOrchestrationEnvironmentPlayer,
  createEmptyOrchestrationProject,
  ensureRequiredEnvironmentAgentStateFields,
  ensureRequiredPrimaryAgentStateFields,
  makeOrchestrationId,
  mergeSuggestedFields,
  normalizeLatestInteractionStateFields,
  PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME,
  PRIMARY_AGENT_LATEST_OBSERVATION_FIELD_NAME,
  PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME,
  syncDerivedPrompts,
  WORKFLOW_OVERVIEW_CANVAS_MARKER,
  type OrchestrationField,
  type OrchestrationProject,
} from "./general-orchestration";
import type {
  CanvasDoc,
  CanvasEdgeRecord,
  CanvasEntry,
  CanvasNodeRecord,
} from "@airlab/canvas-compiler/types";
import { getNodeActionSubtype } from "@airlab/canvas-core/components/canvas/action-subtype";
import { normalizePromptOutputFields } from "@airlab/canvas-core/components/canvas/prompt-output-fields";
import {
  hydrateStoredOrchestrationProject,
  serializeCanvasRows,
  serializeOrchestrationProject,
  type StoredOrchestrationCanvasRow,
} from "./orchestration-project-storage";
import {
  DEFAULT_CONVERSATION_MEMORY_LIMIT,
  NEW_EVENTS_FIELD_NAME,
} from "@airlab/canvas-core/lib/conversation-memory";
import { LATEST_SIMULATION_TRANSCRIPT_PROMPT_VALUE_NAME } from "@airlab/canvas-core/lib/canvas-flow-values";
import { createCanvasRuleRegistryDataset } from "@airlab/canvas-core/lib/canvas-rule-registry";
import {
  APPEND_ASSISTANT_TURN_CODE_LABEL,
  APPEND_ASSISTANT_TURN_CODE_TEMPLATE_ID,
  buildAppendAssistantTurnCodeNodeData,
} from "@airlab/canvas-core/lib/canvas-append-assistant-turn-code";
import { NODE_EXECUTABLE_CODE_OPS_DATA_KEY } from "@airlab/canvas-core/lib/canvas-node-code-ops";
import { NODE_LOCAL_INPUTS_DATA_KEY } from "@airlab/canvas-core/lib/canvas-node-local-fields";
import {
  buildExplicitLocalValueConditionLabel,
  canonicalizeExplicitLocalValueConditionLabel,
} from "@airlab/canvas-core/lib/canvas-condition-labels";

export const GENERAL_ORCHESTRATION_DAEMON_SETUP_TABLE =
  "general_orchestration_daemon_inputs";
export const GENERAL_ORCHESTRATION_DAEMON_ENDPOINT =
  "/demo/general-orchestration-daemon/input";

export interface GeneralOrchestrationDaemonConfigRow {
  id?: string;
  config_name?: string | null;
  state_schema?: Array<{
    field_name?: string;
    type?: OrchestrationField["type"];
    initial_value?: string | null;
  }> | null;
  state_update_prompt?: string | null;
  policy_prompt?: string | null;
  guideline_blocks?: unknown;
  datasets?: unknown;
  environment_players?: unknown;
  uploaded_files?: unknown;
  typical_user_patterns?: string | null;
  edge_cases_to_cover?: string | null;
}

export interface GeneralOrchestrationDaemonCanvasRow {
  canvas_id?: string;
  name?: string;
  sort_order?: number | null;
  canvas?: unknown;
}

const DAEMON_MAIN_CANVAS_NAME = "Daemon orchestration policy";
const DAEMON_RUNTIME_WORKFLOW_CANVAS_NAME = "Primary / Environment Workflow";
const DAEMON_PROCESS_CANVAS_NAME = "Understand target workflow";
const DAEMON_WORKFLOW_REVIEW_CANVAS_NAME = "Approve workflow shape";
const DAEMON_AGENT_BOUNDARY_CANVAS_NAME = "Choose agent boundaries";
const DAEMON_BUILD_RUNNABLE_DRAFT_CANVAS_NAME = "Build runnable draft";
const DAEMON_REVIEW_ITERATE_CANVAS_NAME = "Review and iterate";
const DAEMON_STATE_MAIN_CANVAS_NAME = "Daemon workflow state router";
const DAEMON_UNDERSTAND_STATE_CANVAS_NAME = "Understand target workflow state";
const DAEMON_WORKFLOW_SHAPE_STATE_CANVAS_NAME = "Approve workflow shape state";
const DAEMON_BOUNDARY_STATE_CANVAS_NAME = "Choose agent boundaries state";
const DAEMON_BUILD_STATE_CANVAS_NAME = "Build runnable draft state";
const DAEMON_STAGE_FINISHED_MESSAGE_FIELD_NAME = "daemon_stage_finished_message";
const DAEMON_REVIEW_STATE_CANVAS_NAME = "Review and iterate state";
const DAEMON_SEED_CANVAS_NAME = "Seed first structured draft";
const DAEMON_TRIAGE_CANVAS_NAME = "Focused triage";
const DAEMON_TOOLING_CANVAS_NAME = "Scaffold missing tools";
const DAEMON_SKILL_CREATION_CANVAS_NAME = "Create requested skills";
const DAEMON_ENVIRONMENT_AGENT_CREATION_CANVAS_NAME =
  "Create requested agent connections";
const DAEMON_EDITING_CANVAS_NAME = "Refine existing draft";
const LEGACY_DAEMON_LATEST_INPUT_EVENT_FIELD_NAME = [
  "latest",
  "turn",
  "event",
].join("_");
const LEGACY_DAEMON_MODE_ROUTING_ISSUE_CANVAS_NAME =
  "Report legacy mode routing issue";
const DAEMON_APPLY_PATCH_CANVAS_NAME = "Apply structured patch workflow";
const DAEMON_REPAIR_CANVAS_RULES_CANVAS_NAME =
  "Repair canvas rules pass";
const DAEMON_ENVIRONMENT_AGENT_POLICY_CANVAS_NAME =
  "Daemon environment user policy";
const DAEMON_ENVIRONMENT_UNDERSTAND_POLICY_CANVAS_NAME =
  "Environment - Understand target workflow";
const DAEMON_ENVIRONMENT_APPROVE_WORKFLOW_POLICY_CANVAS_NAME =
  "Environment - Approve workflow shape";
const DAEMON_ENVIRONMENT_BOUNDARY_POLICY_CANVAS_NAME =
  "Environment - Choose agent boundaries";
const DAEMON_ENVIRONMENT_BUILD_POLICY_CANVAS_NAME =
  "Environment - Build runnable draft";
const DAEMON_ENVIRONMENT_REVIEW_POLICY_CANVAS_NAME =
  "Environment - Review and iterate";
const DAEMON_ENVIRONMENT_STATE_MAIN_CANVAS_NAME =
  "Environment workflow state router";
const DAEMON_ENVIRONMENT_UNDERSTAND_STATE_CANVAS_NAME =
  "Environment - Understand target workflow state";
const DAEMON_ENVIRONMENT_APPROVE_WORKFLOW_STATE_CANVAS_NAME =
  "Environment - Approve workflow shape state";
const DAEMON_ENVIRONMENT_BOUNDARY_STATE_CANVAS_NAME =
  "Environment - Choose agent boundaries state";
const DAEMON_ENVIRONMENT_BUILD_STATE_CANVAS_NAME =
  "Environment - Build runnable draft state";
const DAEMON_ENVIRONMENT_REVIEW_STATE_CANVAS_NAME =
  "Environment - Review and iterate state";
export const DAEMON_WORKFLOW_STAGE_FIELD_NAME = "daemon_workflow_stage";
export const DAEMON_WORKFLOW_STAGE_UNDERSTAND = "understand_target_workflow";
export const DAEMON_WORKFLOW_STAGE_APPROVE = "approve_workflow_shape";
export const DAEMON_WORKFLOW_STAGE_BOUNDARIES = "choose_agent_boundaries";
export const DAEMON_WORKFLOW_STAGE_BUILD = "build_runnable_draft";
export const DAEMON_WORKFLOW_STAGE_REVIEW = "review_and_iterate";
export type DaemonWorkflowStageId =
  | typeof DAEMON_WORKFLOW_STAGE_UNDERSTAND
  | typeof DAEMON_WORKFLOW_STAGE_APPROVE
  | typeof DAEMON_WORKFLOW_STAGE_BOUNDARIES
  | typeof DAEMON_WORKFLOW_STAGE_BUILD
  | typeof DAEMON_WORKFLOW_STAGE_REVIEW;

export interface DaemonWorkflowStageDefinition {
  id: DaemonWorkflowStageId;
  label: string;
  primaryPolicyCanvasName: string;
  primaryStateCanvasName: string;
  environmentPolicyCanvasName: string;
  environmentStateCanvasName: string;
}

export const DAEMON_WORKFLOW_STAGE_DEFINITIONS: DaemonWorkflowStageDefinition[] = [
  {
    id: DAEMON_WORKFLOW_STAGE_UNDERSTAND,
    label: "Understand Target Workflow",
    primaryPolicyCanvasName: DAEMON_PROCESS_CANVAS_NAME,
    primaryStateCanvasName: DAEMON_UNDERSTAND_STATE_CANVAS_NAME,
    environmentPolicyCanvasName: DAEMON_ENVIRONMENT_UNDERSTAND_POLICY_CANVAS_NAME,
    environmentStateCanvasName: DAEMON_ENVIRONMENT_UNDERSTAND_STATE_CANVAS_NAME,
  },
  {
    id: DAEMON_WORKFLOW_STAGE_APPROVE,
    label: "Approve Workflow Shape",
    primaryPolicyCanvasName: DAEMON_WORKFLOW_REVIEW_CANVAS_NAME,
    primaryStateCanvasName: DAEMON_WORKFLOW_SHAPE_STATE_CANVAS_NAME,
    environmentPolicyCanvasName:
      DAEMON_ENVIRONMENT_APPROVE_WORKFLOW_POLICY_CANVAS_NAME,
    environmentStateCanvasName:
      DAEMON_ENVIRONMENT_APPROVE_WORKFLOW_STATE_CANVAS_NAME,
  },
  {
    id: DAEMON_WORKFLOW_STAGE_BOUNDARIES,
    label: "Choose Agent Boundaries",
    primaryPolicyCanvasName: DAEMON_AGENT_BOUNDARY_CANVAS_NAME,
    primaryStateCanvasName: DAEMON_BOUNDARY_STATE_CANVAS_NAME,
    environmentPolicyCanvasName: DAEMON_ENVIRONMENT_BOUNDARY_POLICY_CANVAS_NAME,
    environmentStateCanvasName: DAEMON_ENVIRONMENT_BOUNDARY_STATE_CANVAS_NAME,
  },
  {
    id: DAEMON_WORKFLOW_STAGE_BUILD,
    label: "Build Runnable Draft",
    primaryPolicyCanvasName: DAEMON_BUILD_RUNNABLE_DRAFT_CANVAS_NAME,
    primaryStateCanvasName: DAEMON_BUILD_STATE_CANVAS_NAME,
    environmentPolicyCanvasName: DAEMON_ENVIRONMENT_BUILD_POLICY_CANVAS_NAME,
    environmentStateCanvasName: DAEMON_ENVIRONMENT_BUILD_STATE_CANVAS_NAME,
  },
  {
    id: DAEMON_WORKFLOW_STAGE_REVIEW,
    label: "Review And Iterate",
    primaryPolicyCanvasName: DAEMON_REVIEW_ITERATE_CANVAS_NAME,
    primaryStateCanvasName: DAEMON_REVIEW_STATE_CANVAS_NAME,
    environmentPolicyCanvasName: DAEMON_ENVIRONMENT_REVIEW_POLICY_CANVAS_NAME,
    environmentStateCanvasName: DAEMON_ENVIRONMENT_REVIEW_STATE_CANVAS_NAME,
  },
];

const DAEMON_WORKFLOW_STAGE_ORDER = new Map<DaemonWorkflowStageId, number>(
  DAEMON_WORKFLOW_STAGE_DEFINITIONS.map((stage, index) => [stage.id, index])
);

export function isDaemonWorkflowStageId(
  value: unknown
): value is DaemonWorkflowStageId {
  return (
    value === DAEMON_WORKFLOW_STAGE_UNDERSTAND ||
    value === DAEMON_WORKFLOW_STAGE_APPROVE ||
    value === DAEMON_WORKFLOW_STAGE_BOUNDARIES ||
    value === DAEMON_WORKFLOW_STAGE_BUILD ||
    value === DAEMON_WORKFLOW_STAGE_REVIEW
  );
}
export const DAEMON_RUN_TARGET_SIMULATION_TOOL_NAME =
  "run_target_simulation";
const DAEMON_APPLY_PATCH_LABEL =
  "Apply the structured planner patch to the target draft, which is where the workflow and selected agent boundaries are actually created or updated on the right. This step applies setup metadata, state fields, datasets, skills, explicit agentConnections, and any seeded canvases, reseeding canvases only when the patch explicitly asks to replace them.";
const DAEMON_BUILD_INITIAL_CANVAS_SHAPE_REQUESTS_LABEL =
  "Build the local initial-canvas-shape materialization requests from the current structured planner patch without changing the carried planner JSON.";
const DAEMON_MATERIALIZE_INITIAL_CANVAS_STRUCTURES_LABEL =
  "If the structured planner patch still contains abstract initial policy/state canvas shapes, ask a model to materialize them into concrete InitialCanvasStructure IR before patch application while preserving the rest of the planner JSON.";
const DAEMON_MATERIALIZE_INITIAL_CANVAS_STRUCTURES_PROMPT_LABEL = [
  "Convert local initial_canvas_shape_materialization_requests into concrete InitialCanvasStructure IR for the starter-template applicator.",
  "Stay faithful to each abstract shape. Do not invent major branches or loops that the shape did not imply.",
  "Use only confirmed process facts plus the request JSON for labels and notes.",
  "For policy canvases, start from the catalog starter template Start -> fallback action Prompt -> commit Code node -> Display node. Emit only project-specific prompt/tool/condition/display behavior that replaces the fallback prompt before the commit/display tail; do not emit a special append/commit IR step and do not mark the commit node runtime-managed or read-only.",
  `For state canvases, start from the catalog starter template Start -> code "Add agent_latest_observation and agent_latest_reward to new_events." -> condition "summary plus new_events exceeds ${DEFAULT_CONVERSATION_MEMORY_LIMIT} characters" -> TRUE summary-update prompt -> code "Set new_events to empty list.", with FALSE and clear paths rejoining at remaining-state update. Emit only project-specific prompt/tool/condition/display behavior that belongs after that memory path; do not emit special append/summary/clear IR steps.`,
  "Do not emit canvasEdits here. Only produce the requested local structures.",
].join("\n");
const DAEMON_MERGE_MATERIALIZED_INITIAL_CANVAS_STRUCTURES_LABEL =
  "Merge the local materialized InitialCanvasStructure IR back into the carried structured planner patch before patch application.";
const DAEMON_BUILD_DEFAULT_PRIMARY_SCHEMA_LABEL =
  "Build only the legacy top-level runtime state fields for first-draft seeding before planner extras are merged: summary, new_events, agent_latest_observation, numeric scalar agent_latest_reward, and agent_latest_action. Workflow-specific agent behavior is created later when apply_structured_patch realizes the planner JSON and stage-scoped agentConnections.";
const DAEMON_BUILD_DEFAULT_ENVIRONMENT_SCHEMA_LABEL =
  "Legacy compatibility only: if an older planner JSON contains environmentAgents, build their default state fields before normalization converts them to graph connections. New target drafts must use agentConnections instead of embedded environment agents.";
const DAEMON_SCAFFOLD_TOOLS_LABEL =
  "If the structured planner patch requests missing tooling capabilities, synthesize supported tools, add any needed dataset hooks, and append the corresponding tool canvases.";
const DAEMON_SYNC_PROMPTS_LABEL =
  "Recompile the target draft's derived policy and state prompts after all structural changes are applied.";
const DAEMON_REPAIR_CANVAS_RULES_LABEL =
  "Check the target draft for canvas-rule violations, ask a model for the needed structured repairs, apply those repairs in code, resync derived prompts if needed, and report whether another repair pass is still needed.";
const DAEMON_PREPARE_CANVAS_RULE_DETECTION_REQUESTS_LABEL =
  "Canonicalize the target draft's canvases in code, publish local canvas_rule_detection_requests for model inspection, and record any deterministic preflight changes made during this pass.";
const DAEMON_DETECT_CANVAS_RULE_ISSUES_PROMPT_LABEL = [
  "Inspect local canvas_rule_detection_requests and return local canvas_rule_detected_issues as a JSON array.",
  "Each issue object must include docKey, target, ruleId, summary, and evidence, plus canvasId, canvasName, nodeId, or edgeId when those ids are visible in the supplied canvas summary.",
  "Only report real rule violations against the embedded rule registry for each request. Return [] when the canvases are compliant enough for this pass.",
].join("\n");
const DAEMON_BUILD_CANVAS_RULE_REPAIR_REQUESTS_LABEL =
  "Build local canvas_rule_repair_requests by combining the prepared detection bundle with local canvas_rule_detected_issues, without mutating the target draft yet.";
const DAEMON_PROPOSE_CANVAS_RULE_REPAIRS_PROMPT_LABEL = [
  "Use local canvas_rule_repair_requests to return local canvas_rule_repair_edits as a JSON array of repair groups.",
  "Each repair group must have docKey, target, canvasEdits, and optional notes.",
  "Keep repairs minimal, use exact ids from the supplied summaries whenever possible, and return [] when no structured edits are needed.",
].join("\n");
const DAEMON_APPLY_CANVAS_RULE_REPAIRS_LABEL =
  "Apply the local canvas_rule_repair_edits groups to the target draft's canvases in code and record exactly which repair edits changed the draft.";
const DAEMON_PREPARE_CANVAS_RULE_RECHECK_REQUESTS_LABEL =
  "Re-canonicalize the repaired target draft in code, publish local canvas_rule_recheck_requests for one final model check, and aggregate whether any deterministic or model-guided changes were applied in this pass.";
const DAEMON_RECHECK_CANVAS_RULE_ISSUES_PROMPT_LABEL = [
  "Re-check local canvas_rule_recheck_requests and return local canvas_rule_remaining_issues as a JSON array with the same issue shape as the first detection step.",
  "Only report issues that still genuinely violate the embedded rule registry after the applied repairs.",
  "Return [] when no meaningful violations remain.",
].join("\n");
const DAEMON_FINALIZE_CANVAS_RULE_REPAIR_PASS_LABEL =
  "Finalize this repair pass by reporting whether rule violations were detected, whether any repairs were applied, whether violations remain, and whether the top-level retry loop should run again.";
const DAEMON_REPAIR_LOOP_LABEL = buildExplicitLocalValueConditionLabel(
  "canvas_rule_retry_needed",
  "is true"
);
const DAEMON_TYPICAL_ANSWER_CHOICE_INSTRUCTION =
  "Whenever asking a clarification, review, approval, or boundary-selection question, include one concrete typical answer/default choice that the expert can choose directly if it is acceptable, and say they may revise it instead.";
const DAEMON_FINALIZE_REPLY_LABEL =
  `Finalize the visible assistant reply so it only reports concrete updates when the workflow actually applied them, and otherwise falls back to review or question language. ${DAEMON_TYPICAL_ANSWER_CHOICE_INSTRUCTION}`;
const DAEMON_APPEND_ASSISTANT_TURN_LABEL =
  "Append the finalized assistant reply as the latest action in new_events.";
const DAEMON_BUILD_CURRENT_BUILD_LABEL =
  "Set current_build to canonical current_build.";
const DAEMON_DERIVE_PROCESS_STATE_LABEL = [
  "Use the current daemon state plus recent conversation memory to update the individual process fields: process_agent_description, process_environment_description, process_observation_description, process_reward_description, process_action_description, process_state_update_description, and process_policy_description. Treat process_agent_description as the participating agent identities and roles in the workflow, not as one privileged default agent.",
  "Treat process_agent_description, process_environment_description, process_observation_description, process_reward_description, and process_action_description as required onboarding fields. process_state_update_description and process_policy_description are optional refinements. The required agent field is satisfied when the participating people, systems, or organizations are clear enough to draft a temporal workflow, even if the automation boundary is not decided yet.",
  "Then synchronize process_model from those individual process fields so the right-hand process workspace remains concrete: Environment, Observation, Reward, State Update, Policy, Action, and Participating Agents labels plus short descriptions for each part.",
  "Also update process_description, session_rules, user_requests, user_edit_requests, user_tooling_requests, user_skill_requests, user_environment_agent_requests, process_open_questions, process_ready, workflow_approved, and workflow_decomposition_complete.",
  "This node is the sole owner of request routing and process clarification state. Later build-fact derivation must not reclassify user_requests, user_edit_requests, user_tooling_requests, user_skill_requests, user_environment_agent_requests, process_open_questions, or process_ready.",
  "session_rules should hold the active session-specific drafting and repair rules inferred from confirmed process details plus explicit user requests in the chat. Keep only active rules, and remove rules that later turns override or make obsolete.",
  "Store session_rules as a JSON array of objects with title, scope, description, repairGuidance, and source, where scope is policy, state, or both and source is process_description, user_chat, or both.",
  "Update user_requests by comparing agent_latest_observation with the existing list: add each new user request, requirement, preference, or constraint; remove one only when the user retracts or cancels it; modify one only when the user changes it. Avoid duplicates. Keep fulfilled requests in user_requests as cumulative request memory so future changes do not violate them.",
  "user_edit_requests is the pending subset of user_requests that still asks for direct target-draft edits, corrections, refinements, canvas changes, conditional behavior, or runtime behavior changes.",
  "user_tooling_requests is the pending subset of user_requests that still asks for tools, external capabilities, search, retrieval, saving, dataset reads, or other supported tool/capability scaffolding.",
  "user_skill_requests is the pending subset of user_requests that still asks to add or create new temporally extended skills for an automated workflow agent, including requests that say 'skill' explicitly or ask for a new agent behavior with a start condition and duration.",
  "user_environment_agent_requests is the pending subset of user_requests that still asks to add or create connected agents, agent-to-agent interactions, simulated counterparts, clients, customers, patients, users, reviewers, managers, or other workflow participants. Target drafts should represent these as ID-addressed agentConnections, not embedded environment agents.",
  "Requests to edit, revise, remove, inspect, or add tools to existing skills or existing agent connections belong in user_edit_requests and, when capabilities are needed, user_tooling_requests. Remove matching items from the typed pending queues once current_build shows the request has been fulfilled or the user asks to remove/cancel it. Do not remove fulfilled requests from user_requests unless the user retracts or cancels them.",
  "Maintain workflow_approved as the checkpoint for the latest workflow canvas shown to the expert. Set workflow_approved=false until that Overall Workflow or child stage workflow canvas exists and the latest expert response semantically approves it without requesting changes. If the expert gives workflow comments, corrections, missing-stage notes, or asks to change stages, keep workflow_approved=false so the workflow review subtree can revise it and ask again. If the expert approves the current workflow, do not treat that approval as permission to simplify, compress, or replace that workflow.",
  "When current_build.workflow.canvas_count > 0, interpret agent_latest_observation in context as the newest expert response to the workflow checkpoint whenever workflow_decomposition_complete is false. Use the meaning of the expert response in context. If the response communicates unqualified approval of the current workflow canvas, set workflow_approved=true in this model call. If it communicates requested changes, set workflow_approved=false.",
  "Maintain workflow_decomposition_complete as the stricter implementation gate. Set workflow_decomposition_complete=false until the Overall Workflow canvas and every necessary child stage workflow canvas have been approved, and every remaining stage is small enough to depict with low-level state/policy/reward operations. Do not keep workflow_decomposition_complete=false merely because implementation canvases have not been built yet; false means more workflow partitioning or workflow approval is still needed. After the latest expert response approves the current workflow, keep workflow_decomposition_complete=false only when you can identify a specific approved stage that still needs a child workflow canvas; otherwise set workflow_decomposition_complete=true in this same state update so the main policy can proceed to agent-boundary selection on this turn.",
  "Keep process_model and process_description factual and neutral: include only confirmed process details, not meta commentary, judgments, or unresolved caveats.",
  "Put unresolved, missing, or still-open details into process_open_questions instead of mixing them into process_model, session_rules, or process_description. Keep process_open_questions current: remove questions that the latest response has answered or made obsolete.",
  "Before judging process_ready, first check the required individual fields. If any required field is empty, set process_ready=false and set process_open_questions to focused questions for the missing required fields. Do not judge overall readiness while any required field is missing.",
  "Only when all required individual fields are non-empty may you judge whether the overall process is roughly clear. Set process_ready=true only when the confirmed process details are specific enough to seed the first target draft confidently.",
].join("\n");
const DAEMON_DERIVE_AGENT_BOUNDARY_STATE_LABEL = [
  "Use the current daemon state, current_build.workflow, the previous assistant boundary-selection turn, and recent conversation memory as context to derive the agent-boundary checkpoint.",
  "The writable outputs of this node are agent_boundary_plan and agent_boundaries_confirmed. Treat process_description, process_model, session_rules, user_requests, typed request queues, process_open_questions, process_ready, workflow_approved, workflow_decomposition_complete, general_description, structured_draft_exists, requested_tooling_capabilities, missing_tooling_capabilities, and drafted_artifacts as read-only context in this node.",
  "If the workflow hierarchy is missing, newly revised, not approved, or not decomposed enough for implementation, set agent_boundaries_confirmed=false and keep agent_boundary_plan empty or clearly provisional.",
  "When workflow_decomposition_complete is true, identify every participating workflow agent from current_build.workflow. Merge duplicate appearances into stable workflow agent ids while preserving role descriptions and stage participation.",
  "agent_boundary_plan must be a JSON object keyed by stable workflow agent id. Each entry should include role, stages, mode, and notes. mode must be exactly one of build, import_template, or user_played. For imported agents, include templateId, templateVersionId, or templateName when the expert supplied it; otherwise include notes about which Agent Template Catalog choice remains needed.",
  "Set agent_boundaries_confirmed=true only when every participating workflow agent has a mode. If any participating agent lacks a mode, set agent_boundaries_confirmed=false.",
  "Interpret the latest expert response in context of the previous assistant boundary-selection turn. That previous turn may be phrased as a question, a proposed default, or an approve-or-revise choice; do not require literal question wording. If the expert explicitly chooses a mode for every participating workflow agent, write that plan and set agent_boundaries_confirmed=true. If the previous assistant message offered a typical/default boundary plan that explicitly listed every participating workflow agent with a mode, and the latest expert response semantically accepts that default without changes, write that default plan and set agent_boundaries_confirmed=true.",
  "A response that only confirms agent names, such as using a two-agent setup, does not by itself choose build, import_template, or user_played modes. In that case, keep agent_boundaries_confirmed=false and preserve any useful provisional plan.",
  "If agent_boundaries_confirmed was already true and the latest expert response does not revise boundaries, preserve the existing agent_boundary_plan and agent_boundaries_confirmed=true.",
].join("\n");
const DAEMON_DERIVE_REMAINING_STATE_LABEL = [
  "Use current_build only to derive build inventory facts: general_description, structured_draft_exists, requested_tooling_capabilities, missing_tooling_capabilities, drafted_artifacts, workflow_approved consistency, workflow_decomposition_complete consistency, and agent boundary consistency.",
  "structured_draft_exists means implementation structure exists, such as runtime policy canvases, state canvases, non-memory state fields, datasets, guidelines, tools, skills, or agentConnections. An Overall Workflow canvas by itself does not make structured_draft_exists=true.",
  "If current_build.workflow.canvas_count is 0, set workflow_approved=false, workflow_decomposition_complete=false, agent_boundaries_confirmed=false, and agent_boundary_plan={} because there is no workflow to approve yet. If this turn just created or revised workflowStages or workflowStagePartitions, set workflow_approved=false, workflow_decomposition_complete=false, agent_boundaries_confirmed=false, and agent_boundary_plan={} because the changed workflow canvas needs approval before boundaries can be chosen. Otherwise preserve workflow_approved, workflow_decomposition_complete, agent_boundary_plan, and agent_boundaries_confirmed exactly as produced by the previous state extraction nodes.",
  "Do not update or reclassify user_requests, user_edit_requests, user_tooling_requests, user_skill_requests, user_environment_agent_requests, process_open_questions, or process_ready in this node. Preserve those fields exactly as produced by the previous request-routing node.",
  "general_description should summarize only what the current draft already contains. Do not infer unresolved process details, open questions, user intent, or request routing here.",
  "Do not move into target draft seeding until process_ready is true.",
  "Do not rewrite current_build manually; it is already canonical.",
].join("\n");
const LEGACY_DAEMON_DERIVE_PROCESS_STATE_LABEL = [
  "Use the current daemon state plus recent conversation memory to update process_description, process_model, session_rules, process_open_questions, and process_ready.",
  "process_model should keep the right-hand process workspace concrete: Environment, Observation, Reward, State Update, Policy, Action, and Agent labels plus short descriptions for each part.",
  "session_rules should hold only the currently active session-specific drafting and repair rules inferred from confirmed process details plus explicit user requests in the chat.",
  "Set process_ready to true only when the confirmed process details are specific enough to seed the first target draft confidently.",
].join("\n");
const LEGACY_DAEMON_DERIVE_REMAINING_STATE_LABEL = [
  "Use the current daemon state together with current_build to derive general_description, structured_draft_exists, process_open_questions, requested_tooling_capabilities, missing_tooling_capabilities, and drafted_artifacts.",
  "Treat agent_latest_observation as the newest user-side request/event. When a structured draft already exists and agent_latest_observation asks for a direct draft correction or refinement, preserve it as an edit request.",
  "Requests phrased as conditional runtime behavior, such as 'if/when/unless X, then do Y', are direct draft refinements when a structured draft exists, even if they do not mention canvases or nodes.",
  "Do not move into target draft seeding until process_ready is true.",
  "Do not rewrite current_build manually; it is already canonical.",
].join("\n");
const DAEMON_INITIAL_CANVAS_SHAPE_MATERIALIZATION_REQUESTS_OUTPUT_NAME =
  "initial_canvas_shape_materialization_requests";
const DAEMON_INITIAL_CANVAS_SHAPE_MATERIALIZATION_REQUESTS_EXIST_OUTPUT_NAME =
  "initial_canvas_shape_materialization_requests_exist";
const DAEMON_MATERIALIZED_INITIAL_CANVAS_STRUCTURES_OUTPUT = {
  name: "materialized_initial_canvas_structures",
  type: "json" as const,
  instruction: [
    `Return a JSON object keyed by every request key in local ${DAEMON_INITIAL_CANVAS_SHAPE_MATERIALIZATION_REQUESTS_OUTPUT_NAME}.`,
    "Each value must be either null or a concrete InitialCanvasStructure object with canvasName, notes, startLabel, and steps.",
    "Preserve every request key exactly.",
  ].join(" "),
};
const DAEMON_WORKFLOW_READY_FOR_BOUNDARY_SELECTION_OUTPUT = {
  name: "workflow_ready_for_agent_boundary_selection",
  type: "boolean" as const,
  instruction:
    "Return true only when the workflow hierarchy needs no revision, no additional child workflow partition is pending, and agent_boundaries_confirmed is false. Return false otherwise.",
};
const DAEMON_DECIDE_WORKFLOW_BOUNDARY_HANDOFF_LABEL = [
  "Inspect the result of the Review Workflow Stages subtree plus current_build.workflow, workflow_approved, workflow_decomposition_complete, and agent_boundaries_confirmed.",
  "Set local workflow_ready_for_agent_boundary_selection=true only when the workflow-review subtree did not emit workflowStages or workflowStagePartitions, did not ask for another workflow approval, no approved stage still needs a child workflow canvas, and agent_boundaries_confirmed is false.",
  "Set it false when the workflow was created, revised, partitioned, or still needs expert approval.",
].join(" ");
const DAEMON_CANVAS_RULE_DETECTED_ISSUES_OUTPUT = {
  name: "canvas_rule_detected_issues",
  type: "json" as const,
  instruction: [
    "Return a JSON array of canvas-rule issues.",
    "Each item must include docKey, target, ruleId, summary, and evidence.",
    "Include canvasId, canvasName, nodeId, or edgeId when those ids are identifiable from the supplied canvas summary.",
  ].join(" "),
};
const DAEMON_CANVAS_RULE_REPAIR_EDITS_OUTPUT = {
  name: "canvas_rule_repair_edits",
  type: "json" as const,
  instruction: [
    "Return a JSON array of repair groups.",
    "Each repair group must include docKey, target, canvasEdits, and optional notes.",
    "canvasEdits must contain only structured canvas edit objects.",
  ].join(" "),
};
const DAEMON_CANVAS_RULE_REMAINING_ISSUES_OUTPUT = {
  name: "canvas_rule_remaining_issues",
  type: "json" as const,
  instruction: [
    "Return a JSON array of remaining canvas-rule issues after the repair pass.",
    "Use the same issue shape as canvas_rule_detected_issues.",
    "Return [] when no meaningful violations remain.",
  ].join(" "),
};
const DAEMON_INITIAL_CANVAS_SHAPE_REQUESTS_GATE_LABEL =
  buildExplicitLocalValueConditionLabel(
    DAEMON_INITIAL_CANVAS_SHAPE_MATERIALIZATION_REQUESTS_EXIST_OUTPUT_NAME,
    "is true"
  );
const DAEMON_CANVAS_RULE_ISSUES_EXIST_GATE_LABEL =
  buildExplicitLocalValueConditionLabel(
    DAEMON_CANVAS_RULE_DETECTED_ISSUES_OUTPUT.name,
    "is not empty"
  );
const DAEMON_CANVAS_RULE_PREFLIGHT_CHANGES_GATE_LABEL =
  buildExplicitLocalValueConditionLabel(
    "canvas_rule_preflight_changes_applied",
    "is true"
  );
const DAEMON_CANVAS_RULE_ANY_CHANGES_GATE_LABEL =
  buildExplicitLocalValueConditionLabel(
    "canvas_rule_any_changes_applied",
    "is true"
  );
const DAEMON_USER_EDIT_REQUESTS_GATE_LABEL =
  "user_edit_requests is not empty";
const DAEMON_USER_TOOLING_REQUESTS_GATE_LABEL =
  "user_tooling_requests is not empty";
const DAEMON_USER_SKILL_REQUESTS_GATE_LABEL =
  "user_skill_requests is not empty";
const DAEMON_USER_ENVIRONMENT_AGENT_REQUESTS_GATE_LABEL =
  "user_environment_agent_requests is not empty";
const DAEMON_PROCESS_OPEN_QUESTIONS_GATE_LABEL =
  "process_open_questions is not empty";
const DAEMON_WORKFLOW_DECOMPOSITION_GATE_LABEL =
  "workflow_decomposition_complete is false";
const DAEMON_AGENT_BOUNDARIES_GATE_LABEL =
  "agent_boundaries_confirmed is false";
const DAEMON_PROCESS_STATE_UPDATE_GATE_LABEL =
  "process_ready is false, workflow_decomposition_complete is false, or the latest expert turn can change process facts, request routing, workflow approval, or workflow decomposition state";
const DAEMON_AGENT_BOUNDARY_STATE_UPDATE_GATE_LABEL =
  "workflow_decomposition_complete is true and either agent_boundaries_confirmed is false or the latest expert turn asks to revise agent boundaries";
const DAEMON_BUILD_INVENTORY_STATE_UPDATE_GATE_LABEL =
  "current_build can change build inventory, tooling inventory, workflow checkpoint consistency, or agent-boundary consistency state";
const DAEMON_WORKFLOW_READY_FOR_BOUNDARY_SELECTION_GATE_LABEL =
  buildExplicitLocalValueConditionLabel(
    DAEMON_WORKFLOW_READY_FOR_BOUNDARY_SELECTION_OUTPUT.name,
    "is true"
  );
const DAEMON_MAIN_CANVAS_NOTES = [
  "Routing guidance:",
  "- process_ready=false means the overall Environment -> Observation/Reward -> State Update -> Policy -> Action process is still underspecified or not roughly clear",
  "- process_ready=true with workflow_decomposition_complete=false means the daemon must create or revise the editable Overall Workflow canvas only before approval, or create one child stage workflow canvas only after approval when a named approved stage is still too broad; show the changed workflow canvas to the expert and ask for approval before seeding implementation details",
  "- process_ready=true with workflow_decomposition_complete=true and agent_boundaries_confirmed=false means the daemon must ask which participating workflow agents should be built, imported from the Agent Template Catalog, or played by the user before seeding implementation details",
  "- process_ready=true with workflow_decomposition_complete=true, agent_boundaries_confirmed=true, and structured_draft_exists=false means the approved workflow hierarchy and chosen agent boundaries can now be expanded into the first implementation draft",
  "- user_environment_agent_requests controls whether new explicit agentConnections or simulated counterparts should be created through the agent-connection creation subtree",
  "- user_skill_requests controls whether new temporally extended agent skills should be created through the skill-creation subtree",
  "- user_tooling_requests controls whether missing requested capabilities are scaffolded as supported tools",
  "- user_edit_requests controls whether direct user corrections or refinements are applied to the existing draft through the refine subtree",
  "- process_open_questions controls whether the daemon asks one focused triage question",
  "",
  "Behavior requirements:",
  "- Start by clarifying the required onboarding fields on the right: participating agents/roles, Environment, Observation, Reward, and Action. Ask for missing required fields before judging process readiness.",
  "- The onboarding Reward field/process_reward_description is the overall success signal for the workflow or organization being automated. Do not treat it as a single per-connection directional reward canvas; directional reward canvases are generated separately where implementation needs them.",
  "- Once the required onboarding fields are present, clarify how State Update should interpret observations/rewards and how Policy should choose the next Action only when those optional refinements are needed for a confident seed.",
  "- After a structured draft exists, run the tooling, agent-connection, skill, editing, and triage routing in a single policy pass whenever their corresponding request/open-question lists are non-empty.",
  "- After seeding the first structured draft, continue through the tooling, agent-connection, skill, editing, and triage gates in the same policy pass whenever they are needed.",
  "- Do not start filling in the target draft form until the overall process is concrete enough to guide the build.",
  "- If the process is rich enough to derive a broad target description but still too generic to seed confidently, keep process_ready=false, update process_open_questions, and ask through the process-clarification subtree instead of silently backfilling a first draft.",
  "- Once the process is clear enough to seed, carry the best broad target description forward from the confirmed process and current daemon state instead of pausing for a separate description-only phase.",
  "- If current_build.bootstrap_datasets includes workflow_historical_records or workflow_reference_materials, use those uploaded sources as evidence for the first workflow abstraction: historical records reveal likely inputs, outputs, handoffs, and examples; reference materials reveal stage names, constraints, and domain guidelines.",
  "- Once the process and broad target description exist and the draft is sparse, create the editable Overall Workflow canvas first, then stop and ask the expert whether the stage abstraction looks right.",
  "- Workflow canvases must show the concrete temporal process. Each stage must be one temporal stage, and any repeat/retry/revision/evaluation loop must be represented with nextStageIds so the canvas has a visible loop/back-edge; do not hide loops only in stage descriptions.",
  "- Approval freezes the approved workflow canvas. After any workflow canvas is approved, do not emit workflowStages to simplify, compress, restate, or replace it. Inspect whether any approved stage itself is still a big operation that benefits from partitioning. If so, create exactly one child workflow canvas for that stage with workflowStagePartitions, stop, and ask for approval. Repeat recursively until the remaining stages are small enough for low-level implementation canvases.",
  "- Do not emit state schema, state canvas, policy canvas, datasets, guidelines, agentSkills, tools, or stage-scoped agentConnections until workflow_decomposition_complete=true and agent_boundaries_confirmed=true.",
  "- If workflow_decomposition_complete=false and workflow_approved=false, emit workflowStages only when the Overall Workflow canvas is missing or the expert requested changes to it; otherwise emit workflowStagePartitions only when revising an unapproved child workflow canvas. If workflow_decomposition_complete=false and workflow_approved=true, do not emit workflowStages; emit at most one workflowStagePartitions item for a named oversized approved stage.",
  "- If workflow_decomposition_complete=true and agent_boundaries_confirmed=false, ask the expert to choose the automation boundary for every participating workflow agent: build as new automation, import from the Agent Template Catalog, or play by the user. Do not emit implementation artifacts in that boundary-selection pass.",
  "- If workflow_decomposition_complete=true and agent_boundaries_confirmed=true, construct the state schema, state/policy canvases, datasets, agentTemplateBindings for exact catalog imports, agentSkills for temporally extended behavior owned by specific workflow agents, guidelines, and stage-scoped agentConnections from the approved workflow hierarchy and agent_boundary_plan. Each built or imported agent identity should be represented by stable ids, and user-played agents should appear as human-controlled handoff/input points rather than autonomous policy canvases.",
  "- Continue with exactly one focused follow-up question at a time after the first draft exists.",
  `- ${DAEMON_TYPICAL_ANSWER_CHOICE_INSTRUCTION}`,
  "- Return structured setup updates as JSON planner patches rather than free-form edits. assistantMessage is only one field inside that structured patch.",
  `- When building any state canvas, start from the catalog starter state template: Start with project/agent-specific state instructions, then Code "Add agent_latest_observation and agent_latest_reward to new_events.", then condition "summary plus new_events exceeds ${DEFAULT_CONVERSATION_MEMORY_LIMIT} characters", TRUE to summary-update prompt and clear-new_events code node, with FALSE and clear paths rejoining at remaining-state-update prompt. Put project-specific changes after that memory path; do not emit duplicate append/summary/clear starter steps or rely on runtime-managed/read-only nodes.`,
  "- When building any policy canvas, start from the catalog starter policy template: Start followed by a fallback action Prompt, a commit Code node that writes the finalized action to state/new_events, and a Display node that publishes the visible action. Replace the fallback prompt with project-specific behavior when available; do not rely on runtime-managed/read-only commit nodes.",
  "- By default, both state update and policy should read the current daemon state itself. summary is compact long-term memory, and new_events is the recent unsummarized event context.",
  "- Let the state flow append the latest agent_latest_observation/agent_latest_reward event into new_events, keeping agent_latest_reward as a numeric scalar, and let the policy flow commit the finalized action as the latest action in new_events.",
  "- Set assistantReplyIntent explicitly in the structured planner patch so the runtime can finalize whether this turn should ask, report a real update, or report a review.",
  "- After producing the structured planner patch, run the shared apply-patch workflow: ensure the default seeding schemas, materialize abstract initial canvas shapes when needed, apply the patch to the target draft, scaffold any requested missing tools, recompile the target draft's derived prompts, run a bounded model-assisted canvas-repair pass if rule issues remain, and then finalize the visible assistant reply inside the policy execution flow itself.",
  "- Keep the target draft coherent and additive unless the user explicitly asks to reset, replace, or recreate structure.",
  "- Treat the target draft on the main demo as directly editable and keep it synchronized with the conversation.",
  "- Treat current_build as the canonical server-generated JSON snapshot of what is currently built on the right.",
  "- Prefer practical titles and slugs as soon as enough information exists.",
  "- Keep structured_draft_exists, user_requests, user_edit_requests, user_tooling_requests, user_skill_requests, user_environment_agent_requests, process_open_questions, missing_tooling_capabilities, and drafted_artifacts aligned with the real draft state.",
  "- Only scaffold new tools when the current system does not already cover a requested capability.",
  "- When the user asks to add, insert, move, or wire a tool/capability node in an existing canvas, treat it as an editing request and emit toolPlacements; do not satisfy that request with tool scaffolding alone.",
  "- For any edit request, first decompose it into independent edit units or one related ordered sequence, then choose target agents, target canvases, atomic edit types, and explicit node/edge locations before emitting the structured planner patch.",
  "- Treat conditional runtime instructions like 'if/when/unless X, then do Y' as editing requests for an existing draft. Represent them as visible policy-canvas structure, usually a condition node plus true-branch action nodes, rather than only storing them as prose.",
  "- Make edit routing explicit in canvasEdits and toolPlacements: omit agentTarget only for top-level runtime canvas edits. For pairwise interaction canvases, set agentConnectionId or targetAgentId on canvasEdits; do not create embedded environment agents in target drafts.",
  "- Tool source types must stay within http, rss, page, web_search, knowledge_save, and dataset_read. Use Display nodes for text or video output. Use Call Agent nodes for Default, OpenClaw backend, or Hermes backend delegation.",
  "- Keep assistant replies concise and actionable.",
  "- This runtime config controls the daemon itself. The publishable target draft on the main demo remains a separate artifact.",
].join("\n");

const DAEMON_POLICY_LABEL_REWRITES = new Map<string, string>([
  [
    "Ask what demo to build and what it should help the user accomplish. If the latest user message already contains that broad description, capture it immediately instead of asking again.",
    "Ask what target demo to build and what it should help the user accomplish. If the latest user message already contains that broad target description, capture it immediately instead of asking again.",
  ],
  [
    "the overall process on the right is still underspecified",
    "process_ready is false",
  ],
  [
    "the first structured draft has not been seeded yet",
    "structured_draft_exists is false",
  ],
  [
    "important policy questions remain open or the current build is still underspecified",
    DAEMON_PROCESS_OPEN_QUESTIONS_GATE_LABEL,
  ],
  [
    "a requested capability is not covered by the current tool surface",
    DAEMON_USER_TOOLING_REQUESTS_GATE_LABEL,
  ],
  [
    "briefly summarize the most meaningful setup changes, ground the reply in what exists in the current build, and ask the next best focused question only when the policy is still underspecified",
    `revise the structured planner output so assistantReplyIntent correctly marks whether this turn should ask, report_update, or report_review, and the reply stays grounded in current_build; when assistantReplyIntent=ask, assistantMessage must ask the next concrete question directly rather than summarize a status or say what should happen next, and must include one typical answer/default choice the expert can accept or revise; preserve the JSON shape and the non-message fields unless the instruction requires changing them`,
  ],
  [
    "Create or refine the target demo's title, route slug, summary, and policy intent. Prefer practical naming once the draft is specific enough.",
    "Create or refine the target demo's title, route slug, summary, and policy intent inside the structured planner patch. Prefer practical naming once the draft is specific enough.",
  ],
  [
    "Create the first coherent setup pass in one move: state schema, policy canvas, state canvas, datasets, and guideline blocks.",
    "After workflow_decomposition_complete and agent_boundaries_confirmed are true, create the first implementation setup pass in one move inside the structured planner patch: state schema, policy canvas, state canvas, datasets, and stage-scoped agentConnections grounded in the approved workflow hierarchy and agent_boundary_plan.",
  ],
  [
    "Create the first coherent setup pass in one move inside the structured planner patch: state schema, a concrete policy canvas grounded in confirmed process facts, a state canvas, datasets, and guideline blocks. Treat process_open_questions as unresolved follow-up questions for later turns, not as draft-node content.",
    "After workflow_decomposition_complete and agent_boundaries_confirmed are true, create the first implementation setup pass in one move inside the structured planner patch: state schema, a concrete policy canvas grounded in confirmed process facts, the approved workflow hierarchy, and agent_boundary_plan, a state canvas, datasets, and stage-scoped agentConnections. Treat process_open_questions as unresolved follow-up questions for later turns, not as draft-node content.",
  ],
  [
    "Create the first coherent setup pass in one move inside the structured planner patch: workflowStages for the editable Overall Workflow canvas, state schema, a concrete policy canvas grounded in confirmed process facts, a state canvas, and datasets. Treat process_open_questions as unresolved follow-up questions for later turns, not as draft-node content.",
    "After workflow_decomposition_complete and agent_boundaries_confirmed are true, create the first implementation setup pass in one move inside the structured planner patch: state schema, a concrete policy canvas grounded in confirmed process facts, the approved workflow hierarchy, and agent_boundary_plan, a state canvas, datasets, and stage-scoped agentConnections. Treat process_open_questions as unresolved follow-up questions for later turns, not as draft-node content.",
  ],
  [
    "Ask exactly one focused follow-up question about goals, constraints, success criteria, failure modes, missing tooling capabilities, or a weak part of the current build.",
    `Use assistantMessage in the structured planner patch to ask exactly one focused follow-up question about goals, constraints, success criteria, failure modes, missing tooling capabilities, or a weak part of the current build. ${DAEMON_TYPICAL_ANSWER_CHOICE_INSTRUCTION}`,
  ],
  [
    "Add any required dataset hooks and update missing_tooling_capabilities, current_build, and drafted_artifacts to reflect the new tool surface. Treat tooling scaffolding as needed when missing_tooling_capabilities is non-empty.",
    "Add any required dataset hooks inside the structured planner patch and update missing_tooling_capabilities, current_build, and drafted_artifacts to reflect the new tool surface. Treat tooling scaffolding as needed when missing_tooling_capabilities is non-empty.",
  ],
  [
    "Apply the user's requested corrections or refinements directly to the current draft while keeping changes coherent and additive.",
    "Apply the user's requested corrections or refinements directly to the current draft through the structured planner patch while keeping changes coherent and additive.",
  ],
]);

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s-]+/g, " ");
}

function readDaemonStageBoolean(
  state: Record<string, unknown> | null | undefined,
  key: string
): boolean | null {
  const value = state?.[key];
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "true") {
      return true;
    }
    if (trimmed === "false") {
      return false;
    }
  }
  return null;
}

function resolveComputedDaemonWorkflowStage(
  state: Record<string, unknown> | null | undefined
): DaemonWorkflowStageId {
  if (readDaemonStageBoolean(state, "process_ready") !== true) {
    return DAEMON_WORKFLOW_STAGE_UNDERSTAND;
  }
  if (readDaemonStageBoolean(state, "workflow_decomposition_complete") !== true) {
    return DAEMON_WORKFLOW_STAGE_APPROVE;
  }
  if (readDaemonStageBoolean(state, "agent_boundaries_confirmed") !== true) {
    return DAEMON_WORKFLOW_STAGE_BOUNDARIES;
  }
  if (readDaemonStageBoolean(state, "structured_draft_exists") !== true) {
    return DAEMON_WORKFLOW_STAGE_BUILD;
  }
  return DAEMON_WORKFLOW_STAGE_REVIEW;
}

export function resolveDaemonWorkflowStageId(
  state: Record<string, unknown> | null | undefined
): DaemonWorkflowStageId {
  const computed = resolveComputedDaemonWorkflowStage(state);
  const rawStage = state?.[DAEMON_WORKFLOW_STAGE_FIELD_NAME];
  const requestedStage = isDaemonWorkflowStageId(rawStage) ? rawStage : null;
  if (!requestedStage) {
    return computed;
  }

  const computedOrder = DAEMON_WORKFLOW_STAGE_ORDER.get(computed) ?? 0;
  const requestedOrder = DAEMON_WORKFLOW_STAGE_ORDER.get(requestedStage) ?? 0;
  return requestedOrder <= computedOrder ? requestedStage : computed;
}

export function getDaemonWorkflowStageDefinition(
  stageId: DaemonWorkflowStageId
): DaemonWorkflowStageDefinition {
  return (
    DAEMON_WORKFLOW_STAGE_DEFINITIONS.find((stage) => stage.id === stageId) ??
    DAEMON_WORKFLOW_STAGE_DEFINITIONS[0]
  );
}

function moveCanvasNamedToFront(
  doc: CanvasDoc | null | undefined,
  canvasName: string
): CanvasDoc | null {
  if (!doc || doc.canvases.length === 0) {
    return doc ?? null;
  }
  const targetIndex = doc.canvases.findIndex(
    (canvas) => normalizeKey(canvas.name) === normalizeKey(canvasName)
  );
  if (targetIndex < 0) {
    return doc;
  }
  const targetCanvas = doc.canvases[targetIndex];
  const canvasByName = new Map(
    doc.canvases.map((canvas) => [normalizeKey(canvas.name), canvas])
  );
  const selectedCanvases: CanvasEntry[] = [];
  const seenCanvasIds = new Set<string>();
  const visit = (canvas: CanvasEntry) => {
    if (seenCanvasIds.has(canvas.id)) {
      return;
    }
    seenCanvasIds.add(canvas.id);
    selectedCanvases.push(canvas);
    for (const node of canvas.graph.nodes) {
      if (node.type !== "expand" || typeof node.data?.label !== "string") {
        continue;
      }
      const target = canvasByName.get(normalizeKey(node.data.label));
      if (target) {
        visit(target);
      }
    }
  };
  visit(targetCanvas);

  return {
    ...doc,
    activeId: targetCanvas.id,
    canvases: selectedCanvases,
  };
}

export function scopeDaemonCanvasDocToWorkflowStage(args: {
  doc: CanvasDoc | null;
  stageId: DaemonWorkflowStageId;
  participant: "primary" | "environment";
  phase: "policy" | "state";
}): CanvasDoc | null {
  const stage = getDaemonWorkflowStageDefinition(args.stageId);
  const canvasName =
    args.participant === "primary"
      ? args.phase === "policy"
        ? stage.primaryPolicyCanvasName
        : stage.primaryStateCanvasName
      : args.phase === "policy"
        ? stage.environmentPolicyCanvasName
        : stage.environmentStateCanvasName;

  return moveCanvasNamedToFront(args.doc, canvasName);
}

function stableDaemonId(prefix: string, parts: unknown[]): string {
  const input = parts.map(stableDaemonIdPart).join("|");
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `daemon-${prefix}-${(hash >>> 0).toString(36)}`;
}

function stableDaemonIdPart(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableDaemonIdPart).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${key}:${stableDaemonIdPart((value as Record<string, unknown>)[key])}`
      )
      .join(",")}}`;
  }
  return String(value);
}

type DaemonCanvasStorageNamespace = "policy" | "state" | "workflow";

function daemonCanvasStorageId(
  namespace: DaemonCanvasStorageNamespace,
  name: string
): string {
  const slug =
    normalizeKey(name)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "canvas";
  return `daemon-${namespace}-${slug}`;
}

function canonicalizeDaemonCanvasDocStorageIds(
  doc: CanvasDoc,
  existingDoc: CanvasDoc | null | undefined,
  namespace: DaemonCanvasStorageNamespace
): CanvasDoc {
  const existingIdByName = new Map(
    (existingDoc?.canvases ?? []).map((canvas) => [
      normalizeKey(canvas.name),
      canvas.id,
    ])
  );
  const sourceActiveCanvas =
    doc.canvases.find((canvas) => canvas.id === doc.activeId) ?? doc.canvases[0];
  const canvases = doc.canvases.map((canvas) => ({
    ...canvas,
    id:
      existingIdByName.get(normalizeKey(canvas.name)) ??
      daemonCanvasStorageId(namespace, canvas.name),
  }));
  const activeCanvas =
    sourceActiveCanvas
      ? canvases.find(
          (canvas) =>
            normalizeKey(canvas.name) === normalizeKey(sourceActiveCanvas.name)
        )
      : null;

  return {
    ...doc,
    activeId: activeCanvas?.id ?? canvases[0]?.id ?? "",
    canvases,
  };
}

function ensureDaemonEnvironmentAgentCanvasDoc(
  doc: CanvasDoc | null | undefined,
  createFallback: () => CanvasDoc
): CanvasDoc {
  if (!doc || doc.canvases.length === 0) {
    return createFallback();
  }
  return doc;
}

function mergeDaemonOpenQuestionFieldValues(
  currentValue: string | null | undefined,
  legacyValue: string | null | undefined
): string | undefined {
  const current = typeof currentValue === "string" ? currentValue.trim() : "";
  const legacy = typeof legacyValue === "string" ? legacyValue.trim() : "";

  if (!legacy) {
    return typeof currentValue === "string" ? currentValue : undefined;
  }

  if (!current || current === "[]") {
    return typeof legacyValue === "string" ? legacyValue : undefined;
  }

  return typeof currentValue === "string" ? currentValue : undefined;
}

function normalizeDaemonRuntimeFields(
  fields: OrchestrationProject["fields"],
  defaults: OrchestrationProject["fields"]
): OrchestrationProject["fields"] {
  const merged = mergeSuggestedFields(
    normalizeLatestInteractionStateFields(fields),
    defaults.map((field) => ({
      name: field.name,
      type: field.type,
      initialValue: field.initialValue,
    }))
  );

  let legacyPolicyOpenQuestions: string | null = null;
  const filtered = merged.filter((field) => {
    if (normalizeKey(field.name) === normalizeKey("policy_open_questions")) {
      legacyPolicyOpenQuestions = field.initialValue ?? null;
      return false;
    }
    if (normalizeKey(field.name) === normalizeKey("draft_seed_ready")) {
      return false;
    }
    if (normalizeKey(field.name) === normalizeKey("workspace_mode")) {
      return false;
    }
    if (normalizeKey(field.name) === normalizeKey("workspaceMode")) {
      return false;
    }
    if (
      normalizeKey(field.name) ===
      normalizeKey(LEGACY_DAEMON_LATEST_INPUT_EVENT_FIELD_NAME)
    ) {
      return false;
    }
    if (normalizeKey(field.name) === normalizeKey("requested_edits")) {
      return false;
    }
    if (normalizeKey(field.name) === normalizeKey("needs_tool_scaffolding")) {
      return false;
    }
    return true;
  });

  return filtered.map((field) =>
    normalizeKey(field.name) === normalizeKey("process_open_questions")
      ? {
          ...field,
          initialValue:
            mergeDaemonOpenQuestionFieldValues(
              field.initialValue,
              legacyPolicyOpenQuestions
            ) ?? field.initialValue,
        }
      : field
  );
}

function createCanvasNode(
  type: CanvasNodeRecord["type"],
  x: number,
  y: number,
  label: string,
  extra: Record<string, unknown> = {}
): CanvasNodeRecord {
  return {
    id: stableDaemonId("node", [type, x, y, label, extra]),
    type,
    position: { x, y },
    data: {
      label,
      ...extra,
    },
  };
}

function isPromptNode(node: CanvasNodeRecord): boolean {
  return node.type === "prompt" || getNodeActionSubtype(node) === "prompt";
}

function isPromptTransformNode(node: CanvasNodeRecord): boolean {
  return getNodeActionSubtype(node) === "prompt_transform";
}

function nodeLabelIncludes(node: CanvasNodeRecord, text: string): boolean {
  return (
    typeof node.data?.label === "string" &&
    normalizeKey(node.data.label).includes(normalizeKey(text))
  );
}

function daemonCanvasMentionsNeedsToolScaffolding(doc: CanvasDoc | null): boolean {
  if (!doc) {
    return false;
  }

  return doc.canvases.some((canvas) =>
    canvas.graph.nodes.some(
      (node) =>
        typeof node.data?.label === "string" &&
        normalizeKey(node.data.label).includes(
          normalizeKey("needs_tool_scaffolding")
        )
    )
  );
}

function createAppendAssistantTurnCodeNode(
  x: number,
  y: number,
  label = APPEND_ASSISTANT_TURN_CODE_LABEL
): CanvasNodeRecord {
  return createCanvasNode(
    "code",
    x,
    y,
    label,
    buildAppendAssistantTurnCodeNodeData(
      { label },
      { strictFinalizedAssistantMessage: true }
    )
  );
}

function createDisplayCommittedAgentActionNode(
  x: number,
  y: number
): CanvasNodeRecord {
  return createCanvasNode(
    "display",
    x,
    y,
    "Display the committed agent action.",
    {
      displayType: "text",
      inputVariable: PRIMARY_AGENT_LATEST_ACTION_FIELD_NAME,
    }
  );
}

function titleCaseDaemonStageName(name: string): string {
  const normalized = name
    .replace(/^Environment\s*-\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized
    .split(" ")
    .filter(Boolean)
    .map((word) =>
      word.length <= 1
        ? word.toUpperCase()
        : `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`
    )
    .join(" ");
}

function buildDaemonStageFinishedMessage(stageName: string): string {
  const displayName = titleCaseDaemonStageName(stageName) || "Workflow";
  return `${displayName} stage is finished.`;
}

function createSetStageFinishedMessageCodeNode(
  x: number,
  y: number,
  message: string
): CanvasNodeRecord {
  return createCanvasNode(
    "code",
    x,
    y,
    `Set ${DAEMON_STAGE_FINISHED_MESSAGE_FIELD_NAME} to "${message}"`,
    {
      actionType: "code",
      actionTypeSource: "auto",
      [NODE_EXECUTABLE_CODE_OPS_DATA_KEY]: [
        {
          kind: "set_field",
          field: DAEMON_STAGE_FINISHED_MESSAGE_FIELD_NAME,
          source: { kind: "constant", value: message },
        },
      ],
    }
  );
}

function createDisplayStageFinishedMessageNode(
  x: number,
  y: number,
  message: string
): CanvasNodeRecord {
  return createCanvasNode(
    "display",
    x,
    y,
    `Display text: ${message}`,
    {
      displayType: "text",
      inputVariable: DAEMON_STAGE_FINISHED_MESSAGE_FIELD_NAME,
    }
  );
}

function buildClearNewEventsCodeNodeData(): Record<string, unknown> {
  return {
    actionType: "code",
    actionTypeSource: "auto",
    [NODE_EXECUTABLE_CODE_OPS_DATA_KEY]: [
      {
        kind: "set_field",
        field: NEW_EVENTS_FIELD_NAME,
        source: { kind: "constant", value: [] },
      },
    ],
  };
}

function createCanvasEdge(
  source: string,
  target: string,
  sourceHandle?: string | null
): CanvasEdgeRecord {
  return {
    id: stableDaemonId("edge", [source, target, sourceHandle ?? ""]),
    source,
    target,
    ...(sourceHandle ? { sourceHandle } : {}),
  };
}

function createDaemonRuntimeWorkflowCanvas(): CanvasDoc {
  const start = createCanvasNode(
    "start",
    120,
    250,
    "Start a daemon build conversation. The environment role is the automated environment agent in automated mode, and the human user in conversation mode."
  );
  const understand = createCanvasNode(
    "stage",
    380,
    250,
    [
      "Understand Target Workflow",
      "Primary and environment establish the real process: participating roles, environment, observations, reward/success signal, actions, and enough constraints to draft a temporal workflow.",
    ].join("\n"),
    {
      workflowOverview: true,
      runtimeRole: "workflow_overview",
      workflowStageId: "understand-target-workflow",
      workflowStageName: "Understand Target Workflow",
      childPolicyCanvasName: DAEMON_PROCESS_CANVAS_NAME,
    }
  );
  const approve = createCanvasNode(
    "stage",
    690,
    250,
    [
      "Approve Workflow Shape",
      "Primary drafts or revises the workflow canvas; environment reviews stages, handoffs, loops, and participating roles until the shape is accepted.",
    ].join("\n"),
    {
      workflowOverview: true,
      runtimeRole: "workflow_overview",
      workflowStageId: "approve-workflow-shape",
      workflowStageName: "Approve Workflow Shape",
      childPolicyCanvasName: DAEMON_WORKFLOW_REVIEW_CANVAS_NAME,
    }
  );
  const boundaries = createCanvasNode(
    "stage",
    1000,
    250,
    [
      "Choose Agent Boundaries",
      "Primary proposes which workflow participants are built, imported from templates, or user-played; environment confirms or revises the boundary plan.",
    ].join("\n"),
    {
      workflowOverview: true,
      runtimeRole: "workflow_overview",
      workflowStageId: "choose-agent-boundaries",
      workflowStageName: "Choose Agent Boundaries",
      childPolicyCanvasName: DAEMON_AGENT_BOUNDARY_CANVAS_NAME,
    }
  );
  const build = createCanvasNode(
    "stage",
    1310,
    250,
    [
      "Build Runnable Draft",
      "Primary creates the executable setup from the approved workflow and boundaries: state/policy/reward canvases, agent connections, tools, skills, datasets, and derived prompts.",
    ].join("\n"),
    {
      workflowOverview: true,
      runtimeRole: "workflow_overview",
      workflowStageId: "build-runnable-draft",
      workflowStageName: "Build Runnable Draft",
      childPolicyCanvasName: DAEMON_BUILD_RUNNABLE_DRAFT_CANVAS_NAME,
    }
  );
  const review = createCanvasNode(
    "stage",
    1620,
    250,
    [
      "Review And Iterate",
      "Environment inspects the draft or simulation results; feedback returns to workflow shape, boundaries, or implementation edits depending on what is wrong.",
    ].join("\n"),
    {
      workflowOverview: true,
      runtimeRole: "workflow_overview",
      workflowStageId: "review-and-iterate",
      workflowStageName: "Review And Iterate",
      childPolicyCanvasName: DAEMON_REVIEW_ITERATE_CANVAS_NAME,
    }
  );

  const entry: CanvasEntry = {
    id: daemonCanvasStorageId("workflow", DAEMON_RUNTIME_WORKFLOW_CANVAS_NAME),
    name: DAEMON_RUNTIME_WORKFLOW_CANVAS_NAME,
    freeText: [
      WORKFLOW_OVERVIEW_CANVAS_MARKER,
      "This workflow canvas is the shared high-level process for daemon primary/environment turns. Each stage can involve both participants; policy and state canvases contain the implementation detail for each stage.",
    ].join("\n"),
    graph: {
      nodes: [start, understand, approve, boundaries, build, review],
      edges: [
        createCanvasEdge(start.id, understand.id),
        createCanvasEdge(understand.id, approve.id),
        createCanvasEdge(approve.id, boundaries.id),
        createCanvasEdge(boundaries.id, build.id),
        createCanvasEdge(build.id, review.id),
        createCanvasEdge(approve.id, understand.id, "workflow-loop"),
        createCanvasEdge(boundaries.id, approve.id, "workflow-loop"),
        createCanvasEdge(review.id, approve.id, "workflow-loop"),
        createCanvasEdge(review.id, boundaries.id, "workflow-loop"),
        createCanvasEdge(review.id, build.id, "workflow-loop"),
      ],
    },
  };

  return {
    version: 2,
    activeId: entry.id,
    canvases: [entry],
  };
}

function createActionChainCanvas(args: {
  name: string;
  intro: string;
  actions: string[];
  freeText?: string;
}): CanvasEntry {
  const start = createCanvasNode("start", 540, 40, args.intro);
  const nodes: CanvasNodeRecord[] = [start];
  const edges: CanvasEdgeRecord[] = [];
  const horizontalSpacing = 320;
  const firstX = Math.max(60, 540 - ((args.actions.length - 1) * horizontalSpacing) / 2);

  args.actions.forEach((action, index) => {
    const actionNode = createCanvasNode(
      "prompt",
      firstX + index * horizontalSpacing,
      220,
      action
    );
    nodes.push(actionNode);
    edges.push(createCanvasEdge(start.id, actionNode.id));
  });

  return {
    id: daemonCanvasStorageId("policy", args.name),
    name: args.name,
    freeText: args.freeText?.trim() ?? "",
    graph: {
      nodes,
      edges,
    },
  };
}

function createProcessClarificationCanvas(): CanvasEntry {
  const stageFinishedMessage = buildDaemonStageFinishedMessage(
    DAEMON_PROCESS_CANVAS_NAME
  );
  const start = createCanvasNode(
    "start",
    560,
    40,
    "Use this subtree while the overall process on the right is still underspecified, or while it is cohesive but still not specific enough to seed the first workflow canvas confidently."
  );
  const processReadyGate = createCanvasNode(
    "condition",
    560,
    180,
    "process_ready is true"
  );
  const setStageFinishedMessage = createSetStageFinishedMessageCodeNode(
    900,
    180,
    stageFinishedMessage
  );
  const displayStageFinishedMessage = createDisplayStageFinishedMessageNode(
    1240,
    180,
    stageFinishedMessage
  );
  const moveImmediately = createCanvasNode(
    "terminate_stage_immediate",
    1580,
    180,
    "Stage complete; move to the next stage state canvas immediately.",
    {
      nextStageId: DAEMON_WORKFLOW_STAGE_APPROVE,
    }
  );
  const scopeGuard = createCanvasNode(
    "prompt",
    560,
    340,
    [
      "Do not start filling in the target draft form, workflow canvas, state schema, policy canvas, datasets, tools, skills, or agentConnections here.",
      "Use assistantReplyIntent=ask unless the main canvas has already routed away from process clarification because process_ready is true.",
      "Respect the process_model, process_description, session_rules, user_requests, user_edit_requests, user_tooling_requests, user_skill_requests, user_environment_agent_requests, process_open_questions, and process_ready values produced by the visible state canvas.",
    ].join(" ")
  );
  const missingRequiredFieldGate = createCanvasNode(
    "condition",
    560,
    500,
    "a required onboarding field is missing: participating agents or roles, Environment, Observation, Reward, or Action"
  );
  const askMissingRequiredField = createCanvasNode(
    "prompt",
    160,
    700,
    `Ask exactly one focused question for the most important missing required onboarding field. Do not ask about optional State Update or Policy details while any required field is still missing. ${DAEMON_TYPICAL_ANSWER_CHOICE_INSTRUCTION}`
  );
  const stillNotSpecificGate = createCanvasNode(
    "condition",
    900,
    700,
    "all required onboarding fields are present, but the process is still not specific enough to seed the first workflow canvas confidently"
  );
  const optionalStatePolicyGate = createCanvasNode(
    "condition",
    720,
    900,
    "optional State Update or Policy details would remove the main remaining ambiguity"
  );
  const askOptionalStatePolicyDetail = createCanvasNode(
    "prompt",
    420,
    1100,
    `Ask exactly one focused question about the optional State Update or Policy detail that would remove the main ambiguity. ${DAEMON_TYPICAL_ANSWER_CHOICE_INSTRUCTION}`
  );
  const askWeakestComponent = createCanvasNode(
    "prompt",
    980,
    1100,
    `Ask exactly one focused question about the weakest remaining process component. If the process is already cohesive enough to derive a broad target description but not yet ready for seeding, ask for more detail about that weakest component rather than switching to target draft construction. ${DAEMON_TYPICAL_ANSWER_CHOICE_INSTRUCTION}`
  );
  const noClarificationNeeded = createCanvasNode(
    "prompt",
    1280,
    900,
    "If no process clarification is actually needed, do not emit target draft artifacts in this subtree. Let the next main-canvas route handle workflow drafting after process_ready is true."
  );

  return {
    id: daemonCanvasStorageId("policy", DAEMON_PROCESS_CANVAS_NAME),
    name: DAEMON_PROCESS_CANVAS_NAME,
    freeText:
      "This process-clarification subtree is intentionally conditional: it first checks for missing required onboarding fields, then asks about optional state/policy detail only when that is the remaining blocker, otherwise asks about the weakest remaining process component.",
    graph: {
      nodes: [
        start,
        processReadyGate,
        setStageFinishedMessage,
        displayStageFinishedMessage,
        moveImmediately,
        scopeGuard,
        missingRequiredFieldGate,
        askMissingRequiredField,
        stillNotSpecificGate,
        optionalStatePolicyGate,
        askOptionalStatePolicyDetail,
        askWeakestComponent,
        noClarificationNeeded,
      ],
      edges: [
        createCanvasEdge(start.id, processReadyGate.id),
        createCanvasEdge(
          processReadyGate.id,
          setStageFinishedMessage.id,
          "true"
        ),
        createCanvasEdge(
          setStageFinishedMessage.id,
          displayStageFinishedMessage.id
        ),
        createCanvasEdge(displayStageFinishedMessage.id, moveImmediately.id),
        createCanvasEdge(processReadyGate.id, scopeGuard.id, "false"),
        createCanvasEdge(scopeGuard.id, missingRequiredFieldGate.id),
        createCanvasEdge(
          missingRequiredFieldGate.id,
          askMissingRequiredField.id,
          "true"
        ),
        createCanvasEdge(
          missingRequiredFieldGate.id,
          stillNotSpecificGate.id,
          "false"
        ),
        createCanvasEdge(
          stillNotSpecificGate.id,
          optionalStatePolicyGate.id,
          "true"
        ),
        createCanvasEdge(
          stillNotSpecificGate.id,
          noClarificationNeeded.id,
          "false"
        ),
        createCanvasEdge(
          optionalStatePolicyGate.id,
          askOptionalStatePolicyDetail.id,
          "true"
        ),
        createCanvasEdge(
          optionalStatePolicyGate.id,
          askWeakestComponent.id,
          "false"
        ),
      ],
    },
  };
}

function createWorkflowReviewCanvas(): CanvasEntry {
  const start = createCanvasNode(
    "start",
    560,
    40,
    "Use this subtree only after process_ready is true and before workflow_decomposition_complete is true. Route workflow review visibly: first create the missing workflow, otherwise revise commented workflows, otherwise partition approved oversized stages, otherwise stop asking for the same workflow approval."
  );
  const resetWorkflowBoundaryHandoff = createCanvasNode(
    "code",
    560,
    180,
    "Set workflow_ready_for_agent_boundary_selection to false before reviewing the workflow.",
    {
      [NODE_EXECUTABLE_CODE_OPS_DATA_KEY]: [
        {
          kind: "set_local",
          field: "summary",
          name: DAEMON_WORKFLOW_READY_FOR_BOUNDARY_SELECTION_OUTPUT.name,
          source: { kind: "constant", value: false },
        },
      ],
    }
  );
  const scopeGuard = createCanvasNode(
    "prompt",
    560,
    320,
    [
      "Keep workflow canvases at the abstraction level: stage descriptions, transition structure, conditions, and participating agents only.",
      "Do not put per-stage state, policy, reward logic, datasets, tools, agentSkills, agentConnections, stateFields, policySeed, initialPolicyCanvasShape, initialPolicyCanvasStructure, initialStateCanvasShape, initialStateCanvasStructure, or implementation canvasEdits into this workflow-review pass.",
    ].join(" ")
  );
  const missingWorkflowGate = createCanvasNode(
    "condition",
    560,
    480,
    "current_build.workflow.canvas_count is 0"
  );
  const createOverallWorkflow = createCanvasNode(
    "prompt",
    120,
    660,
    "If no workflow canvas exists yet, emit workflowStages in the structured planner patch to create the editable Overall Workflow canvas. Use the confirmed process facts, participating agent descriptions, current_build.workflow if present, and the latest expert comments to choose the main stages, transitions, entry/completion conditions, and participating agents."
  );
  const workflowApprovedGate = createCanvasNode(
    "condition",
    800,
    660,
    "workflow_approved is false"
  );
  const expertCommentGate = createCanvasNode(
    "condition",
    620,
    840,
    "the latest expert response asks for workflow changes or corrections"
  );
  const reviseWorkflow = createCanvasNode(
    "prompt",
    260,
    1040,
    "If the expert comments on the current Overall Workflow canvas, revise workflowStages and ask again. If the expert comments on a child stage workflow canvas, emit workflowStagePartitions for that same parent stage and ask again."
  );
  const askForWorkflowApproval = createCanvasNode(
    "prompt",
    920,
    1040,
    `A workflow canvas exists and has not been approved. If the latest expert response gives no concrete corrections and does not approve, ask a direct workflow-review question rather than seeding implementation artifacts. ${DAEMON_TYPICAL_ANSWER_CHOICE_INSTRUCTION}`
  );
  const partitionNeededGate = createCanvasNode(
    "condition",
    1120,
    840,
    "after inspecting current_build.workflow, an approved stage is still a big operation that benefits from partitioning into a child workflow canvas"
  );
  const partitionStage = createCanvasNode(
    "prompt",
    920,
    1240,
    `Emit exactly one workflowStagePartitions item to create or update a child workflow canvas for that parent stage, then ask whether that child stage breakdown looks right. Repeat on later turns until no stage needs further partitioning. Do not replace the approved Overall Workflow canvas while doing this. ${DAEMON_TYPICAL_ANSWER_CHOICE_INSTRUCTION}`
  );
  const completeWorkflowReview = createCanvasNode(
    "code",
    1320,
    1240,
    "No workflow changes or approval question are needed in this workflow-review pass.",
    {
      actionType: "code",
      actionTypeSource: "auto",
      [NODE_EXECUTABLE_CODE_OPS_DATA_KEY]: [],
    }
  );
  const encodeTransitions = createCanvasNode(
    "prompt",
    260,
    1420,
    "Populate workflowStages[].nextStageIds or workflowStagePartitions[].stages[].nextStageIds with the actual temporal transitions. If the process repeats, retries, revises, evaluates again, or returns to an earlier stage, include the earlier stage id so the rendered workflow has a visible loop/back-edge."
  );
  const changedWorkflowReply = createCanvasNode(
    "prompt",
    620,
    1600,
    `When this pass creates or revises a workflow canvas, set assistantReplyIntent=ask and assistantMessage to show that changed workflow to the expert and ask whether it looks right. In conversation mode the user is the expert; in automated generation mode the daemon environment agent is the expert. If the latest response approved the current workflow and no child partition is needed, do not ask for workflow approval again. ${DAEMON_TYPICAL_ANSWER_CHOICE_INSTRUCTION}`
  );
  const decideWorkflowBoundaryHandoff = createCanvasNode(
    "action",
    980,
    1780,
    DAEMON_DECIDE_WORKFLOW_BOUNDARY_HANDOFF_LABEL,
    {
      promptOutputFields: [DAEMON_WORKFLOW_READY_FOR_BOUNDARY_SELECTION_OUTPUT],
    }
  );

  return {
    id: daemonCanvasStorageId("policy", DAEMON_WORKFLOW_REVIEW_CANVAS_NAME),
    name: DAEMON_WORKFLOW_REVIEW_CANVAS_NAME,
    freeText:
      "This workflow-review subtree is intentionally conditional: the canvas decides whether to create the missing Overall Workflow, revise commented workflow canvases, partition an approved oversized stage, or stop asking for duplicate workflow approval.",
    graph: {
      nodes: [
        start,
        resetWorkflowBoundaryHandoff,
        scopeGuard,
        missingWorkflowGate,
        createOverallWorkflow,
        workflowApprovedGate,
        expertCommentGate,
        reviseWorkflow,
        askForWorkflowApproval,
        partitionNeededGate,
        partitionStage,
        completeWorkflowReview,
        encodeTransitions,
        changedWorkflowReply,
        decideWorkflowBoundaryHandoff,
      ],
      edges: [
        createCanvasEdge(start.id, resetWorkflowBoundaryHandoff.id),
        createCanvasEdge(resetWorkflowBoundaryHandoff.id, scopeGuard.id),
        createCanvasEdge(scopeGuard.id, missingWorkflowGate.id),
        createCanvasEdge(missingWorkflowGate.id, createOverallWorkflow.id, "true"),
        createCanvasEdge(missingWorkflowGate.id, workflowApprovedGate.id, "false"),
        createCanvasEdge(createOverallWorkflow.id, encodeTransitions.id),
        createCanvasEdge(workflowApprovedGate.id, expertCommentGate.id, "true"),
        createCanvasEdge(workflowApprovedGate.id, partitionNeededGate.id, "false"),
        createCanvasEdge(expertCommentGate.id, reviseWorkflow.id, "true"),
        createCanvasEdge(expertCommentGate.id, askForWorkflowApproval.id, "false"),
        createCanvasEdge(reviseWorkflow.id, encodeTransitions.id),
        createCanvasEdge(partitionNeededGate.id, partitionStage.id, "true"),
        createCanvasEdge(partitionNeededGate.id, completeWorkflowReview.id, "false"),
        createCanvasEdge(partitionStage.id, encodeTransitions.id),
        createCanvasEdge(encodeTransitions.id, changedWorkflowReply.id),
        createCanvasEdge(changedWorkflowReply.id, decideWorkflowBoundaryHandoff.id),
        createCanvasEdge(askForWorkflowApproval.id, decideWorkflowBoundaryHandoff.id),
        createCanvasEdge(completeWorkflowReview.id, decideWorkflowBoundaryHandoff.id),
      ],
    },
  };
}

function createDaemonSkillCreationCanvas(): CanvasEntry {
  const start = createCanvasNode(
    "start",
    540,
    40,
    "Use this subtree only when user_skill_requests is not empty and the structured draft already exists."
  );
  const createSkills = createCanvasNode(
    "prompt",
    540,
    220,
    `Handle pending skill creation requests only after agent boundaries are confirmed. If user_skill_requests or agent_latest_observation asks to create a new temporally extended skill for an automated workflow agent, emit concrete agentSkills[] seed objects keyed by the owning workflow agentId, or put stage-specific target-side behavior in the matching agentConnections[] item. For 'add skill: if X then Y' requests, set startCondition from X, put Y in policySeed execution/response text, and set terminationCondition from any stated duration such as 'until the end of the conversation'. If X mentions a user-played participant, represent it as a handoff/input condition rather than autonomous behavior for that participant. Source-side pairwise interaction behavior belongs in sourcePolicySeed/sourceInitialPolicyCanvasShape/sourceInitialPolicyCanvasStructure. Do not emit agentConnections[].policySeed or top-level skills[]. If a matching skill already exists, treat the request as fulfilled or as an existing-skill edit routed through user_edit_requests; do not add a duplicate skill. If the requested skill is too ambiguous to seed safely, ask one focused clarification question and do not claim an update. ${DAEMON_TYPICAL_ANSWER_CHOICE_INSTRUCTION}`
  );
  const finalize = createCanvasNode(
    "prompt",
    540,
    400,
    "Return a structured planner patch containing only the represented agentSkills[] additions or a focused clarification/review response. Set assistantReplyIntent=report_update only when the patch adds a skill."
  );

  return {
    id: daemonCanvasStorageId("policy", DAEMON_SKILL_CREATION_CANVAS_NAME),
    name: DAEMON_SKILL_CREATION_CANVAS_NAME,
    freeText:
      "This subtree handles pending new-skill requests. Existing skill edits and skill tool placement belong to the refine/tooling paths.",
    graph: {
      nodes: [start, createSkills, finalize],
      edges: [
        createCanvasEdge(start.id, createSkills.id),
        createCanvasEdge(createSkills.id, finalize.id),
      ],
    },
  };
}

function createDaemonEnvironmentAgentCreationCanvas(): CanvasEntry {
  const start = createCanvasNode(
    "start",
    540,
    40,
    "Use this subtree only when user_environment_agent_requests is not empty and the structured draft already exists. In target drafts, satisfy these requests with agentConnections, not embedded environment agents."
  );
  const createEnvironmentAgents = createCanvasNode(
    "prompt",
    540,
    220,
    `Handle pending connected-agent creation requests only after agent boundaries are confirmed. If user_environment_agent_requests or agent_latest_observation asks to add or create another workflow agent, simulated counterpart, client, customer, patient, user, reviewer, manager, or other participant, return a structured planner patch with one or more concrete agentConnections seed objects that respect agent_boundary_plan. Every connection must include targetAgentId, and should include sourceAgentId when the source workflow agent is known; use existing workflow agent IDs when supplied, otherwise create short stable IDs and titles. Each connection may include sourcePolicySeed/sourceInitialPolicyCanvasShape/sourceInitialPolicyCanvasStructure for the source agent's pairwise interaction policy, and should include targetPolicySeed/targetInitialPolicyCanvasShape/targetInitialPolicyCanvasStructure for a built target agent's own behavior plus targetInitialStateCanvasShape or targetInitialStateCanvasStructure when target state needs project-specific behavior. Each connection should also include sourceRewardSeed/sourceInitialRewardCanvasShape/sourceInitialRewardCanvasStructure for reward delivered to the target after a source action, and targetRewardSeed/targetInitialRewardCanvasShape/targetInitialRewardCanvasStructure for reward delivered to the source after a target action. Do not emit agentConnections[].policySeed or agentConnections[].initialPolicyCanvasShape. Use a Call Agent node when the source-side pairwise policy needs to call another agent. Use a Terminate node only after the current pairwise task is complete; Terminate ends the whole interaction with no future turns, not just the current turn. If a matching connection already exists, treat the request as fulfilled or as an existing-connection edit routed through user_edit_requests; do not add a duplicate connection. If the target agent ID or scenario is too ambiguous to seed safely, ask one focused clarification question or report review, and do not claim an update. Set assistantReplyIntent=report_update only when the patch creates or updates an agent connection. ${DAEMON_TYPICAL_ANSWER_CHOICE_INSTRUCTION}`
  );

  return {
    id: daemonCanvasStorageId(
      "policy",
      DAEMON_ENVIRONMENT_AGENT_CREATION_CANVAS_NAME
    ),
    name: DAEMON_ENVIRONMENT_AGENT_CREATION_CANVAS_NAME,
    freeText:
      "This subtree handles pending new agent-connection requests. Existing connection edits and connection tool placement belong to the refine/tooling paths.",
    graph: {
      nodes: [start, createEnvironmentAgents],
      edges: [createCanvasEdge(start.id, createEnvironmentAgents.id)],
    },
  };
}

function createDaemonEditingCanvas(): CanvasEntry {
  const start = createCanvasNode(
    "start",
    540,
    40,
    "Route direct draft edits through an explicit edit-planning subtree before emitting the structured planner patch."
  );
  const decomposeEdits = createCanvasNode(
    "prompt",
    540,
    400,
    "Decompose agent_latest_observation into either independent node/edge edit units or one related ordered sequence of edits to a single canvas. Preserve user wording that identifies anchors, target agents, target canvases, and intended placement."
  );
  const independentEditsGate = createCanvasNode(
    "condition",
    540,
    580,
    "the requested edits are independent rather than one related sequence"
  );
  const planIndependentEdits = createCanvasNode(
    "prompt",
    220,
    760,
    "For independent edit units, apply the routing procedure separately to each unit. Do not let an unresolved unit block unrelated units that can be represented safely."
  );
  const planRelatedSequence = createCanvasNode(
    "prompt",
    860,
    760,
    "For one related edit sequence, keep the atomic edits ordered on the same target canvas. Share anchors and nodeKey aliases across the sequence where later edits depend on earlier added nodes."
  );
  const chooseAgents = createCanvasNode(
    "prompt",
    540,
    940,
    "Determine which graph target receives each edit unit or sequence. Primary-agent edits omit connection selectors. Pairwise connected-agent edits must use agentConnectionId or targetAgentId on canvasEdits/toolPlacements and should edit that connection's policy canvas; do not create or target embedded environment agents for new drafts. Legacy environment selectors may only be used when the current draft already has visible legacy environmentPlayers."
  );
  const chooseCanvases = createCanvasNode(
    "prompt",
    540,
    1120,
    "For each targeted agent edit, determine which canvas receives the edit. Use policy or state for canvasEdits and toolPlacements. If the request edits an existing skill definition, update the matching owning agent's skill through agentSkills[] by agentId and name with replaceExisting when appropriate rather than adding a duplicate skill. If the request needs direct node or tool placement inside an existing skill canvas, set skillName or skillId plus optional skillCanvas=policy/start_condition/termination_condition on canvasEdits or toolPlacements so the patch targets the nested skill canvas instead of the main agent canvas."
  );
  const planConditionalRuntimeBehavior = createCanvasNode(
    "prompt",
    540,
    1300,
    "For conditional runtime behavior edits phrased as if/when/unless X then Y, represent the behavior visibly on the target policy canvas. Add or update a condition node for X, put Y on the true branch, and preserve the existing default policy flow on the false branch. If Y includes a tool/capability plus a summary or user-facing output, include the tool_call node, any prompt or prompt_transform node needed to summarize the result, and an editable display text node for the value to show."
  );
  const classifyAtomicEdits = createCanvasNode(
    "prompt",
    540,
    1480,
    "Classify every atomic canvas edit as changing, deleting, or adding a node or edge. Represent a change as update_node/update_edge when precise, or delete plus add when that is clearer or safer."
  );
  const locateAdditions = createCanvasNode(
    "prompt",
    540,
    1660,
    "For every added node or edge, choose an explicit location. Use insert_node_before or insert_node_after when the user names an existing anchor. If no anchor is named, append before the final Display/End path or create a clear branch from the nearest relevant condition. Otherwise create a location with add_node x/y plus add_edge operations. Use nodeKey aliases whenever later edits need to reference newly added nodes."
  );
  const toolPlacementGate = createCanvasNode(
    "condition",
    540,
    1840,
    "one or more atomic additions place a tool or capability node"
  );
  const emitToolPlacement = createCanvasNode(
    "prompt",
    220,
    2020,
    "For each tool or capability node placement, emit toolPlacements with target, agentTarget, placement, anchorRef, querySource when specified, and tool sourceType. Reuse an existing matching capability when present. Add a toolRequests sidecar only when standalone scaffolding is also needed."
  );
  const emitCanvasEdits = createCanvasNode(
    "prompt",
    860,
    2020,
    "For non-tool canvas edits and any remaining wiring around placed tools, emit canvasEdits with target, agentTarget, op, node/edge refs, data, and placement details. Use nodeRef.actionType when matching subtypes such as prompt_transform."
  );
  const finalizePatch = createCanvasNode(
    "prompt",
    540,
    2200,
    `Return a structured planner patch that includes the represented direct draft edits and sets assistantReplyIntent=report_update only when the patch changes the draft. If the requested edit is impossible or ambiguous, use assistantReplyIntent=report_review or ask one focused clarification question instead of claiming an update. ${DAEMON_TYPICAL_ANSWER_CHOICE_INSTRUCTION}`
  );

  return {
    id: daemonCanvasStorageId("policy", DAEMON_EDITING_CANVAS_NAME),
    name: DAEMON_EDITING_CANVAS_NAME,
    freeText:
      "This subtree makes direct draft-edit routing visible: decompose the request, choose the target agent scope, choose the target canvas, classify each atomic node/edge edit, choose explicit placement, and only then emit canvasEdits, toolPlacements, existing-skill updates, or a clarification/review response. New skill and environment-agent creation are handled by separate subtrees.",
    graph: {
      nodes: [
        start,
        decomposeEdits,
        independentEditsGate,
        planIndependentEdits,
        planRelatedSequence,
        chooseAgents,
        chooseCanvases,
        planConditionalRuntimeBehavior,
        classifyAtomicEdits,
        locateAdditions,
        toolPlacementGate,
        emitToolPlacement,
        emitCanvasEdits,
        finalizePatch,
      ],
      edges: [
        createCanvasEdge(start.id, decomposeEdits.id),
        createCanvasEdge(decomposeEdits.id, independentEditsGate.id),
        createCanvasEdge(independentEditsGate.id, planIndependentEdits.id, "true"),
        createCanvasEdge(independentEditsGate.id, planRelatedSequence.id, "false"),
        createCanvasEdge(planIndependentEdits.id, chooseAgents.id),
        createCanvasEdge(planRelatedSequence.id, chooseAgents.id),
        createCanvasEdge(chooseAgents.id, chooseCanvases.id),
        createCanvasEdge(chooseCanvases.id, planConditionalRuntimeBehavior.id),
        createCanvasEdge(planConditionalRuntimeBehavior.id, classifyAtomicEdits.id),
        createCanvasEdge(classifyAtomicEdits.id, locateAdditions.id),
        createCanvasEdge(locateAdditions.id, toolPlacementGate.id),
        createCanvasEdge(toolPlacementGate.id, emitToolPlacement.id, "true"),
        createCanvasEdge(toolPlacementGate.id, emitCanvasEdits.id, "false"),
        createCanvasEdge(emitToolPlacement.id, emitCanvasEdits.id),
        createCanvasEdge(emitCanvasEdits.id, finalizePatch.id),
      ],
    },
  };
}

function createDaemonStateCanvas(): CanvasDoc {
  const stageRoutingInstruction = [
    `Always set ${DAEMON_WORKFLOW_STAGE_FIELD_NAME} to exactly one of: ${DAEMON_WORKFLOW_STAGE_UNDERSTAND}, ${DAEMON_WORKFLOW_STAGE_APPROVE}, ${DAEMON_WORKFLOW_STAGE_BOUNDARIES}, ${DAEMON_WORKFLOW_STAGE_BUILD}, ${DAEMON_WORKFLOW_STAGE_REVIEW}.`,
    `Use ${DAEMON_WORKFLOW_STAGE_UNDERSTAND} while process_ready is false.`,
    `Use ${DAEMON_WORKFLOW_STAGE_APPROVE} when process_ready is true and workflow_decomposition_complete is false, or when the latest expert/environment response asks to revise workflow stages, loops, handoffs, transitions, or decomposition.`,
    `Use ${DAEMON_WORKFLOW_STAGE_BOUNDARIES} when workflow_decomposition_complete is true and agent_boundaries_confirmed is false, or when the latest response asks to revise which agents are built, imported, or user-played.`,
    `Use ${DAEMON_WORKFLOW_STAGE_BUILD} when workflow decomposition and boundaries are confirmed but structured_draft_exists is false.`,
    `Use ${DAEMON_WORKFLOW_STAGE_REVIEW} after a structured draft exists unless the latest response explicitly reopens workflow shape or agent-boundary decisions.`,
    "Do not advance to a later stage while an earlier checkpoint is still false. Backward loops are allowed when the latest review reopens an earlier checkpoint.",
  ].join(" ");

  const withStageRouting = (instruction: string): string =>
    [instruction, stageRoutingInstruction].join("\n\n");

  const createStageStateCanvas = (args: {
    name: string;
    stageLabel: string;
    freeText: string;
    instruction: string;
  }): CanvasEntry => {
    const start = createCanvasNode(
      "start",
      460,
      40,
      [
        `Primary state stage: ${args.stageLabel}.`,
        "This canvas is self-contained for one turn: it syncs current_build, appends the latest observation/reward event, maintains long memory, then updates this stage's state and stage handoff field.",
      ].join(" ")
    );
    const buildCurrentBuild = createCanvasNode(
      "action",
      460,
      190,
      DAEMON_BUILD_CURRENT_BUILD_LABEL,
      {
        actionType: "code",
        actionTypeSource: "auto",
        [NODE_EXECUTABLE_CODE_OPS_DATA_KEY]: [
          {
            kind: "set_field",
            field: "current_build",
            source: { kind: "current_build_snapshot" },
          },
        ],
      }
    );
    const appendConversationTurns = createCanvasNode(
      "action",
      460,
      350,
      "Add agent_latest_observation and agent_latest_reward to new_events.",
      {
        actionType: "code",
        actionTypeSource: "auto",
        [NODE_EXECUTABLE_CODE_OPS_DATA_KEY]: [
          {
            kind: "append_list_item",
            field: NEW_EVENTS_FIELD_NAME,
            source: { kind: "latest_observation_and_reward_event" },
          },
        ],
        [NODE_LOCAL_INPUTS_DATA_KEY]: [
          {
            name: PRIMARY_AGENT_LATEST_OBSERVATION_FIELD_NAME,
            type: "string",
          },
          {
            name: PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME,
            type: "number",
          },
        ],
      }
    );
    const summaryMemoryGate = createCanvasNode(
      "condition",
      460,
      510,
      `summary plus new_events exceeds ${DEFAULT_CONVERSATION_MEMORY_LIMIT} characters`
    );
    const summarizeConversationMemory = createCanvasNode(
      "prompt",
      180,
      690,
      "Update summary with a concise summary of summary plus new_events."
    );
    const clearConversationMemory = createCanvasNode(
      "code",
      180,
      860,
      "Set new_events to empty list.",
      buildClearNewEventsCodeNodeData()
    );
    const stageState = createCanvasNode(
      "prompt",
      720,
      690,
      withStageRouting(args.instruction)
    );

    return {
      id: daemonCanvasStorageId("state", args.name),
      name: args.name,
      freeText: args.freeText,
      graph: {
        nodes: [
          start,
          buildCurrentBuild,
          appendConversationTurns,
          summaryMemoryGate,
          summarizeConversationMemory,
          clearConversationMemory,
          stageState,
        ],
        edges: [
          createCanvasEdge(start.id, buildCurrentBuild.id),
          createCanvasEdge(buildCurrentBuild.id, appendConversationTurns.id),
          createCanvasEdge(appendConversationTurns.id, summaryMemoryGate.id),
          createCanvasEdge(summaryMemoryGate.id, summarizeConversationMemory.id, "true"),
          createCanvasEdge(summaryMemoryGate.id, stageState.id, "false"),
          createCanvasEdge(summarizeConversationMemory.id, clearConversationMemory.id),
          createCanvasEdge(clearConversationMemory.id, stageState.id),
        ],
      },
    };
  };

  const understandStateCanvas = createStageStateCanvas({
    name: DAEMON_UNDERSTAND_STATE_CANVAS_NAME,
    stageLabel: "Understand Target Workflow",
    freeText:
      "Self-contained primary state canvas for understanding the target workflow, process facts, readiness, session rules, and request queues.",
    instruction: DAEMON_DERIVE_PROCESS_STATE_LABEL,
  });

  const workflowShapeStateCanvas = createStageStateCanvas({
    name: DAEMON_WORKFLOW_SHAPE_STATE_CANVAS_NAME,
    stageLabel: "Approve Workflow Shape",
    freeText:
      "Self-contained primary state canvas for workflow approval and decomposition checkpoints.",
    instruction: [
      "Use current_build.workflow, the latest expert/environment response, process_ready, workflow_approved, and workflow_decomposition_complete to maintain the workflow checkpoint.",
      "Set workflow_approved=false when a workflow canvas is missing, newly changed, or the latest response requests stage, transition, loop, handoff, or participant changes.",
      "Set workflow_approved=true only when the latest visible workflow canvas is approved without requested changes.",
      "Set workflow_decomposition_complete=true only when the approved workflow hierarchy is specific enough for implementation canvases; otherwise identify the next oversized stage that needs a child workflow canvas.",
      "When workflow approval or decomposition changes, keep agent_boundaries_confirmed=false unless the existing boundary plan still names every participating workflow agent and remains valid.",
    ].join(" "),
  });

  const boundaryStateCanvas = createStageStateCanvas({
    name: DAEMON_BOUNDARY_STATE_CANVAS_NAME,
    stageLabel: "Choose Agent Boundaries",
    freeText:
      "Self-contained primary state canvas for agent boundary plan and confirmation checkpoint.",
    instruction: DAEMON_DERIVE_AGENT_BOUNDARY_STATE_LABEL,
  });

  const buildStateCanvas = createStageStateCanvas({
    name: DAEMON_BUILD_STATE_CANVAS_NAME,
    stageLabel: "Build Runnable Draft",
    freeText:
      "Self-contained primary state canvas for build inventory facts after the runnable draft is created or structurally changed.",
    instruction: DAEMON_DERIVE_REMAINING_STATE_LABEL,
  });

  const reviewStateCanvas = createStageStateCanvas({
    name: DAEMON_REVIEW_STATE_CANVAS_NAME,
    stageLabel: "Review And Iterate",
    freeText:
      "Self-contained primary state canvas for pending review/edit/tooling/skill/agent requests after the environment or user inspects a runnable draft.",
    instruction: [
      "Use the latest expert/environment response and current_build to update pending review queues after a structured draft exists.",
      "If the response says workflow stages, transitions, loops, handoffs, or decomposition are wrong, set workflow_approved=false and workflow_decomposition_complete=false so control moves back to workflow approval.",
      "If the response says the build/import/user-played boundary is wrong, set agent_boundaries_confirmed=false so control moves back to boundary selection.",
      "Requests to change existing canvas behavior, conditional logic, wording, state fields, agent wiring, or runtime behavior belong in user_edit_requests.",
      "Requests for external capabilities, retrieval, web/search, dataset reads, saving, or tool placement belong in user_tooling_requests when not already covered.",
      "Requests for new temporally extended behavior owned by a workflow agent belong in user_skill_requests.",
      "Requests for new workflow participants, simulated counterparts, clients, reviewers, patients, users, managers, or agent-to-agent interactions belong in user_environment_agent_requests.",
      "Remove items from pending request queues once current_build shows they have been fulfilled or the latest response cancels them; keep user_requests as cumulative memory unless explicitly retracted.",
    ].join(" "),
  });

  return {
    version: 2,
    activeId: understandStateCanvas.id,
    canvases: [
      understandStateCanvas,
      workflowShapeStateCanvas,
      boundaryStateCanvas,
      buildStateCanvas,
      reviewStateCanvas,
    ],
  };
}

interface StageExitBranch {
  conditionLabel: string;
  nextStageId: DaemonWorkflowStageId;
  immediate?: boolean;
  continueOnFalse?: boolean;
}

function appendPrimaryPolicyReplyTail(
  entry: CanvasEntry,
  yOffset = 180,
  stageExitBranches: StageExitBranch[] = []
): CanvasEntry {
  const maxY = Math.max(
    40,
    ...entry.graph.nodes.map((node) => node.position.y)
  );
  const centerX =
    entry.graph.nodes.reduce((sum, node) => sum + node.position.x, 0) /
      Math.max(entry.graph.nodes.length, 1) || 560;
  const finalizeAssistantReplyNode = createCanvasNode(
    "finalize_assistant_reply",
    centerX,
    maxY + yOffset,
    DAEMON_FINALIZE_REPLY_LABEL
  );
  const appendAssistantTurnNode = createAppendAssistantTurnCodeNode(
    centerX,
    maxY + yOffset + 160,
    DAEMON_APPEND_ASSISTANT_TURN_LABEL
  );
  const displayAssistantReplyNode = createDisplayCommittedAgentActionNode(
    centerX,
    maxY + yOffset + 320
  );
  const stageFinishedMessage = buildDaemonStageFinishedMessage(entry.name);
  const stageExitGroups = stageExitBranches.map((branch, index) => {
    const y = maxY + yOffset + 480 + index * 240;
    const gate = createCanvasNode(
      "condition",
      centerX,
      y,
      branch.conditionLabel
    );
    const setStageFinishedMessage = createSetStageFinishedMessageCodeNode(
      centerX + 240,
      y,
      stageFinishedMessage
    );
    const displayStageFinishedMessage = createDisplayStageFinishedMessageNode(
      centerX + 480,
      y,
      stageFinishedMessage
    );
    const terminate = createCanvasNode(
      branch.immediate ? "terminate_stage_immediate" : "terminate_stage",
      centerX + 720,
      y,
      branch.immediate
        ? "Stage complete; move to the next stage state canvas immediately."
        : "Stage complete; next turn is controlled by the next stage canvas.",
      {
        nextStageId: branch.nextStageId,
      }
    );
    const continueNode = branch.continueOnFalse
      ? createCanvasNode(
          "continue",
          centerX - 360,
          y,
          "Stage is not complete; continue this stage next turn."
        )
      : null;
    return {
      gate,
      setStageFinishedMessage,
      displayStageFinishedMessage,
      terminate,
      continueNode,
    };
  });
  const stageExitNodes = stageExitGroups.flatMap(
    ({
      gate,
      setStageFinishedMessage,
      displayStageFinishedMessage,
      terminate,
      continueNode,
    }) =>
      continueNode
        ? [
            gate,
            setStageFinishedMessage,
            displayStageFinishedMessage,
            terminate,
            continueNode,
          ]
        : [gate, setStageFinishedMessage, displayStageFinishedMessage, terminate]
  );
  const outgoingSources = new Set(entry.graph.edges.map((edge) => edge.source));
  const leafNodes = entry.graph.nodes.filter(
    (node) =>
      !outgoingSources.has(node.id) &&
      node.type !== "display" &&
      node.type !== "terminate_stage" &&
      node.type !== "terminate_stage_immediate" &&
      node.type !== "terminate" &&
      node.type !== "continue" &&
      node.type !== "yield"
  );
  const loopNodesMissingDonePath = entry.graph.nodes.filter(
    (node) =>
      (node.type === "while" || node.type === "for") &&
      !entry.graph.edges.some(
        (edge) =>
          edge.source === node.id &&
          (edge.sourceHandle === "done" || edge.sourceHandle === "false")
      )
  );

  return {
    ...entry,
    graph: {
      nodes: [
        ...entry.graph.nodes,
        finalizeAssistantReplyNode,
        appendAssistantTurnNode,
        displayAssistantReplyNode,
        ...stageExitNodes,
      ],
      edges: [
        ...entry.graph.edges,
        ...leafNodes.map((node) =>
          createCanvasEdge(node.id, finalizeAssistantReplyNode.id)
        ),
        ...loopNodesMissingDonePath.map((node) =>
          createCanvasEdge(node.id, finalizeAssistantReplyNode.id, "done")
        ),
        createCanvasEdge(finalizeAssistantReplyNode.id, appendAssistantTurnNode.id),
        createCanvasEdge(appendAssistantTurnNode.id, displayAssistantReplyNode.id),
        ...(stageExitGroups.length > 0
          ? [
              createCanvasEdge(
                displayAssistantReplyNode.id,
                stageExitGroups[0].gate.id
              ),
              ...stageExitGroups.flatMap((group, index) => {
                const nextGate = stageExitGroups[index + 1]?.gate ?? null;
                const falseTarget = nextGate ?? group.continueNode;
                return [
                  createCanvasEdge(
                    group.gate.id,
                    group.setStageFinishedMessage.id,
                    "true"
                  ),
                  createCanvasEdge(
                    group.setStageFinishedMessage.id,
                    group.displayStageFinishedMessage.id
                  ),
                  createCanvasEdge(
                    group.displayStageFinishedMessage.id,
                    group.terminate.id
                  ),
                  ...(falseTarget
                    ? [createCanvasEdge(group.gate.id, falseTarget.id, "false")]
                    : []),
                ];
              }),
            ]
          : []),
      ],
    },
  };
}

function createDaemonPolicyCanvas(
): CanvasDoc {
  const processCanvas = appendPrimaryPolicyReplyTail(
    createProcessClarificationCanvas(),
    180,
    [
      {
        conditionLabel: "process_ready is true",
        nextStageId: DAEMON_WORKFLOW_STAGE_APPROVE,
        immediate: true,
        continueOnFalse: true,
      },
    ]
  );

  const workflowReviewCanvas = appendPrimaryPolicyReplyTail(
    createWorkflowReviewCanvas(),
    180,
    [
      {
        conditionLabel: "workflow_decomposition_complete is true",
        nextStageId: DAEMON_WORKFLOW_STAGE_BOUNDARIES,
        immediate: true,
        continueOnFalse: true,
      },
    ]
  );

  const agentBoundaryCanvas = appendPrimaryPolicyReplyTail(
    createActionChainCanvas({
      name: DAEMON_AGENT_BOUNDARY_CANVAS_NAME,
      intro:
        "Use this stage only after the workflow hierarchy has been approved and decomposed enough for implementation, and before agent_boundaries_confirmed is true. The goal is to let the expert choose the automation boundary for each participating workflow agent.",
      actions: [
        "Read the participating agent identities from current_build.workflow stage nodes and their agent lists. Merge duplicate appearances into stable workflow agent ids, preserving roles and stage participation.",
        `Ask exactly one boundary-selection question in the assistantMessage. The message should be directly answerable by the expert: list each participating workflow agent from current_build.workflow and ask the expert to mark each as build, import from Agent Template Catalog, or user-played. Include a typical boundary plan the expert can accept or revise. The typical plan must explicitly list every participating workflow agent with one mode value: build, import_template, or user_played. Do not offer a default answer that only confirms the agent names or says "use a two-agent boundary"; that is not enough to set agent_boundaries_confirmed=true. For catalog imports, ask for the template name/id/version only when it is not already known. ${DAEMON_TYPICAL_ANSWER_CHOICE_INSTRUCTION}`,
        "Do not emit workflowStages, workflowStagePartitions, stateFields, policySeed, initialPolicyCanvasShape, initialPolicyCanvasStructure, initialStateCanvasShape, initialStateCanvasStructure, datasets, agentTemplateBindings, agentSkills, toolRequests, toolPlacements, canvasEdits for implementation canvases, or agentConnections in this boundary-selection pass.",
        "Use assistantReplyIntent=ask. The assistantMessage must not say only that the turn should move to agent-boundary selection; it must actually ask for the boundary choices and include the available modes: build, import, or user-played plus a typical answer/default plan the expert can accept or revise. The default plan must be complete enough that, if accepted, Derive Process State can set agent_boundary_plan and agent_boundaries_confirmed=true without asking another confirmation. The stage state canvas owns agent_boundary_plan and agent_boundaries_confirmed from the expert's response; do not hard-code phrase matching in policy text.",
      ],
    }),
    180,
    [
      {
        conditionLabel: "agent_boundaries_confirmed is true",
        nextStageId: DAEMON_WORKFLOW_STAGE_BUILD,
        immediate: true,
        continueOnFalse: true,
      },
    ]
  );

  const seedStart = createCanvasNode(
    "start",
    540,
    40,
    "Use this subtree only after process_ready is true, workflow_decomposition_complete is true, agent_boundaries_confirmed is true, and the target implementation draft is still sparse."
  );
  const seedMetadata = createCanvasNode(
    "action",
    60,
    220,
    "Create or refine the target demo's title, route slug, summary, and policy intent inside the structured planner patch. Prefer practical naming once the draft is specific enough."
  );
  const seedStructure = createCanvasNode(
    "action",
    380,
    220,
    `After workflow_decomposition_complete and agent_boundaries_confirmed are true, create the first implementation setup pass in one move inside the structured planner patch: state schema, concrete policy/state/reward canvases grounded in confirmed process facts, the approved workflow hierarchy, datasets, agentTemplateBindings for confirmed catalog imports with exact template ids, agentSkills keyed by owning workflow agentId, and stage-scoped agentConnections. On the first turn after boundaries become confirmed while structured_draft_exists is still false, do not merely report that boundaries are confirmed; emit this implementation patch and set assistantReplyIntent=report_update with a concise assistantMessage about the setup that was created. Build only the agents whose agent_boundary_plan mode is build. For agents whose mode is import_template, emit agentTemplateBindings only when templateId and templateVersionId are known, preserve that catalog template identity, and only add project-specific overrides needed by the workflow; otherwise ask for the catalog choice and include a typical catalog choice/default template type the expert can accept or revise. For agents whose mode is user_played, represent them as human-controlled handoff/input points rather than autonomous policy canvases. Do not emit workflowStages or workflowStagePartitions here unless the expert explicitly asks to revise the approved workflow hierarchy. Treat process_open_questions as unresolved follow-up questions for later turns, not as draft-node content. ${DAEMON_TYPICAL_ANSWER_CHOICE_INSTRUCTION}`
  );
  const seedPrimaryInstructions = createCanvasNode(
    "action",
    700,
    220,
    "The runtime will deterministically build the legacy top-level runtime state schema during seeding: summary, new_events, agent_latest_observation, numeric scalar agent_latest_reward, and agent_latest_action. Use stateFields in the structured planner patch only for extra workflow-level fields beyond that default, or for justified refinements to those defaults; do not redefine agent_latest_reward as a string."
  );
  const seedEnvironmentInstructions = createCanvasNode(
    "action",
    1020,
    220,
    "Prefer adding stage-scoped agentConnections to the structured planner patch whenever the approved workflow has automated or imported agents interacting across a stage. Each stage-specific connection must set workflowStageId and workflowStageName from workflowStages, name both sourceAgentId and targetAgentId when the source is known, and respect agent_boundary_plan. When the same real agent appears in multiple stages, keep targetAgentSharedId stable and use stage-scoped targetAgentId values when separate canvases are needed. Use sourcePolicySeed/sourceInitialPolicyCanvasShape/sourceInitialPolicyCanvasStructure for the source agent's pairwise interaction policy, sourceInitialStateCanvasShape/sourceInitialStateCanvasStructure for the source agent's stage-specific state canvas, and targetPolicySeed/targetInitialPolicyCanvasShape/targetInitialPolicyCanvasStructure for a built target agent's own policy. Also create directional reward canvases with sourceRewardSeed/sourceInitialRewardCanvasShape/sourceInitialRewardCanvasStructure and targetRewardSeed/targetInitialRewardCanvasShape/targetInitialRewardCanvasStructure when the connection needs explicit scoring. Do not emit agentConnections[].policySeed. Do not create embedded environmentAgents for target drafts. Use Call Agent nodes for nested agent calls. Use Terminate nodes only when the pairwise task is complete; Terminate means no future turns in that interaction, not end-of-turn."
  );
  const seedCanvas: CanvasEntry = {
    id: daemonCanvasStorageId("policy", DAEMON_SEED_CANVAS_NAME),
    name: DAEMON_SEED_CANVAS_NAME,
    freeText:
      "This subtree produces the initial implementation patch only after the editable workflow hierarchy has been approved, decomposed enough for low-level implementation canvases, and paired with an explicit agent boundary plan. The shared patch-application workflow then ensures legacy default schemas before the patch is applied.",
    graph: {
      nodes: [
        seedStart,
        seedMetadata,
        seedStructure,
        seedPrimaryInstructions,
        seedEnvironmentInstructions,
      ],
      edges: [
        createCanvasEdge(seedStart.id, seedMetadata.id),
        createCanvasEdge(seedStart.id, seedStructure.id),
        createCanvasEdge(seedStart.id, seedPrimaryInstructions.id),
        createCanvasEdge(seedStart.id, seedEnvironmentInstructions.id),
      ],
    },
  };

  const triageCanvas = createActionChainCanvas({
    name: DAEMON_TRIAGE_CANVAS_NAME,
    intro:
      "Use this subtree when the draft exists but important policy decisions remain unresolved.",
    actions: [
      "If agent_latest_observation asks for an explicit runtime behavior change, including conditional behavior such as if/when/unless X then Y, preserve it in the matching request fields and let the editing subtree handle it before triage.",
      "If agent_latest_observation asks to create a new skill or connected agent/agent connection, preserve it in user_skill_requests or user_environment_agent_requests respectively so the dedicated creation subtrees handle it before triage. If it edits, removes, inspects, or adds tooling to an existing skill or agent connection, preserve it in user_edit_requests and user_tooling_requests as applicable.",
      `Use assistantReplyIntent=ask and assistantMessage in the structured planner patch to ask exactly one focused follow-up question selected from process_open_questions. If process_open_questions is empty, first derive the most important unresolved question from current_build into process_open_questions, then ask that question. ${DAEMON_TYPICAL_ANSWER_CHOICE_INSTRUCTION}`,
      "When the current structured planner output already contains a concise summary of a completed change from earlier in this turn, preserve that summary and append the follow-up question instead of replacing it.",
      "Keep edits additive and preserve useful structure while refining the most uncertain part of the draft.",
      "Use current_build as the canonical live-draft snapshot, and keep process_open_questions accurate so the daemon knows what remains unclear.",
    ],
  });

  const toolingCanvas = createActionChainCanvas({
    name: DAEMON_TOOLING_CANVAS_NAME,
    intro:
      "Use this subtree when the user wants a capability the current tool surface does not already cover.",
    actions: [
      "Only scaffold tools for capabilities the current system does not already cover.",
      "Keep tool definitions within the supported source types: http, rss, page, web_search, knowledge_save, and dataset_read. Use Display nodes for text or video output. Use Call Agent nodes for Default, OpenClaw backend, or Hermes backend delegation.",
      "If the user asks to place a tool node in a specific existing canvas, leave that to the editing path with toolPlacements instead of only appending a standalone tool canvas.",
      "When tooling changes the draft, mark assistantReplyIntent=report_update so the final runtime step can safely present that update.",
      "Add any required dataset hooks inside the structured planner patch and derive missing_tooling_capabilities and drafted_artifacts from the updated current_build to reflect the new tool surface. Treat tooling scaffolding as needed when missing_tooling_capabilities is non-empty.",
    ],
  });

  const editingCanvas = createDaemonEditingCanvas();
  const skillCreationCanvas = createDaemonSkillCreationCanvas();
  const environmentAgentCreationCanvas =
    createDaemonEnvironmentAgentCreationCanvas();

  const applyPatchStart = createCanvasNode(
    "start",
    540,
    40,
    "Use this subtree to normalize a structured planner patch before it mutates the target draft."
  );
  const applyPatchNeedsSeedDefaults = createCanvasNode(
    "condition",
    540,
    180,
    "structured_draft_exists is false"
  );
  const applyPatchBuildPrimary = createCanvasNode(
    "build_default_primary_state_schema",
    300,
    340,
    DAEMON_BUILD_DEFAULT_PRIMARY_SCHEMA_LABEL
  );
  const applyPatchBuildEnvironment = createCanvasNode(
    "build_default_environment_state_schema",
    300,
    500,
    DAEMON_BUILD_DEFAULT_ENVIRONMENT_SCHEMA_LABEL
  );
  const materializeStructuresBuildRequests = createCanvasNode(
    "build_initial_canvas_shape_materialization_requests",
    540,
    660,
    DAEMON_BUILD_INITIAL_CANVAS_SHAPE_REQUESTS_LABEL
  );
  const materializeStructuresHasRequests = createCanvasNode(
    "condition",
    540,
    820,
    DAEMON_INITIAL_CANVAS_SHAPE_REQUESTS_GATE_LABEL
  );
  const materializeStructuresPrompt = createCanvasNode(
    "action",
    300,
    1000,
    DAEMON_MATERIALIZE_INITIAL_CANVAS_STRUCTURES_PROMPT_LABEL,
    {
      promptOutputFields: [DAEMON_MATERIALIZED_INITIAL_CANVAS_STRUCTURES_OUTPUT],
    }
  );
  const materializeStructuresMerge = createCanvasNode(
    "merge_materialized_initial_canvas_structures",
    540,
    1180,
    DAEMON_MERGE_MATERIALIZED_INITIAL_CANVAS_STRUCTURES_LABEL
  );
  const applyPatchApplyStructuredPatch = createCanvasNode(
    "apply_structured_patch",
    540,
    1340,
    DAEMON_APPLY_PATCH_LABEL
  );
  const applyPatchScaffoldTools = createCanvasNode(
    "scaffold_tools",
    540,
    1500,
    DAEMON_SCAFFOLD_TOOLS_LABEL
  );
  const applyPatchSyncPrompts = createCanvasNode(
    "sync_derived_prompts",
    540,
    1660,
    DAEMON_SYNC_PROMPTS_LABEL
  );
  const applyPatchCanvas: CanvasEntry = {
    id: daemonCanvasStorageId("policy", DAEMON_APPLY_PATCH_CANVAS_NAME),
    name: DAEMON_APPLY_PATCH_CANVAS_NAME,
    freeText:
      "This subtree makes the shared draft-realization workflow explicit: when seeding the first draft, ensure the default primary schema in code; materialize any needed initial canvases from abstract shapes; apply the structured planner patch; scaffold any requested tools; and then resync derived prompts before control returns to the main repair loop.",
    graph: {
      nodes: [
        applyPatchStart,
        applyPatchNeedsSeedDefaults,
        applyPatchBuildPrimary,
        applyPatchBuildEnvironment,
        materializeStructuresBuildRequests,
        materializeStructuresHasRequests,
        materializeStructuresPrompt,
        materializeStructuresMerge,
        applyPatchApplyStructuredPatch,
        applyPatchScaffoldTools,
        applyPatchSyncPrompts,
      ],
      edges: [
        createCanvasEdge(applyPatchStart.id, applyPatchNeedsSeedDefaults.id),
        createCanvasEdge(
          applyPatchNeedsSeedDefaults.id,
          applyPatchBuildPrimary.id,
          "true"
        ),
        createCanvasEdge(
          applyPatchNeedsSeedDefaults.id,
          applyPatchBuildEnvironment.id,
          "false"
        ),
        createCanvasEdge(
          applyPatchBuildPrimary.id,
          applyPatchBuildEnvironment.id
        ),
        createCanvasEdge(
          applyPatchBuildEnvironment.id,
          materializeStructuresBuildRequests.id
        ),
        createCanvasEdge(
          materializeStructuresBuildRequests.id,
          materializeStructuresHasRequests.id
        ),
        createCanvasEdge(
          materializeStructuresHasRequests.id,
          materializeStructuresPrompt.id,
          "true"
        ),
        createCanvasEdge(
          materializeStructuresHasRequests.id,
          materializeStructuresMerge.id,
          "false"
        ),
        createCanvasEdge(
          materializeStructuresPrompt.id,
          materializeStructuresMerge.id
        ),
        createCanvasEdge(
          materializeStructuresMerge.id,
          applyPatchApplyStructuredPatch.id
        ),
        createCanvasEdge(
          applyPatchApplyStructuredPatch.id,
          applyPatchScaffoldTools.id
        ),
        createCanvasEdge(
          applyPatchScaffoldTools.id,
          applyPatchSyncPrompts.id
        ),
      ],
    },
  };

  const repairCanvasRulesStart = createCanvasNode(
    "start",
    540,
    40,
    "Use this subtree for one bounded canvas-rule repair pass. Keep the top-level retry loop visible on the main canvas."
  );
  const repairCanvasRulesPrepareDetection = createCanvasNode(
    "prepare_canvas_rule_detection_requests",
    540,
    200,
    DAEMON_PREPARE_CANVAS_RULE_DETECTION_REQUESTS_LABEL
  );
  const repairCanvasRulesDetectIssues = createCanvasNode(
    "action",
    540,
    380,
    DAEMON_DETECT_CANVAS_RULE_ISSUES_PROMPT_LABEL,
    {
      promptOutputFields: [DAEMON_CANVAS_RULE_DETECTED_ISSUES_OUTPUT],
    }
  );
  const repairCanvasRulesIssuesExist = createCanvasNode(
    "condition",
    540,
    560,
    DAEMON_CANVAS_RULE_ISSUES_EXIST_GATE_LABEL
  );
  const repairCanvasRulesBuildRequests = createCanvasNode(
    "build_canvas_rule_repair_requests",
    860,
    740,
    DAEMON_BUILD_CANVAS_RULE_REPAIR_REQUESTS_LABEL
  );
  const repairCanvasRulesPromptRepairs = createCanvasNode(
    "action",
    860,
    920,
    DAEMON_PROPOSE_CANVAS_RULE_REPAIRS_PROMPT_LABEL,
    {
      promptOutputFields: [DAEMON_CANVAS_RULE_REPAIR_EDITS_OUTPUT],
    }
  );
  const repairCanvasRulesApplyRepairs = createCanvasNode(
    "apply_canvas_rule_repairs",
    860,
    1100,
    DAEMON_APPLY_CANVAS_RULE_REPAIRS_LABEL
  );
  const repairCanvasRulesPrepareRecheck = createCanvasNode(
    "prepare_canvas_rule_recheck_requests",
    860,
    1280,
    DAEMON_PREPARE_CANVAS_RULE_RECHECK_REQUESTS_LABEL
  );
  const repairCanvasRulesRecheck = createCanvasNode(
    "action",
    860,
    1460,
    DAEMON_RECHECK_CANVAS_RULE_ISSUES_PROMPT_LABEL,
    {
      promptOutputFields: [DAEMON_CANVAS_RULE_REMAINING_ISSUES_OUTPUT],
    }
  );
  const repairCanvasRulesAnyChanges = createCanvasNode(
    "condition",
    860,
    1640,
    DAEMON_CANVAS_RULE_ANY_CHANGES_GATE_LABEL
  );
  const repairCanvasRulesPreflightChanges = createCanvasNode(
    "condition",
    220,
    740,
    DAEMON_CANVAS_RULE_PREFLIGHT_CHANGES_GATE_LABEL
  );
  const repairCanvasRulesSyncLeft = createCanvasNode(
    "sync_derived_prompts",
    220,
    920,
    DAEMON_SYNC_PROMPTS_LABEL
  );
  const repairCanvasRulesSyncRight = createCanvasNode(
    "sync_derived_prompts",
    860,
    1820,
    DAEMON_SYNC_PROMPTS_LABEL
  );
  const repairCanvasRulesFinalize = createCanvasNode(
    "finalize_canvas_rule_repair_pass",
    540,
    2000,
    DAEMON_FINALIZE_CANVAS_RULE_REPAIR_PASS_LABEL
  );
  const repairCanvasRulesCanvas: CanvasEntry = {
    id: daemonCanvasStorageId("policy", DAEMON_REPAIR_CANVAS_RULES_CANVAS_NAME),
    name: DAEMON_REPAIR_CANVAS_RULES_CANVAS_NAME,
    freeText:
      "This subtree exposes one canvas-rule repair pass as deterministic prep, model issue detection, conditional model repair, deterministic application, optional prompt resync, and final pass status. The retry loop itself stays visible on the main canvas.",
    graph: {
      nodes: [
        repairCanvasRulesStart,
        repairCanvasRulesPrepareDetection,
        repairCanvasRulesDetectIssues,
        repairCanvasRulesIssuesExist,
        repairCanvasRulesBuildRequests,
        repairCanvasRulesPromptRepairs,
        repairCanvasRulesApplyRepairs,
        repairCanvasRulesPrepareRecheck,
        repairCanvasRulesRecheck,
        repairCanvasRulesAnyChanges,
        repairCanvasRulesPreflightChanges,
        repairCanvasRulesSyncLeft,
        repairCanvasRulesSyncRight,
        repairCanvasRulesFinalize,
      ],
      edges: [
        createCanvasEdge(
          repairCanvasRulesStart.id,
          repairCanvasRulesPrepareDetection.id
        ),
        createCanvasEdge(
          repairCanvasRulesPrepareDetection.id,
          repairCanvasRulesDetectIssues.id
        ),
        createCanvasEdge(
          repairCanvasRulesDetectIssues.id,
          repairCanvasRulesIssuesExist.id
        ),
        createCanvasEdge(
          repairCanvasRulesIssuesExist.id,
          repairCanvasRulesBuildRequests.id,
          "true"
        ),
        createCanvasEdge(
          repairCanvasRulesIssuesExist.id,
          repairCanvasRulesPreflightChanges.id,
          "false"
        ),
        createCanvasEdge(
          repairCanvasRulesBuildRequests.id,
          repairCanvasRulesPromptRepairs.id
        ),
        createCanvasEdge(
          repairCanvasRulesPromptRepairs.id,
          repairCanvasRulesApplyRepairs.id
        ),
        createCanvasEdge(
          repairCanvasRulesApplyRepairs.id,
          repairCanvasRulesPrepareRecheck.id
        ),
        createCanvasEdge(
          repairCanvasRulesPrepareRecheck.id,
          repairCanvasRulesRecheck.id
        ),
        createCanvasEdge(
          repairCanvasRulesRecheck.id,
          repairCanvasRulesAnyChanges.id
        ),
        createCanvasEdge(
          repairCanvasRulesAnyChanges.id,
          repairCanvasRulesSyncRight.id,
          "true"
        ),
        createCanvasEdge(
          repairCanvasRulesAnyChanges.id,
          repairCanvasRulesFinalize.id,
          "false"
        ),
        createCanvasEdge(
          repairCanvasRulesSyncRight.id,
          repairCanvasRulesFinalize.id
        ),
        createCanvasEdge(
          repairCanvasRulesPreflightChanges.id,
          repairCanvasRulesSyncLeft.id,
          "true"
        ),
        createCanvasEdge(
          repairCanvasRulesPreflightChanges.id,
          repairCanvasRulesFinalize.id,
          "false"
        ),
        createCanvasEdge(
          repairCanvasRulesSyncLeft.id,
          repairCanvasRulesFinalize.id
        ),
      ],
    },
  };

  const buildStageStart = createCanvasNode(
    "start",
    540,
    40,
    "Use this stage after the workflow hierarchy and agent boundaries are approved but before the first runnable implementation draft exists."
  );
  const buildStageSeedDraft = createCanvasNode(
    "expand",
    540,
    200,
    DAEMON_SEED_CANVAS_NAME
  );
  const buildStageSummarize = createCanvasNode(
    "action",
    540,
    360,
    `revise the structured planner output so assistantReplyIntent=report_update when the first runnable draft was actually seeded, and otherwise report the exact blocker. Preserve the structured planner JSON shape and keep the reply grounded in current_build. ${DAEMON_TYPICAL_ANSWER_CHOICE_INSTRUCTION}`,
    { actionType: "prompt_transform" }
  );
  const buildStageApplyPatch = createCanvasNode(
    "expand",
    540,
    520,
    DAEMON_APPLY_PATCH_CANVAS_NAME
  );
  const buildStageRepair = createCanvasNode(
    "expand",
    540,
    680,
    DAEMON_REPAIR_CANVAS_RULES_CANVAS_NAME
  );
  const buildStageRepairLoop = createCanvasNode(
    "while",
    540,
    840,
    DAEMON_REPAIR_LOOP_LABEL,
    { maxIterations: 2 }
  );
  const buildStageRetryRepair = createCanvasNode(
    "expand",
    800,
    1000,
    DAEMON_REPAIR_CANVAS_RULES_CANVAS_NAME
  );
  const buildStageCanvas = appendPrimaryPolicyReplyTail(
    {
      id: daemonCanvasStorageId("policy", DAEMON_BUILD_RUNNABLE_DRAFT_CANVAS_NAME),
      name: DAEMON_BUILD_RUNNABLE_DRAFT_CANVAS_NAME,
      freeText:
        "This stage turns the approved workflow and chosen boundaries into the first runnable draft, then applies the shared patch/materialization/tooling/prompt-sync workflow and bounded canvas-rule repair pass.",
      graph: {
        nodes: [
          buildStageStart,
          buildStageSeedDraft,
          buildStageSummarize,
          buildStageApplyPatch,
          buildStageRepair,
          buildStageRepairLoop,
          buildStageRetryRepair,
        ],
        edges: [
          createCanvasEdge(buildStageStart.id, buildStageSeedDraft.id),
          createCanvasEdge(buildStageSeedDraft.id, buildStageSummarize.id),
          createCanvasEdge(buildStageSummarize.id, buildStageApplyPatch.id),
          createCanvasEdge(buildStageApplyPatch.id, buildStageRepair.id),
          createCanvasEdge(buildStageRepair.id, buildStageRepairLoop.id),
          createCanvasEdge(buildStageRepairLoop.id, buildStageRetryRepair.id, "body"),
        ],
      },
    },
    180,
    [
      {
        conditionLabel: "structured_draft_exists is true",
        nextStageId: DAEMON_WORKFLOW_STAGE_REVIEW,
        immediate: true,
        continueOnFalse: true,
      },
    ]
  );

  const reviewStageStart = createCanvasNode(
    "start",
    640,
    40,
    "Use this stage after a runnable draft exists. Route environment/user feedback into the smallest relevant build update, then realize and repair that update."
  );
  const reviewEnvironmentAgentRequestsGate = createCanvasNode(
    "condition",
    640,
    200,
    DAEMON_USER_ENVIRONMENT_AGENT_REQUESTS_GATE_LABEL
  );
  const reviewCreateEnvironmentAgents = createCanvasNode(
    "expand",
    960,
    360,
    DAEMON_ENVIRONMENT_AGENT_CREATION_CANVAS_NAME
  );
  const reviewSkillRequestsGate = createCanvasNode(
    "condition",
    640,
    360,
    DAEMON_USER_SKILL_REQUESTS_GATE_LABEL
  );
  const reviewCreateSkills = createCanvasNode(
    "expand",
    960,
    520,
    DAEMON_SKILL_CREATION_CANVAS_NAME
  );
  const reviewToolingRequestsGate = createCanvasNode(
    "condition",
    640,
    520,
    DAEMON_USER_TOOLING_REQUESTS_GATE_LABEL
  );
  const reviewScaffoldTools = createCanvasNode(
    "expand",
    960,
    680,
    DAEMON_TOOLING_CANVAS_NAME
  );
  const reviewEditRequestsGate = createCanvasNode(
    "condition",
    640,
    680,
    DAEMON_USER_EDIT_REQUESTS_GATE_LABEL
  );
  const reviewRefineDraft = createCanvasNode(
    "expand",
    960,
    840,
    DAEMON_EDITING_CANVAS_NAME
  );
  const reviewOpenQuestionsGate = createCanvasNode(
    "condition",
    640,
    840,
    DAEMON_PROCESS_OPEN_QUESTIONS_GATE_LABEL
  );
  const reviewTriageDraft = createCanvasNode(
    "expand",
    320,
    1000,
    DAEMON_TRIAGE_CANVAS_NAME
  );
  const reviewSummarize = createCanvasNode(
    "action",
    640,
    1160,
    `revise the structured planner output so assistantReplyIntent correctly marks whether this review pass applied a concrete update, asks the next focused question, or only reports the current review status. Preserve the JSON shape and keep the reply grounded in current_build. ${DAEMON_TYPICAL_ANSWER_CHOICE_INSTRUCTION}`,
    { actionType: "prompt_transform" }
  );
  const reviewApplyPatch = createCanvasNode(
    "expand",
    640,
    1320,
    DAEMON_APPLY_PATCH_CANVAS_NAME
  );
  const reviewRepair = createCanvasNode(
    "expand",
    640,
    1480,
    DAEMON_REPAIR_CANVAS_RULES_CANVAS_NAME
  );
  const reviewRepairLoop = createCanvasNode(
    "while",
    640,
    1640,
    DAEMON_REPAIR_LOOP_LABEL,
    { maxIterations: 2 }
  );
  const reviewRetryRepair = createCanvasNode(
    "expand",
    900,
    1800,
    DAEMON_REPAIR_CANVAS_RULES_CANVAS_NAME
  );
  const reviewStageCanvas = appendPrimaryPolicyReplyTail(
    {
      id: daemonCanvasStorageId("policy", DAEMON_REVIEW_ITERATE_CANVAS_NAME),
      name: DAEMON_REVIEW_ITERATE_CANVAS_NAME,
      freeText:
        "This stage handles all post-seed review feedback. Feedback can request new agent connections, skills, tools, direct canvas edits, or one focused triage question; any structural update then runs through shared patch realization and repair.",
      graph: {
        nodes: [
          reviewStageStart,
          reviewEnvironmentAgentRequestsGate,
          reviewCreateEnvironmentAgents,
          reviewSkillRequestsGate,
          reviewCreateSkills,
          reviewToolingRequestsGate,
          reviewScaffoldTools,
          reviewEditRequestsGate,
          reviewRefineDraft,
          reviewOpenQuestionsGate,
          reviewTriageDraft,
          reviewSummarize,
          reviewApplyPatch,
          reviewRepair,
          reviewRepairLoop,
          reviewRetryRepair,
        ],
        edges: [
          createCanvasEdge(reviewStageStart.id, reviewEnvironmentAgentRequestsGate.id),
          createCanvasEdge(
            reviewEnvironmentAgentRequestsGate.id,
            reviewCreateEnvironmentAgents.id,
            "true"
          ),
          createCanvasEdge(
            reviewEnvironmentAgentRequestsGate.id,
            reviewSkillRequestsGate.id,
            "false"
          ),
          createCanvasEdge(reviewCreateEnvironmentAgents.id, reviewSkillRequestsGate.id),
          createCanvasEdge(reviewSkillRequestsGate.id, reviewCreateSkills.id, "true"),
          createCanvasEdge(reviewSkillRequestsGate.id, reviewToolingRequestsGate.id, "false"),
          createCanvasEdge(reviewCreateSkills.id, reviewToolingRequestsGate.id),
          createCanvasEdge(reviewToolingRequestsGate.id, reviewScaffoldTools.id, "true"),
          createCanvasEdge(reviewToolingRequestsGate.id, reviewEditRequestsGate.id, "false"),
          createCanvasEdge(reviewScaffoldTools.id, reviewEditRequestsGate.id),
          createCanvasEdge(reviewEditRequestsGate.id, reviewRefineDraft.id, "true"),
          createCanvasEdge(reviewEditRequestsGate.id, reviewOpenQuestionsGate.id, "false"),
          createCanvasEdge(reviewRefineDraft.id, reviewOpenQuestionsGate.id),
          createCanvasEdge(reviewOpenQuestionsGate.id, reviewTriageDraft.id, "true"),
          createCanvasEdge(reviewOpenQuestionsGate.id, reviewSummarize.id, "false"),
          createCanvasEdge(reviewTriageDraft.id, reviewSummarize.id),
          createCanvasEdge(reviewSummarize.id, reviewApplyPatch.id),
          createCanvasEdge(reviewApplyPatch.id, reviewRepair.id),
          createCanvasEdge(reviewRepair.id, reviewRepairLoop.id),
          createCanvasEdge(reviewRepairLoop.id, reviewRetryRepair.id, "body"),
        ],
      },
    },
    180,
    [
      {
        conditionLabel: "workflow_decomposition_complete is false",
        nextStageId: DAEMON_WORKFLOW_STAGE_APPROVE,
        immediate: true,
      },
      {
        conditionLabel: "agent_boundaries_confirmed is false",
        nextStageId: DAEMON_WORKFLOW_STAGE_BOUNDARIES,
        immediate: true,
      },
      {
        conditionLabel: "structured_draft_exists is false",
        nextStageId: DAEMON_WORKFLOW_STAGE_BUILD,
        immediate: true,
        continueOnFalse: true,
      },
    ]
  );

  return {
    version: 2,
    activeId: processCanvas.id,
    canvases: [
      processCanvas,
      workflowReviewCanvas,
      agentBoundaryCanvas,
      buildStageCanvas,
      reviewStageCanvas,
      seedCanvas,
      triageCanvas,
      toolingCanvas,
      skillCreationCanvas,
      environmentAgentCreationCanvas,
      editingCanvas,
      applyPatchCanvas,
      repairCanvasRulesCanvas,
    ],
  };
}

function docHasCanvasNamed(doc: CanvasDoc, name: string): boolean {
  return doc.canvases.some((canvas) => canvas.name.trim() === name);
}

function canvasHasExpandNode(entry: CanvasEntry): boolean {
  return entry.graph.nodes.some((node) => node.type === "expand");
}

function isAppendAssistantTurnCodeNode(node: CanvasNodeRecord): boolean {
  const templateId =
    typeof node.data?.codeTemplateId === "string"
      ? node.data.codeTemplateId.trim()
      : "";
  const label =
    typeof node.data?.label === "string" ? node.data.label.trim() : "";
  return (
    (node.type === "code" || getNodeActionSubtype(node) === "code") &&
    (templateId === APPEND_ASSISTANT_TURN_CODE_TEMPLATE_ID ||
      normalizeKey(label) === normalizeKey(APPEND_ASSISTANT_TURN_CODE_LABEL) ||
      normalizeKey(label) === normalizeKey(DAEMON_APPEND_ASSISTANT_TURN_LABEL))
  );
}

function normalizeAppendAssistantTurnCodeNode(
  node: CanvasNodeRecord
): CanvasNodeRecord {
  if (!isAppendAssistantTurnCodeNode(node)) {
    return node;
  }

  const nextData = buildAppendAssistantTurnCodeNodeData(node.data, {
    strictFinalizedAssistantMessage: true,
  });

  return {
    ...node,
    type: "code",
    data: {
      ...nextData,
      label:
        typeof nextData.label === "string" && nextData.label.trim()
          ? nextData.label
          : DAEMON_APPEND_ASSISTANT_TURN_LABEL,
    },
  };
}

function isApplyPatchWorkflowExpandNode(node: CanvasNodeRecord): boolean {
  return (
    node.type === "expand" &&
    normalizeKey(typeof node.data?.label === "string" ? node.data.label : "") ===
      normalizeKey(DAEMON_APPLY_PATCH_CANVAS_NAME)
  );
}

function isRepairCanvasRulesWorkflowExpandNode(
  node: CanvasNodeRecord
): boolean {
  return (
    node.type === "expand" &&
    normalizeKey(typeof node.data?.label === "string" ? node.data.label : "") ===
      normalizeKey(DAEMON_REPAIR_CANVAS_RULES_CANVAS_NAME)
  );
}

function canvasHasDaemonRuntimeOperations(entry: CanvasEntry): boolean {
  const operations = new Set<string>();
  let hasRepairLoop = false;
  let hasApplyPatchWorkflow = false;
  let hasRepairCanvasWorkflow = false;
  let hasLegacyTopLevelScaffold = false;
  let hasLegacyTopLevelPromptSync = false;
  let hasLegacyTopLevelRepair = false;
  entry.graph.nodes.forEach((node) => {
    if (isApplyPatchWorkflowExpandNode(node)) {
      hasApplyPatchWorkflow = true;
    }
    if (isRepairCanvasRulesWorkflowExpandNode(node)) {
      hasRepairCanvasWorkflow = true;
    }

    if (
      node.type === "while" &&
      normalizeKey(typeof node.data?.label === "string" ? node.data.label : "") ===
        normalizeKey(DAEMON_REPAIR_LOOP_LABEL)
    ) {
      hasRepairLoop = true;
    }

    if (
      node.type === "apply_structured_patch" ||
      node.type === "scaffold_tools" ||
      node.type === "sync_derived_prompts" ||
      node.type === "repair_canvas_rules" ||
      node.type === "finalize_assistant_reply" ||
      node.type === "raise_error"
    ) {
      if (node.type === "scaffold_tools") {
        hasLegacyTopLevelScaffold = true;
      }
      if (node.type === "sync_derived_prompts") {
        hasLegacyTopLevelPromptSync = true;
      }
      if (node.type === "repair_canvas_rules") {
        hasLegacyTopLevelRepair = true;
      }
      operations.add(node.type);
      return;
    }

    if (
      node.type === "action" &&
      (node.data?.actionType === "apply_structured_patch" ||
        node.data?.actionType === "scaffold_tools" ||
        node.data?.actionType === "sync_derived_prompts" ||
        node.data?.actionType === "repair_canvas_rules" ||
        node.data?.actionType === "finalize_assistant_reply" ||
        node.data?.actionType === "raise_error")
    ) {
      if (node.data.actionType === "scaffold_tools") {
        hasLegacyTopLevelScaffold = true;
      }
      if (node.data.actionType === "sync_derived_prompts") {
        hasLegacyTopLevelPromptSync = true;
      }
      if (node.data.actionType === "repair_canvas_rules") {
        hasLegacyTopLevelRepair = true;
      }
      operations.add(node.data.actionType);
    }
  });

  return (
    hasApplyPatchWorkflow &&
    hasRepairCanvasWorkflow &&
    operations.has("finalize_assistant_reply") &&
    !hasLegacyTopLevelScaffold &&
    !hasLegacyTopLevelPromptSync &&
    !hasLegacyTopLevelRepair &&
    hasRepairLoop
  );
}

function ensureDaemonPostProcessingChain(entry: CanvasEntry): CanvasEntry {
  if (canvasHasDaemonRuntimeOperations(entry)) {
    return entry;
  }

  const summarizeNode = entry.graph.nodes.find(isPromptTransformNode);
  if (!summarizeNode) {
    return entry;
  }

  const summarizeOutgoing = entry.graph.edges.filter(
    (edge) => edge.source === summarizeNode.id
  );
  if (summarizeOutgoing.length !== 1) {
    return entry;
  }

  const runtimeOperationNodeIds = new Set(
    entry.graph.nodes
      .filter(
        (node) =>
          isApplyPatchWorkflowExpandNode(node) ||
          isRepairCanvasRulesWorkflowExpandNode(node) ||
          node.type === "build_initial_canvas_shape_materialization_requests" ||
          node.type === "materialize_initial_canvas_structures" ||
          node.type === "merge_materialized_initial_canvas_structures" ||
          node.type === "apply_structured_patch" ||
          node.type === "scaffold_tools" ||
          node.type === "sync_derived_prompts" ||
          node.type === "repair_canvas_rules" ||
          (node.type === "while" &&
            normalizeKey(typeof node.data?.label === "string" ? node.data.label : "") ===
              normalizeKey(DAEMON_REPAIR_LOOP_LABEL)) ||
          node.type === "finalize_assistant_reply" ||
          node.type === "raise_error" ||
          (node.type === "action" &&
        (node.data?.actionType ===
          "build_initial_canvas_shape_materialization_requests" ||
          node.data?.actionType === "materialize_initial_canvas_structures" ||
          node.data?.actionType ===
            "merge_materialized_initial_canvas_structures" ||
          node.data?.actionType === "apply_structured_patch" ||
          node.data?.actionType === "scaffold_tools" ||
          node.data?.actionType === "sync_derived_prompts" ||
          node.data?.actionType === "repair_canvas_rules" ||
          node.data?.actionType === "finalize_assistant_reply" ||
          node.data?.actionType === "raise_error"))
      )
      .map((node) => node.id)
  );

  let nextTarget = summarizeOutgoing[0].target;
  while (runtimeOperationNodeIds.has(nextTarget)) {
    const nextEdge = entry.graph.edges.filter((edge) => edge.source === nextTarget);
    if (nextEdge.length !== 1) {
      return entry;
    }
    nextTarget = nextEdge[0].target;
  }

  const summarizePosition = summarizeNode.position;
  const applyPatchWorkflow = createCanvasNode(
    "expand",
    summarizePosition.x,
    summarizePosition.y + 160,
    DAEMON_APPLY_PATCH_CANVAS_NAME
  );
  const repairCanvasRulesNode = createCanvasNode(
    "expand",
    summarizePosition.x,
    summarizePosition.y + 320,
    DAEMON_REPAIR_CANVAS_RULES_CANVAS_NAME
  );
  const repairLoopNode = createCanvasNode(
    "while",
    summarizePosition.x,
    summarizePosition.y + 480,
    DAEMON_REPAIR_LOOP_LABEL,
    { maxIterations: 2 }
  );
  const retryRepairCanvasRulesNode = createCanvasNode(
    "expand",
    summarizePosition.x + 260,
    summarizePosition.y + 640,
    DAEMON_REPAIR_CANVAS_RULES_CANVAS_NAME
  );
  const finalizeAssistantReplyNode = createCanvasNode(
    "finalize_assistant_reply",
    summarizePosition.x,
    summarizePosition.y + 800,
    DAEMON_FINALIZE_REPLY_LABEL
  );
  const appendAssistantTurnNode = createAppendAssistantTurnCodeNode(
    summarizePosition.x,
    summarizePosition.y + 960,
    DAEMON_APPEND_ASSISTANT_TURN_LABEL
  );
  const displayAssistantReplyNode = createDisplayCommittedAgentActionNode(
    summarizePosition.x,
    summarizePosition.y + 1120
  );
  const shiftedNodes = entry.graph.nodes
    .filter((node) => !runtimeOperationNodeIds.has(node.id))
    .map((node) =>
    node.id === nextTarget
      ? {
          ...node,
          position: {
            ...node.position,
            x: summarizePosition.x,
            y: summarizePosition.y + 1280,
          },
        }
      : node
  );

  return {
    ...entry,
    graph: {
      nodes: [
        ...shiftedNodes,
        applyPatchWorkflow,
        repairCanvasRulesNode,
        repairLoopNode,
        retryRepairCanvasRulesNode,
        finalizeAssistantReplyNode,
        appendAssistantTurnNode,
        displayAssistantReplyNode,
      ],
      edges: [
        ...entry.graph.edges.filter(
          (edge) =>
            edge.source !== summarizeNode.id &&
            !runtimeOperationNodeIds.has(edge.source) &&
            !runtimeOperationNodeIds.has(edge.target)
        ),
        createCanvasEdge(summarizeNode.id, applyPatchWorkflow.id),
        createCanvasEdge(applyPatchWorkflow.id, repairCanvasRulesNode.id),
        createCanvasEdge(repairCanvasRulesNode.id, repairLoopNode.id),
        createCanvasEdge(repairLoopNode.id, retryRepairCanvasRulesNode.id, "body"),
        createCanvasEdge(repairLoopNode.id, finalizeAssistantReplyNode.id, "done"),
        createCanvasEdge(finalizeAssistantReplyNode.id, appendAssistantTurnNode.id),
        createCanvasEdge(appendAssistantTurnNode.id, displayAssistantReplyNode.id),
        createCanvasEdge(displayAssistantReplyNode.id, nextTarget),
      ],
    },
  };
}

function shouldUpgradeToStructuredDaemonPolicy(doc: CanvasDoc | null): boolean {
  if (!doc || doc.canvases.length === 0) {
    return true;
  }

  const mainCanvas = doc.canvases.find(
    (canvas) => canvas.name.trim() === DAEMON_MAIN_CANVAS_NAME
  );
  if (mainCanvas) {
    return true;
  }

  const hasAllStructuredSubcanvases =
    docHasCanvasNamed(doc, DAEMON_PROCESS_CANVAS_NAME) &&
    docHasCanvasNamed(doc, DAEMON_WORKFLOW_REVIEW_CANVAS_NAME) &&
    docHasCanvasNamed(doc, DAEMON_AGENT_BOUNDARY_CANVAS_NAME) &&
    docHasCanvasNamed(doc, DAEMON_BUILD_RUNNABLE_DRAFT_CANVAS_NAME) &&
    docHasCanvasNamed(doc, DAEMON_REVIEW_ITERATE_CANVAS_NAME) &&
    docHasCanvasNamed(doc, DAEMON_SEED_CANVAS_NAME) &&
    docHasCanvasNamed(doc, DAEMON_TRIAGE_CANVAS_NAME) &&
    docHasCanvasNamed(doc, DAEMON_TOOLING_CANVAS_NAME) &&
    docHasCanvasNamed(doc, DAEMON_SKILL_CREATION_CANVAS_NAME) &&
    docHasCanvasNamed(doc, DAEMON_ENVIRONMENT_AGENT_CREATION_CANVAS_NAME) &&
    docHasCanvasNamed(doc, DAEMON_EDITING_CANVAS_NAME) &&
    docHasCanvasNamed(doc, DAEMON_APPLY_PATCH_CANVAS_NAME) &&
      docHasCanvasNamed(doc, DAEMON_REPAIR_CANVAS_RULES_CANVAS_NAME);

  return !hasAllStructuredSubcanvases;
}

function extractLinearActionChainLabels(canvas: CanvasEntry): string[] | null {
  const startNode = canvas.graph.nodes.find((node) => node.type === "start") ?? null;
  if (!startNode) {
    return null;
  }

  const nodesById = new Map(canvas.graph.nodes.map((node) => [node.id, node]));
  const labels: string[] = [];
  const visited = new Set<string>([startNode.id]);
  let currentNodeId = startNode.id;

  while (true) {
    const outgoingEdges = canvas.graph.edges.filter((edge) => edge.source === currentNodeId);
    if (outgoingEdges.length === 0) {
      return labels;
    }
    if (outgoingEdges.length !== 1) {
      return null;
    }

    const nextNode = nodesById.get(outgoingEdges[0].target) ?? null;
    if (!nextNode || visited.has(nextNode.id)) {
      return null;
    }

    visited.add(nextNode.id);

    const isLinearStepNode =
      nextNode.type === "action" ||
      nextNode.type === "build_default_primary_state_schema" ||
      nextNode.type === "build_default_environment_state_schema" ||
      nextNode.type === "build_initial_canvas_shape_materialization_requests" ||
      nextNode.type === "materialize_initial_canvas_structures" ||
      nextNode.type === "merge_materialized_initial_canvas_structures" ||
      nextNode.type === "prepare_canvas_rule_detection_requests" ||
      nextNode.type === "build_canvas_rule_repair_requests" ||
      nextNode.type === "apply_canvas_rule_repairs" ||
      nextNode.type === "prepare_canvas_rule_recheck_requests" ||
      nextNode.type === "finalize_canvas_rule_repair_pass" ||
      nextNode.type === "apply_structured_patch" ||
      nextNode.type === "scaffold_tools" ||
      nextNode.type === "sync_derived_prompts" ||
      nextNode.type === "repair_canvas_rules" ||
      nextNode.type === "finalize_assistant_reply" ||
      nextNode.type === "raise_error";

    if (!isLinearStepNode) {
      return null;
    }

    labels.push(
      typeof nextNode.data?.label === "string" ? nextNode.data.label.trim() : ""
    );
    currentNodeId = nextNode.id;
  }
}

function extractStartPromptForestLabels(canvas: CanvasEntry): string[] | null {
  const startNode = canvas.graph.nodes.find((node) => node.type === "start") ?? null;
  if (!startNode) {
    return null;
  }

  const nodesById = new Map(canvas.graph.nodes.map((node) => [node.id, node]));
  const startTargets = canvas.graph.edges
    .filter((edge) => edge.source === startNode.id)
    .map((edge) => nodesById.get(edge.target))
    .filter((node): node is CanvasNodeRecord => Boolean(node));
  if (startTargets.length === 0 || startTargets.some((node) => !isPromptNode(node))) {
    return null;
  }

  const actionIds = new Set(startTargets.map((node) => node.id));
  const hasUnexpectedNodes = canvas.graph.nodes.some(
    (node) => node.type !== "start" && !actionIds.has(node.id)
  );
  if (hasUnexpectedNodes) {
    return null;
  }

  const onlyStartEdges = canvas.graph.edges.every(
    (edge) => edge.source === startNode.id && actionIds.has(edge.target)
  );
  if (!onlyStartEdges) {
    return null;
  }

  return [...startTargets]
    .sort((a, b) =>
      a.position.y === b.position.y ? a.position.x - b.position.x : a.position.y - b.position.y
    )
    .map((node) => (typeof node.data?.label === "string" ? node.data.label.trim() : ""));
}

function extractStructuredSubcanvasLabels(canvas: CanvasEntry): string[] | null {
  return extractStartPromptForestLabels(canvas) ?? extractLinearActionChainLabels(canvas);
}

function seedCanvasUsesSharedPatchSchemaPrep(canvas: CanvasEntry): boolean {
  const hasSchemaPrepRuntimeNodes = canvas.graph.nodes.some(
    (node) =>
      node.type === "build_default_primary_state_schema" ||
      node.type === "build_default_environment_state_schema"
  );
  if (hasSchemaPrepRuntimeNodes) {
    return false;
  }

  return canvas.graph.nodes.some(
    (node) =>
      isPromptNode(node) &&
      typeof node.data?.label === "string" &&
      (normalizeKey(node.data.label).includes(normalizeKey("environmentAgents")) ||
        normalizeKey(node.data.label).includes(normalizeKey("agentConnections"))) &&
      normalizeKey(node.data.label).includes(
        normalizeKey("structured planner patch")
      )
  );
}

function seedCanvasOmitsRedundantDerivedStateNode(canvas: CanvasEntry): boolean {
  return !canvas.graph.nodes.some(
    (node) =>
      isPromptNode(node) &&
      normalizeKey(typeof node.data?.label === "string" ? node.data.label : "") ===
        normalizeKey(
          "Treat current_build as already synchronized from the live draft, and derive draft_seed_ready=true, structured_draft_exists, drafted_artifacts, and process_open_questions from it."
        )
  );
}

function seedCanvasUsesApprovedWorkflowCheckpoint(canvas: CanvasEntry): boolean {
  return canvas.graph.nodes.some((node) => {
    const label =
      isPromptNode(node) && typeof node.data?.label === "string"
        ? normalizeKey(node.data.label)
        : "";
    return (
      label.includes(normalizeKey("workflow_decomposition_complete is true")) &&
      label.includes(normalizeKey("approved workflow hierarchy")) &&
      label.includes(normalizeKey("Do not emit workflowStages or workflowStagePartitions"))
    );
  });
}

function applyPatchCanvasUsesConditionalSeedSchemaPrep(
  canvas: CanvasEntry
): boolean {
  const seedGate = canvas.graph.nodes.find(
    (node) =>
      node.type === "condition" &&
      normalizeKey(typeof node.data?.label === "string" ? node.data.label : "") ===
        normalizeKey("structured_draft_exists is false")
  );
  const primarySchemaNode = canvas.graph.nodes.find(
    (node) => node.type === "build_default_primary_state_schema"
  );
  const environmentSchemaNode = canvas.graph.nodes.find(
    (node) => node.type === "build_default_environment_state_schema"
  );
  const materializationBuildRequestsNode = canvas.graph.nodes.find(
    (node) => node.type === "build_initial_canvas_shape_materialization_requests"
  );
  const materializationGateNode = canvas.graph.nodes.find(
    (node) =>
      node.type === "condition" &&
      normalizeKey(
        canonicalizeExplicitLocalValueConditionLabel(
          typeof node.data?.label === "string" ? node.data.label : ""
        )
      ) === normalizeKey(DAEMON_INITIAL_CANVAS_SHAPE_REQUESTS_GATE_LABEL)
  );
  const materializationPromptNode = canvas.graph.nodes.find((node) =>
    normalizePromptOutputFields(node.data?.promptOutputFields).some(
      (field) =>
        normalizeKey(field.name) ===
        normalizeKey(DAEMON_MATERIALIZED_INITIAL_CANVAS_STRUCTURES_OUTPUT.name)
    )
  );
  const materializationMergeNode = canvas.graph.nodes.find(
    (node) => node.type === "merge_materialized_initial_canvas_structures"
  );
  const hasScaffoldTools = canvas.graph.nodes.some(
    (node) => node.type === "scaffold_tools"
  );
  const hasPromptSync = canvas.graph.nodes.some(
    (node) => node.type === "sync_derived_prompts"
  );

  return (
    Boolean(seedGate) &&
    Boolean(primarySchemaNode) &&
    Boolean(environmentSchemaNode) &&
    canvas.graph.edges.some(
      (edge) =>
        edge.source === seedGate?.id &&
        edge.target === primarySchemaNode?.id &&
        edge.sourceHandle === "true"
    ) &&
    canvas.graph.edges.some(
      (edge) =>
        edge.source === seedGate?.id &&
        edge.target === environmentSchemaNode?.id &&
        edge.sourceHandle === "false"
    ) &&
    canvas.graph.edges.some(
      (edge) =>
        edge.source === primarySchemaNode?.id &&
        edge.target === environmentSchemaNode?.id
    ) &&
    canvas.graph.edges.some(
      (edge) =>
        edge.source === environmentSchemaNode?.id &&
        edge.target === materializationBuildRequestsNode?.id
    ) &&
    canvas.graph.edges.some(
      (edge) =>
        edge.source === materializationBuildRequestsNode?.id &&
        edge.target === materializationGateNode?.id
    ) &&
    canvas.graph.edges.some(
      (edge) =>
        edge.source === materializationGateNode?.id &&
        edge.target === materializationPromptNode?.id &&
        edge.sourceHandle === "true"
    ) &&
    canvas.graph.edges.some(
      (edge) =>
        edge.source === materializationGateNode?.id &&
        edge.target === materializationMergeNode?.id &&
        edge.sourceHandle === "false"
    ) &&
    canvas.graph.edges.some(
      (edge) =>
        edge.source === materializationPromptNode?.id &&
        edge.target === materializationMergeNode?.id
    ) &&
    hasScaffoldTools &&
    hasPromptSync
  );
}

function repairCanvasRulesCanvasUsesExplicitPassNodes(
  canvas: CanvasEntry
): boolean {
  const hasPrepareDetection = canvas.graph.nodes.some(
    (node) => node.type === "prepare_canvas_rule_detection_requests"
  );
  const hasDetectPrompt = canvas.graph.nodes.some((node) =>
    normalizePromptOutputFields(node.data?.promptOutputFields).some(
      (field) =>
        normalizeKey(field.name) ===
        normalizeKey(DAEMON_CANVAS_RULE_DETECTED_ISSUES_OUTPUT.name)
    )
  );
  const hasIssuesGate = canvas.graph.nodes.some(
    (node) =>
      node.type === "condition" &&
      normalizeKey(
        canonicalizeExplicitLocalValueConditionLabel(
          typeof node.data?.label === "string" ? node.data.label : ""
        )
      ) === normalizeKey(DAEMON_CANVAS_RULE_ISSUES_EXIST_GATE_LABEL)
  );
  const hasBuildRepairRequests = canvas.graph.nodes.some(
    (node) => node.type === "build_canvas_rule_repair_requests"
  );
  const hasRepairPrompt = canvas.graph.nodes.some((node) =>
    normalizePromptOutputFields(node.data?.promptOutputFields).some(
      (field) =>
        normalizeKey(field.name) ===
        normalizeKey(DAEMON_CANVAS_RULE_REPAIR_EDITS_OUTPUT.name)
    )
  );
  const hasApplyRepairs = canvas.graph.nodes.some(
    (node) => node.type === "apply_canvas_rule_repairs"
  );
  const hasPrepareRecheck = canvas.graph.nodes.some(
    (node) => node.type === "prepare_canvas_rule_recheck_requests"
  );
  const hasRecheckPrompt = canvas.graph.nodes.some((node) =>
    normalizePromptOutputFields(node.data?.promptOutputFields).some(
      (field) =>
        normalizeKey(field.name) ===
        normalizeKey(DAEMON_CANVAS_RULE_REMAINING_ISSUES_OUTPUT.name)
    )
  );
  const hasFinalize = canvas.graph.nodes.some(
    (node) => node.type === "finalize_canvas_rule_repair_pass"
  );
  const hasSyncNode = canvas.graph.nodes.some(
    (node) => node.type === "sync_derived_prompts"
  );

  return (
    hasPrepareDetection &&
    hasDetectPrompt &&
    hasIssuesGate &&
    hasBuildRepairRequests &&
    hasRepairPrompt &&
    hasApplyRepairs &&
    hasPrepareRecheck &&
    hasRecheckPrompt &&
    hasFinalize &&
    hasSyncNode
  );
}

function editingCanvasUsesExplicitEditRouting(canvas: CanvasEntry): boolean {
  const normalizedLabels = canvas.graph.nodes
    .map((node) =>
      normalizeKey(typeof node.data?.label === "string" ? node.data.label : "")
    )
    .filter(Boolean);

  const hasDecomposition = normalizedLabels.some((label) =>
    label.includes(normalizeKey("Decompose agent_latest_observation"))
  );
  const hasAgentRouting = normalizedLabels.some(
    (label) =>
      label.includes(normalizeKey("Determine which agent scope")) &&
      label.includes(normalizeKey("agentTarget"))
  );
  const hasEnvironmentAgentCreation = normalizedLabels.some(
    (label) =>
      (label.includes(normalizeKey("environment-agent creation requests")) ||
        label.includes(normalizeKey("connected-agent creation requests"))) &&
      (label.includes(normalizeKey("environmentAgents seed objects")) ||
        label.includes(normalizeKey("agentConnections seed objects")))
  );
  const hasSkillCreation = normalizedLabels.some(
    (label) =>
      label.includes(normalizeKey("user_skill_requests")) &&
      label.includes(normalizeKey("create a new temporally extended skill"))
  );
  const hasCanvasRouting = normalizedLabels.some((label) =>
    label.includes(normalizeKey("determine which canvas receives the edit"))
  );
  const hasConditionalRuntimeBehavior = normalizedLabels.some(
    (label) =>
      label.includes(normalizeKey("conditional runtime behavior")) &&
      label.includes(normalizeKey("condition node")) &&
      label.includes(normalizeKey("display text node"))
  );
  const hasAtomicEditTyping = normalizedLabels.some((label) =>
    label.includes(normalizeKey("Classify every atomic canvas edit"))
  );
  const hasPlacement = normalizedLabels.some((label) =>
    label.includes(normalizeKey("choose an explicit location"))
  );
  const hasToolPlacement = normalizedLabels.some((label) =>
    label.includes(normalizeKey("emit toolPlacements"))
  );

  return (
    hasDecomposition &&
    hasAgentRouting &&
    !hasEnvironmentAgentCreation &&
    !hasSkillCreation &&
    hasCanvasRouting &&
    hasConditionalRuntimeBehavior &&
    hasAtomicEditTyping &&
    hasPlacement &&
    hasToolPlacement
  );
}

function syncStructuredDaemonSubcanvas(
  canvas: CanvasEntry,
  templateCanvas: CanvasEntry | null
): CanvasEntry {
  if (!templateCanvas) {
    return canvas;
  }

  if (
    canvas.name.trim() === DAEMON_SEED_CANVAS_NAME &&
    (!seedCanvasUsesSharedPatchSchemaPrep(canvas) ||
      !seedCanvasOmitsRedundantDerivedStateNode(canvas) ||
      !seedCanvasUsesApprovedWorkflowCheckpoint(canvas))
  ) {
    return {
      ...templateCanvas,
      id: canvas.id,
      freeText: canvas.freeText?.trim() || templateCanvas.freeText,
    };
  }

  if (
    canvas.name.trim() === DAEMON_APPLY_PATCH_CANVAS_NAME &&
    !applyPatchCanvasUsesConditionalSeedSchemaPrep(canvas)
  ) {
    return {
      ...templateCanvas,
      id: canvas.id,
      freeText: canvas.freeText?.trim() || templateCanvas.freeText,
    };
  }

  if (
    canvas.name.trim() === DAEMON_REPAIR_CANVAS_RULES_CANVAS_NAME &&
    !repairCanvasRulesCanvasUsesExplicitPassNodes(canvas)
  ) {
    return {
      ...templateCanvas,
      id: canvas.id,
      freeText: canvas.freeText?.trim() || templateCanvas.freeText,
    };
  }

  if (
    canvas.name.trim() === DAEMON_EDITING_CANVAS_NAME &&
    !editingCanvasUsesExplicitEditRouting(canvas)
  ) {
    return {
      ...templateCanvas,
      id: canvas.id,
      freeText: canvas.freeText?.trim() || templateCanvas.freeText,
    };
  }

  const existingLabels = extractStructuredSubcanvasLabels(canvas);
  const templateLabels = extractStructuredSubcanvasLabels(templateCanvas);
  if (!existingLabels || !templateLabels) {
    return canvas;
  }

  const normalizedExisting = existingLabels.map((label) => normalizeKey(label)).sort();
  const normalizedTemplate = templateLabels.map((label) => normalizeKey(label)).sort();
  const labelsMatch =
    normalizedExisting.length === normalizedTemplate.length &&
    normalizedExisting.every((label, index) => label === normalizedTemplate[index]);

  if (labelsMatch) {
    const existingIsPromptForest = extractStartPromptForestLabels(canvas) !== null;
    const templateIsPromptForest = extractStartPromptForestLabels(templateCanvas) !== null;

    if (existingIsPromptForest === templateIsPromptForest) {
      return canvas;
    }

    return {
      ...templateCanvas,
      id: canvas.id,
      freeText: canvas.freeText?.trim() || templateCanvas.freeText,
    };
  }

  return {
    ...templateCanvas,
    id: canvas.id,
    freeText: canvas.freeText?.trim() || templateCanvas.freeText,
  };
}

function syncDaemonMainCanvasFreeText(value: string | null | undefined): string {
  const text = value?.trim() || DAEMON_MAIN_CANVAS_NOTES;
  return text.replace(
    /- If the process is rich enough to derive a broad target description but still too generic to seed confidently, keep process_ready=false, stay in [^,]+, and ask for more detail about the weakest components instead of silently backfilling a first draft\./g,
    "- If the process is rich enough to derive a broad target description but still too generic to seed confidently, keep process_ready=false, update process_open_questions, and ask through the process-clarification subtree instead of silently backfilling a first draft."
  );
}

function syncDaemonPolicyCanvas(doc: CanvasDoc | null): CanvasDoc | null {
  const structured = canonicalizeDaemonCanvasDocStorageIds(
    createDaemonPolicyCanvas(),
    doc,
    "policy"
  );
  if (shouldUpgradeToStructuredDaemonPolicy(doc)) {
    return structured;
  }

  if (daemonCanvasMentionsDraftSeedReady(doc)) {
    return structured;
  }

  if (daemonCanvasMentionsNeedsToolScaffolding(doc)) {
    return structured;
  }

  if (!doc || doc.canvases.length === 0) {
    return structured;
  }

  if (!doc.canvases.some((canvas) => canvas.name.trim() === DAEMON_MAIN_CANVAS_NAME)) {
    const structuredCanvasByName = new Map(
      structured.canvases.map((canvas) => [canvas.name.trim(), canvas])
    );
    const existingNames = new Set(doc.canvases.map((canvas) => canvas.name.trim()));
    const syncedCanvases = doc.canvases.map((canvas) =>
      syncStructuredDaemonSubcanvas(
        canvas,
        structuredCanvasByName.get(canvas.name.trim()) ?? null
      )
    );
    const missingStructuredCanvases = structured.canvases.filter(
      (canvas) => !existingNames.has(canvas.name.trim())
    );
    return canonicalizeDaemonCanvasDocStorageIds(
      {
        ...doc,
        activeId: doc.activeId || syncedCanvases[0]?.id || "",
        canvases: [...syncedCanvases, ...missingStructuredCanvases],
      },
      doc,
      "policy"
    );
  }

  const replaceLegacyMainCanvas =
    daemonMainCanvasUsesLegacyGeneralDescriptionGate(doc) ||
    daemonMainCanvasRoutesProcessReadinessBeforeDraftExistence(doc) ||
    daemonMainCanvasMissingProcessClarificationReplyTail(doc) ||
    daemonMainCanvasUsesLegacyProxyModeGates(doc) ||
    daemonMainCanvasUsesInvalidTriageFallback(doc) ||
    daemonMainCanvasUsesLegacyModeRoutingIssueFallback(doc) ||
    daemonMainCanvasMissingWorkflowReviewGate(doc) ||
    daemonMainCanvasMissingEditingGate(doc) ||
    daemonMainCanvasMissingEnvironmentAgentGate(doc) ||
    daemonMainCanvasMissingSkillGate(doc) ||
    daemonMainCanvasMissingTriageGate(doc) ||
    daemonMainCanvasMissingToolingGate(doc);

  const structuredCanvasByName = new Map(
    structured.canvases.map((canvas) => [canvas.name.trim(), canvas])
  );
  const existingNames = new Set(doc.canvases.map((canvas) => canvas.name.trim()));
  const missingStructuredCanvases = structured.canvases.filter(
    (canvas) => !existingNames.has(canvas.name.trim())
  );
  const mainCanvasIndex = doc.canvases.findIndex(
    (canvas) => canvas.name.trim() === DAEMON_MAIN_CANVAS_NAME
  );
  const targetIndex = mainCanvasIndex >= 0 ? mainCanvasIndex : 0;
  const targetCanvas = doc.canvases[targetIndex];
  const structuredMainCanvas =
    structuredCanvasByName.get(DAEMON_MAIN_CANVAS_NAME) ?? structured.canvases[0];
  const syncedExistingCanvases = doc.canvases.map((canvas, index) => {
      const structuredSubcanvas =
        structuredCanvasByName.get(canvas.name.trim()) ?? null;
      const upgradedStructuredSubcanvas =
        index === targetIndex
          ? replaceLegacyMainCanvas
            ? {
                ...structuredMainCanvas,
                id: canvas.id,
                name: canvas.name,
              }
            : canvas
          : !structuredSubcanvas
            ? canvas
            : syncStructuredDaemonSubcanvas(canvas, structuredSubcanvas);
      const nextCanvas = {
        ...upgradedStructuredSubcanvas,
        freeText:
          index === targetIndex
            ? syncDaemonMainCanvasFreeText(upgradedStructuredSubcanvas.freeText)
            : upgradedStructuredSubcanvas.freeText,
        graph: {
          ...upgradedStructuredSubcanvas.graph,
          nodes: upgradedStructuredSubcanvas.graph.nodes.map((node) => {
            const runtimeOperationType =
              node.type === "action" &&
              (node.data?.actionType ===
                "build_default_primary_state_schema" ||
                node.data?.actionType ===
                  "build_default_environment_state_schema" ||
                node.data?.actionType ===
                  "build_initial_canvas_shape_materialization_requests" ||
                node.data?.actionType ===
                  "materialize_initial_canvas_structures" ||
                node.data?.actionType ===
                  "merge_materialized_initial_canvas_structures" ||
                node.data?.actionType ===
                  "prepare_canvas_rule_detection_requests" ||
                node.data?.actionType ===
                  "build_canvas_rule_repair_requests" ||
                node.data?.actionType ===
                  "apply_canvas_rule_repairs" ||
                node.data?.actionType ===
                  "prepare_canvas_rule_recheck_requests" ||
                node.data?.actionType ===
                  "finalize_canvas_rule_repair_pass" ||
                node.data?.actionType === "apply_structured_patch" ||
                node.data?.actionType === "scaffold_tools" ||
                node.data?.actionType === "sync_derived_prompts" ||
                node.data?.actionType === "repair_canvas_rules" ||
                node.data?.actionType === "finalize_assistant_reply" ||
                node.data?.actionType === "raise_error")
                ? node.data.actionType
                : null;

            const normalizedNode =
              runtimeOperationType === null
                ? node
                : (() => {
                    const nextData = { ...node.data };
                    delete nextData.actionType;

                    return {
                      ...node,
                      type: runtimeOperationType,
                      data: {
                        ...nextData,
                        label:
                          typeof node.data?.label === "string" &&
                          node.data.label.trim()
                            ? node.data.label
                            : runtimeOperationType ===
                                "build_default_primary_state_schema"
                              ? DAEMON_BUILD_DEFAULT_PRIMARY_SCHEMA_LABEL
                              : runtimeOperationType ===
                                  "build_default_environment_state_schema"
                                ? DAEMON_BUILD_DEFAULT_ENVIRONMENT_SCHEMA_LABEL
                                : runtimeOperationType ===
                                    "build_initial_canvas_shape_materialization_requests"
                                  ? DAEMON_BUILD_INITIAL_CANVAS_SHAPE_REQUESTS_LABEL
                                  : runtimeOperationType ===
                                      "materialize_initial_canvas_structures"
                                    ? DAEMON_MATERIALIZE_INITIAL_CANVAS_STRUCTURES_LABEL
                                    : runtimeOperationType ===
                                        "merge_materialized_initial_canvas_structures"
                                      ? DAEMON_MERGE_MATERIALIZED_INITIAL_CANVAS_STRUCTURES_LABEL
                                      : runtimeOperationType ===
                                          "prepare_canvas_rule_detection_requests"
                                        ? DAEMON_PREPARE_CANVAS_RULE_DETECTION_REQUESTS_LABEL
                                        : runtimeOperationType ===
                                            "build_canvas_rule_repair_requests"
                                          ? DAEMON_BUILD_CANVAS_RULE_REPAIR_REQUESTS_LABEL
                                          : runtimeOperationType ===
                                              "apply_canvas_rule_repairs"
                                            ? DAEMON_APPLY_CANVAS_RULE_REPAIRS_LABEL
                                            : runtimeOperationType ===
                                                "prepare_canvas_rule_recheck_requests"
                                              ? DAEMON_PREPARE_CANVAS_RULE_RECHECK_REQUESTS_LABEL
                                              : runtimeOperationType ===
                                                  "finalize_canvas_rule_repair_pass"
                                                ? DAEMON_FINALIZE_CANVAS_RULE_REPAIR_PASS_LABEL
                                                : runtimeOperationType ===
                                                    "apply_structured_patch"
                                                  ? DAEMON_APPLY_PATCH_LABEL
                                                  : runtimeOperationType ===
                                                      "scaffold_tools"
                                                    ? DAEMON_SCAFFOLD_TOOLS_LABEL
                                                    : runtimeOperationType ===
                                                        "sync_derived_prompts"
                                                      ? DAEMON_SYNC_PROMPTS_LABEL
                                                      : runtimeOperationType ===
                                                          "repair_canvas_rules"
                                                        ? DAEMON_REPAIR_CANVAS_RULES_LABEL
                                                        : runtimeOperationType ===
                                                            "raise_error"
                                                          ? "Abort policy execution and raise an explicit runtime error."
                                                          : DAEMON_FINALIZE_REPLY_LABEL,
                      },
                    };
                  })();

            const appendNormalizedNode =
              normalizeAppendAssistantTurnCodeNode(normalizedNode);

            if (typeof appendNormalizedNode.data?.label !== "string") {
              return appendNormalizedNode;
            }

            const label = appendNormalizedNode.data.label;
            const rewrittenLabel =
              DAEMON_POLICY_LABEL_REWRITES.get(label) ??
              canonicalizeExplicitLocalValueConditionLabel(label);

            if (rewrittenLabel === label) {
              return appendNormalizedNode;
            }

            return {
              ...appendNormalizedNode,
              data: {
                ...appendNormalizedNode.data,
                label: rewrittenLabel,
              },
            };
          }),
        },
      };

      return index === targetIndex
        ? ensureDaemonPostProcessingChain(nextCanvas)
        : nextCanvas;
    });

  return canonicalizeDaemonCanvasDocStorageIds({
    ...doc,
    canvases: [
      ...syncedExistingCanvases.map((canvas, index) =>
        index === targetIndex
          ? {
              ...targetCanvas,
              ...canvas,
            }
          : canvas
      ),
      ...missingStructuredCanvases,
    ],
  }, doc, "policy");
}

function daemonCanvasMentionsDraftSeedReady(doc: CanvasDoc | null): boolean {
  if (!doc) {
    return false;
  }

  return doc.canvases.some((canvas) =>
    canvas.graph.nodes.some(
      (node) =>
        typeof node.data?.label === "string" &&
        normalizeKey(node.data.label).includes(normalizeKey("draft_seed_ready"))
    )
  );
}

function daemonMainCanvasUsesLegacyGeneralDescriptionGate(
  doc: CanvasDoc | null
): boolean {
  if (!doc || doc.canvases.length === 0) {
    return false;
  }

  const mainCanvas =
    doc.canvases.find((canvas) => canvas.name.trim() === DAEMON_MAIN_CANVAS_NAME) ??
    doc.canvases[0];

  return mainCanvas.graph.nodes.some(
    (node) =>
      node.type === "condition" &&
      typeof node.data?.label === "string" &&
      (normalizeKey(node.data.label) === normalizeKey("general_description is empty") ||
        normalizeKey(node.data.label) ===
          normalizeKey("a useful broad target demo description is still missing"))
  );
}

function daemonMainCanvasRoutesProcessReadinessBeforeDraftExistence(
  doc: CanvasDoc | null
): boolean {
  if (!doc || doc.canvases.length === 0) {
    return false;
  }

  const mainCanvas =
    doc.canvases.find((canvas) => canvas.name.trim() === DAEMON_MAIN_CANVAS_NAME) ??
    doc.canvases[0];
  const start =
    mainCanvas.graph.nodes.find((node) => node.type === "start") ?? null;
  const processReadyGate =
    mainCanvas.graph.nodes.find(
      (node) =>
        node.type === "condition" &&
        typeof node.data?.label === "string" &&
        normalizeKey(node.data.label) === normalizeKey("process_ready is false")
    ) ?? null;
  const seedGate =
    mainCanvas.graph.nodes.find(
      (node) =>
        node.type === "condition" &&
        typeof node.data?.label === "string" &&
        normalizeKey(node.data.label) ===
          normalizeKey("structured_draft_exists is false")
    ) ?? null;

  return Boolean(
    start &&
      processReadyGate &&
      seedGate &&
      mainCanvas.graph.edges.some(
        (edge) => edge.source === start.id && edge.target === processReadyGate.id
      ) &&
      mainCanvas.graph.edges.some(
        (edge) =>
          edge.source === processReadyGate.id &&
          edge.target === seedGate.id &&
          edge.sourceHandle === "false"
      )
  );
}

function daemonMainCanvasMissingProcessClarificationReplyTail(
  doc: CanvasDoc | null
): boolean {
  if (!doc || doc.canvases.length === 0) {
    return true;
  }

  const mainCanvas =
    doc.canvases.find((canvas) => canvas.name.trim() === DAEMON_MAIN_CANVAS_NAME) ??
    doc.canvases[0];
  const clarifyProcess =
    mainCanvas.graph.nodes.find(
      (node) =>
        node.type === "expand" &&
        typeof node.data?.label === "string" &&
        normalizeKey(node.data.label) === normalizeKey(DAEMON_PROCESS_CANVAS_NAME)
    ) ?? null;
  const finalizeAssistantReplyNode =
    mainCanvas.graph.nodes.find(
      (node) =>
        node.type === "finalize_assistant_reply" ||
        node.data?.actionType === "finalize_assistant_reply"
    ) ?? null;

  if (!clarifyProcess || !finalizeAssistantReplyNode) {
    return true;
  }

  return !mainCanvas.graph.edges.some(
    (edge) =>
      edge.source === clarifyProcess.id &&
      edge.target === finalizeAssistantReplyNode.id
  );
}

function daemonMainCanvasMissingEditingGate(doc: CanvasDoc | null): boolean {
  return daemonMainCanvasMissingRequestGate(
    doc,
    DAEMON_USER_EDIT_REQUESTS_GATE_LABEL
  );
}

function daemonMainCanvasMissingTriageGate(doc: CanvasDoc | null): boolean {
  return daemonMainCanvasMissingRequestGate(
    doc,
    DAEMON_PROCESS_OPEN_QUESTIONS_GATE_LABEL
  );
}

function daemonMainCanvasMissingToolingGate(doc: CanvasDoc | null): boolean {
  if (daemonMainCanvasMissingRequestGate(doc, DAEMON_USER_TOOLING_REQUESTS_GATE_LABEL)) {
    return true;
  }

  if (!doc || doc.canvases.length === 0) {
    return true;
  }

  const mainCanvas =
    doc.canvases.find((canvas) => canvas.name.trim() === DAEMON_MAIN_CANVAS_NAME) ??
    doc.canvases[0];
  const skillGate =
    mainCanvas.graph.nodes.find(
      (node) =>
        node.type === "condition" &&
        typeof node.data?.label === "string" &&
        normalizeKey(node.data.label) ===
          normalizeKey(DAEMON_USER_SKILL_REQUESTS_GATE_LABEL)
    ) ?? null;
  const skillSubtree =
    mainCanvas.graph.nodes.find(
      (node) =>
        node.type === "expand" &&
        typeof node.data?.label === "string" &&
        normalizeKey(node.data.label) ===
          normalizeKey(DAEMON_SKILL_CREATION_CANVAS_NAME)
    ) ?? null;
  const toolingGate =
    mainCanvas.graph.nodes.find(
      (node) =>
        node.type === "condition" &&
        typeof node.data?.label === "string" &&
        normalizeKey(node.data.label) ===
          normalizeKey(DAEMON_USER_TOOLING_REQUESTS_GATE_LABEL)
    ) ?? null;

  return !(
    skillGate &&
    skillSubtree &&
    toolingGate &&
    mainCanvas.graph.edges.some(
      (edge) =>
        edge.source === skillGate.id &&
        edge.target === toolingGate.id &&
        edge.sourceHandle === "false"
    ) &&
    mainCanvas.graph.edges.some(
      (edge) =>
        edge.source === skillSubtree.id && edge.target === toolingGate.id
    )
  );
}

function daemonMainCanvasMissingSkillGate(doc: CanvasDoc | null): boolean {
  if (daemonMainCanvasMissingRequestGate(doc, DAEMON_USER_SKILL_REQUESTS_GATE_LABEL)) {
    return true;
  }

  if (!doc || doc.canvases.length === 0) {
    return true;
  }

  const mainCanvas =
    doc.canvases.find((canvas) => canvas.name.trim() === DAEMON_MAIN_CANVAS_NAME) ??
    doc.canvases[0];
  const skillGate =
    mainCanvas.graph.nodes.find(
      (node) =>
        node.type === "condition" &&
        typeof node.data?.label === "string" &&
        normalizeKey(node.data.label) ===
          normalizeKey(DAEMON_USER_SKILL_REQUESTS_GATE_LABEL)
    ) ?? null;
  const skillSubtree =
    mainCanvas.graph.nodes.find(
      (node) =>
        node.type === "expand" &&
        typeof node.data?.label === "string" &&
        normalizeKey(node.data.label) ===
          normalizeKey(DAEMON_SKILL_CREATION_CANVAS_NAME)
    ) ?? null;
  const environmentAgentGate =
    mainCanvas.graph.nodes.find(
      (node) =>
        node.type === "condition" &&
        typeof node.data?.label === "string" &&
        normalizeKey(node.data.label) ===
          normalizeKey(DAEMON_USER_ENVIRONMENT_AGENT_REQUESTS_GATE_LABEL)
    ) ?? null;
  const environmentAgentSubtree =
    mainCanvas.graph.nodes.find(
      (node) =>
        node.type === "expand" &&
        typeof node.data?.label === "string" &&
        normalizeKey(node.data.label) ===
          normalizeKey(DAEMON_ENVIRONMENT_AGENT_CREATION_CANVAS_NAME)
    ) ?? null;

  return !(
    skillGate &&
    skillSubtree &&
    environmentAgentGate &&
    environmentAgentSubtree &&
    mainCanvas.graph.edges.some(
      (edge) =>
        edge.source === skillGate.id &&
        edge.target === skillSubtree.id &&
        edge.sourceHandle === "true"
    ) &&
    mainCanvas.graph.edges.some(
      (edge) =>
        edge.source === environmentAgentGate.id &&
        edge.target === skillGate.id &&
        edge.sourceHandle === "false"
    ) &&
    mainCanvas.graph.edges.some(
      (edge) =>
        edge.source === environmentAgentSubtree.id && edge.target === skillGate.id
    )
  );
}

function daemonMainCanvasMissingEnvironmentAgentGate(
  doc: CanvasDoc | null
): boolean {
  if (!doc || doc.canvases.length === 0) {
    return true;
  }

  const mainCanvas =
    doc.canvases.find((canvas) => canvas.name.trim() === DAEMON_MAIN_CANVAS_NAME) ??
    doc.canvases[0];
  const environmentAgentGate =
    mainCanvas.graph.nodes.find(
      (node) =>
        node.type === "condition" &&
        typeof node.data?.label === "string" &&
        normalizeKey(node.data.label) ===
          normalizeKey(DAEMON_USER_ENVIRONMENT_AGENT_REQUESTS_GATE_LABEL)
    ) ?? null;
  const environmentAgentSubtree =
    mainCanvas.graph.nodes.find(
      (node) =>
        node.type === "expand" &&
        typeof node.data?.label === "string" &&
        normalizeKey(node.data.label) ===
          normalizeKey(DAEMON_ENVIRONMENT_AGENT_CREATION_CANVAS_NAME)
    ) ?? null;
  const seedGate =
    mainCanvas.graph.nodes.find(
      (node) =>
        node.type === "condition" &&
        typeof node.data?.label === "string" &&
        normalizeKey(node.data.label) ===
          normalizeKey("structured_draft_exists is false")
    ) ?? null;
  const seedDraft =
    mainCanvas.graph.nodes.find(
      (node) =>
        node.type === "expand" &&
        typeof node.data?.label === "string" &&
        normalizeKey(node.data.label) === normalizeKey(DAEMON_SEED_CANVAS_NAME)
    ) ?? null;

  return !(
    environmentAgentGate &&
    environmentAgentSubtree &&
    seedGate &&
    seedDraft &&
    mainCanvas.graph.edges.some(
      (edge) =>
        edge.source === environmentAgentGate.id &&
        edge.target === environmentAgentSubtree.id &&
        edge.sourceHandle === "true"
    ) &&
    mainCanvas.graph.edges.some(
      (edge) =>
        edge.source === seedGate.id &&
        edge.target === environmentAgentGate.id &&
        edge.sourceHandle === "false"
    ) &&
    mainCanvas.graph.edges.some(
      (edge) =>
        edge.source === seedDraft.id && edge.target === environmentAgentGate.id
    )
  );
}

function daemonMainCanvasUsesLegacyProxyModeGates(doc: CanvasDoc | null): boolean {
  if (!doc || doc.canvases.length === 0) {
    return false;
  }

  const mainCanvas =
    doc.canvases.find((canvas) => canvas.name.trim() === DAEMON_MAIN_CANVAS_NAME) ??
    doc.canvases[0];

  return mainCanvas.graph.nodes.some(
    (node) =>
      node.type === "condition" &&
      typeof node.data?.label === "string" &&
      (normalizeKey(node.data.label) ===
        normalizeKey(
          "important policy questions remain open or the current build is still underspecified"
        ) ||
        normalizeKey(node.data.label) ===
          normalizeKey(
            "a requested capability is not covered by the current tool surface"
          ))
  );
}

function daemonMainCanvasUsesInvalidTriageFallback(doc: CanvasDoc | null): boolean {
  if (!doc || doc.canvases.length === 0) {
    return false;
  }

  const mainCanvas =
    doc.canvases.find((canvas) => canvas.name.trim() === DAEMON_MAIN_CANVAS_NAME) ??
    doc.canvases[0];
  const triageGate =
    mainCanvas.graph.nodes.find(
      (node) =>
        node.type === "condition" &&
        typeof node.data?.label === "string" &&
        normalizeKey(node.data.label) ===
          normalizeKey(DAEMON_PROCESS_OPEN_QUESTIONS_GATE_LABEL)
    ) ?? null;

  if (!triageGate) {
    return false;
  }

  const trueEdge =
    mainCanvas.graph.edges.find(
      (edge) => edge.source === triageGate.id && edge.sourceHandle === "true"
    ) ?? null;
  const falseEdge =
    mainCanvas.graph.edges.find(
      (edge) => edge.source === triageGate.id && edge.sourceHandle === "false"
    ) ?? null;

  if (!trueEdge || !falseEdge) {
    return false;
  }

  return trueEdge.target === falseEdge.target;
}

function daemonMainCanvasUsesLegacyModeRoutingIssueFallback(
  doc: CanvasDoc | null
): boolean {
  if (!doc || doc.canvases.length === 0) {
    return false;
  }

  const mainCanvas =
    doc.canvases.find((canvas) => canvas.name.trim() === DAEMON_MAIN_CANVAS_NAME) ??
    doc.canvases[0];

  return mainCanvas.graph.nodes.some(
    (node) =>
      node.type === "expand" &&
      typeof node.data?.label === "string" &&
      normalizeKey(node.data.label) ===
        normalizeKey(LEGACY_DAEMON_MODE_ROUTING_ISSUE_CANVAS_NAME)
  );
}

function daemonMainCanvasMissingRequestGate(
  doc: CanvasDoc | null,
  gateLabel: string
): boolean {
  if (!doc || doc.canvases.length === 0) {
    return true;
  }

  const mainCanvas =
    doc.canvases.find((canvas) => canvas.name.trim() === DAEMON_MAIN_CANVAS_NAME) ??
    doc.canvases[0];

  return !mainCanvas.graph.nodes.some(
    (node) =>
      node.type === "condition" &&
      typeof node.data?.label === "string" &&
      normalizeKey(node.data.label) === normalizeKey(gateLabel)
  );
}

function daemonMainCanvasMissingWorkflowReviewGate(doc: CanvasDoc | null): boolean {
  if (!doc || doc.canvases.length === 0) {
    return true;
  }

  const mainCanvas =
    doc.canvases.find((canvas) => canvas.name.trim() === DAEMON_MAIN_CANVAS_NAME) ??
    doc.canvases[0];
  const hasApprovalGate = mainCanvas.graph.nodes.some(
    (node) =>
      node.type === "condition" &&
      typeof node.data?.label === "string" &&
      normalizeKey(node.data.label) ===
        normalizeKey(DAEMON_WORKFLOW_DECOMPOSITION_GATE_LABEL)
  );
  const hasWorkflowReviewExpand = mainCanvas.graph.nodes.some(
    (node) =>
      node.type === "expand" &&
      typeof node.data?.label === "string" &&
      normalizeKey(node.data.label) ===
        normalizeKey(DAEMON_WORKFLOW_REVIEW_CANVAS_NAME)
  );

  return !hasApprovalGate || !hasWorkflowReviewExpand;
}

function hasDaemonCurrentBuildSyncNode(doc: CanvasDoc | null): boolean {
  if (!doc) {
    return false;
  }

  return doc.canvases.some((canvas) =>
    canvas.graph.nodes.some(
      (node) =>
        typeof node.data?.label === "string" &&
        normalizeKey(node.data.label) === normalizeKey(DAEMON_BUILD_CURRENT_BUILD_LABEL)
    )
  );
}

function hasDaemonConversationMemoryNode(doc: CanvasDoc | null): boolean {
  if (!doc) {
    return false;
  }

  return doc.canvases.some((canvas) =>
    canvas.graph.nodes.some(
      (node) =>
        nodeLabelIncludes(node, "summary plus new_events exceeds") ||
        (typeof node.data?.label === "string" &&
          normalizeKey(node.data.label) ===
            normalizeKey(
              "Add agent_latest_observation and agent_latest_reward to new_events."
            ))
    )
  );
}

function normalizeDaemonEnvironmentPlayers(
  players: OrchestrationProject["environmentPlayers"]
): OrchestrationProject["environmentPlayers"] {
  return players.map((player) => ({
    ...player,
    fields: ensureRequiredEnvironmentAgentStateFields(player.fields),
    stateUpdatePrompt: shouldUpgradeDaemonEnvironmentAgentStatePrompt(
      player.stateUpdatePrompt
    )
      ? DAEMON_ENVIRONMENT_AGENT_STATE_UPDATE_PROMPT
      : player.stateUpdatePrompt,
    policyPrompt: shouldUpgradeDaemonEnvironmentAgentPolicyPrompt(
      player.policyPrompt
    )
      ? DAEMON_ENVIRONMENT_AGENT_POLICY_PROMPT
      : player.policyPrompt,
    policyCanvases: ensureDaemonEnvironmentAgentCanvasDoc(
      player.policyCanvases,
      createDaemonEnvironmentAgentPolicyCanvas
    ),
    statePolicyCanvases: ensureDaemonEnvironmentAgentCanvasDoc(
      player.statePolicyCanvases,
      createDaemonEnvironmentAgentStateCanvas
    ),
  }));
}

function hasDaemonProcessStateNode(doc: CanvasDoc | null): boolean {
  if (!doc) {
    return false;
  }

  return doc.canvases.some((canvas) =>
    canvas.graph.nodes.some(
      (node) =>
        typeof node.data?.label === "string" &&
        normalizeKey(node.data.label).includes(normalizeKey("process_model")) &&
        normalizeKey(node.data.label).includes(normalizeKey("process_ready")) &&
        normalizeKey(node.data.label).includes(
          normalizeKey("process_agent_description")
        ) &&
        normalizeKey(node.data.label).includes(
          normalizeKey("process_environment_description")
        ) &&
        normalizeKey(node.data.label).includes(
          normalizeKey("process_observation_description")
        ) &&
        normalizeKey(node.data.label).includes(
          normalizeKey("process_reward_description")
        ) &&
        normalizeKey(node.data.label).includes(
          normalizeKey("process_action_description")
        )
    )
  );
}

function daemonStateCanvasUsesPrimaryMemoryIngress(doc: CanvasDoc | null): boolean {
  if (!doc) {
    return false;
  }

  return doc.canvases.some((canvas) =>
    canvas.graph.nodes.some(
      (node) =>
        typeof node.data?.label === "string" &&
        normalizeKey(node.data.label).includes(
          normalizeKey("agent_latest_observation")
        ) &&
        normalizeKey(node.data.label).includes(normalizeKey("agent_latest_reward"))
    )
  );
}

function daemonStateCanvasMentionsRequestRoutingFields(
  doc: CanvasDoc | null
): boolean {
  if (!doc) {
    return false;
  }

  return doc.canvases.some((canvas) =>
    canvas.graph.nodes.some((node) => {
      if (!isPromptNode(node) || typeof node.data?.label !== "string") {
        return false;
      }

      const label = normalizeKey(node.data.label);
      return (
        label.includes(normalizeKey("user_skill_requests")) &&
        label.includes(normalizeKey("user_environment_agent_requests"))
      );
    })
  );
}

function daemonStateCanvasUsesOverlappingBuildFactDerivation(
  doc: CanvasDoc | null
): boolean {
  if (!doc) {
    return false;
  }

  return doc.canvases.some((canvas) =>
    canvas.graph.nodes.some((node) => {
      if (!isPromptNode(node) || typeof node.data?.label !== "string") {
        return false;
      }

      const label = normalizeKey(node.data.label);
      return (
        label.includes(normalizeKey("derive general_description")) &&
        label.includes(normalizeKey("process_open_questions")) &&
        label.includes(normalizeKey("user_edit_requests")) &&
        label.includes(normalizeKey("user_environment_agent_requests"))
      );
    })
  );
}

function syncDaemonStateCanvas(doc: CanvasDoc | null): CanvasDoc | null {
  return canonicalizeDaemonCanvasDocStorageIds(
    createDaemonStateCanvas(),
    doc,
    "state"
  );
}

function syncDaemonWorkflowCanvas(doc: CanvasDoc | null): CanvasDoc | null {
  const structured = canonicalizeDaemonCanvasDocStorageIds(
    createDaemonRuntimeWorkflowCanvas(),
    doc,
    "workflow"
  );
  if (!doc || doc.canvases.length === 0) {
    return structured;
  }
  return docHasCanvasNamed(doc, DAEMON_RUNTIME_WORKFLOW_CANVAS_NAME)
    ? doc
    : structured;
}

export function createDefaultDaemonRuntimeProject(): OrchestrationProject {
  const project = createDaemonRuntimeProjectBase();
  project.workflowCanvases = createDaemonRuntimeWorkflowCanvas();
  project.policyCanvases = createDaemonPolicyCanvas();
  project.statePolicyCanvases = createDaemonStateCanvas();

  return syncDerivedPrompts(project);
}

const DAEMON_ENVIRONMENT_AGENT_POLICY_PROMPT = [
  "You are the daemon's environment agent.",
  "You play the role of a user who wants to define and improve a target organizational workflow and its participating agents.",
  "You receive a target_agent_description from the human operator and a live snapshot of the workflow and agents under construction.",
  "If the daemon has drafted an Overall Workflow canvas or child stage workflow canvas and is asking whether it looks right, inspect that workflow against target_agent_description. Approve it clearly when it is a good abstraction; otherwise give concrete stage-level comments. Do not ask for state, policy, reward, datasets, or simulation until the workflow hierarchy is fully approved and decomposed enough for implementation.",
  "If the daemon is asking which workflow agents should be built, imported from the Agent Template Catalog, or played by the user, answer with a concrete boundary choice for every participating agent when target_agent_description provides enough context. If a catalog import is desired but the exact template is unknown, say which agent should be imported and ask to choose the closest template.",
  "If no structured target implementation draft has been built yet, do not compare against an empty draft. Continue the daemon conversation instead: answer any pending daemon questions from target_agent_description, review or approve the current workflow canvas when asked, choose agent boundaries when asked, and if no question is pending, ask for the next clarification, workflow drafting, workflow partitioning, boundary-selection, or implementation-seeding step.",
  "Once a structured target draft exists, inspect the current target draft against the target_agent_description. Decide the most important missing or weak part of the target design: workflow agent roles, built/imported/user-played boundary choices, agent IDs, pairwise agentConnections and policy canvases, observations, actions, rewards, state update, policy behavior, skills, datasets, tools, run contract, or simulation settings.",
  "Write the next user-side message to the daemon. Be concrete and ask for one coherent construction or revision step at a time.",
  "If the draft being built has no connected automated or imported agents (agentConnections), ask the daemon to add the needed stage interactions before requesting simulation.",
  "Simulation vocabulary: sourceAgentId and targetAgentId refer to workflow agent identities from agentConnections. In run-contract simulation settings, targetAgentId, simulationTargetAgentId, and environmentPlayerId refer to a connected counterpart agent from agentConnections.",
  "If a readable latest simulation transcript is available, inspect that transcript before requesting another simulation.",
  `If no latest simulation transcript is available and the draft being built is good enough to test, call the ${DAEMON_RUN_TARGET_SIMULATION_TOOL_NAME} tool to request a fresh simulation between connected workflow agents, then inspect that returned transcript in the same automated turn before ending the automated session.`,
  "Inspect the simulation transcript and ask: does this look like a typical real-life interaction between agents with these roles? If yes, terminate the session. If not, determine how the behavior of either agent should change to make the interaction more realistic, then ask the daemon to apply those concrete behavior changes.",
  "When a simulation transcript is available, keep the action text limited to the realism judgment or behavior-change request. Do not include the transcript in the action text; display the transcript separately from latest_simulation_transcript.",
  "Return only the message the user would send to the daemon.",
].join("\n");

const DAEMON_ENVIRONMENT_AGENT_STATE_UPDATE_PROMPT = [
  "Track what the target_agent_description requires, whether an Overall Workflow canvas exists, whether any child stage workflow canvases exist, whether the workflow hierarchy appears fully approved and decomposed enough for implementation, whether agent boundaries have been chosen, whether a structured implementation draft exists yet, what the draft being built already contains, whether it has connected counterpart agents, the most important missing design elements, whether the draft is good enough for simulation, and whether the latest simulation transcript looked realistic.",
  "Keep the state concise and oriented toward generating the next useful user-side message.",
].join("\n");

function shouldUpgradeDaemonEnvironmentAgentPolicyPrompt(value: string): boolean {
  const normalized = normalizeKey(value);
  return (
    !normalized ||
    (normalized.includes(normalizeKey("typical real-life interaction")) &&
      (!normalized.includes(normalizeKey("connected counterpart agents")) ||
        !normalized.includes(normalizeKey("project.agentId")) ||
        !normalized.includes(normalizeKey(DAEMON_RUN_TARGET_SIMULATION_TOOL_NAME)) ||
        !normalized.includes(normalizeKey("latest_simulation_transcript")) ||
        !normalized.includes(normalizeKey("display the transcript separately")) ||
        !normalized.includes(
          normalizeKey("no structured target implementation draft")
        ) ||
        !normalized.includes(normalizeKey("Overall Workflow canvas")) ||
        !normalized.includes(normalizeKey("child stage workflow canvas")) ||
        !normalized.includes(normalizeKey("workflow hierarchy is fully approved")) ||
        !normalized.includes(normalizeKey("agent boundaries")) ||
        !normalized.includes(normalizeKey("Approve it clearly")) ||
        !normalized.includes(normalizeKey("same automated turn")) ||
        !normalized.includes(
          normalizeKey("If a readable latest simulation transcript is available")
        ))) ||
    (!normalized.includes(normalizeKey("typical real-life interaction")) &&
      (normalized.includes(normalizeKey("occasionally ask the daemon primary agent")) ||
        normalized.includes(normalizeKey("occasionally request inspection"))))
  );
}

function shouldUpgradeDaemonEnvironmentAgentStatePrompt(value: string): boolean {
  const normalized = normalizeKey(value);
  return (
    !normalized ||
    (normalized.includes(normalizeKey("simulation transcript looked realistic")) &&
      (!normalized.includes(normalizeKey("connected counterpart agents")) ||
        !normalized.includes(
          normalizeKey("structured implementation draft exists")
        ) ||
        !normalized.includes(normalizeKey("Overall Workflow canvas")) ||
        !normalized.includes(normalizeKey("child stage workflow canvases")) ||
        !normalized.includes(
          normalizeKey("workflow hierarchy appears fully approved")
        ))) ||
    (!normalized.includes(normalizeKey("simulation transcript looked realistic")) &&
      normalized.includes(normalizeKey("pairwise interaction canvases")))
  );
}

function createEnvironmentStagePolicyCanvas(
  name: string,
  instruction: string,
  stageExitBranches: StageExitBranch[] = []
): CanvasEntry {
  const start = createCanvasNode(
    "start",
    220,
    40,
    `Environment-side stage policy: ${name}.`
  );
  const message = createCanvasNode("prompt", 220, 220, instruction);
  return appendEnvironmentPolicyReplyTail(
    {
      id: daemonCanvasStorageId("policy", name),
      name,
      freeText:
        "This environment policy stage writes the next user-side message. In conversation mode, the human user plays this environment role directly.",
      graph: {
        nodes: [start, message],
        edges: [createCanvasEdge(start.id, message.id)],
      },
    },
    stageExitBranches
  );
}

function appendEnvironmentPolicyReplyTail(
  entry: CanvasEntry,
  stageExitBranches: StageExitBranch[] = []
): CanvasEntry {
  const maxY = Math.max(
    40,
    ...entry.graph.nodes.map((node) => node.position.y)
  );
  const centerX =
    entry.graph.nodes.reduce((sum, node) => sum + node.position.x, 0) /
      Math.max(entry.graph.nodes.length, 1) || 220;
  const commitAction = createAppendAssistantTurnCodeNode(
    centerX,
    maxY + 180,
    "Commit the environment-side message to agent_latest_action and new_events."
  );
  const displayAction = createDisplayCommittedAgentActionNode(
    centerX,
    maxY + 340
  );
  const stageFinishedMessage = buildDaemonStageFinishedMessage(entry.name);
  const stageExitGroups = stageExitBranches.map((branch, index) => {
    const y = maxY + 500 + index * 240;
    const gate = createCanvasNode(
      "condition",
      centerX,
      y,
      branch.conditionLabel
    );
    const setStageFinishedMessage = createSetStageFinishedMessageCodeNode(
      centerX + 220,
      y,
      stageFinishedMessage
    );
    const displayStageFinishedMessage = createDisplayStageFinishedMessageNode(
      centerX + 440,
      y,
      stageFinishedMessage
    );
    const terminate = createCanvasNode(
      branch.immediate ? "terminate_stage_immediate" : "terminate_stage",
      centerX + 660,
      y,
      branch.immediate
        ? "Stage complete; move to the next stage state canvas immediately."
        : "Stage complete; next turn is controlled by the next stage canvas.",
      {
        nextStageId: branch.nextStageId,
      }
    );
    const continueNode = branch.continueOnFalse
      ? createCanvasNode(
          "continue",
          centerX - 320,
          y,
          "Stage is not complete; continue this stage next turn."
        )
      : null;
    return {
      gate,
      setStageFinishedMessage,
      displayStageFinishedMessage,
      terminate,
      continueNode,
    };
  });
  const stageExitNodes = stageExitGroups.flatMap(
    ({
      gate,
      setStageFinishedMessage,
      displayStageFinishedMessage,
      terminate,
      continueNode,
    }) =>
      continueNode
        ? [
            gate,
            setStageFinishedMessage,
            displayStageFinishedMessage,
            terminate,
            continueNode,
          ]
        : [gate, setStageFinishedMessage, displayStageFinishedMessage, terminate]
  );
  const outgoingSources = new Set(entry.graph.edges.map((edge) => edge.source));
  const leafNodes = entry.graph.nodes.filter(
    (node) =>
      !outgoingSources.has(node.id) &&
      node.type !== "display" &&
      node.type !== "terminate_stage" &&
      node.type !== "terminate_stage_immediate" &&
      node.type !== "terminate" &&
      node.type !== "continue" &&
      node.type !== "yield"
  );

  return {
    ...entry,
    graph: {
      nodes: [...entry.graph.nodes, commitAction, displayAction, ...stageExitNodes],
      edges: [
        ...entry.graph.edges,
        ...leafNodes.map((node) => createCanvasEdge(node.id, commitAction.id)),
        createCanvasEdge(commitAction.id, displayAction.id),
        ...(stageExitGroups.length > 0
          ? [
              createCanvasEdge(displayAction.id, stageExitGroups[0].gate.id),
              ...stageExitGroups.flatMap((group, index) => {
                const nextGate = stageExitGroups[index + 1]?.gate ?? null;
                const falseTarget = nextGate ?? group.continueNode;
                return [
                  createCanvasEdge(
                    group.gate.id,
                    group.setStageFinishedMessage.id,
                    "true"
                  ),
                  createCanvasEdge(
                    group.setStageFinishedMessage.id,
                    group.displayStageFinishedMessage.id
                  ),
                  createCanvasEdge(
                    group.displayStageFinishedMessage.id,
                    group.terminate.id
                  ),
                  ...(falseTarget
                    ? [createCanvasEdge(group.gate.id, falseTarget.id, "false")]
                    : []),
                ];
              }),
            ]
          : []),
      ],
    },
  };
}

function createDaemonEnvironmentAgentPolicyCanvas(): CanvasDoc {
  const understandStage = createEnvironmentStagePolicyCanvas(
    DAEMON_ENVIRONMENT_UNDERSTAND_POLICY_CANVAS_NAME,
    `Answer the daemon's most important clarification question from target_agent_description. If the daemon has not asked a question yet, provide a concrete workflow brief covering participating roles, environment, observations, success/reward signal, and actions. ${DAEMON_TYPICAL_ANSWER_CHOICE_INSTRUCTION} Return only the message the user would send.`,
    [
      {
        conditionLabel: `${DAEMON_WORKFLOW_STAGE_FIELD_NAME} is ${DAEMON_WORKFLOW_STAGE_APPROVE}`,
        nextStageId: DAEMON_WORKFLOW_STAGE_APPROVE,
        continueOnFalse: true,
      },
    ]
  );
  const approveStage = createEnvironmentStagePolicyCanvas(
    DAEMON_ENVIRONMENT_APPROVE_WORKFLOW_POLICY_CANVAS_NAME,
    "Inspect the current Overall Workflow or child stage workflow against target_agent_description. Approve it clearly when stages, loops, handoffs, and participating roles are right; otherwise give concrete stage-level corrections. Do not request implementation details until the workflow hierarchy is approved.",
    [
      {
        conditionLabel: `${DAEMON_WORKFLOW_STAGE_FIELD_NAME} is ${DAEMON_WORKFLOW_STAGE_BOUNDARIES}`,
        nextStageId: DAEMON_WORKFLOW_STAGE_BOUNDARIES,
        continueOnFalse: true,
      },
    ]
  );
  const boundaryStage = createEnvironmentStagePolicyCanvas(
    DAEMON_ENVIRONMENT_BOUNDARY_POLICY_CANVAS_NAME,
    "Choose a boundary mode for every participating workflow agent: build, import_template, or user_played. If a catalog import is desired but the exact template is unknown, say which role should be imported and ask the daemon to suggest the closest template. Return a complete boundary answer when possible.",
    [
      {
        conditionLabel: `${DAEMON_WORKFLOW_STAGE_FIELD_NAME} is ${DAEMON_WORKFLOW_STAGE_BUILD}`,
        nextStageId: DAEMON_WORKFLOW_STAGE_BUILD,
        continueOnFalse: true,
      },
    ]
  );
  const buildStage = createEnvironmentStagePolicyCanvas(
    DAEMON_ENVIRONMENT_BUILD_POLICY_CANVAS_NAME,
    "If workflow shape and boundaries are approved but no structured draft exists, ask the daemon to seed the runnable implementation draft from the approved workflow. Mention any known missing catalog/template choice that blocks seeding.",
    [
      {
        conditionLabel: `${DAEMON_WORKFLOW_STAGE_FIELD_NAME} is ${DAEMON_WORKFLOW_STAGE_REVIEW}`,
        nextStageId: DAEMON_WORKFLOW_STAGE_REVIEW,
        continueOnFalse: true,
      },
    ]
  );
  const reviewStage = createEnvironmentStagePolicyCanvas(
    DAEMON_ENVIRONMENT_REVIEW_POLICY_CANVAS_NAME,
    "Inspect the runnable draft and any latest simulation transcript. Ask for one concrete improvement at a time: workflow revision, boundary revision, agent connection, skill, tool, state/policy/reward behavior, or simulation realism change. If the draft is good enough and a simulation transcript looks realistic, terminate the automated session. Return only the message the user would send.",
    [
      {
        conditionLabel: `${DAEMON_WORKFLOW_STAGE_FIELD_NAME} is ${DAEMON_WORKFLOW_STAGE_APPROVE}`,
        nextStageId: DAEMON_WORKFLOW_STAGE_APPROVE,
      },
      {
        conditionLabel: `${DAEMON_WORKFLOW_STAGE_FIELD_NAME} is ${DAEMON_WORKFLOW_STAGE_BOUNDARIES}`,
        nextStageId: DAEMON_WORKFLOW_STAGE_BOUNDARIES,
      },
      {
        conditionLabel: `${DAEMON_WORKFLOW_STAGE_FIELD_NAME} is ${DAEMON_WORKFLOW_STAGE_BUILD}`,
        nextStageId: DAEMON_WORKFLOW_STAGE_BUILD,
        continueOnFalse: true,
      },
    ]
  );
  return {
    version: 2,
    activeId: understandStage.id,
    canvases: [
      understandStage,
      approveStage,
      boundaryStage,
      buildStage,
      reviewStage,
    ],
  };
}

function createDaemonEnvironmentAgentStateCanvas(): CanvasDoc {
  const makeStateStage = (name: string, label: string): CanvasEntry => {
    const stageStart = createCanvasNode(
      "start",
      220,
      40,
      [
        `Environment state stage: ${name}.`,
        "This canvas is self-contained for one automated environment-agent turn: it appends latest observation/reward to memory, summarizes long memory, then updates this stage's user-side planning state.",
      ].join(" ")
    );
    const appendEnvironmentTurn = createCanvasNode(
      "code",
      220,
      190,
      "Add agent_latest_observation and agent_latest_reward to new_events.",
      {
        actionType: "code",
        actionTypeSource: "auto",
        [NODE_EXECUTABLE_CODE_OPS_DATA_KEY]: [
          {
            kind: "append_list_item",
            field: NEW_EVENTS_FIELD_NAME,
            source: { kind: "latest_observation_and_reward_event" },
          },
        ],
        [NODE_LOCAL_INPUTS_DATA_KEY]: [
          {
            name: PRIMARY_AGENT_LATEST_OBSERVATION_FIELD_NAME,
            type: "string",
          },
          {
            name: PRIMARY_AGENT_LATEST_REWARD_FIELD_NAME,
            type: "number",
          },
        ],
      }
    );
    const summaryMemoryGate = createCanvasNode(
      "condition",
      220,
      350,
      `summary plus new_events exceeds ${DEFAULT_CONVERSATION_MEMORY_LIMIT} characters`
    );
    const summarizeMemory = createCanvasNode(
      "prompt",
      20,
      530,
      "Update summary with a concise summary of summary plus new_events."
    );
    const clearMemory = createCanvasNode(
      "code",
      20,
      700,
      "Set new_events to empty list.",
      buildClearNewEventsCodeNodeData()
    );
    const stagePrompt = createCanvasNode(
      "prompt",
      520,
      530,
      [
        label,
        `Track the current shared daemon workflow stage in ${DAEMON_WORKFLOW_STAGE_FIELD_NAME} when it is clear from the daemon's latest message or target draft snapshot. Use exact stage ids from the primary daemon stage field when visible.`,
      ].join(" ")
    );
    return {
      id: daemonCanvasStorageId("state", name),
      name,
      freeText:
        "One self-contained stage of the environment agent's state update flow. It keeps automated user behavior aligned with the shared workflow canvas.",
      graph: {
        nodes: [
          stageStart,
          appendEnvironmentTurn,
          summaryMemoryGate,
          summarizeMemory,
          clearMemory,
          stagePrompt,
        ],
        edges: [
          createCanvasEdge(stageStart.id, appendEnvironmentTurn.id),
          createCanvasEdge(appendEnvironmentTurn.id, summaryMemoryGate.id),
          createCanvasEdge(summaryMemoryGate.id, summarizeMemory.id, "true"),
          createCanvasEdge(summaryMemoryGate.id, stagePrompt.id, "false"),
          createCanvasEdge(summarizeMemory.id, clearMemory.id),
          createCanvasEdge(clearMemory.id, stagePrompt.id),
        ],
      },
    };
  };

  const understandState = makeStateStage(
    DAEMON_ENVIRONMENT_UNDERSTAND_STATE_CANVAS_NAME,
    "Track the target_agent_description, missing process facts, and whether the daemon is still asking clarification questions about participating roles, environment, observations, reward/success signal, or actions."
  );
  const approveState = makeStateStage(
    DAEMON_ENVIRONMENT_APPROVE_WORKFLOW_STATE_CANVAS_NAME,
    "Track whether an Overall Workflow canvas or child stage workflow canvas exists, whether it appears approved, whether any stage is still too broad, and what concrete workflow-stage comments should be sent next."
  );
  const boundaryState = makeStateStage(
    DAEMON_ENVIRONMENT_BOUNDARY_STATE_CANVAS_NAME,
    "Track whether every participating workflow agent has a boundary mode: build, import_template, or user_played. Keep notes about missing template choices or unresolved ownership questions."
  );
  const buildState = makeStateStage(
    DAEMON_ENVIRONMENT_BUILD_STATE_CANVAS_NAME,
    "Track whether a structured implementation draft exists and whether known blockers remain before the daemon can seed state, policy, reward, datasets, tools, skills, and agent connections."
  );
  const reviewState = makeStateStage(
    DAEMON_ENVIRONMENT_REVIEW_STATE_CANVAS_NAME,
    DAEMON_ENVIRONMENT_AGENT_STATE_UPDATE_PROMPT
  );

  return {
    version: 2,
    activeId: understandState.id,
    canvases: [
      understandState,
      approveState,
      boundaryState,
      buildState,
      reviewState,
    ],
  };
}

function createDefaultDaemonEnvironmentAgent(): OrchestrationProject["environmentPlayers"][number] {
  const environmentAgent = createEmptyOrchestrationEnvironmentPlayer();
  environmentAgent.fields = ensureRequiredEnvironmentAgentStateFields([
    {
      id: makeOrchestrationId(),
      name: DAEMON_WORKFLOW_STAGE_FIELD_NAME,
      type: "string",
      initialValue: DAEMON_WORKFLOW_STAGE_UNDERSTAND,
    },
    {
      id: makeOrchestrationId(),
      name: "target_agent_description",
      type: "string",
      initialValue: "",
    },
    {
      id: makeOrchestrationId(),
      name: "current_target_design_assessment",
      type: "string",
      initialValue: "",
    },
    {
      id: makeOrchestrationId(),
      name: "missing_design_elements",
      type: "string[]",
      initialValue: "[]",
    },
    {
      id: makeOrchestrationId(),
      name: "simulation_request_status",
      type: "string",
      initialValue: "not_requested",
    },
  ]);
  environmentAgent.stateUpdatePrompt = DAEMON_ENVIRONMENT_AGENT_STATE_UPDATE_PROMPT;
  environmentAgent.policyPrompt = DAEMON_ENVIRONMENT_AGENT_POLICY_PROMPT;
  environmentAgent.policyCanvases = createDaemonEnvironmentAgentPolicyCanvas();
  environmentAgent.statePolicyCanvases = createDaemonEnvironmentAgentStateCanvas();
  return environmentAgent;
}

function createDaemonRuntimeProjectBase(): OrchestrationProject {
  const project = createEmptyOrchestrationProject();
  project.meta = {
    title: "General Orchestration Daemon",
    slug: "general-orchestration-daemon",
    summary:
      "Workflow-first daemon that shapes editable workflow canvases, agent boundaries, setup pages, state canvases, policy canvases, datasets, and tool scaffolding for other demos through conversation while keeping the live draft editable.",
    policyIntent:
      "Clarify the overall process first, create and approve the workflow hierarchy, ask which participating agents should be built, imported, or user-played, then seed the first structured implementation from those boundaries. Continue with one focused triage question at a time, preserve existing structure unless the user asks to rebuild it, and scaffold only the missing tooling capabilities the demo still needs.",
    status: "Ready to run the daemon policy canvas.",
  };
  project.fields = ensureRequiredPrimaryAgentStateFields([
    {
      id: makeOrchestrationId(),
      name: DAEMON_WORKFLOW_STAGE_FIELD_NAME,
      type: "string",
      initialValue: DAEMON_WORKFLOW_STAGE_UNDERSTAND,
    },
    {
      id: makeOrchestrationId(),
      name: "process_agent_description",
      type: "string",
      initialValue: "",
    },
    {
      id: makeOrchestrationId(),
      name: "process_environment_description",
      type: "string",
      initialValue: "",
    },
    {
      id: makeOrchestrationId(),
      name: "process_observation_description",
      type: "string",
      initialValue: "",
    },
    {
      id: makeOrchestrationId(),
      name: "process_reward_description",
      type: "string",
      initialValue: "",
    },
    {
      id: makeOrchestrationId(),
      name: "process_action_description",
      type: "string",
      initialValue: "",
    },
    {
      id: makeOrchestrationId(),
      name: "process_state_update_description",
      type: "string",
      initialValue: "",
    },
    {
      id: makeOrchestrationId(),
      name: "process_policy_description",
      type: "string",
      initialValue: "",
    },
    {
      id: makeOrchestrationId(),
      name: "process_description",
      type: "string",
      initialValue: "",
    },
    {
      id: makeOrchestrationId(),
      name: "process_model",
      type: "json",
      initialValue:
        '{"environment":{"label":"Environment","description":""},"agent":{"label":"Participating Agents","description":""},"observation":{"label":"Observation","description":""},"reward":{"label":"Reward","description":""},"state_update":{"label":"State Update","description":""},"policy":{"label":"Policy","description":""},"action":{"label":"Action","description":""},"summary":""}',
    },
    {
      id: makeOrchestrationId(),
      name: "session_rules",
      type: "json",
      initialValue: "[]",
    },
    {
      id: makeOrchestrationId(),
      name: "user_requests",
      type: "string[]",
      initialValue: "[]",
    },
    {
      id: makeOrchestrationId(),
      name: "user_edit_requests",
      type: "string[]",
      initialValue: "[]",
    },
    {
      id: makeOrchestrationId(),
      name: "user_tooling_requests",
      type: "string[]",
      initialValue: "[]",
    },
    {
      id: makeOrchestrationId(),
      name: "user_skill_requests",
      type: "string[]",
      initialValue: "[]",
    },
    {
      id: makeOrchestrationId(),
      name: "user_environment_agent_requests",
      type: "string[]",
      initialValue: "[]",
    },
    {
      id: makeOrchestrationId(),
      name: "process_open_questions",
      type: "string[]",
      initialValue: "[]",
    },
    {
      id: makeOrchestrationId(),
      name: "process_ready",
      type: "boolean",
      initialValue: "false",
    },
    {
      id: makeOrchestrationId(),
      name: "workflow_approved",
      type: "boolean",
      initialValue: "false",
    },
    {
      id: makeOrchestrationId(),
      name: "workflow_decomposition_complete",
      type: "boolean",
      initialValue: "false",
    },
    {
      id: makeOrchestrationId(),
      name: "agent_boundary_plan",
      type: "json",
      initialValue: "{}",
    },
    {
      id: makeOrchestrationId(),
      name: "agent_boundaries_confirmed",
      type: "boolean",
      initialValue: "false",
    },
    {
      id: makeOrchestrationId(),
      name: "general_description",
      type: "string",
      initialValue: "",
    },
    {
      id: makeOrchestrationId(),
      name: "structured_draft_exists",
      type: "boolean",
      initialValue: "false",
    },
    {
      id: makeOrchestrationId(),
      name: DAEMON_STAGE_FINISHED_MESSAGE_FIELD_NAME,
      type: "string",
      initialValue: "",
    },
    {
      id: makeOrchestrationId(),
      name: "current_build",
      type: "json",
      initialValue:
        '{"meta":{"title":null,"slug":null,"summary":null,"policy_intent":null,"status":null},"state_schema":{"field_count":0,"fields":[]},"workflow":{"active_canvas_id":null,"canvas_count":0,"canvases":[]},"policy":{"active_canvas_id":null,"canvas_count":0,"canvases":[]},"state_tracking":{"active_canvas_id":null,"canvas_count":0,"canvases":[]},"guidelines":[],"datasets":[],"bootstrap_datasets":[],"tools":[],"structural_gaps":[]}',
    },
    {
      id: makeOrchestrationId(),
      name: "requested_tooling_capabilities",
      type: "string[]",
      initialValue: "[]",
    },
    {
      id: makeOrchestrationId(),
      name: "missing_tooling_capabilities",
      type: "string[]",
      initialValue: "[]",
    },
    {
      id: makeOrchestrationId(),
      name: "drafted_artifacts",
      type: "string[]",
      initialValue: "[]",
    },
  ]);
  project.datasets = [createCanvasRuleRegistryDataset(makeOrchestrationId)];
  project.environmentPlayers = [createDefaultDaemonEnvironmentAgent()];
  project.guidelines = [];
  return project;
}

export function hydrateDaemonRuntimeProject(args: {
  config: GeneralOrchestrationDaemonConfigRow | null;
  workflowCanvases?: GeneralOrchestrationDaemonCanvasRow[];
  policyCanvases?: GeneralOrchestrationDaemonCanvasRow[];
  statePolicyCanvases?: GeneralOrchestrationDaemonCanvasRow[];
}, options: {
  syncPrompts?: boolean;
} = {}): OrchestrationProject {
  const defaults = args.config
    ? createDaemonRuntimeProjectBase()
    : createDefaultDaemonRuntimeProject();
  const hydrated = hydrateStoredOrchestrationProject({
    configId: args.config?.id,
    title: args.config?.config_name,
    summary: args.config?.typical_user_patterns,
    policyIntent: args.config?.edge_cases_to_cover,
    stateSchema: args.config?.state_schema,
    stateUpdatePrompt: args.config?.state_update_prompt,
    policyPrompt: args.config?.policy_prompt,
    datasets: args.config?.datasets,
    environmentPlayers: args.config?.environment_players,
    uploadedFiles: args.config?.uploaded_files,
    workflowCanvases:
      args.workflowCanvases as StoredOrchestrationCanvasRow[] | undefined,
    policyCanvases: args.policyCanvases as StoredOrchestrationCanvasRow[] | undefined,
    statePolicyCanvases:
      args.statePolicyCanvases as StoredOrchestrationCanvasRow[] | undefined,
    defaults,
    loadedStatus: "Loaded from the saved daemon runtime project.",
    syncPrompts: options.syncPrompts,
    autoTagActionSubtypes: false,
  });

  const nextProject = {
    ...hydrated,
    workflowCanvases: syncDaemonWorkflowCanvas(hydrated.workflowCanvases),
    policyCanvases: syncDaemonPolicyCanvas(hydrated.policyCanvases),
    statePolicyCanvases: syncDaemonStateCanvas(hydrated.statePolicyCanvases),
    guidelines: [],
    datasets: args.config
      ? Array.isArray(hydrated.datasets)
        ? hydrated.datasets
        : []
      : defaults.datasets,
    fields: normalizeDaemonRuntimeFields(hydrated.fields, defaults.fields),
    environmentPlayers: normalizeDaemonEnvironmentPlayers(
      hydrated.environmentPlayers
    ),
  };

  return options.syncPrompts === false
    ? nextProject
    : syncDerivedPrompts(nextProject);
}

export function serializeDaemonRuntimeProject(project: OrchestrationProject) {
  const serialized = serializeOrchestrationProject(project, {
    titleFallback: "General Orchestration Daemon",
  });

  const runtimePolicyCanvasRows = serializeCanvasRows(
    serialized.project.policyCanvases
  );

  return {
    project: serialized.project,
    config: {
      config_name: serialized.configName,
      uploaded_files: serialized.uploadedFiles,
      state_schema: serialized.stateSchema,
      state_update_prompt: serialized.stateUpdatePrompt,
      policy_prompt: serialized.policyPrompt,
      guideline_blocks: [],
      datasets: serialized.datasets,
      environment_players: serialized.environmentPlayers,
      typical_user_patterns: serialized.summary,
      edge_cases_to_cover: serialized.policyIntent,
      endpoint: GENERAL_ORCHESTRATION_DAEMON_ENDPOINT,
    },
    workflowCanvases: serialized.workflowCanvases,
    policyCanvases: runtimePolicyCanvasRows,
    statePolicyCanvases: serialized.statePolicyCanvases,
  };
}
