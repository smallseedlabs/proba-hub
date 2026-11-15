import { randomUUID } from 'node:crypto';
import { pool } from '../db/client.js';

export type AssetKind = 'image' | 'video';

export interface CreativeAsset {
  id: string;
  workspaceId: string;
  userId: string;
  goalId?: string;
  kind: AssetKind;
  url: string;
  mimeType?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  aspectRatio?: string;
  provider: string;
  model?: string;
  prompt?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface CreateCreativeAssetInput {
  workspaceId: string;
  userId: string;
  goalId?: string;
  kind: AssetKind;
  url: string;
  mimeType?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  aspectRatio?: string;
  provider: string;
  model?: string;
  prompt?: string;
  metadata?: Record<string, unknown>;
}

interface AssetRow {
  id: string;
  workspace_id: string;
  user_id: string;
  goal_id: string | null;
  kind: AssetKind;
  url: string;
  mime_type: string | null;
  width: number | null;
  height: number | null;
  duration_seconds: string | number | null;
  aspect_ratio: string | null;
  provider: string;
  model: string | null;
  prompt: string | null;
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
    ...(r.mime_type ? { mimeType: r.mime_type } : {}),
    ...(r.width !== null ? { width: r.width } : {}),
    ...(r.height !== null ? { height: r.height } : {}),
    ...(r.duration_seconds !== null ? { durationSeconds: Number(r.duration_seconds) } : {}),
    ...(r.aspect_ratio ? { aspectRatio: r.aspect_ratio } : {}),
    provider: r.provider,
    ...(r.model ? { model: r.model } : {}),
    ...(r.prompt ? { prompt: r.prompt } : {}),
    metadata: r.metadata ?? {},
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

export class AssetService {
  async create(input: CreateCreativeAssetInput): Promise<CreativeAsset> {
    const id = `ast_${randomUUID()}`;
    const res = await pool.query<AssetRow>(
      `INSERT INTO creative_assets
        (id, workspace_id, user_id, goal_id, kind, url, mime_type, width, height, duration_seconds, aspect_ratio, provider, model, prompt, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
       RETURNING *`,
      [
        id,
        input.workspaceId,
        input.userId,
        input.goalId ?? null,
        input.kind,
        input.url,
        input.mimeType ?? null,
        input.width ?? null,
        input.height ?? null,
        input.durationSeconds ?? null,
        input.aspectRatio ?? null,
        input.provider,
        input.model ?? null,
        input.prompt ?? null,
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
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);
    values.push(limit);
    const res = await pool.query<AssetRow>(
      `SELECT * FROM creative_assets WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT $${values.length}`,
      values
    );
    return res.rows.map(rowToAsset);
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
