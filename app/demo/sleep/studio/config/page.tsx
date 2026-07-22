"use client";

import "../ra-theme.css";
import * as sleepData from "../sleep-data";
import {
  createSetupStudio,
  turnExtractedStateKeys,
  type StudioSetupConfig,
} from "../../../studio-components/config/SetupStudio";

const config: StudioSetupConfig = {
  setupEndpoint: "/api/admin/setup/sleep",
  productName: "Therapist",
  studioPath: "/demo/sleep/studio",
  assistantNoun: "therapist",
  coachNoun: "sleeper",
  subjectNoun: "patient",
};

const { SetupBar, useSleepSetup, Page } = createSetupStudio(config, sleepData);

export { turnExtractedStateKeys, useSleepSetup, SetupBar };
export default Page;
