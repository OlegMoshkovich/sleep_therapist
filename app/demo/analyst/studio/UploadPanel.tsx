"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Ic } from "./ra-icons";

/**
 * Upload content: a drop zone backed by the signed-in user's document library.
 * Dropped files are uploaded to the private `sleep-input-files` Storage bucket
 * and recorded in `public.user_files` (see app/api/files/route.ts), so every
 * file the user uploads — from any conversation — lives in one persistent
 * library, browsable/downloadable here. Uploads made while a conversation is
 * active are tagged with it for provenance.
 *
 * Rendered as one tab inside the shared RightDrawer; the drawer shell, tab strip
 * and close button live there. This component renders only the pane body.
 */

interface LibraryFile {
  id: string;
  conversationId: string | null;
  name: string;
  size: number;
  type: string;
  path: string;
  createdAt: string;
  /** Short-lived signed download URL (may be null if signing failed). */
  url?: string | null;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function UploadContent({ conversationId }: { conversationId?: string | null }) {
  const [files, setFiles] = useState<LibraryFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load the whole library on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/files");
        if (!res.ok) return;
        const { files: rows } = (await res.json()) as { files: LibraryFile[] };
        if (!cancelled) setFiles(rows ?? []);
      } catch {
        /* leave the list empty on failure */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const uploadFiles = useCallback(
    async (list: FileList | null) => {
      if (!list || list.length === 0) return;
      setError(null);
      setUploading(true);
      for (const file of Array.from(list)) {
        const fd = new FormData();
        fd.append("file", file);
        if (conversationId) fd.append("conversationId", conversationId);
        try {
          const res = await fetch("/api/files", { method: "POST", body: fd });
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as { error?: string };
            setError(body.error || `Couldn't upload ${file.name}`);
            continue;
          }
          const { file: saved } = (await res.json()) as { file: LibraryFile };
          setFiles((prev) => [saved, ...prev]);
        } catch {
          setError(`Couldn't upload ${file.name}`);
        }
      }
      setUploading(false);
    },
    [conversationId]
  );

  const removeFile = useCallback(async (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id)); // optimistic
    try {
      await fetch(`/api/files?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch {
      /* best-effort; the row is already gone from the UI */
    }
  }, []);

  // Attach a library file to (or detach it from) the active conversation.
  const toggleAttach = useCallback(
    async (file: LibraryFile) => {
      if (!conversationId) return;
      const attached = file.conversationId === conversationId;
      const nextConvo = attached ? null : conversationId;
      setFiles((prev) =>
        prev.map((f) => (f.id === file.id ? { ...f, conversationId: nextConvo } : f))
      ); // optimistic
      try {
        await fetch("/api/files", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: file.id, conversationId: nextConvo }),
        });
      } catch {
        /* best-effort; revert on failure */
        setFiles((prev) =>
          prev.map((f) =>
            f.id === file.id ? { ...f, conversationId: file.conversationId } : f
          )
        );
      }
    },
    [conversationId]
  );

  return (
    <div className="drawer-pane">
      <div className="drawer-subhead">
        <span className="obs-sub">Your library — shared with the expert</span>
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
            uploadFiles(e.dataTransfer.files);
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
          <div className="upload-drop-title">
            {uploading ? "Uploading…" : "Drop files here"}
          </div>
          <div className="upload-drop-sub">or click to browse — CSV, JSON, PDF, images</div>
          <input
            ref={inputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              uploadFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>

        {error && <div className="upload-error">{error}</div>}

        {files.length > 0 && (
          <div className="upload-list">
            {files.map((f) => (
              <div key={f.id} className="upload-item">
                <span className="upload-item-ic">
                  <Ic.Book size={15} />
                </span>
                <div className="upload-item-meta">
                  {f.url ? (
                    <a
                      className="upload-item-name"
                      href={f.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Download"
                    >
                      {f.name}
                    </a>
                  ) : (
                    <span className="upload-item-name">{f.name}</span>
                  )}
                  <span className="upload-item-size">{formatSize(f.size)}</span>
                </div>
                {conversationId && (
                  <button
                    type="button"
                    className={
                      "upload-item-attach" +
                      (f.conversationId === conversationId ? " on" : "")
                    }
                    title={
                      f.conversationId === conversationId
                        ? "Attached to this conversation — click to detach"
                        : "Attach to this conversation"
                    }
                    aria-pressed={f.conversationId === conversationId}
                    onClick={() => toggleAttach(f)}
                  >
                    {f.conversationId === conversationId ? "Attached" : "Attach"}
                  </button>
                )}
                <button
                  type="button"
                  className="upload-item-x"
                  title="Remove from library"
                  onClick={() => removeFile(f.id)}
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
