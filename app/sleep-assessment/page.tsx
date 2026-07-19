"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import SiteNavbar from "../components/SiteNavbar";

type Role = "assistant" | "user";
type Stage =
  | "concern"
  | "bedtime"
  | "waketime"
  | "latency"
  | "awakenings"
  | "sleepHours"
  | "caffeine"
  | "screens"
  | "stress"
  | "redFlags"
  | "goal"
  | "plan";

interface Message {
  role: Role;
  text: string;
}

interface AnswerState {
  concern?: string;
  bedtime?: string;
  waketime?: string;
  latency?: string;
  awakenings?: string;
  sleepHours?: string;
  caffeine?: string;
  screens?: string;
  stress?: string;
  redFlags?: string;
  goal?: string;
}

const questions: Record<Stage, { prompt: string; chips?: string[]; placeholder?: string }> = {
  concern: {
    prompt: "What is the main sleep challenge you want help with right now?",
    chips: ["Trouble falling asleep", "Waking at night", "Waking too early", "Poor sleep quality", "Irregular schedule", "Daytime tiredness"],
  },
  bedtime: {
    prompt: "What time do you usually get into bed?",
    chips: ["10:30 PM", "11:00 PM", "12:00 AM", "1:00 AM", "It varies"],
    placeholder: "e.g. 11:45 PM",
  },
  waketime: {
    prompt: "What time do you usually wake up or need to be out of bed?",
    chips: ["6:30 AM", "7:00 AM", "7:30 AM", "8:00 AM", "It varies"],
    placeholder: "e.g. 7:15 AM",
  },
  latency: {
    prompt: "About how long does it usually take you to fall asleep?",
    chips: ["Less than 15 min", "15–30 min", "30–60 min", "More than 1 hour"],
  },
  awakenings: {
    prompt: "How many times do you typically wake during the night?",
    chips: ["0", "1", "2–3", "4+", "Not sure"],
  },
  sleepHours: {
    prompt: "How many hours of actual sleep do you think you get on a typical night?",
    chips: ["<5 hours", "5–6 hours", "6–7 hours", "7–8 hours", "8+ hours"],
  },
  caffeine: {
    prompt: "When do you usually have caffeine, if at all?",
    chips: ["No caffeine", "Morning only", "Afternoon", "Evening", "Varies"],
  },
  screens: {
    prompt: "Do you usually use a phone, laptop, or TV in bed or right before sleep?",
    chips: ["No", "Sometimes", "Most nights", "Yes, in bed"],
  },
  stress: {
    prompt: "How mentally active or stressed do you feel when trying to sleep?",
    chips: ["Calm", "Mild", "Moderate", "Very stressed", "Racing thoughts"],
  },
  redFlags: {
    prompt:
      "Quick safety check: do any of these apply — loud snoring with gasping/choking, breathing pauses, sudden sleep attacks, extreme daytime sleepiness, or thoughts of self-harm?",
    chips: ["None of these", "Snoring/gasping", "Extreme sleepiness", "Sudden sleep attacks", "Self-harm thoughts", "Prefer not to say"],
  },
  goal: {
    prompt: "What would success look like for you over the next 2–4 weeks?",
    chips: ["Fall asleep faster", "Wake less often", "More energy", "Earlier schedule", "Less sleep anxiety"],
    placeholder: "Describe your sleep goal…",
  },
  plan: { prompt: "" },
};

const order: Stage[] = [
  "concern",
  "bedtime",
  "waketime",
  "latency",
  "awakenings",
  "sleepHours",
  "caffeine",
  "screens",
  "stress",
  "redFlags",
  "goal",
];

const fieldLabels: Record<keyof AnswerState, string> = {
  concern: "Main challenge",
  bedtime: "Usual bedtime",
  waketime: "Usual wake time",
  latency: "Time to fall asleep",
  awakenings: "Night wakings",
  sleepHours: "Estimated sleep",
  caffeine: "Caffeine pattern",
  screens: "Screens near bedtime",
  stress: "Bedtime stress",
  redFlags: "Safety screen",
  goal: "Goal",
};

function isRedFlag(value?: string) {
  return Boolean(value && !["None of these", "Prefer not to say"].includes(value));
}

function makePlan(answers: AnswerState) {
  const steps = [
    `Keep your wake time anchored around ${answers.waketime || "the same time"} every day for the next week, including weekends.`,
    answers.caffeine === "Afternoon" || answers.caffeine === "Evening" || answers.caffeine === "Varies"
      ? "Set a caffeine cutoff 8 hours before bed. For most people, that means no caffeine after early afternoon."
      : "Keep caffeine limited to your current low-risk window and avoid adding any after lunch while you stabilize sleep.",
    answers.screens === "Most nights" || answers.screens === "Yes, in bed"
      ? "Create a 30-minute screen-free wind-down. Charge your phone away from the bed and use dim light, reading, or audio instead."
      : "Protect the last 30 minutes before bed as a low-stimulation wind-down window.",
    answers.latency === "30–60 min" || answers.latency === "More than 1 hour"
      ? "If you are awake for roughly 20–30 minutes, leave the bed and do something quiet in dim light until sleepy. This helps rebuild the bed-sleep association."
      : "Use the bed mainly for sleep so your brain continues to associate it with rest rather than effort.",
    answers.stress === "Very stressed" || answers.stress === "Racing thoughts"
      ? "Add a 10-minute worry download before wind-down: write tomorrow's tasks and unresolved thoughts outside the bedroom."
      : "Use a short relaxation cue nightly: slow breathing, body scan, or a repeated calming phrase.",
  ];

  return steps;
}

function AssistantBubble({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black text-lg text-[#E1DECF]">☾</div>
      <div className="max-w-[82%] rounded-3xl rounded-tl-md bg-white px-5 py-4 text-[15px] leading-relaxed text-black shadow-sm">
        {children}
      </div>
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[82%] rounded-3xl rounded-tr-md bg-black px-5 py-4 text-[15px] leading-relaxed text-[#E1DECF]">
        {text}
      </div>
    </div>
  );
}

export default function SleepAssessmentPage() {
  const [stage, setStage] = useState<Stage>("concern");
  const [answers, setAnswers] = useState<AnswerState>({});
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      text:
        "Hi, I’m your digital sleep coach. I’ll ask a few structured questions, check for safety signals, and then build a practical 7-day sleep plan. I’m educational support only — not a doctor or emergency service.",
    },
    { role: "assistant", text: questions.concern.prompt },
  ]);
  const [typed, setTyped] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const progress = useMemo(() => {
    const idx = Math.max(0, order.indexOf(stage));
    return stage === "plan" ? 100 : Math.round((idx / order.length) * 100);
  }, [stage]);

  const submitAnswer = (value: string) => {
    const clean = value.trim();
    if (!clean || stage === "plan") return;

    const nextAnswers = { ...answers, [stage]: clean };
    const stageIndex = order.indexOf(stage);
    const nextStage = order[stageIndex + 1] ?? "plan";
    const nextMessages: Message[] = [...messages, { role: "user", text: clean }];

    if (nextStage === "plan") {
      nextMessages.push({
        role: "assistant",
        text:
          "Thanks — I have enough to create a first-pass sleep profile and plan. You can use this as a starting point and adjust it with a clinician if medical symptoms are present.",
      });
    } else {
      nextMessages.push({ role: "assistant", text: questions[nextStage].prompt });
    }

    setAnswers(nextAnswers);
    setMessages(nextMessages);
    setStage(nextStage);
    setTyped("");
  };

  const reset = () => {
    setStage("concern");
    setAnswers({});
    setTyped("");
    setMessages([
      {
        role: "assistant",
        text:
          "Hi, I’m your digital sleep coach. I’ll ask a few structured questions, check for safety signals, and then build a practical 7-day sleep plan. I’m educational support only — not a doctor or emergency service.",
      },
      { role: "assistant", text: questions.concern.prompt },
    ]);
  };

  const plan = makePlan(answers);
  const redFlag = isRedFlag(answers.redFlags);

  return (
    <div className="h-dvh overflow-y-auto overflow-x-hidden overscroll-none bg-[#E1DECF]">
      <SiteNavbar />
      <main className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 pb-10 pt-4 sm:px-6 lg:grid lg:grid-cols-[0.9fr_1.1fr] lg:px-8 lg:pb-14">
        <section className="flex flex-col justify-center py-6 lg:py-12">
          <p className="mb-4 text-xs font-bold uppercase tracking-[0.28em] text-[#F05025]">Digital sleep coach</p>
          <h1 className="max-w-3xl text-4xl font-bold leading-[0.95] text-black sm:text-6xl lg:text-7xl">
            Build a calmer sleep routine in five minutes.
          </h1>
          <p className="mt-6 max-w-2xl font-serif text-xl leading-relaxed text-black/75 sm:text-2xl">
            A guided chatbot flow for sleep intake, safety screening, and a personalized 7-day behavioral plan.
          </p>
          <div className="mt-8 grid max-w-2xl gap-3 sm:grid-cols-3">
            {[
              ["1", "Sleep pattern", "Bedtime, wake time, night wakings"],
              ["2", "Habits", "Caffeine, screens, stress"],
              ["3", "Plan", "Concrete next-night actions"],
            ].map(([n, title, copy]) => (
              <div key={n} className="border-t-4 border-black pt-4">
                <p className="text-xs font-bold uppercase tracking-widest text-black/55">Step {n}</p>
                <h2 className="mt-2 text-lg font-bold text-black">{title}</h2>
                <p className="mt-2 text-sm leading-relaxed text-black/65">{copy}</p>
              </div>
            ))}
          </div>
          <p className="mt-8 max-w-2xl text-sm leading-relaxed text-black/55">
            This tool does not diagnose sleep disorders, prescribe medication, or replace a licensed clinician. If symptoms suggest sleep apnea, narcolepsy, severe mood symptoms, or self-harm risk, it recommends professional support.
          </p>
          <Link
            href="/sleep-assessment/hermes"
            className="mt-5 inline-flex w-fit rounded-full bg-[#F05025] px-6 py-3 text-sm font-bold text-white transition hover:bg-black"
          >
            Try the AI-powered sleep therapist
          </Link>
        </section>

        <section className="min-h-[680px] overflow-hidden rounded-[2rem] border border-black/15 bg-[#f8f4e8] shadow-[0_28px_100px_rgba(0,0,0,0.18)]">
          <div className="flex items-center justify-between gap-4 border-b border-black/10 bg-black px-5 py-4 text-[#E1DECF] sm:px-6">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#E1DECF] text-xl text-black">☾</div>
              <div>
                <p className="font-bold leading-tight">Sleep Assistant</p>
                <p className="text-xs text-[#E1DECF]/65">Guided intake • CBT-I-informed habits</p>
              </div>
            </div>
            <div className="min-w-[92px] text-right">
              <p className="text-xs text-[#E1DECF]/65">Progress</p>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/15">
                <div className="h-full rounded-full bg-[#F05025] transition-all" style={{ width: `${progress}%` }} />
              </div>
            </div>
          </div>

          <div className="flex h-[calc(100%-73px)] min-h-[606px] flex-col">
            <div className="flex-1 space-y-4 overflow-y-auto px-4 py-5 sm:px-6">
              {messages.map((m, idx) =>
                m.role === "assistant" ? (
                  <AssistantBubble key={idx}>{m.text}</AssistantBubble>
                ) : (
                  <UserBubble key={idx} text={m.text} />
                )
              )}

              {stage === "plan" && (
                <div className="space-y-4">
                  <AssistantBubble>
                    <div className="space-y-4">
                      <div>
                        <p className="font-bold">Your sleep profile</p>
                        <div className="mt-3 grid gap-2 text-sm">
                          {(Object.keys(fieldLabels) as Array<keyof AnswerState>).map((key) => (
                            <div key={key} className="flex justify-between gap-4 border-b border-black/10 pb-2">
                              <span className="text-black/55">{fieldLabels[key]}</span>
                              <span className="text-right font-medium">{answers[key] || "—"}</span>
                            </div>
                          ))}
                        </div>
                      </div>

                      {redFlag && (
                        <div className="rounded-2xl border border-[#F05025]/40 bg-[#F05025]/10 px-4 py-3 text-sm leading-relaxed">
                          <strong>Professional support recommended:</strong> your safety screen includes a symptom that may need a doctor, sleep specialist, or mental health professional. If there is immediate self-harm risk, contact emergency services or a crisis line now.
                        </div>
                      )}

                      <div>
                        <p className="font-bold">7-day starter plan</p>
                        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-relaxed">
                          {plan.map((step) => (
                            <li key={step}>{step}</li>
                          ))}
                        </ol>
                      </div>

                      <div className="rounded-2xl bg-black px-4 py-3 text-sm leading-relaxed text-[#E1DECF]">
                        Tonight: choose one fixed wake time, begin wind-down 30 minutes before bed, and track bedtime, wake time, awakenings, and rested rating tomorrow morning.
                      </div>
                    </div>
                  </AssistantBubble>
                </div>
              )}
            </div>

            <div className="border-t border-black/10 bg-[#f2eddf] px-4 py-4 sm:px-6">
              {stage !== "plan" ? (
                <>
                  <div className="mb-3 flex flex-wrap gap-2">
                    {questions[stage].chips?.map((chip) => (
                      <button
                        key={chip}
                        type="button"
                        onClick={() => submitAnswer(chip)}
                        className="rounded-full border border-black/15 bg-white px-3 py-2 text-sm text-black transition hover:border-black hover:bg-black hover:text-[#E1DECF]"
                      >
                        {chip}
                      </button>
                    ))}
                  </div>
                  <form
                    className="flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      submitAnswer(typed);
                    }}
                  >
                    <input
                      ref={inputRef}
                      value={typed}
                      onChange={(e) => setTyped(e.target.value)}
                      placeholder={questions[stage].placeholder ?? "Type your answer…"}
                      className="min-w-0 flex-1 rounded-full border border-black/15 bg-white px-4 py-3 text-sm text-black outline-none focus:border-black"
                    />
                    <button
                      type="submit"
                      disabled={!typed.trim()}
                      className="rounded-full bg-black px-5 py-3 text-sm font-bold text-[#E1DECF] transition hover:bg-[#F05025] disabled:cursor-not-allowed disabled:opacity-35"
                    >
                      Send
                    </button>
                  </form>
                </>
              ) : (
                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={reset}
                    className="rounded-full border border-black px-5 py-3 text-sm font-bold text-black transition hover:bg-black hover:text-[#E1DECF]"
                  >
                    Start over
                  </button>
                  <Link
                    href="/demo/sleep/studio"
                    className="rounded-full bg-[#F05025] px-5 py-3 text-sm font-bold text-white transition hover:bg-black"
                  >
                    Continue to full sleep assistant
                  </Link>
                </div>
              )}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
