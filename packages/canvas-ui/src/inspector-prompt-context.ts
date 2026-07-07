import {
  serializeDatasets,
  type SimulationPlayerDataset,
} from "@airlab/canvas-core/components/setup/dataset-schema";

interface GuidelineBlockLike {
  topic: string;
  content: string;
  problem: string;
  recommendation: string;
}

const GUIDELINE_ITEMS_DATASET_NAME = "guideline_items";

export function buildInspectorDatasetsContext(
  datasets: SimulationPlayerDataset[],
  guidelineBlocks: GuidelineBlockLike[] = []
): string {
  const serialized = serializeDatasets(datasets);
  const syntheticGuidelineDataset = buildGuidelineItemsDataset(guidelineBlocks);
  const combined = syntheticGuidelineDataset
    ? [...serialized, syntheticGuidelineDataset]
    : serialized;
  return combined.length > 0 ? JSON.stringify(combined, null, 2) : "";
}

export function buildInspectorDatasetNames(
  datasets: SimulationPlayerDataset[],
  guidelineBlocks: GuidelineBlockLike[] = []
): string[] {
  const names = datasets.map((dataset) => dataset.name);
  return buildGuidelineItemsDataset(guidelineBlocks)
    ? [...names, GUIDELINE_ITEMS_DATASET_NAME]
    : names;
}

function buildGuidelineItemText(guideline: GuidelineBlockLike): string {
  const firstField = guideline.content.trim() || guideline.topic.trim();
  const problem = guideline.problem.trim();
  const recommendation = guideline.recommendation.trim();
  let text = firstField;

  if (problem) {
    text = text
      ? `${text}\n\n Problem description: ${problem}`
      : `Problem description: ${problem}`;
  }

  if (recommendation) {
    text = text
      ? `${text}\n\n Recommendation: ${recommendation}`
      : `Recommendation: ${recommendation}`;
  }

  return text.trim();
}

function buildGuidelineItemsDataset(blocks: GuidelineBlockLike[]) {
  const records = blocks
    .map((block) => buildGuidelineItemText(block))
    .filter((item) => item.length > 0)
    .map((item) => ({ text: item }));

  if (records.length === 0) {
    return null;
  }

  return {
    name: GUIDELINE_ITEMS_DATASET_NAME,
    notes:
      "Derived text items from saved guideline blocks. Each row concatenates the main content, problem description, and recommendation.",
    columns: [{ name: "text", type: "string" as const }],
    records,
  };
}
