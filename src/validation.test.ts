import { describe, it, expect } from 'vitest';
import { commandEnvelopeSchema } from '@smallseedlabs/proba-protocol';

describe('Command Validation', () => {
  describe('commandEnvelopeSchema', () => {
    it('should validate a valid send_message command', () => {
      const command = {
        kind: 'command',
        clientMsgId: '123e4567-e89b-12d3-a456-426614174000',
        type: 'send_message',
        threadId: '123e4567-e89b-12d3-a456-426614174001',
        payload: {
          text: 'Hello world',
        },
        sentAt: '2024-10-19T10:00:00Z',
      };

      const result = commandEnvelopeSchema.safeParse(command);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('send_message');
        expect(result.data.clientMsgId).toBe(command.clientMsgId);
      }
    });

    it('should validate a valid create_goal command', () => {
      const command = {
        kind: 'command',
        clientMsgId: '123e4567-e89b-12d3-a456-426614174000',
        type: 'create_goal',
        threadId: '123e4567-e89b-12d3-a456-426614174001',
        payload: {
          title: 'Launch Campaign',
          description: 'Q4 product launch',
          constraints: ['family-friendly'],
          budget: {
            daily: 100,
            total: 3000,
            currency: 'USD',
          },
        },
        sentAt: '2024-10-19T10:00:00Z',
      };

      const result = commandEnvelopeSchema.safeParse(command);
      expect(result.success).toBe(true);
    });

    it('should validate a valid control command', () => {
      const command = {
        kind: 'command',
        clientMsgId: '123e4567-e89b-12d3-a456-426614174000',
        type: 'control',
        threadId: '123e4567-e89b-12d3-a456-426614174001',
        payload: {
          action: 'pause',
        },
        sentAt: '2024-10-19T10:00:00Z',
      };

      const result = commandEnvelopeSchema.safeParse(command);
      expect(result.success).toBe(true);
    });

    it('should reject command with missing clientMsgId', () => {
      const command = {
        kind: 'command',
        type: 'send_message',
        payload: {
          text: 'Hello',
        },
        sentAt: '2024-10-19T10:00:00Z',
      };

      const result = commandEnvelopeSchema.safeParse(command);
      expect(result.success).toBe(false);
    });

    it('should reject command with invalid type', () => {
      const command = {
        kind: 'command',
        clientMsgId: '123e4567-e89b-12d3-a456-426614174000',
        type: 'invalid_type',
        payload: {},
        sentAt: '2024-10-19T10:00:00Z',
      };

      const result = commandEnvelopeSchema.safeParse(command);
      expect(result.success).toBe(false);
    });

    it('should accept command with empty payload', () => {
      const command = {
        kind: 'command',
        clientMsgId: '123e4567-e89b-12d3-a456-426614174000',
        type: 'mark_read',
        payload: {},
        sentAt: '2024-10-19T10:00:00Z',
      };

      const result = commandEnvelopeSchema.safeParse(command);
      expect(result.success).toBe(true);
    });
  });
});
