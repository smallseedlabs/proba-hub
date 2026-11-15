import { randomUUID } from 'node:crypto';
import { pool } from '../db/client.js';

export type AssetKind = 'image' | 'video';
export type CurationStatus = 'approved' | 'candidate' | 'do_not_use';

export interface CreativeAsset {
  id: string;
  workspaceId: string;
  userId: string;
  goalId?: string;
  kind: AssetKind;
  url: string;
  sourceUrl?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  aspectRatio?: string;
  provider: string;
  model?: string;
  prompt?: string;
  title?: string;
  description?: string;
  tags: string[];
  visualStyle?: string;
  brandElements: string[];
  useCases: string[];
  curationStatus: CurationStatus;
  parentAssetId?: string;
  timesUsed: number;
  lastUsedAt?: string;
  performanceSummary: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface CreateCreativeAssetInput {
  id?: string;
  workspaceId: string;
  userId: string;
  goalId?: string;
  kind: AssetKind;
  url: string;
  sourceUrl?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  aspectRatio?: string;
  provider: string;
  model?: string;
  prompt?: string;
  title?: string;
  description?: string;
  tags?: string[];
  visualStyle?: string;
  brandElements?: string[];
  useCases?: string[];
  curationStatus?: CurationStatus;
  parentAssetId?: string;
  performanceSummary?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  dedupeByPrompt?: boolean;
}

export interface UpdateCreativeAssetInput {
  title?: string;
  description?: string;
  tags?: string[];
  visualStyle?: string;
  brandElements?: string[];
  useCases?: string[];
  curationStatus?: CurationStatus;
}

interface AssetRow {
  id: string;
  workspace_id: string;
  user_id: string;
  goal_id: string | null;
  kind: AssetKind;
  url: string;
  source_url: string | null;
  mime_type: string | null;
  width: number | null;
  height: number | null;
  duration_seconds: string | number | null;
  aspect_ratio: string | null;
  provider: string;
  model: string | null;
  prompt: string | null;
  title: string | null;
  description: string | null;
  tags: string[] | null;
  visual_style: string | null;
  brand_elements: string[] | null;
  use_cases: string[] | null;
  curation_status: CurationStatus | null;
  parent_asset_id: string | null;
  times_used: number | null;
  last_used_at: Date | string | null;
  performance_summary: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  created_at: Date | string;
}

function rowToAsset(r: AssetRow): CreativeAsset {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    userId: r.user_id,
    ...(r.goal_id ? { goalId: r.goal_id } : {}),
    kind: r.kind,
    url: r.url,
    ...(r.source_url ? { sourceUrl: r.source_url } : {}),
    ...(r.mime_type ? { mimeType: r.mime_type } : {}),
    ...(r.width !== null ? { width: r.width } : {}),
    ...(r.height !== null ? { height: r.height } : {}),
    ...(r.duration_seconds !== null ? { durationSeconds: Number(r.duration_seconds) } : {}),
    ...(r.aspect_ratio ? { aspectRatio: r.aspect_ratio } : {}),
    provider: r.provider,
    ...(r.model ? { model: r.model } : {}),
    ...(r.prompt ? { prompt: r.prompt } : {}),
    ...(r.title ? { title: r.title } : {}),
    ...(r.description ? { description: r.description } : {}),
    tags: Array.isArray(r.tags) ? r.tags : [],
    ...(r.visual_style ? { visualStyle: r.visual_style } : {}),
    brandElements: Array.isArray(r.brand_elements) ? r.brand_elements : [],
    useCases: Array.isArray(r.use_cases) ? r.use_cases : [],
    curationStatus: r.curation_status ?? 'candidate',
    ...(r.parent_asset_id ? { parentAssetId: r.parent_asset_id } : {}),
    timesUsed: r.times_used ?? 0,
    ...(r.last_used_at ? { lastUsedAt: r.last_used_at instanceof Date ? r.last_used_at.toISOString() : String(r.last_used_at) } : {}),
    performanceSummary: r.performance_summary ?? {},
    metadata: r.metadata ?? {},
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

export class AssetService {
  async findDuplicateByPrompt(params: {
    workspaceId: string;
    userId: string;
    kind: AssetKind;
    prompt: string;
    aspectRatio?: string;
  }): Promise<CreativeAsset | null> {
    const res = await pool.query<AssetRow>(
      `SELECT * FROM creative_assets
       WHERE workspace_id = $1 AND user_id = $2 AND kind = $3
         AND LOWER(TRIM(COALESCE(prompt, ''))) = LOWER(TRIM($4))
         AND ($5::text IS NULL OR COALESCE(aspect_ratio, '') = $5)
         AND curation_status <> 'do_not_use'
       ORDER BY created_at DESC LIMIT 1`,
      [params.workspaceId, params.userId, params.kind, params.prompt, params.aspectRatio ?? null]
    );
    return res.rows[0] ? rowToAsset(res.rows[0]) : null;
  }

  async create(input: CreateCreativeAssetInput): Promise<CreativeAsset> {
    if (input.dedupeByPrompt && input.prompt?.trim()) {
      const existing = await this.findDuplicateByPrompt({
        workspaceId: input.workspaceId,
        userId: input.userId,
        kind: input.kind,
        prompt: input.prompt,
        aspectRatio: input.aspectRatio,
      });
      if (existing) return existing;
    }

    const id = input.id && input.id.startsWith('ast_') ? input.id : `ast_${randomUUID()}`;
    const res = await pool.query<AssetRow>(
      `INSERT INTO creative_assets
        (id, workspace_id, user_id, goal_id, kind, url, source_url, mime_type, width, height, duration_seconds, aspect_ratio,
         provider, model, prompt, title, description, tags, visual_style, brand_elements, use_cases, curation_status, parent_asset_id, performance_summary, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::text[], $19, $20::text[], $21::text[], $22, $23, $24::jsonb, $25::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         url = EXCLUDED.url,
         title = COALESCE(EXCLUDED.title, creative_assets.title),
         description = COALESCE(EXCLUDED.description, creative_assets.description)
       RETURNING *`,
      [
        id,
        input.workspaceId,
        input.userId,
        input.goalId ?? null,
        input.kind,
        input.url,
        input.sourceUrl ?? input.url,
        input.mimeType ?? null,
        input.width ?? null,
        input.height ?? null,
        input.durationSeconds ?? null,
        input.aspectRatio ?? null,
        input.provider,
        input.model ?? null,
        input.prompt ?? null,
        input.title ?? null,
        input.description ?? null,
        input.tags ?? [],
        input.visualStyle ?? null,
        input.brandElements ?? [],
        input.useCases ?? [],
        input.curationStatus ?? 'candidate',
        input.parentAssetId ?? null,
        JSON.stringify(input.performanceSummary ?? {}),
        JSON.stringify(input.metadata ?? {}),
      ]
    );
    return rowToAsset(res.rows[0]!);
  }

  async list(params: {
    workspaceId: string;
    userId: string;
    goalId?: string;
    kind?: AssetKind;
    curationStatus?: CurationStatus;
    excludeDoNotUse?: boolean;
    tag?: string;
    useCase?: string;
    query?: string;
    limit?: number;
  }): Promise<CreativeAsset[]> {
    const conditions = ['workspace_id = $1', 'user_id = $2'];
    const values: unknown[] = [params.workspaceId, params.userId];
    if (params.goalId) {
      values.push(params.goalId);
      conditions.push(`goal_id = $${values.length}`);
    }
    if (params.kind) {
      values.push(params.kind);
      conditions.push(`kind = $${values.length}`);
    }
    if (params.curationStatus) {
      values.push(params.curationStatus);
      conditions.push(`curation_status = $${values.length}`);
    } else if (params.excludeDoNotUse) {
      conditions.push(`curation_status <> 'do_not_use'`);
    }
    if (params.tag) {
      values.push(params.tag.toLowerCase());
      conditions.push(`EXISTS (SELECT 1 FROM unnest(tags) t WHERE LOWER(t) = $${values.length})`);
    }
    if (params.useCase) {
      values.push(params.useCase.toLowerCase());
      conditions.push(`EXISTS (SELECT 1 FROM unnest(use_cases) u WHERE LOWER(u) = $${values.length})`);
    }
    if (params.query?.trim()) {
      values.push(`%${params.query.trim().toLowerCase()}%`);
      conditions.push(
        `(LOWER(COALESCE(title, '')) LIKE $${values.length} OR LOWER(COALESCE(description, '')) LIKE $${values.length} OR LOWER(COALESCE(prompt, '')) LIKE $${values.length} OR EXISTS (SELECT 1 FROM unnest(tags) t WHERE LOWER(t) LIKE $${values.length}))`
      );
    }
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);
    values.push(limit);
    const res = await pool.query<AssetRow>(
      `SELECT * FROM creative_assets WHERE ${conditions.join(' AND ')}
       ORDER BY (curation_status = 'approved') DESC, created_at DESC LIMIT $${values.length}`,
      values
    );
    return res.rows.map(rowToAsset);
  }

  async update(
    id: string,
    workspaceId: string,
    userId: string,
    patch: UpdateCreativeAssetInput
  ): Promise<CreativeAsset | null> {
    const sets: string[] = [];
    const values: unknown[] = [id, workspaceId, userId];
    const push = (col: string, val: unknown, cast = '') => {
      values.push(val);
      sets.push(`${col} = $${values.length}${cast}`);
    };
    if (patch.title !== undefined) push('title', patch.title);
    if (patch.description !== undefined) push('description', patch.description);
    if (patch.tags !== undefined) push('tags', patch.tags, '::text[]');
    if (patch.visualStyle !== undefined) push('visual_style', patch.visualStyle);
    if (patch.brandElements !== undefined) push('brand_elements', patch.brandElements, '::text[]');
    if (patch.useCases !== undefined) push('use_cases', patch.useCases, '::text[]');
    if (patch.curationStatus !== undefined) push('curation_status', patch.curationStatus);
    if (sets.length === 0) return this.get(id, workspaceId, userId);

    const res = await pool.query<AssetRow>(
      `UPDATE creative_assets SET ${sets.join(', ')}
       WHERE id = $1 AND workspace_id = $2 AND user_id = $3
       RETURNING *`,
      values
    );
    return res.rows[0] ? rowToAsset(res.rows[0]) : null;
  }

  async markUsed(id: string, workspaceId: string, userId: string): Promise<void> {
    await pool.query(
      `UPDATE creative_assets SET times_used = times_used + 1, last_used_at = NOW()
       WHERE id = $1 AND workspace_id = $2 AND user_id = $3`,
      [id, workspaceId, userId]
    );
  }

  async get(id: string, workspaceId: string, userId: string): Promise<CreativeAsset | null> {
    const res = await pool.query<AssetRow>(
      `SELECT * FROM creative_assets WHERE id = $1 AND workspace_id = $2 AND user_id = $3`,
      [id, workspaceId, userId]
    );
    return res.rows[0] ? rowToAsset(res.rows[0]) : null;
  }

  async remove(id: string, workspaceId: string, userId: string): Promise<boolean> {
    const res = await pool.query(
      `DELETE FROM creative_assets WHERE id = $1 AND workspace_id = $2 AND user_id = $3`,
      [id, workspaceId, userId]
    );
    return (res.rowCount ?? 0) > 0;
  }
}
