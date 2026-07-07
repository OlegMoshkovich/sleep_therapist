"use client";

import { useRef } from "react";
import Image from "next/image";

interface Expert {
  id: string;
  name: string;
  title: string;
  image: string;
}

const EXPERTS: Expert[] = [
  {
    id: "esther-perel",
    name: "Esther Perel",
    title: "Psychoterapist",
    image: "/platform_images/experts/Esther.png",
  },
  {
    id: "jamie-oliver",
    name: "Jamie Oliver",
    title: "Chef",
    image: "/platform_images/experts/Jamie.png",
  },
  {
    id: "ieva-rute",
    name: "Ieva Rute",
    title: "Travel Guide",
    image: "/platform_images/experts/Ieva.png",
  },
  {
    id: "koya-webb",
    name: "Koya Webb",
    title: "Holistic Coach",
    image: "/platform_images/experts/Koya.png",
  },
];

export default function PopularExperts() {
  const scrollRef = useRef<HTMLDivElement>(null);

  function scrollRight() {
    scrollRef.current?.scrollBy({ left: 320, behavior: "smooth" });
  }

  return (
    <section className="mb-10">
      <h2 className="text-2xl font-bold font-test-american-grotesk text-black mb-6 leading-tight">
        Popular Experts
      </h2>

      <div className="relative">
        <div
          ref={scrollRef}
          className="flex gap-4 md:gap-10 overflow-x-auto pb-2"
          style={{ scrollbarWidth: "none" }}
        >
          {EXPERTS.map((expert) => (
            <div
              key={expert.id}
              className="flex-shrink-0 flex flex-col items-center gap-2 cursor-pointer group"
            >
              {/* Circular photo */}
              <div className="w-[90px] h-[90px] md:w-[140px] md:h-[140px] rounded-full bg-gray-200 overflow-hidden ring-2 ring-transparent group-hover:ring-gray-300 transition-all">
                <Image
                  src={expert.image}
                  alt={expert.name}
                  width={140}
                  height={140}
                  className="w-full h-full object-cover"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = "none";
                  }}
                />
              </div>

              {/* Name & title */}
              <div className="text-center">
                <p className="font-bold text-sm font-sans text-gray-900 leading-snug">
                  {expert.name}
                </p>
                <p className="text-sm font-sans text-gray-500 leading-snug">
                  {expert.title}
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* Right arrow — desktop only */}
        <button
          onClick={scrollRight}
          className="hidden md:flex absolute right-0 top-[70px] -translate-y-1/2 translate-x-4 w-9 h-9  bg-[#F0EFE9] rounded-full shadow-md items-center justify-center hover:bg-gray-50 transition-colors z-10"
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
