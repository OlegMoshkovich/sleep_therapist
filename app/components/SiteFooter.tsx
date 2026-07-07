"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import SiteLogo from "./SiteLogo";

export default function SiteFooter() {
  // The "air" password is a restricted login that hides the Technical link.
  const [showTechnical, setShowTechnical] = useState(true);

  useEffect(() => {
    setShowTechnical(sessionStorage.getItem("siteAuthType") !== "air");
  }, []);

  return (
    <footer className="w-full bg-[#F05025] text-black px-6 sm:px-6 lg:px-8 pt-30 pb-10 sm:py-24 md:min-h-screen">
      <div className="max-w-7xl mx-auto min-h-[400px] md:min-h-[calc(100vh-theme(spacing.30)*2)] flex flex-col">
        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-16 sm:gap-20 flex-1">
          {/* Left: Logo + About */}
          <div className="space-y-8 sm:space-y-10">
            <SiteLogo size={80} />

            <p className="max-w-xl text-sm sm:text-base leading-relaxed font-serif mt-10">
              We are an independent research lab working on the fundamental reliability of AI: quantifying uncertainty, increasing diversity, and building the theoretical foundations for models that can be genuinely trusted.
            </p>
          </div>

          {/* Right: Links + Address */}
          <div className="text-left md:text-right font-serif flex flex-col justify-between mt-0 sm:mt-10 md:mt-30">
            <div className="space-y-2 text-sm sm:text-base">
              <Link href="/pitch" className="block hover:underline">Pitch</Link>
              {showTechnical && (
                <Link href="/technical" className="block hover:underline">Details</Link>
              )}
              <Link href="/demo" className="block hover:underline">Models</Link>
              <Link href="/expertise" className="block hover:underline">Analysis</Link>
              <Link href="/team" className="block hover:underline">Team</Link>
            </div>

            <div className="text-sm sm:text-base mt-24 sm:mt-12">
              237A Caledonian Road
              <br />
              London N1 1ED
            </div>
          </div>
        </div>

        <div className="mt-auto pt-10 pb-8 sm:pt-12 text-xs sm:text-sm text-left md:text-right font-serif">
          © The AI Research Lab, 2026
        </div>
      </div>
    </footer>
  );
}
