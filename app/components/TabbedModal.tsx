'use client';

import { useState } from 'react';

export interface TabData {
  id: string;
  label: string;
  content: string;
}

interface TabbedModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  tabs: TabData[];
  titleLink?: string;
}

export default function TabbedModal({ isOpen, onClose, title, tabs, titleLink }: TabbedModalProps) {
  const [activeTab, setActiveTab] = useState(tabs.length > 0 ? tabs[0].id : '');

  if (!isOpen) return null;

  // Simple markdown parser for links and bold text
  const parseMarkdown = (text: string) => {
    if (!text) return text;

    const parts: (string | React.JSX.Element)[] = [];
    let lastIndex = 0;
    let keyCounter = 0;

    // Match markdown links [text](url) and bold **text**
    const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
    const boldRegex = /\*\*([^*]+)\*\*/g;

    // First, find all matches
    const matches: Array<{ type: 'link' | 'bold'; start: number; end: number; text: string; url?: string }> = [];

    let match: RegExpExecArray | null;
    while ((match = linkRegex.exec(text)) !== null) {
      matches.push({
        type: 'link',
        start: match.index,
        end: match.index + match[0].length,
        text: match[1],
        url: match[2]
      });
    }

    while ((match = boldRegex.exec(text)) !== null) {
      // Check if this bold is inside a link (skip if so)
      const isInsideLink = matches.some(
        m => m.type === 'link' && match && match.index >= m.start && match.index < m.end
      );
      if (!isInsideLink && match) {
        matches.push({
          type: 'bold',
          start: match.index,
          end: match.index + match[0].length,
          text: match[1]
        });
      }
    }

    // Sort matches by position
    matches.sort((a, b) => a.start - b.start);

    // Build parts array
    matches.forEach((m) => {
      // Add text before match
      if (m.start > lastIndex) {
        const beforeText = text.substring(lastIndex, m.start);
        if (beforeText) {
          parts.push(beforeText);
        }
      }

      // Add match
      if (m.type === 'link' && m.url) {
        parts.push(
          <a
            key={`md-${keyCounter++}`}
            href={m.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:text-blue-800 underline"
          >
            {m.text}
          </a>
        );
      } else if (m.type === 'bold') {
        parts.push(<strong key={`md-${keyCounter++}`}>{m.text}</strong>);
      }

      lastIndex = m.end;
    });

    // Add remaining text
    if (lastIndex < text.length) {
      const remainingText = text.substring(lastIndex);
      if (remainingText) {
        parts.push(remainingText);
      }
    }

    return parts.length > 0 ? <>{parts}</> : text;
  };

  // Enhanced markdown parser for tab content (headers, bold, paragraphs)
  const parseTabContent = (text: string) => {
    if (!text) return null;

    const lines = text.split('\n');
    const elements: React.JSX.Element[] = [];
    let keyCounter = 0;
    let currentParagraph: string[] = [];

    const flushParagraph = () => {
      if (currentParagraph.length > 0) {
        const paragraphText = currentParagraph.join(' ');
        elements.push(
          <p key={`p-${keyCounter++}`} className="text-sm lg:text-base text-black leading-relaxed mb-4">
            {parseMarkdown(paragraphText)}
          </p>
        );
        currentParagraph = [];
      }
    };

    lines.forEach((line) => {
      const trimmed = line.trim();

      // Empty line - flush current paragraph
      if (trimmed === '') {
        flushParagraph();
        return;
      }

      // H2 header (##)
      if (trimmed.startsWith('## ')) {
        flushParagraph();
        const headerText = trimmed.substring(3).trim();
        elements.push(
          <h2 key={`h2-${keyCounter++}`} className="text-base lg:text-lg font-semibold text-black mt-6 mb-3">
            {parseMarkdown(headerText)}
          </h2>
        );
        return;
      }

      // H3 header (###)
      if (trimmed.startsWith('### ')) {
        flushParagraph();
        const headerText = trimmed.substring(4).trim();
        elements.push(
          <h3 key={`h3-${keyCounter++}`} className="text-sm lg:text-base font-semibold text-black mt-4 mb-2">
            {parseMarkdown(headerText)}
          </h3>
        );
        return;
      }

      // Regular line - add to current paragraph
      currentParagraph.push(trimmed);
    });

    // Flush any remaining paragraph
    flushParagraph();

    return <div className="pt-[10px]">{elements}</div>;
  };

  const activeTabData = tabs.find(tab => tab.id === activeTab);

  return (
    <div
      className="fixed inset-0 bg-gray-800 bg-opacity-50 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white max-w-4xl w-full h-[70vh] md:h-[calc(100vh-2rem)] overflow-hidden flex flex-col rounded-xs"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex-shrink-0 bg-white border-b border-gray-100 px-6 py-3 z-10">
          <div className="flex justify-between items-center">
            {titleLink ? (
              <a
                href={titleLink}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-light text-black hover:text-gray-600 transition-colors"
              >
                {title}
              </a>
            ) : (
              <h2 className="text-sm font-light text-black">{title}</h2>
            )}
            <button
              type="button"
              onClick={onClose}
              className="text-gray-600 font-light text-sm"
            >
              x
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex-shrink-0 bg-white border-b border-gray-200 px-6 overflow-x-auto overflow-y-hidden z-10 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
          <div className="flex gap-1 min-w-max">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-2 text-sm font-medium transition-colors whitespace-nowrap ${
                  activeTab === tab.id
                    ? 'text-black border-b-2 border-black'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="overflow-y-auto flex-1 px-6 pb-6 min-h-0">
          <div className="pt-4">
            {activeTabData ? parseTabContent(activeTabData.content) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

