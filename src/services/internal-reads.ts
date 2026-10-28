import { pool } from '../db/client.js';
import { DEFAULT_WORKSPACE_ID } from '../config.js';
import { maskSecretsInText } from '../audit/redact.js';

export interface GoalState {
  goalId: string;
  workspaceId: string;
  userId: string;
  threadId: string;
  title: string;
  status: string;
  step: string | null;
  budget: {
    current: Record<string, unknown> | null;
    proposed: Record<string, unknown> | null;
  };
  approvals: Array<{
    askId: string;
    askType: string;
    status: string;
    answeredAt: string | null;
    decision: string | null;
  }>;
  declines: Array<{
    askId: string;
    askType: string;
    status: string;
    answeredAt: string | null;
  }>;
  campaignIds: string[];
}

export interface ThreadMessage {
  id: string;
  threadId: string;
  role: string;
  text: string;
  source: string;
  createdAt: string;
}

export interface AuthorizeResult {
  allowed: boolean;
  reason: string;
}

/** Load goal state for the acting user in the workspace, or null when not found / not owned. */
export async function loadGoalState(params: {
  goalId: string;
  userId: string;
  workspaceId: string;
}): Promise<GoalState | null> {
  if (params.workspaceId !== DEFAULT_WORKSPACE_ID) return null;

  const goalResult = await pool.query<{
    id: string;
    userId: string;
    threadId: string;
    title: string;
    status: string;
    budget: Record<string, unknown> | null;
    progress: { completed?: number; total?: number; milestones?: Array<{ name: string; completed: boolean }> } | null;
    metrics: Record<string, unknown> | null;
  }>(
    `SELECT id, user_id as "userId", thread_id as "threadId", title, status,
            budget, progress, metrics
     FROM goals
     WHERE id = $1 AND user_id = $2`,
    [params.goalId, params.userId]
  );
  if (goalResult.rows.length === 0) return null;
  const goal = goalResult.rows[0];

  const asks = await pool.query<{
    id: string;
    askType: string;
    status: string;
    answeredAt: Date | null;
    answer: { choice?: string } | null;
    costEffect: Record<string, unknown> | null;
  }>(
    `SELECT id, ask_type as "askType", status, answered_at as "answeredAt",
            answer, cost_effect as "costEffect"
     FROM asks
     WHERE thread_id = $1
       AND ask_type IN ('plan_approval', 'action_approval')
     ORDER BY created_at DESC
     LIMIT 50`,
    [goal.threadId]
  );

  const approvals: GoalState['approvals'] = [];
  const declines: GoalState['declines'] = [];
  let proposedBudget: Record<string, unknown> | null = null;

  for (const ask of asks.rows) {
    const choice = ask.answer?.choice ?? null;
    const answeredAt = ask.answeredAt ? ask.answeredAt.toISOString() : null;
    if (ask.status === 'pending') {
      if (ask.costEffect && proposedBudget === null) {
        proposedBudget = ask.costEffect;
      }
      continue;
    }
    if (choice === 'reject') {
      declines.push({ askId: ask.id, askType: ask.askType, status: ask.status, answeredAt });
    } else if (choice === 'approve' || choice === 'edit' || ask.status === 'answered') {
      approvals.push({
        askId: ask.id,
        askType: ask.askType,
        status: ask.status,
        answeredAt,
        decision: choice,
      });
    }
  }

  const campaignIds = extractCampaignIds(goal.metrics);
  const step = deriveStep(goal.status, goal.progress);

  return {
    goalId: goal.id,
    workspaceId: params.workspaceId,
    userId: goal.userId,
    threadId: goal.threadId,
    title: goal.title,
    status: goal.status,
    step,
    budget: {
      current: goal.budget,
      proposed: proposedBudget,
    },
    approvals,
    declines,
    campaignIds,
  };
}

function extractCampaignIds(metrics: Record<string, unknown> | null): string[] {
  if (!metrics) return [];
  const raw = metrics.campaignIds ?? metrics.campaign_ids;
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

function deriveStep(
  status: string,
  progress: { completed?: number; total?: number; milestones?: Array<{ name: string; completed: boolean }> } | null
): string | null {
  const open = progress?.milestones?.find((m) => !m.completed);
  if (open?.name) return open.name;
  if (progress && typeof progress.completed === 'number' && typeof progress.total === 'number') {
    return `progress:${progress.completed}/${progress.total}`;
  }
  return status || null;
}

/** Newest-first cursor page of thread messages, masked for secrets. */
export async function loadThreadMessages(params: {
  threadId: string;
  userId: string;
  workspaceId: string;
  goalId: string;
  cursor?: string;
  limit: number;
}): Promise<{ messages: ThreadMessage[]; nextCursor: string | null } | null> {
  if (params.workspaceId !== DEFAULT_WORKSPACE_ID) return null;

  const thread = await pool.query<{ id: string; userId: string }>(
    `SELECT t.id, t.user_id as "userId"
     FROM threads t
     WHERE t.id = $1 AND t.user_id = $2`,
    [params.threadId, params.userId]
  );
  if (thread.rows.length === 0) return null;

  const goal = await pool.query<{ id: string }>(
    `SELECT id FROM goals WHERE id = $1 AND user_id = $2 AND thread_id = $3`,
    [params.goalId, params.userId, params.threadId]
  );
  if (goal.rows.length === 0) return null;

  const limit = Math.max(1, Math.min(params.limit, 100));
  const queryParams: (string | number)[] = [params.threadId];
  let sql = `
    SELECT id, thread_id as "threadId", text, source, created_at as "createdAt"
    FROM messages
    WHERE thread_id = $1
  `;
  if (params.cursor) {
    sql += ` AND created_at < (SELECT created_at FROM messages WHERE id = $2 AND thread_id = $1)`;
    queryParams.push(params.cursor);
  }
  sql += ` ORDER BY created_at DESC LIMIT $${queryParams.length + 1}`;
  queryParams.push(limit + 1);

  const result = await pool.query<{
    id: string;
    threadId: string;
    text: string;
    source: string;
    createdAt: Date;
  }>(sql, queryParams);

  const hasMore = result.rows.length > limit;
  const page = result.rows.slice(0, limit);
  const messages: ThreadMessage[] = page.map((row) => ({
    id: row.id,
    threadId: row.threadId,
    role: sourceToRole(row.source),
    text: maskSecretsInText(row.text, { pii: true }).text,
    source: row.source,
    createdAt: row.createdAt.toISOString(),
  }));

  return {
    messages,
    nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
  };
}

function sourceToRole(source: string): string {
  if (source === 'user') return 'user';
  if (source === 'brain') return 'assistant';
  return source || 'system';
}

/** Whether the user belongs to the workspace and owns (or may act on) the goal. */
export async function authorizeActor(params: {
  userId: string;
  workspaceId: string;
  goalId: string;
}): Promise<AuthorizeResult> {
  if (params.workspaceId !== DEFAULT_WORKSPACE_ID) {
    return { allowed: false, reason: 'workspace_not_allowed' };
  }
  const user = await pool.query(`SELECT id FROM users WHERE id = $1`, [params.userId]);
  if (user.rows.length === 0) {
    return { allowed: false, reason: 'user_not_found' };
  }
  const goal = await pool.query(`SELECT id FROM goals WHERE id = $1 AND user_id = $2`, [
    params.goalId,
    params.userId,
  ]);
  if (goal.rows.length === 0) {
    return { allowed: false, reason: 'goal_not_owned' };
  }
  return { allowed: true, reason: 'ok' };
}
