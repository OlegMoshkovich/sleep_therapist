"use client";

import { useState } from "react";

const CATEGORIES = [
  "Wellness",
  "Technology",
  "Finance",
  "Career & Business",
  "Style & Beauty",
  "Home",
  "Psychology",
  "Legal",
];

export default function CategoryExplorer() {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <section className="mb-10">
      <h2 className="text-3xl md:text-4xl font-bold font-test-american-grotesk text-gray-950 text-center mb-6 md:mb-8 leading-tight">
        Explore by Category
      </h2>

      {/* Mobile: vertical stack — Desktop: horizontal wrap */}
      <div className="flex flex-row flex-wrap justify-center gap-2 md:gap-3">
        {CATEGORIES.map((cat) => (
          <button
            key={cat}
            onClick={() => setSelected((prev) => (prev === cat ? null : cat))}
            className={`w-fit px-3 py-2 md:px-5 md:py-3 rounded-2xl text-xs md:text-base font-sans transition-colors ${
              selected === cat
                ? "bg-gray-900 text-white"
                : "bg-[#E4E1DA] text-gray-900 hover:bg-[#D8D5CE]"
            }`}
          >
            {cat}
          </button>
        ))}
      </div>
    </section>
  );
}
