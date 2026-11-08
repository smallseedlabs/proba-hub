import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { CommandEnvelope } from '@smallseedlabs/proba-protocol';
import {
  landingPageUrlOf,
  userSuppliedInputFromCommand,
  userSuppliedInputFromCreateGoal,
  userSuppliedInputFromUnknown,
} from './user-input.js';

const LANDING = 'https://operator-entered.example/path';

function command(type: CommandEnvelope['type'], payload: Record<string, unknown>): CommandEnvelope {
  return {
    kind: 'command',
    type,
    clientMsgId: randomUUID(),
    threadId: randomUUID(),
    payload,
    sentAt: new Date().toISOString(),
  };
}

describe('operator userSuppliedInput', () => {
  it('keeps the original operator URL and does not default a host', () => {
    expect(userSuppliedInputFromCreateGoal({ title: 'Launch', userSuppliedInput: { landingPageUrl: LANDING } })).toEqual({
      landingPageUrl: LANDING,
    });
    expect(userSuppliedInputFromCreateGoal({ title: 'Launch' })).toBeUndefined();
    expect(userSuppliedInputFromUnknown({ landingPageUrl: LANDING, workspaceId: 'seedbed' })).toBeUndefined();
    expect(landingPageUrlOf({ landingPageUrl: LANDING })).toBe(LANDING);
    expect(userSuppliedInputFromCreateGoal({ title: 'x' })).toBeUndefined();
    expect(JSON.stringify({ title: 'x' })).not.toMatch(/smallseedlabs\.com/);
  });

  it('reads create_goal and edit-only answer_ask, never send_message text', () => {
    expect(
      userSuppliedInputFromCommand(command('create_goal', { title: 'G', userSuppliedInput: { landingPageUrl: LANDING } }))
    ).toEqual({ landingPageUrl: LANDING });
    expect(
      userSuppliedInputFromCommand(
        command('answer_ask', {
          askId: randomUUID(),
          choice: 'edit',
          userSuppliedInput: { landingPageUrl: 'https://operator-entered.example/new' },
        })
      )
    ).toEqual({ landingPageUrl: 'https://operator-entered.example/new' });
    expect(
      userSuppliedInputFromCommand(
        command('answer_ask', {
          askId: randomUUID(),
          choice: 'approve',
          userSuppliedInput: { landingPageUrl: LANDING },
        })
      )
    ).toBeUndefined();
    expect(
      userSuppliedInputFromCommand(command('send_message', { text: `please use ${LANDING}` }))
    ).toBeUndefined();
  });
});
