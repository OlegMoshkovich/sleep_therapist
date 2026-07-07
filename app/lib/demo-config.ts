/**
 * Static config per demo — used by the /api/admin/setup/[demo] server routes
 * so all configured demos share one implementation.
 */

import type { DemoKey } from "./admin-auth";

export interface DemoSetupConfig {
  setupTable: string;
  filesBucket: string;
  endpoint: string;
}

export const DEMO_SETUP: Record<DemoKey, DemoSetupConfig> = {
  nutrition: {
    setupTable: "nutrition",
    filesBucket: "nutritian-input-files",
    endpoint: "/demo/nutrition/input",
  },
  sleep: {
    setupTable: "sleep_inputs",
    filesBucket: "sleep-input-files",
    endpoint: "/demo/sleep/input",
  },
  dnd: {
    setupTable: "dnd_inputs",
    filesBucket: "dnd-input-files",
    endpoint: "/demo/dnd/input",
  },
  "research-assistant": {
    setupTable: "research_assistant_inputs",
    filesBucket: "research-assistant-input-files",
    endpoint: "/demo/research-assistant/input",
  },
  "general-orchestration-daemon": {
    setupTable: "general_orchestration_daemon_inputs",
    filesBucket: "general-orchestration-daemon-input-files",
    endpoint: "/demo/general-orchestration-daemon/input",
  },
};

export function isDemoKey(value: string): value is DemoKey {
  return value in DEMO_SETUP;
}
