import { NextRequest, NextResponse } from "next/server";

import { resolveCurrentUser } from "../../../../lib/admin-auth";
import {
  deleteAgentTemplate,
  loadAgentTemplateWithVersions,
  updateAgentTemplateWithNewVersion,
  type AgentTemplate,
  type AgentTemplateVisibility,
} from "../../../../lib/agent-template-catalog";
import {
  countAgentTemplateProjectReferences,
  loadAgentTemplateProjectReferences,
  type AgentTemplateProjectReference,
} from "../../../../lib/agent-template-references";
import type { CanvasDoc } from "../../../../components/canvas/types";
import { createSupabaseAdminClient } from "../../../../lib/supabase-admin";

type SupabaseClient = ReturnType<typeof createSupabaseAdminClient>;

interface RouteContext {
  params: Promise<{ id: string }>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asCanvasDoc(value: unknown): CanvasDoc | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as CanvasDoc)
    : null;
}

function normalizeVisibility(
  value: unknown,
  fallback: AgentTemplateVisibility
): AgentTemplateVisibility {
  return value === "private" || value === "shared" || value === "published"
    ? value
    : fallback;
}

function serializeTemplate(
  template: AgentTemplate,
  references: AgentTemplateProjectReference[]
) {
  const latestVersion =
    template.versions.find((version) => version.id === template.latestVersionId) ??
    template.versions[0] ??
    null;

  return {
    id: template.id,
    slug: template.slug,
    title: template.title,
    description: template.description,
    visibility: template.visibility,
    ownerId: template.ownerId,
    latestVersionId: template.latestVersionId,
    latestVersion: latestVersion
      ? {
          id: latestVersion.id,
          defaultFields: latestVersion.defaultFields,
          defaultStateUpdatePrompt: latestVersion.defaultStateUpdatePrompt,
          defaultPolicyPrompt: latestVersion.defaultPolicyPrompt,
          defaultRewardPrompt: latestVersion.defaultRewardPrompt,
          defaultGuidelines: latestVersion.defaultGuidelines,
          defaultDatasets: latestVersion.defaultDatasets,
          defaultUploadedFiles: latestVersion.defaultUploadedFiles,
          defaultSkills: latestVersion.defaultSkills,
          defaultStatePolicyCanvases:
            latestVersion.defaultStatePolicyCanvases,
          defaultPolicyCanvases: latestVersion.defaultPolicyCanvases,
          defaultRewardCanvases: latestVersion.defaultRewardCanvases,
          versionNumber: latestVersion.versionNumber,
          versionLabel: latestVersion.versionLabel,
          status: latestVersion.status,
          createdAt: latestVersion.createdAt,
          updatedAt: latestVersion.updatedAt,
        }
      : null,
    versions: template.versions.map((version) => ({
      id: version.id,
      versionNumber: version.versionNumber,
      versionLabel: version.versionLabel,
      status: version.status,
      createdAt: version.createdAt,
      updatedAt: version.updatedAt,
    })),
    references,
    referenceCount: references.length,
    updatedAt: template.updatedAt,
  };
}

async function loadEditableTemplate(args: {
  templateId: string;
  supabase: SupabaseClient;
  userUUID: string;
  isAdmin: boolean;
}) {
  const template = await loadAgentTemplateWithVersions(args.templateId, {
    supabase: args.supabase,
  });
  if (!template) {
    return {
      response: NextResponse.json(
        { error: "Agent template not found." },
        { status: 404 }
      ),
      template: null,
    };
  }
  if (!args.isAdmin && template.ownerId !== args.userUUID) {
    return {
      response: NextResponse.json(
        { error: "You can only modify templates you own." },
        { status: 403 }
      ),
      template: null,
    };
  }

  return { response: null, template };
}

export async function PUT(request: NextRequest, ctx: RouteContext) {
  const me = await resolveCurrentUser();
  if (!me) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const templateId = id.trim();
  if (!templateId) {
    return NextResponse.json(
      { error: "Agent template id is required." },
      { status: 400 }
    );
  }

  try {
    const supabase = createSupabaseAdminClient();
    const loaded = await loadEditableTemplate({
      templateId,
      supabase,
      userUUID: me.userUUID,
      isAdmin: me.isAdmin,
    });
    if (loaded.response || !loaded.template) {
      return loaded.response;
    }

    const body = (await request.json().catch(() => ({}))) as {
      title?: unknown;
      description?: unknown;
      visibility?: unknown;
      versionLabel?: unknown;
      defaults?: Record<string, unknown>;
    };
    const defaults =
      body.defaults && typeof body.defaults === "object" ? body.defaults : {};

    const updated = await updateAgentTemplateWithNewVersion({
      templateId,
      title: asString(body.title).trim() || loaded.template.title,
      description: asString(body.description),
      visibility: normalizeVisibility(body.visibility, loaded.template.visibility),
      versionLabel: asString(body.versionLabel),
      defaultFields: asArray(defaults.defaultFields),
      defaultStateUpdatePrompt: asString(defaults.defaultStateUpdatePrompt),
      defaultPolicyPrompt: asString(defaults.defaultPolicyPrompt),
      defaultRewardPrompt: asString(defaults.defaultRewardPrompt),
      defaultGuidelines: asArray(defaults.defaultGuidelines),
      defaultDatasets: asArray(defaults.defaultDatasets),
      defaultUploadedFiles: asArray(defaults.defaultUploadedFiles),
      defaultSkills: asArray(defaults.defaultSkills),
      defaultPolicyCanvases: asCanvasDoc(defaults.defaultPolicyCanvases),
      defaultStatePolicyCanvases: asCanvasDoc(
        defaults.defaultStatePolicyCanvases
      ),
      defaultRewardCanvases: asCanvasDoc(defaults.defaultRewardCanvases),
      supabase,
    });
    const referencesByTemplate = await loadAgentTemplateProjectReferences(
      supabase,
      [templateId]
    );
    const references = referencesByTemplate.get(templateId) ?? [];

    return NextResponse.json({
      template: serializeTemplate(updated, references),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to update agent template.",
      },
      { status: 500 }
    );
  }
}

export async function DELETE(_request: NextRequest, ctx: RouteContext) {
  const me = await resolveCurrentUser();
  if (!me) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const templateId = id.trim();
  if (!templateId) {
    return NextResponse.json(
      { error: "Agent template id is required." },
      { status: 400 }
    );
  }

  try {
    const supabase = createSupabaseAdminClient();
    const loaded = await loadEditableTemplate({
      templateId,
      supabase,
      userUUID: me.userUUID,
      isAdmin: me.isAdmin,
    });
    if (loaded.response || !loaded.template) {
      return loaded.response;
    }

    const referenceCounts = await countAgentTemplateProjectReferences(
      supabase,
      [templateId]
    );
    const referenceCount = referenceCounts.get(templateId) ?? 0;
    if (referenceCount > 0) {
      const referencesByTemplate = await loadAgentTemplateProjectReferences(
        supabase,
        [templateId]
      );
      return NextResponse.json(
        {
          error:
            "This template is still referenced by drafts or published setups.",
          referenceCount,
          references: referencesByTemplate.get(templateId) ?? [],
        },
        { status: 409 }
      );
    }

    await deleteAgentTemplate({ templateId, supabase });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to delete agent template.",
      },
      { status: 500 }
    );
  }
}
