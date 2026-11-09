/**
 * Operator-entered landing URL. Auth identity is not a command field.
 * Model/tool text, Context packets, and hardcoded hosts are not user input.
 * There is no default landing URL (including no smallseedlabs.com).
 */

import {
  parseLandingPageUrl,
  validateUserSuppliedInput,
  type CommandEnvelope,
  type CreateGoalPayload,
  type UserSuppliedInput,
} from '@smallseedlabs/proba-protocol';

export type { UserSuppliedInput };

export function userSuppliedInputFromUnknown(value: unknown): UserSuppliedInput | undefined {
  const parsed = validateUserSuppliedInput(value);
  return parsed.success ? parsed.data : undefined;
}

/** create_goal payload only. Title/description/text are not a landing URL. */
export function userSuppliedInputFromCreateGoal(payload: CreateGoalPayload | unknown): UserSuppliedInput | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  return userSuppliedInputFromUnknown((payload as CreateGoalPayload).userSuppliedInput);
}

export function userSuppliedInputFromCommand(command: CommandEnvelope): UserSuppliedInput | undefined {
  if (command.type === 'create_goal') return userSuppliedInputFromCreateGoal(command.payload);
  if (command.type === 'answer_ask') {
    const payload = command.payload as { choice?: unknown; userSuppliedInput?: unknown };
    if (payload.choice !== 'edit') return undefined;
    return userSuppliedInputFromUnknown(payload.userSuppliedInput);
  }
  return undefined;
}

export function landingPageUrlOf(input: UserSuppliedInput | undefined): string | undefined {
  if (!input) return undefined;
  const parsed = parseLandingPageUrl(input.landingPageUrl);
  return parsed.ok ? parsed.url : undefined;
}
