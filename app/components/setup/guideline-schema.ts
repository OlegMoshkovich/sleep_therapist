export interface SerializedGuidelineBlock {
  topic: string;
  content: string;
  problem: string;
  recommendation: string;
}

function toGuidelineText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isBlankGuidelineBlock(block: SerializedGuidelineBlock): boolean {
  return [block.topic, block.content, block.problem, block.recommendation].every(
    (value) => value.trim().length === 0
  );
}

export function normalizeGuidelineBlocks(raw: unknown): SerializedGuidelineBlock[] {
  let items: unknown[] = [];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      items = Array.isArray(parsed) ? parsed : [];
    } catch {
      items = [];
    }
  }

  return items
    .map((item) => {
      const block = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const topic = block.topic ?? block.Topic;
      const content = block.content ?? block.Content;
      const problem =
        block.problem ?? block.Problem ?? block.problem_description ?? block.problemDescription;
      const recommendation = block.recommendation ?? block.Recommendation;
      return {
        topic: toGuidelineText(topic),
        content: toGuidelineText(content),
        problem: toGuidelineText(problem),
        recommendation: toGuidelineText(recommendation),
      };
    })
    .filter((block) => !isBlankGuidelineBlock(block));
}

export function serializeGuidelineBlocks(
  blocks: Array<{
    topic: string;
    content: string;
    problem: string;
    recommendation: string;
  }>
): SerializedGuidelineBlock[] {
  return blocks
    .map((block) => ({
      topic: block.topic.trim(),
      content: block.content,
      problem: block.problem,
      recommendation: block.recommendation,
    }))
    .filter((block) => !isBlankGuidelineBlock(block));
}
