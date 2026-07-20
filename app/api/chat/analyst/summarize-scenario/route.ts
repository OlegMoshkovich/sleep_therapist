import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

/**
 * Produces a short, descriptive title for an analyst-demo simulation run — a
 * concise summary of the user's market question (e.g. "NVDA Post-Earnings,
 * 1-Week Outlook") instead of the generic "Improvised user". Given the (optional)
 * scenario the user played and the conversation so far, it returns a <=8-word
 * title.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    scenario?: string;
    history?: Array<{ role: "user" | "ai"; text: string }>;
  };

  const scenario = (body.scenario ?? "").trim();
  const history = Array.isArray(body.history) ? body.history : [];
  const transcript = history
    .map((m) => `${m.role === "ai" ? "Assistant" : "Client"}: ${m.text}`)
    .join("\n");

  if (!scenario && !transcript) {
    return NextResponse.json({ title: "" });
  }

  const system =
    "You write a very short title summarizing a user's market question, " +
    "for a list of simulation runs. Capture the most distinctive details (the type of " +
    "matter, the parties, and any clear deadline). Max 8 words, Title Case, no trailing " +
    "period, no quotes, no 'Simulation' prefix. Reply with ONLY the title.";

  const user =
    (scenario ? `Scenario the user played: ${scenario}\n\n` : "") +
    (transcript ? `Conversation:\n${transcript}\n\n` : "") +
    "Write the title.";

  try {
    const openai = new OpenAI({ apiKey: process.env.AIRLAB_OPENAI_API_KEY });
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      max_tokens: 24,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    const title = (res.choices?.[0]?.message?.content ?? "")
      .trim()
      .replace(/^["'“”]+|["'“”]+$/g, "")
      .replace(/^simulation\s*[·:-]\s*/i, "")
      .replace(/[.\s]+$/g, "")
      .slice(0, 80);
    return NextResponse.json({ title });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to summarize the scenario." },
      { status: 500 }
    );
  }
}
