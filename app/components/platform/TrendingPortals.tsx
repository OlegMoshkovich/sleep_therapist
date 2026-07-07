"use client";

import { useRef } from "react";

interface Portal {
  id: string;
  title: string;
  author: string;
  role: string;
  bg: string;
  image: string;
  href?: string;
}

const PORTALS: Portal[] = [
  {
    id: "nutrition",
    title: "Nutrition",
    author: "Irina Brown MD",
    role: "Nutrition Specialist",
    bg: "#4A1A0A",
    image: "/platform_images/portals/wellbeing 2 1.png",
    href: "/demo/nutrition",
  },
  {
    id: "creative-writing",
    title: "Creative Writing",
    author: "Alex Holmes",
    role: "BBC Writer, Producer",
    bg: "#6B7A1A",
    image: "/platform_images/portals/writing 3 1.png",
  },
  {
    id: "relationships",
    title: "Relationships",
    author: "Esther Perel",
    role: "Psychotherapist",
    bg: "#6B4A9A",
    image: "/platform_images/portals/relationshjip 2 1.png",
  },
  {
    id: "travel",
    title: "Exotic Travel Guide",
    author: "Ieva Rute",
    role: "Travel Guide",
    bg: "#1A3A8C",
    image: "/platform_images/portals/traveling 1.png",
  },
];

export default function TrendingPortals() {
  const scrollRef = useRef<HTMLDivElement>(null);

  function scrollRight() {
    scrollRef.current?.scrollBy({ left: 320, behavior: "smooth" });
  }

  return (
    <section className="mb-10">
      <h2 className="text-2xl md:text-2xl font-bold font-test-american-grotesk text-black mb-5 leading-tight">
        Trending Portals
      </h2>

      <div className="relative">
        {/* Cards row */}
        <div
          ref={scrollRef}
          className="flex gap-4 overflow-x-auto scrollbar-hide pb-2"
          style={{ scrollbarWidth: "none" }}
        >
          {PORTALS.map((portal) => (
            <div
              key={portal.id}
              className="flex-shrink-0 w-[200px] md:w-[280px] h-[240px] md:h-[260px] rounded-2xl overflow-hidden relative cursor-pointer"
              style={{ backgroundColor: portal.bg }}
            >
              {/* Centered text */}
              <div className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center gap-3">
                <p className="text-white font-bold text-lg font-sans leading-snug">
                  {portal.title}
                </p>
                <div>
                  <p className="text-white/80 text-xs font-sans">
                    by {portal.author}
                  </p>
                  <p className="text-white/70 text-xs font-serif italic">
                    {portal.role}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Right arrow — desktop only */}
        <button
          onClick={scrollRight}
          className="hidden md:flex absolute right-0 top-[120px] -translate-y-1/2 translate-x-4 w-9 h-9 bg-[#F0EFE9] rounded-full shadow-md items-center justify-center hover:bg-gray-50 transition-colors z-10"
          aria-label="Scroll right"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6,3 11,8 6,13" />
          </svg>
        </button>
      </div>
    </section>
  );
}
