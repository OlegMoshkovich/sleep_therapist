'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
// Add markdown support
import ReactMarkdown from 'react-markdown';

// Helper to remove markdown links from a string
function removeMarkdownLinks(text: string): string {
  // Remove [label](url) patterns
  return text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

interface TimelineProps {
  className?: string;
}

interface Week {
  start: Date;
  end: Date;
  weekNumber: number;
  month: string;
  year: number;
  threads?:  {
    investment?: string | string[] | null;  
    company?: string | string[] | null;  
    team?: string | string[] | null;  
    research?: string | string[] | null;
    design?: string | string[] | null;  
  };
}

type FilterType = 'all' | 'investment' | 'company' | 'team' | 'research' | 'design';

const validFilters: FilterType[] = ['all', 'research', 'design', 'team', 'company', 'investment'];

export default function Timeline({ className = '' }: TimelineProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  
  const [currentWeek, setCurrentWeek] = useState(0);
  const [touchStart, setTouchStart] = useState<number | null>(null);
  const [touchEnd, setTouchEnd] = useState<number | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [currentFilter, setCurrentFilter] = useState<FilterType>('all');
  const [isInitialized, setIsInitialized] = useState(false);
  const timelineRef = useRef<HTMLDivElement>(null);

  // Fundraising timeline from Dec 2025 to April 2026
  const weeks: Week[] = [
    {
      start: new Date('2025-12-01'),
      end: new Date('2025-12-07'),
      weekNumber: 1,
      month: 'Dec',
      year: 2025,
      threads: {
        team: ['Talk to researchers about joining the team'],
        investment: ['Labs founded in 2024/2025','Make preliminary pitch deck'],
      }
    },
    {
      start: new Date('2025-12-08'),
      end: new Date('2025-12-14'),
      weekNumber: 2,
      month: 'Dec',
      year: 2025,
      threads: {
        team: ['Get the answer', 'Start discussing the idea'],
        investment: ['Deeper look at Labs founded in 2024/2025','Focus on comparables slide'],
        company:['Equity distribution'],
        research: ['GPU Infrastructure'],
      }

    },
    {
      start: new Date('2025-12-15'),
      end: new Date('2025-12-21'),
      weekNumber: 3,
      month: 'Dec',
      year: 2025,
      threads: {
        team: ['Schedule Hello session on Tuesday'],
        investment: ['Discuss Xin opportunity','Team slide - work on Researcher info', 'Organize Funding Info'],
        research: ['Start Brainstorming','Formalize the Idea'],
      }

    },
    {
      start: new Date('2025-12-22'),
      end: new Date('2025-12-28'),
      weekNumber: 4,
      month: 'Dec',
      year: 2025,
      threads: {
        team: ['Meet on 26-28 for the introduction'],
        investment: ['Pre-seed fundraising strategy', 'Multi-Round Trajectory', 'CAP table model'],
        research: ['Expand on the idea - epistemic uncertainty / truthfulness'],
        design: ['Illustrate research paper', 'Review the team space and comment', 'Create investor flow']
      }
    },
    {
      start: new Date('2025-12-29'),
      end: new Date('2026-01-04'),
      weekNumber: 5,
      month: 'Jan',
      year: 2026,
      threads: {
        investment: ['Funding section', ' Diagram the layers of the system'],
        design: ['Explore the graphic novel format', 'Create several story boards'],
 
      }
    },
    {
      start: new Date('2026-01-05'),
      end: new Date('2026-01-11'),
      weekNumber: 6,
      month: 'Jan',
      year: 2026,
      threads: {
        team: ['Schedule a call to meet the team', 'Merge the documents'],
        research: ['Competitive analysis', 'review clean lab and patronus'],
      }
    },
    {
      start: new Date('2026-01-12'),
      end: new Date('2026-01-18'),
      weekNumber: 7,
      month: 'Jan',
      year: 2026,
      threads: {
        team: ['Oleg in London 12-14', 'Align on the roles and responsibilities'],
        research: ['First Draft of the proposal', 'Start collaborating on proposal with the team'],
        company: ['Model staffing for the team',],
        design: ['Compile references', 'Decide on the preliminary message and format of the presentation material', 'Video'],
      }
    },
    {
      start: new Date('2026-01-19'),
      end: new Date('2026-01-25'),
      weekNumber: 8,
      month: 'Jan',
      year: 2026,
      threads: {
        team: [ 'Finish Bios'],
        design: ['Design Language: Colors, Graphics, Logo, Name'],
        investment: ['Yasin met with some investors in Singapore'],   
        company: ['Model company budget for three years'],

      }
    },
    {
      start: new Date('2026-01-26'),  
      end: new Date('2026-02-01'),
      weekNumber: 9,
      month: 'Feb',
      year: 2026,
      threads: {
        team: ['Meeting 3', 'Discuss proposal'],
        design: ['Design Language: Colors, Graphics, Logo, Name'],
        investment: ['Research the acquisition path'],
      }
    },
    {
      start: new Date('2026-02-02'),
      end: new Date('2026-02-08'),
      weekNumber: 10,
      month: 'Feb',
      year: 2026,
      threads: {
        investment: ['Create v1 of the Investment proposal'],
        design: ['Develop Homepage', 'Develop Pitch Deck'],
      }
    },
    {
      start: new Date('2026-02-09'),
      end: new Date('2026-02-15'),
      weekNumber: 11,
      month: 'Feb',
      year: 2026,
      threads: {
        investment: ['Send the deck to the first batch of investors'],
        design: ['Finalize Homepage', 'Finalize Pitch Deck'],
      }
    },
    {
      start: new Date('2026-02-16'),
      end: new Date('2026-02-22'),
      weekNumber: 12,
      month: 'Feb',
      year: 2026,
      
    },
    {
      start: new Date('2026-02-23'),
      end: new Date('2026-03-01'),
      weekNumber: 13,
      month: 'Mar',
      year: 2026,
      
    },
    {
      start: new Date('2026-03-02'),
      end: new Date('2026-03-08'),
      weekNumber: 14,
      month: 'Mar',
      year: 2026,
      
    },
    {
      start: new Date('2026-03-09'),
      end: new Date('2026-03-15'),
      weekNumber: 15,
      month: 'Mar',
      year: 2026,
      
    },
    {
      start: new Date('2026-03-16'),
      end: new Date('2026-03-22'),
      weekNumber: 16,
      month: 'Mar',
      year: 2026,
      
    },
    {
      start: new Date('2026-03-23'),
      end: new Date('2026-03-29'),
      weekNumber: 17,
      month: 'Mar',
      year: 2026,
      
    },
    {
      start: new Date('2026-03-30'),
      end: new Date('2026-04-05'),
      weekNumber: 18,
      month: 'Apr',
      year: 2026,
      threads: {    
        research: ['Paper is published in nature'],
        investment: ['Leverage paper for investor credibility'],
        company: ['Finalize investor target list', 'Prepare for the investor meetings'],
      }
    },
    {
      start: new Date('2026-04-06'),
      end: new Date('2026-04-12'),
      weekNumber: 19,
      month: 'Apr',
      year: 2026,
      
    },
    {
      start: new Date('2026-04-13'),
      end: new Date('2026-04-19'),
      weekNumber: 20,
      month: 'Apr',
      year: 2026,
      
    },
    {
      start: new Date('2026-04-20'),
      end: new Date('2026-04-26'),
      weekNumber: 21,
      month: 'Apr',
      year: 2026,
      
    },
    {
      start: new Date('2026-04-27'),
      end: new Date('2026-04-30'),
      weekNumber: 22,
      month: 'Apr',
      year: 2026,
      
    }
  ];

  // Find the current week based on today's date
  const getCurrentWeekIndex = () => {
    const today = new Date();
    for (let i = 0; i < weeks.length; i++) {
      if (today >= weeks[i].start && today <= weeks[i].end) {
        return i;
      }
    }
    // If current date is before the timeline, return 0
    // If current date is after the timeline, return last week
    const today_time = today.getTime();
    if (today_time < weeks[0].start.getTime()) return 0;
    if (today_time > weeks[weeks.length - 1].end.getTime()) return weeks.length - 1;
    return 0;
  };

  // Initialize from URL params or current week on mount
  useEffect(() => {
    const threadParam = searchParams.get('thread');
    const weekParam = searchParams.get('week');
    
    // Set filter from URL if valid
    if (threadParam && validFilters.includes(threadParam as FilterType)) {
      setCurrentFilter(threadParam as FilterType);
    }
    
    // Set week from URL if valid, otherwise use current week
    if (weekParam) {
      const weekNum = parseInt(weekParam, 10);
      if (!isNaN(weekNum) && weekNum >= 1 && weekNum <= weeks.length) {
        setCurrentWeek(weekNum - 1); // Convert to 0-based index
      } else {
        setCurrentWeek(getCurrentWeekIndex());
      }
    } else {
      setCurrentWeek(getCurrentWeekIndex());
    }
    
    setIsInitialized(true);
  }, []);

  // Update URL when filter or week changes (after initialization)
  useEffect(() => {
    if (!isInitialized) return;
    
    const params = new URLSearchParams();
    
    if (currentFilter !== 'all') {
      params.set('thread', currentFilter);
    }
    
    // Always include week in URL for shareability
    params.set('week', String(currentWeek + 1));
    
    const newUrl = params.toString() ? `?${params.toString()}` : '/';
    router.replace(newUrl, { scroll: false });
  }, [currentFilter, currentWeek, isInitialized, router]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = () => setShowDropdown(false);
    if (showDropdown) {
      document.addEventListener('click', handleClickOutside);
    }
    return () => document.removeEventListener('click', handleClickOutside);
  }, [showDropdown]);

  const handleFilterSelect = (filter: FilterType) => {
    setCurrentFilter(filter);
    setShowDropdown(false);
  };

  // Check if week has data for the current filter
  const weekHasFilterData = (week: Week, filter: FilterType) => {
    if (!week.threads) return false;
    
    switch (filter) {
      case 'all':
        return !!(week.threads.investment || week.threads.company || week.threads.team || week.threads.research || week.threads.design);
      case 'investment':
        return !!week.threads.investment;
      case 'company':
        return !!week.threads.company;
      case 'team':
        return !!week.threads.team;
      case 'research':
        return !!week.threads.research;
      case 'design':
        return !!week.threads.design;
      default:
        return false;
    }
  };

  const getFilterDisplayName = (filter: FilterType) => {
    switch (filter) {
      case 'all':
        return 'Threads';
      case 'investment':
        return 'Investment';
      case 'company':
        return 'Company';
      case 'team':
        return 'Team';
      case 'research':
        return 'Research';
      case 'design':
        return 'Design';
      default:
        return 'Threads';
    }
  };

  const goToPrevious = useCallback(() => {
    setCurrentWeek((prev) => Math.max(0, prev - 1));
  }, []);

  const goToNext = useCallback(() => {
    setCurrentWeek((prev) => Math.min(weeks.length - 1, prev + 1));
  }, []);

  // Keyboard navigation for desktop (arrow keys)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Disable keyboard navigation if dropdown is open
      if (showDropdown) return;

      // Only enable on desktop (not touch devices)
      if ('ontouchstart' in window || navigator.maxTouchPoints > 0) return;

      // Prevent default behavior for arrow keys to avoid scrolling
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goToPrevious();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        goToNext();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        // Navigate to graphic novel (last in sequence)
        window.location.href = '/graphic-novel/1';
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        // Navigate to pitch deck (next in sequence)
        window.location.href = '/story/1';
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [showDropdown, goToPrevious, goToNext]);

  // Touch handlers for swipe functionality
  const handleTouchStart = (e: React.TouchEvent) => {
    // Don't interfere with clicks on interactive elements
    const target = e.target as HTMLElement;
    if (target.tagName === 'BUTTON' || target.tagName === 'A' || target.closest('button') || target.closest('a')) {
      return;
    }
    setTouchEnd(null);
    setTouchStart(e.targetTouches[0].clientX);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    // Don't interfere with clicks on interactive elements
    const target = e.target as HTMLElement;
    if (target.tagName === 'BUTTON' || target.tagName === 'A' || target.closest('button') || target.closest('a')) {
      return;
    }
    setTouchEnd(e.targetTouches[0].clientX);
  };

  const handleTouchEnd = () => {
    if (!touchStart || !touchEnd) return;
    
    const distance = touchStart - touchEnd;
    const minSwipeDistance = 50;

    if (distance > minSwipeDistance) {
      goToNext();
    }
    
    if (distance < -minSwipeDistance) {
      goToPrevious();
    }
  };

  const formatDate = (date: Date) => {
    return date.toLocaleDateString('en-US', { 
      month: 'short', 
      day: 'numeric' 
    });
  };

  // Helper: render a task string (uses markdown), applies underline to links and opens in new window - MODIFIED to remove links
  function renderMarkdownTask(task: string | null | undefined) {
    if (!task) return null;
    // Remove any markdown links before rendering
    const noLinks = removeMarkdownLinks(task);
    return (
      <ReactMarkdown
        components={{
          a: ({node, ...props}) => (
            <span>{props.children}</span>
          ),
        }}
      >
        {noLinks}
      </ReactMarkdown>
    );
  }
  // Helper: render an array of task strings
  function renderMarkdownTaskList(list: (string | null | undefined)[]) {
    return list.map((item, index) => (
      <div key={index} className="flex items-start gap-2">
        <span className="text-sm mt-1">•</span>
        <span className="text-sm">{renderMarkdownTask(item)}</span>
      </div>
    ));
  }

  // Helper for "all" mode: render all threads, each as a markdown list
  function renderThreadSection(label: string, value: string | string[] | null | undefined) {
    if (!value) return null;
    return (
      <div className="flex items-start gap-2">
        <span className="text-sm mt-1">•</span>
        <span className="text-sm">
          <strong>{label}:</strong>{" "}
          {Array.isArray(value) ? (
            <div className="ml-2">
              {value.map((item, index) => (
                <div key={index} className="flex items-start gap-2 mt-1">
                  <span className="text-sm">◦</span>
                  <span>
                    {renderMarkdownTask(item)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <span className="ml-1">{renderMarkdownTask(value)}</span>
          )}
        </span>
      </div>
    );
  }

  return (
    <div 
      ref={timelineRef}
      className={`w-full ${className}`}
      style={{ pointerEvents: 'auto', maxHeight: '70vh' }}
    >
      <div className="bg-gray-50 border border-gray-200 p-4 sm:p-8 rounded-xl h-full flex flex-col" style={{ pointerEvents: 'auto', maxHeight: '69vh' }}>
        <div className="flex justify-between items-start mb-4 flex-shrink-0">
          <div>
            <h3 className="text-sm font-normal tracking-wide text-black">
              Milestones
            </h3>
            <p className="text-sm text-gray-500 mt-1">
            {formatDate(weeks[currentWeek].start)} - {formatDate(weeks[currentWeek].end)}
            </p>
          </div>
          
          <div className="text-right">
            {/* Dropdown Menu */}
            <div className="relative" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowDropdown(!showDropdown);
                }}
                onTouchStart={(e) => e.stopPropagation()}
                className="text-sm font-light tracking-wide text-black hover:text-gray-600 transition-colors"
                style={{ touchAction: 'manipulation', pointerEvents: 'auto' }}
              >
                {getFilterDisplayName(currentFilter)} ↓
              </button>
              
              {showDropdown && (
                <div className="absolute right-0 top-6 bg-white border border-gray-200 min-w-[120px] z-50">
                  <button 
                    onClick={() => handleFilterSelect('all')}
                    className={`block w-full text-left px-4 py-3 sm:py-2 text-xs hover:bg-gray-100 tracking-wide ${
                      currentFilter === 'all' ? 'bg-gray-100 text-black' : 'text-black'
                    }`}
                  >
                     All Threads
                  </button>
                  <button 
                    onClick={() => handleFilterSelect('research')}
                    className={`block w-full text-left px-4 py-3 sm:py-2 text-xs hover:bg-gray-100 tracking-wide ${
                      currentFilter === 'research' ? 'bg-gray-100 text-black' : 'text-black'
                    }`}
                  >
                    Research
                  </button>
                  <button 
                    onClick={() => handleFilterSelect('design')}
                    className={`block w-full text-left px-4 py-3 sm:py-2 text-xs hover:bg-gray-100 tracking-wide ${
                      currentFilter === 'design' ? 'bg-gray-100 text-black' : 'text-black'
                    }`}
                  >
                    Design
                  </button>
                  <button 
                    onClick={() => handleFilterSelect('team')}
                    className={`block w-full text-left px-4 py-3 sm:py-2 text-xs hover:bg-gray-100 tracking-wide ${
                      currentFilter === 'team' ? 'bg-gray-100 text-black' : 'text-black'
                    }`}
                  >
                    Team
                  </button>
                  <button 
                    onClick={() => handleFilterSelect('company')}
                    className={`block w-full text-left px-4 py-3 sm:py-2 text-xs hover:bg-gray-100 tracking-wide ${
                      currentFilter === 'company' ? 'bg-gray-100 text-black' : 'text-black'
                    }`}
                  >
                    Company
                  </button>
                  <button 
                    onClick={() => handleFilterSelect('investment')}
                    className={`block w-full text-left px-4 py-3 sm:py-2 text-xs hover:bg-gray-100 tracking-wide ${
                      currentFilter === 'investment' ? 'bg-gray-100 text-black' : 'text-black'
                    }`}
                  >
                    Investment
                  </button>
                </div>
              )}
            </div>
            <p className="text-sm text-gray-500 mt-1">
              Week {currentWeek + 1} of {weeks.length}
            </p>
          </div>
        </div>

        {/* Timeline visualization */}
        <div 
          className="relative mb-6 flex-shrink-0"
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          style={{ touchAction: 'pan-y pinch-zoom' }}
        >
          <div 
            className="h-2 bg-gray-200 rounded-full overflow-hidden cursor-pointer hover:bg-gray-300 transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              const rect = e.currentTarget.getBoundingClientRect();
              const clickX = e.clientX - rect.left;
              const percentage = clickX / rect.width;
              const clickedWeek = Math.floor(percentage * weeks.length);
              const validWeek = Math.max(0, Math.min(clickedWeek, weeks.length - 1));
              setCurrentWeek(validWeek);
            }}
            onTouchStart={(e) => e.stopPropagation()}
            style={{ touchAction: 'manipulation', pointerEvents: 'auto' }}
          >
            <div 
              className="h-full bg-gray-600 transition-all duration-300 ease-in-out"
              style={{ width: `${((currentWeek + 1) / weeks.length) * 100}%` }}
            />
          </div>
          
          {/* Week markers */}
          <div className="flex justify-between mt-2 overflow-hidden">
            {weeks.map((week, index) => {
              const hasFilterData = weekHasFilterData(week, currentFilter);

              // Determine if this is the first week of a month
              const isFirstOfMonth = index === 0 || weeks[index - 1].month !== week.month;

              return (
                <div 
                  key={index} 
                  className="flex items-center justify-center flex-1 min-w-0 sm:flex-none sm:min-w-[44px]" 
                  style={{ 
                    minHeight: '44px'
                  }}
                >
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setCurrentWeek(index);
                    }}
                    onTouchStart={(e) => {
                      e.stopPropagation();
                    }}
                    className={`w-2 h-2 rounded-full transition-all flex-shrink-0 ${
                      isFirstOfMonth
                        ? 'bg-gray-400'
                        : index === currentWeek && hasFilterData
                          ? 'bg-orange-500 scale-150'
                          : index === currentWeek 
                            ? 'bg-gray-300'
                            : hasFilterData
                              ? 'bg-orange-500 hover:bg-orange-600'
                              : 'bg-gray-300 hover:bg-gray-500'
                    }`}
                    style={{ 
                      touchAction: 'manipulation', 
                      pointerEvents: 'auto', 
                      WebkitTapHighlightColor: 'transparent',
                      userSelect: 'none'
                    }}
                    title={`${formatDate(week.start)} - ${formatDate(week.end)}`}
                  />
                </div>
              );
            })}
          </div>
        </div>

        {/* Current week display - Scrollable content area */}
        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="text-left">
            {/* Actual Data Display */}
            <div className="mt-4">
              <div className="text-left">
                <div className="text-sm text-black mt-1">
                  {(() => {
                    const threads = weeks[currentWeek].threads;
                    if (!threads) return 'Nothing is planned';
                    switch (currentFilter) {
                      case 'investment':
                        if (Array.isArray(threads.investment)) {
                          return (
                            <div className="space-y-1">
                              {renderMarkdownTaskList(threads.investment)}
                            </div>
                          );
                        }
                        return (threads.investment ? renderMarkdownTask(threads.investment) : 'No investment activities planned');
                      case 'company':
                        if (Array.isArray(threads.company)) {
                          return (
                            <div className="space-y-1">
                              {renderMarkdownTaskList(threads.company)}
                            </div>
                          );
                        }
                        return (threads.company ? renderMarkdownTask(threads.company) : 'No company activities planned');
                      case 'team':
                        if (Array.isArray(threads.team)) {
                          return (
                            <div className="space-y-1">
                              {renderMarkdownTaskList(threads.team)}
                            </div>
                          );
                        }
                        return (threads.team ? renderMarkdownTask(threads.team) : 'No team activities planned');
                      case 'research':
                        if (Array.isArray(threads.research)) {
                          return (
                            <div className="space-y-1">
                              {renderMarkdownTaskList(threads.research)}
                            </div>
                          );
                        }
                        return (threads.research ? renderMarkdownTask(threads.research) : 'No research activities planned');
                      case 'design':
                        if (Array.isArray(threads.design)) {
                          return (
                            <div className="space-y-1">
                              {renderMarkdownTaskList(threads.design)}
                            </div>
                          );
                        }
                        return (threads.design ? renderMarkdownTask(threads.design) : 'No design activities planned');
                      case 'all':
                      default:
                        return (
                          <div className="space-y-1">
                            {renderThreadSection('Research', threads.research)}
                            {renderThreadSection('Design', threads.design)}
                            {renderThreadSection('Team', threads.team)}
                            {renderThreadSection('Investment', threads.investment)}
                            {renderThreadSection('Company', threads.company)}
                          </div>
                        );
                    }
                  })()}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Navigation controls */}
        <div className="flex justify-between items-center mt-6 flex-shrink-0">
          <button
            onClick={goToPrevious}
            disabled={currentWeek === 0}
            className={`text-lg font-light ${
              currentWeek === 0 ? 'text-gray-300 cursor-not-allowed' : 'text-black hover:text-gray-600'
            }`}
          >
            ←
          </button>
          
          <div className="text-sm text-gray-500">
            {currentWeek + 1} / {weeks.length}
          </div>
          
          <button
            onClick={goToNext}
            disabled={currentWeek === weeks.length - 1}
            className={`text-lg font-light ${
              currentWeek === weeks.length - 1 ? 'text-gray-300 cursor-not-allowed' : 'text-black hover:text-gray-600'
            }`}
          >
            →
          </button>
        </div>
      </div>
    </div>
  );
}