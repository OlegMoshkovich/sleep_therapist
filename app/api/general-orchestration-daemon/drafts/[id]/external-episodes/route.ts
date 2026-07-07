import { NextRequest, NextResponse } from "next/server";
import { getRequestUserUUID } from "../../../../../lib/admin-auth";
import { DEMO_SETUP } from "../../../../../lib/demo-config";
import {
  makeOrchestrationId,
  type OrchestrationUploadedFile,
} from "../../../../../lib/general-orchestration";
import {
  loadDaemonDraft,
  saveDaemonDraft,
} from "../../../../../lib/general-orchestration-daemon-draft-store";
import { createSupabaseAdminClient } from "../../../../../lib/supabase-admin";
import {
  appendWorkflowBootstrapSourceRecords,
  clearExternalEpisodesDatasetRecords,
  extractExternalEpisodesFromText,
  type WorkflowBootstrapSourceKind,
} from "../../../../../lib/external-episodes";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const EXTERNAL_EPISODES_BUCKET =
  DEMO_SETUP["general-orchestration-daemon"].filesBucket;
const MAX_EXTERNAL_EPISODES_FILE_BYTES = 2 * 1024 * 1024;

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function normalizeWorkflowSourceKind(value: FormDataEntryValue | null): WorkflowBootstrapSourceKind {
  return value === "reference_material" ? "reference_material" : "historical_records";
}

function buildWorkflowSourceStoragePath(
  userUUID: string,
  draftId: string,
  kind: WorkflowBootstrapSourceKind,
  fileName: string
): string {
  const folder =
    kind === "reference_material" ? "reference-materials" : "historical-records";
  return `experts/${userUUID}/general-orchestration-daemon-drafts/${draftId}/workflow-sources/${folder}/${Date.now()}-${sanitizeFileName(fileName)}`;
}

function isExternalEpisodesUpload(file: OrchestrationUploadedFile, draftId: string): boolean {
  return (
    typeof file.path === "string" &&
    file.path.includes(`/general-orchestration-daemon-drafts/${draftId}/external-episodes/`)
  );
}

function splitExternalEpisodeUploads(files: OrchestrationUploadedFile[], draftId: string) {
  const externalEpisodeFiles: OrchestrationUploadedFile[] = [];
  const otherFiles: OrchestrationUploadedFile[] = [];

  for (const file of files) {
    if (isExternalEpisodesUpload(file, draftId)) {
      externalEpisodeFiles.push(file);
    } else {
      otherFiles.push(file);
    }
  }

  return {
    externalEpisodeFiles,
    otherFiles,
  };
}

async function removeStoredFiles(paths: string[]) {
  if (paths.length === 0) {
    return;
  }

  const supabase = createSupabaseAdminClient();
  await supabase.storage.from(EXTERNAL_EPISODES_BUCKET).remove(paths);
}

export async function POST(request: NextRequest, ctx: RouteContext) {
  const userUUID = await getRequestUserUUID();
  if (!userUUID) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file." }, { status: 400 });
  }
  if (file.size > MAX_EXTERNAL_EPISODES_FILE_BYTES) {
    return NextResponse.json(
      { error: "Workflow source file is too large. Keep it under 2 MB for now." },
      { status: 400 }
    );
  }

  const sourceKind = normalizeWorkflowSourceKind(form.get("sourceKind"));
  const text = await file.text();
  const sources =
    sourceKind === "reference_material"
      ? [
          {
            sourceName: file.name,
            sourceType: file.type || "text/plain",
            content: text,
          },
        ]
      : extractExternalEpisodesFromText({
          fileName: file.name,
          fileType: file.type,
          text,
        }).map((episode) => ({
          sourceName: file.name,
          sourceType: file.type || "text/plain",
          content: episode,
        }));
  if (sources.length === 0 || sources.every((source) => !source.content.trim())) {
    return NextResponse.json(
      { error: "Could not extract any readable text from that file." },
      { status: 400 }
    );
  }

  const supabase = createSupabaseAdminClient();
  const draft = await loadDaemonDraft(supabase, userUUID, id);
  if (!draft) {
    return NextResponse.json({ error: "Draft not found." }, { status: 404 });
  }

  const path = buildWorkflowSourceStoragePath(userUUID, id, sourceKind, file.name);
  const uploadResult = await supabase.storage
    .from(EXTERNAL_EPISODES_BUCKET)
    .upload(path, file, {
      upsert: false,
      contentType: file.type || "text/plain",
    });
  if (uploadResult.error) {
    return NextResponse.json(
      { error: uploadResult.error.message },
      { status: 500 }
    );
  }

  const nextUploadedFile: OrchestrationUploadedFile = {
    id: makeOrchestrationId(),
    name: file.name,
    size: file.size,
    type: file.type || "text/plain",
    bucket: EXTERNAL_EPISODES_BUCKET,
    path,
    uploaded_by_uuid: userUUID,
    uploaded_at: new Date().toISOString(),
  };

  const nextProject = {
    ...draft.project,
    uploadedFiles: [...draft.project.uploadedFiles, nextUploadedFile],
    // Workflow evidence is draft-wide bootstrap data, kept on the shared tier
    // alongside other authoring inputs.
    sharedDatasets: appendWorkflowBootstrapSourceRecords(
      draft.project.sharedDatasets,
      sourceKind,
      sources,
      makeOrchestrationId
    ),
  };

  const savedDraft = await saveDaemonDraft({
    supabase,
    userUUID,
    draftId: id,
    project: nextProject,
    messages: draft.messages,
    daemonState: draft.daemonState,
    interactionMode: draft.interactionMode,
  });
  if (!savedDraft) {
    await removeStoredFiles([path]);
    return NextResponse.json({ error: "Draft not found." }, { status: 404 });
  }

  return NextResponse.json({
    draft: savedDraft,
    sourceCount: sources.length,
  });
}

export async function DELETE(_request: NextRequest, ctx: RouteContext) {
  const userUUID = await getRequestUserUUID();
  if (!userUUID) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const supabase = createSupabaseAdminClient();
  const draft = await loadDaemonDraft(supabase, userUUID, id);
  if (!draft) {
    return NextResponse.json({ error: "Draft not found." }, { status: 404 });
  }

  const { externalEpisodeFiles, otherFiles } = splitExternalEpisodeUploads(
    draft.project.uploadedFiles,
    id
  );

  const savedDraft = await saveDaemonDraft({
    supabase,
    userUUID,
    draftId: id,
    project: {
      ...draft.project,
      uploadedFiles: otherFiles,
      sharedDatasets: clearExternalEpisodesDatasetRecords(
        draft.project.sharedDatasets,
        makeOrchestrationId
      ),
    },
    messages: draft.messages,
    daemonState: draft.daemonState,
    interactionMode: draft.interactionMode,
  });
  if (!savedDraft) {
    return NextResponse.json({ error: "Draft not found." }, { status: 404 });
  }

  await removeStoredFiles(
    externalEpisodeFiles
      .map((existingFile) => existingFile.path)
      .filter((existingPath): existingPath is string => typeof existingPath === "string")
  );

  return NextResponse.json({ draft: savedDraft });
}
