'use client';

import { useState, useRef, useEffect } from 'react';
import Image from 'next/image';

const roadmapImages = [
  { filename: '07.12.2025.svg', label: '07.12.2025' },
  { filename: '13.12.2025.svg', label: '13.12.2025' },
  { filename: '24.12.2025.svg', label: '24.12.2025' },
  { filename: '05.01.2026.svg', label: '05.01.2026' },
  { filename: '13.01.2026.svg', label: '13.01.2026' },
  { filename: '15.01.2026.svg', label: '15.01.2026' },
  { filename: '30.01.2026.svg', label: '30.01.2026' },
  { filename: '31.01.2026.svg', label: '31.01.2026' },
];

interface RoadmapOverlayProps {
  externalIsOpen?: boolean;
  onClose?: () => void;
  hideButton?: boolean;
}

export default function RoadmapOverlay({ externalIsOpen, onClose, hideButton = false }: RoadmapOverlayProps) {
  const [internalIsOpen, setInternalIsOpen] = useState(false);
  
  // Use external control if provided, otherwise use internal state
  const isOpen = externalIsOpen !== undefined ? externalIsOpen : internalIsOpen;
  const [selectedRoadmap, setSelectedRoadmap] = useState(roadmapImages[roadmapImages.length - 1].filename);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  
  // Zoom and pan state
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const imageContainerRef = useRef<HTMLDivElement>(null);
  const lastTouchDistance = useRef<number | null>(null);
  const lastTouchCenter = useRef<{ x: number; y: number } | null>(null);

  const openOverlay = () => {
    setInternalIsOpen(true);
    // Reset zoom and pan when opening
    setScale(1);
    setPosition({ x: 0, y: 0 });
  };
  const closeOverlay = () => {
    if (onClose) {
      onClose();
    } else {
      setInternalIsOpen(false);
    }
    setDropdownOpen(false);
    // Reset zoom and pan when closing
    setScale(1);
    setPosition({ x: 0, y: 0 });
  };

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    };

    if (dropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [dropdownOpen]);

  // Zoom functions
  const zoomIn = () => {
    setScale((prev) => Math.min(prev * 1.5, 5));
  };

  const zoomOut = () => {
    setScale((prev) => Math.max(prev / 1.5, 0.5));
  };

  const resetZoom = () => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  };

  const centerImage = () => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  };

  // Mouse wheel zoom
  const handleWheel = (e: React.WheelEvent) => {
    if (!imageContainerRef.current) return;
    
    e.preventDefault();
    const delta = e.deltaY * -0.001;
    const newScale = Math.min(Math.max(scale + delta, 0.5), 5);
    
    if (imageContainerRef.current) {
      const rect = imageContainerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      const scaleChange = newScale / scale;
      setPosition({
        x: x - (x - position.x) * scaleChange,
        y: y - (y - position.y) * scaleChange,
      });
    }
    
    setScale(newScale);
  };

  // Mouse drag handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return; // Only left mouse button
    if (scale <= 1) return; // Only allow dragging when zoomed in
    
    setIsDragging(true);
    setDragStart({
      x: e.clientX - position.x,
      y: e.clientY - position.y,
    });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    
    setPosition({
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y,
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // Touch handlers for pinch-to-zoom and pan
  const getTouchDistance = (touch1: React.Touch, touch2: React.Touch) => {
    const dx = touch2.clientX - touch1.clientX;
    const dy = touch2.clientY - touch1.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const getTouchCenter = (touch1: React.Touch, touch2: React.Touch) => {
    return {
      x: (touch1.clientX + touch2.clientX) / 2,
      y: (touch1.clientY + touch2.clientY) / 2,
    };
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      if (touch1 && touch2) {
        lastTouchDistance.current = getTouchDistance(touch1, touch2);
        if (imageContainerRef.current) {
          const rect = imageContainerRef.current.getBoundingClientRect();
          const center = getTouchCenter(touch1, touch2);
          lastTouchCenter.current = {
            x: center.x - rect.left,
            y: center.y - rect.top,
          };
        }
      }
    } else if (e.touches.length === 1 && scale > 1) {
      const touch = e.touches[0];
      setIsDragging(true);
      setDragStart({
        x: touch.clientX - position.x,
        y: touch.clientY - position.y,
      });
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && lastTouchDistance.current !== null && lastTouchCenter.current) {
      e.preventDefault();
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      if (touch1 && touch2) {
        const distance = getTouchDistance(touch1, touch2);
        const scaleChange = distance / lastTouchDistance.current;
        const newScale = Math.min(Math.max(scale * scaleChange, 0.5), 5);
        
        if (imageContainerRef.current) {
          const rect = imageContainerRef.current.getBoundingClientRect();
          const center = getTouchCenter(touch1, touch2);
          const centerX = center.x - rect.left;
          const centerY = center.y - rect.top;
          
          setPosition({
            x: centerX - (centerX - position.x) * (newScale / scale),
            y: centerY - (centerY - position.y) * (newScale / scale),
          });
        }
        
        setScale(newScale);
        lastTouchDistance.current = distance;
      }
    } else if (e.touches.length === 1 && isDragging) {
      const touch = e.touches[0];
      setPosition({
        x: touch.clientX - dragStart.x,
        y: touch.clientY - dragStart.y,
      });
    }
  };

  const handleTouchEnd = () => {
    lastTouchDistance.current = null;
    lastTouchCenter.current = null;
    setIsDragging(false);
  };

  // Reset zoom when roadmap changes
  useEffect(() => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  }, [selectedRoadmap]);

  // Keyboard navigation for roadmap versions
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const currentIndex = roadmapImages.findIndex(img => img.filename === selectedRoadmap);
      
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        // Go to previous roadmap version
        if (currentIndex > 0) {
          setSelectedRoadmap(roadmapImages[currentIndex - 1].filename);
        }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        // Go to next roadmap version
        if (currentIndex < roadmapImages.length - 1) {
          setSelectedRoadmap(roadmapImages[currentIndex + 1].filename);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeOverlay();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, selectedRoadmap]);

  return (
    <>
      {!hideButton && (
        <button
          onClick={openOverlay}
          className="text-sm text-gray-600 hover:text-black transition-colors text-left w-fit hover:underline"
        >
          Roadmap
        </button>
      )}

      {isOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#6D6D6D] bg-opacity-75 p-4"
          onClick={(e) => {
            // Only close if clicking directly on the backdrop, not on child elements
            if (e.target === e.currentTarget) {
              closeOverlay();
            }
          }}
        >
          {/* Mobile-only close button */}
         
          <div className="flex items-center gap-2 fixed top-20 right-20 z-[60] sm:hidden text-white text-lg w-12 h-12 flex items-center justify-center">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      zoomOut();
                    }}
                    className="text-white hover:text-gray-300 text-sm font-light transition-colors px-2 py-1"
                    aria-label="Zoom out"
                    style={{ touchAction: 'manipulation' }}
                  >
                    −
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      resetZoom();
                    }}
                    className="text-white hover:text-gray-300 text-xs font-light transition-colors px-2 py-1"
                    aria-label="Reset zoom"
                    style={{ touchAction: 'manipulation' }}
                  >
                    {Math.round(scale * 100)}%
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      zoomIn();
                    }}
                    className="text-white hover:text-gray-300 text-sm font-light transition-colors px-2 py-1"
                    aria-label="Zoom in"
                    style={{ touchAction: 'manipulation' }}
                  >
                    +
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      centerImage();
                    }}
                    className="text-white hover:text-gray-300 text-xs font-light transition-colors px-2 py-1"
                    aria-label="Center image"
                    style={{ touchAction: 'manipulation' }}
                    title="Center"
                  >
                    ⊙
                  </button>
                  <button
            onClick={(e) => {
              e.stopPropagation();
              closeOverlay();
            }}
            className=" z-[60] sm:hidden text-white text-lg w-12 h-12 flex items-center justify-center"
            aria-label="Close roadmap"
            style={{ touchAction: 'manipulation' }}
          >
            ×
          </button>
                </div>
          
          <div
            className="max-w-7xl w-full flex flex-col md:max-h-[80vh] sm:max-h-[30vh]"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header row with dropdown and controls */}
            <div className="flex justify-between items-center w-full mb-4 px-4">
              {/* Date dropdown and navigation on the left */}
              <div className="flex items-center gap-2">
                {/* Previous button */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    const currentIndex = roadmapImages.findIndex(img => img.filename === selectedRoadmap);
                    if (currentIndex > 0) {
                      setSelectedRoadmap(roadmapImages[currentIndex - 1].filename);
                    }
                  }}
                  disabled={roadmapImages.findIndex(img => img.filename === selectedRoadmap) === 0}
                  className="text-white hover:text-gray-300 text-lg font-light transition-colors px-2 py-1 disabled:text-gray-600 disabled:cursor-not-allowed"
                  aria-label="Previous roadmap version"
                  style={{ touchAction: 'manipulation' }}
                >
                  ←
                </button>
                
                <div className="relative" ref={dropdownRef}>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setDropdownOpen(!dropdownOpen);
                    }}
                    className="bg-transparent text-white text-xs sm:text-sm px-3 py-1.5 cursor-pointer transition-colors hover:text-gray-200"
                    style={{ touchAction: 'manipulation' }}
                  >
                    {roadmapImages.find(img => img.filename === selectedRoadmap)?.label}
                  </button>
                {dropdownOpen && (
                  <div className="absolute left-0 top-full mt-1 bg-white border border-gray-300 rounded min-w-[120px] z-50">
                    {roadmapImages.map((img) => (
                      <button
                        key={img.filename}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedRoadmap(img.filename);
                          setDropdownOpen(false);
                        }}
                        className={`block w-full text-left px-4 py-2 text-xs sm:text-sm hover:bg-gray-100 transition-colors ${
                          selectedRoadmap === img.filename ? 'text-black' : 'text-black'
                        }`}
                        style={{ touchAction: 'manipulation' }}
                      >
                        {img.label}
                      </button>
                    ))}
                  </div>
                )}
                </div>

                {/* Next button */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    const currentIndex = roadmapImages.findIndex(img => img.filename === selectedRoadmap);
                    if (currentIndex < roadmapImages.length - 1) {
                      setSelectedRoadmap(roadmapImages[currentIndex + 1].filename);
                    }
                  }}
                  disabled={roadmapImages.findIndex(img => img.filename === selectedRoadmap) === roadmapImages.length - 1}
                  className="text-white hover:text-gray-300 text-lg font-light transition-colors px-2 py-1 disabled:text-gray-600 disabled:cursor-not-allowed"
                  aria-label="Next roadmap version"
                  style={{ touchAction: 'manipulation' }}
                >
                  →
                </button>
              </div>
              
              {/* Controls on the right */}
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      zoomOut();
                    }}
                    className="text-white hover:text-gray-300 text-sm font-light transition-colors px-2 py-1"
                    aria-label="Zoom out"
                    style={{ touchAction: 'manipulation' }}
                  >
                    −
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      resetZoom();
                    }}
                    className="text-white hover:text-gray-300 text-xs font-light transition-colors px-2 py-1"
                    aria-label="Reset zoom"
                    style={{ touchAction: 'manipulation' }}
                  >
                    {Math.round(scale * 100)}%
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      zoomIn();
                    }}
                    className="text-white hover:text-gray-300 text-sm font-light transition-colors px-2 py-1"
                    aria-label="Zoom in"
                    style={{ touchAction: 'manipulation' }}
                  >
                    +
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      centerImage();
                    }}
                    className="text-white hover:text-gray-300 text-xs font-light transition-colors px-2 py-1"
                    aria-label="Center image"
                    style={{ touchAction: 'manipulation' }}
                    title="Center"
                  >
                    ⊙
                  </button>
                </div>
                <button
                  onClick={closeOverlay}
                  className="text-white hover:text-gray-300 text-lg font-thin transition-colors"
                  aria-label="Close roadmap"
                  style={{ touchAction: 'manipulation' }}
                >
                  x
                </button>
              </div>
            </div>
            
            {/* Image container */}
            <div 
              ref={imageContainerRef}
              className="relative w-full h-[90vh] overflow-hidden cursor-move"
              onWheel={handleWheel}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
              style={{ touchAction: 'none' }}
            >
              <div
                style={{
                  transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
                  transformOrigin: '0 0',
                  width: '100%',
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transition: isDragging ? 'none' : 'transform 0.1s ease-out',
                }}
              >
                <Image
                  src={`/roadmap/${selectedRoadmap}`}
                  alt="Roadmap"
                  width={1200}
                  height={800}
                  className="object-contain max-w-full max-h-full"
                  priority
                  draggable={false}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

