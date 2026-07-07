"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import SiteLogo from "./SiteLogo";

interface SiteNavbarProps {
  activePage?: "demos" | "team" | "pitch" | "technical" | "expertise" | "thesis" | "map";
}

export default function SiteNavbar({ activePage }: SiteNavbarProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  // The "air" password is a restricted login that hides the Details link.
  const [showDetails, setShowDetails] = useState(true);

  useEffect(() => {
    setShowDetails(sessionStorage.getItem("siteAuthType") !== "air");
  }, []);

  return (
    <nav className="w-full bg-[#E1DECF] px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex justify-between items-start py-6">
          {/* Logo */}
          <SiteLogo size={160} />

          {/* Desktop Navigation */}
          <div className="hidden md:flex flex-col items-end space-y-1 pt-1">
            {activePage === "pitch" ? (
              <span className="text-gray-800 font-semibold text-right underline">Pitch</span>
            ) : (
              <Link href="/pitch" className="text-gray-800 hover:text-gray-600 font-semibold text-right">Pitch</Link>
            )}
            {showDetails && (
              activePage === "technical" ? (
                <span className="text-gray-800 font-semibold text-right underline">Details</span>
              ) : (
                <Link href="/technical" className="text-gray-800 hover:text-gray-600 font-semibold text-right">Details</Link>
              )
            )}
            {activePage === "demos" ? (
              <span className="text-gray-800 font-semibold text-right underline">Models</span>
            ) : (
              <Link href="/demo" className="text-gray-800 hover:text-gray-600 font-semibold text-right">Models</Link>
            )}
            {activePage === "expertise" ? (
              <span className="text-gray-800 font-semibold text-right underline">Analysis</span>
            ) : (
              <Link href="/expertise" className="text-gray-800 hover:text-gray-600 font-semibold text-right">Analysis</Link>
            )}
            {activePage === "team" ? (
              <span className="text-gray-800 font-semibold text-right underline">Team</span>
            ) : (
              <Link href="/team" className="text-gray-800 hover:text-gray-600 font-semibold text-right">Team</Link>
            )}
          </div>

          {/* Mobile menu button */}
          <button
            className="md:hidden p-2 text-gray-800 text-2xl"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          >
            {mobileMenuOpen ? "✕" : "☰"}
          </button>
        </div>
      </div>

      {/* Mobile Navigation */}
      {mobileMenuOpen && (
        <div className="md:hidden bg-[#E1DECF]">
          <div className="px-4 py-3 space-y-3">
            {activePage === "pitch" ? (
              <span className="block text-gray-800 font-medium py-2 underline">Pitch</span>
            ) : (
              <Link href="/pitch" className="block text-gray-800 hover:text-gray-600 font-medium py-2" onClick={() => setMobileMenuOpen(false)}>Pitch</Link>
            )}
            {showDetails && (
              activePage === "technical" ? (
                <span className="block text-gray-800 font-medium py-2 underline">Details</span>
              ) : (
                <Link href="/technical" className="block text-gray-800 hover:text-gray-600 font-medium py-2" onClick={() => setMobileMenuOpen(false)}>Details</Link>
              )
            )}
            {activePage === "demos" ? (
              <span className="block text-gray-800 font-medium py-2 underline">Models</span>
            ) : (
              <Link href="/demo" className="block text-gray-800 hover:text-gray-600 font-medium py-2" onClick={() => setMobileMenuOpen(false)}>Models</Link>
            )}
            {activePage === "expertise" ? (
              <span className="block text-gray-800 font-medium py-2 underline">Analysis</span>
            ) : (
              <Link href="/expertise" className="block text-gray-800 hover:text-gray-600 font-medium py-2" onClick={() => setMobileMenuOpen(false)}>Analysis</Link>
            )}
            {activePage === "team" ? (
              <span className="block text-gray-800 font-medium py-2 underline">Team</span>
            ) : (
              <Link href="/team" className="block text-gray-800 hover:text-gray-600 font-medium py-2" onClick={() => setMobileMenuOpen(false)}>Team</Link>
            )}
          </div>
        </div>
      )}
    </nav>
  );
}
