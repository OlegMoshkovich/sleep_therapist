import { NextRequest, NextResponse } from "next/server";

import { getRequestUserUUID } from "../../../lib/admin-auth";
import {
  createAgentTemplateDraft,
  listAgentTemplates,
  listReusableAgentTemplates,
  loadAgentTemplateVersion,
  type AgentTemplate,
  type AgentTemplateVersion,
  type AgentTemplateVisibility,
} from "../../../lib/agent-template-catalog";
import {
  loadAgentTemplateProjectReferences,
  type AgentTemplateProjectReference,
} from "../../../lib/agent-template-references";
import type { CanvasDoc } from "../../../components/canvas/types";
import { createSupabaseAdminClient } from "../../../lib/supabase-admin";

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

function normalizeVisibility(value: unknown): AgentTemplateVisibility {
  return value === "shared" || value === "published" ? value : "private";
}

function serializeTemplate(
  template: AgentTemplate,
  latestVersion: AgentTemplateVersion | null
) {
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
          defaultStateUpdatePrompt:
            latestVersion.defaultStateUpdatePrompt,
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
    updatedAt: template.updatedAt,
  };
}

export async function GET() {
  const userUUID = await getRequestUserUUID();

  try {
    const supabase = createSupabaseAdminClient();
    const templates = userUUID
      ? await listReusableAgentTemplates({
          ownerId: userUUID,
          supabase,
        })
      : await listAgentTemplates({
          visibility: "published",
          supabase,
        });
    const latestVersions = await Promise.all(
      templates.map((template) =>
        template.latestVersionId
          ? loadAgentTemplateVersion(template.latestVersionId, { supabase })
          : Promise.resolve(null)
      )
    );
    const referencesByTemplate = userUUID
      ? await loadAgentTemplateProjectReferences(
          supabase,
          templates.map((template) => template.id)
        )
      : new Map<string, AgentTemplateProjectReference[]>();

    return NextResponse.json({
      templates: templates.map((template, index) => {
        const latestVersion = latestVersions[index];
        return {
          ...serializeTemplate(template, latestVersion),
          references: referencesByTemplate.get(template.id) ?? [],
          referenceCount: referencesByTemplate.get(template.id)?.length ?? 0,
        };
      }),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to load agent templates.",
      },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const userUUID = await getRequestUserUUID();
  if (!userUUID) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await request.json().catch(() => ({}))) as {
      title?: unknown;
      slug?: unknown;
      description?: unknown;
      visibility?: unknown;
      versionLabel?: unknown;
      defaults?: Record<string, unknown>;
    };
    const title = asString(body.title).trim();
    if (!title) {
      return NextResponse.json(
        { error: "Agent template title is required." },
        { status: 400 }
      );
    }

    const defaults =
      body.defaults && typeof body.defaults === "object" ? body.defaults : {};
    const supabase = createSupabaseAdminClient();
    const template = await createAgentTemplateDraft(
      {
        ownerId: userUUID,
        title,
        slug: asString(body.slug).trim() || undefined,
        description: asString(body.description),
        visibility: normalizeVisibility(body.visibility),
        versionLabel: asString(body.versionLabel).trim() || "Canvas snapshot",
        versionStatus: "draft",
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
      },
      { supabase }
    );
    const latestVersion =
      template.versions.find((version) => version.id === template.latestVersionId) ??
      template.versions[0] ??
      null;

    return NextResponse.json({
      template: {
        ...serializeTemplate(template, latestVersion),
        references: [],
        referenceCount: 0,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to create agent template.",
      },
      { status: 500 }
    );
  }
}
