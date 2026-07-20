import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

/**
 * Generates the next message from a SIMULATED USER (an investor/curious person)
 * for the Financial Analyst demo's Simulation tab. The real analyst reply is
 * produced separately by the /api/chat/analyst/base pipeline (which uses the
 * get_market_data tool), so a full simulated turn is:
 *   simulate-user → analyst(base) → simulate-user → …
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    scenario?: string;
    history?: Array<{ role: "user" | "ai"; text: string }>;
  };

  const scenario = (body.scenario ?? "").trim();
  const history = Array.isArray(body.history) ? body.history : [];

  const transcript = history
    .map((m) => `${m.role === "ai" ? "Analyst" : "User"}: ${m.text}`)
    .join("\n");

  const system =
    "You are role-playing a USER asking a financial-market analyst assistant about capital markets. Stay fully in character. " +
    (scenario
      ? `Your situation: ${scenario}`
      : "Invent a realistic, specific markets question (e.g. about a stock like NVDA or AAPL, an index like the S&P 500, bond yields, the dollar, oil, or bitcoin), with a consistent motivation and timeframe, and keep it consistent across turns.") +
    " Respond with ONE short, natural user message (1–3 sentences). If the analyst just asked a clarifying question, answer it plausibly. You are a curious retail/semi-pro investor, not a professional analyst. Never break character, never mention you are an AI, and reply with ONLY the user's message text (no name prefix, no quotes).";

  const user = transcript
    ? `Conversation so far:\n${transcript}\n\nWrite the user's next message.`
    : "Start the conversation: write the user's opening message with their market question.";

  try {
    const openai = new OpenAI({ apiKey: process.env.AIRLAB_OPENAI_API_KEY });
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.85,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    const message = res.choices?.[0]?.message?.content?.trim() ?? "";
    if (!message) {
      return NextResponse.json({ error: "The simulated user produced no message." }, { status: 502 });
    }
    return NextResponse.json({ message });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to generate the simulated user message." },
      { status: 500 }
    );
  }
}
