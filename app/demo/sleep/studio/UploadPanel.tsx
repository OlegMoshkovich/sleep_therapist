"use client";

import { useRef, useState } from "react";
import { Ic } from "./ra-icons";

/**
 * Upload content: a drop zone for sharing sleep-data files with the human
 * expert. Files can be drag-and-dropped or chosen via the file picker. There is
 * no backend upload — the pane collects the dropped files and lists them.
 *
 * Rendered as one tab inside the shared RightDrawer; the drawer shell, tab strip
 * and close button live there. This component renders only the pane body.
 */

interface DroppedFile {
  name: string;
  size: number;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function UploadContent() {
  const [files, setFiles] = useState<DroppedFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const next = Array.from(list).map((f) => ({ name: f.name, size: f.size }));
    setFiles((prev) => [...prev, ...next]);
  };

  return (
    <div className="drawer-pane">
      <div className="drawer-subhead">
        <span className="obs-sub">Drop files to share with the expert</span>
        {files.length > 0 && (
          <button type="button" onClick={() => setFiles([])} className="obs-clear">
            Clear
          </button>
        )}
      </div>

      <div className="obs-body upload-body">
        <div
          className={"upload-drop" + (dragging ? " dragging" : "")}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            addFiles(e.dataTransfer.files);
          }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              inputRef.current?.click();
            }
          }}
        >
          <span className="upload-ico">
            <Ic.Upload size={24} />
          </span>
          <div className="upload-drop-title">Drop files here</div>
          <div className="upload-drop-sub">or click to browse — CSV, JSON, PDF, images</div>
          <input
            ref={inputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>

        {files.length > 0 && (
          <div className="upload-list">
            {files.map((f, i) => (
              <div key={i} className="upload-item">
                <span className="upload-item-ic">
                  <Ic.Book size={15} />
                </span>
                <div className="upload-item-meta">
                  <span className="upload-item-name">{f.name}</span>
                  <span className="upload-item-size">{formatSize(f.size)}</span>
                </div>
                <button
                  type="button"
                  className="upload-item-x"
                  title="Remove"
                  onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
