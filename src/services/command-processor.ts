import type { PoolClient } from 'pg';
import { transaction } from '../db/client.js';
import { logger } from '../logger.js';
import { kickOutboxRelay } from './outbox-relay.js';
import type { BrainPort, Command, Event, Thread, Message, Goal, BrainContext } from '../types.js';
import type { 
  CommandEnvelope, 
  BrainOutput,
  ControlPayload,
  CreateGoalPayload,
  AnswerAskPayload,
} from '@smallseedlabs/proba-protocol';
import { mapBrainOutputToEvent } from '@smallseedlabs/proba-protocol';

export class CommandProcessor {
  constructor(private brain: BrainPort) {}

  async processCommand(
    userId: string,
    envelope: CommandEnvelope
  ): Promise<{ command: Command; events: Event[] }> {
    return transaction(async (client) => {
      const existingCommand = await this.checkIdempotency(
        client,
        userId,
        envelope.clientMsgId
      );

      if (existingCommand) {
        logger.info(
          { userId, clientMsgId: envelope.clientMsgId },
          'Command already processed (idempotent)'
        );
        
        const events = await this.getCommandEvents(client, existingCommand.id);
        return { command: existingCommand, events };
      }

      const command = await this.storeCommand(client, userId, envelope);

      if (envelope.type === 'control') {
        return this.processControl(client, userId, command, envelope);
      }

      const context = await this.buildContext(client, userId, envelope.threadId);
      
      let brainOutputs: BrainOutput[];
      try {
        brainOutputs = await this.brain.process(envelope, context);
      } catch (error) {
        logger.error({ error, userId, command: envelope.type }, 'Brain processing failed');
        
        const errorEvent = await this.createErrorEvent(
          client,
          userId,
          envelope.threadId,
          'brain_error',
          'Failed to process command. Please try again.'
        );
        
        await this.addToOutbox(client, userId, errorEvent.id);
        return { command, events: [errorEvent] };
      }

      const events: Event[] = [];
      
      for (const output of brainOutputs) {
        try {
          const event = await this.processBrainOutput(
            client,
            userId,
            envelope.threadId,
            output
          );
          events.push(event);
          await this.addToOutbox(client, userId, event.id);
        } catch (error) {
          logger.error({ error, output }, 'Failed to process brain output');
          
          // Surface error as error event
          try {
            const seq = await this.getNextSeq(client, userId);
            const errorEvent = await client.query<Event>(
              `INSERT INTO events (user_id, seq, type, thread_id, payload, created_at)
               VALUES ($1, $2, 'error', $3, $4, NOW())
               RETURNING id, user_id as "userId", seq, type, thread_id as "threadId",
                         payload, created_at as "createdAt"`,
              [userId, seq, envelope.threadId, { code: 'brain_error', message: (error as Error).message }]
            );
            const errorEventRow = errorEvent.rows[0];
            events.push(errorEventRow);
            await this.addToOutbox(client, userId, errorEventRow.id);
          } catch (innerError) {
            logger.error({ error: innerError }, 'Failed to create error event');
          }
        }
      }

      if (envelope.type === 'answer_ask') {
        const answerPayload = envelope.payload as AnswerAskPayload;
        const askType = (envelope.payload as unknown as Record<string, unknown>).askType;
        logger.info({ askId: answerPayload.askId, askType }, 'Handling answer_ask command');
        await this.handleAskAnswer(client, answerPayload);
      }

      if (envelope.type === 'approve_plan') {
        logger.info({ planId: (envelope.payload as Record<string, unknown>).planId }, 'Handling approve_plan command');
      }

      if (envelope.type === 'create_goal') {
        await this.createGoal(client, userId, envelope.threadId!, envelope.payload as CreateGoalPayload);
      }

      await client.query(
        'UPDATE commands SET status = $1, processed_at = NOW() WHERE id = $2',
        ['processed', command.id]
      );

      // Kick outbox relay immediately after transaction commits
      setImmediate(() => kickOutboxRelay());

      return { command, events };
    });
  }

  private async checkIdempotency(
    client: PoolClient,
    userId: string,
    clientMsgId: string
  ): Promise<Command | null> {
    const result = await client.query<Command>(
      `SELECT id, user_id as "userId", client_msg_id as "clientMsgId", type, 
              thread_id as "threadId", payload, status, processed_at as "processedAt", 
              created_at as "createdAt"
       FROM commands 
       WHERE user_id = $1 AND client_msg_id = $2`,
      [userId, clientMsgId]
    );

    return result.rows[0] || null;
  }

  private async storeCommand(
    client: PoolClient,
    userId: string,
    envelope: CommandEnvelope
  ): Promise<Command> {
    const result = await client.query<Command>(
      `INSERT INTO commands (user_id, client_msg_id, type, thread_id, payload, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, user_id as "userId", client_msg_id as "clientMsgId", type,
                 thread_id as "threadId", payload, status, processed_at as "processedAt",
                 created_at as "createdAt"`,
      [userId, envelope.clientMsgId, envelope.type, envelope.threadId, envelope.payload, 'accepted']
    );

    return result.rows[0];
  }

  private async getCommandEvents(client: PoolClient, commandId: string): Promise<Event[]> {
    const result = await client.query<Event>(
      `SELECT DISTINCT e.id, e.user_id as "userId", e.seq, e.type, e.thread_id as "threadId",
              e.payload, e.ui_payload_id as "uiPayloadId", e.fallback_text as "fallbackText",
              e.created_at as "createdAt"
       FROM events e
       JOIN outbox o ON e.id = o.event_id
       WHERE o.created_at >= (
         SELECT created_at FROM commands WHERE id = $1
       )
       ORDER BY e.seq ASC`,
      [commandId]
    );

    return result.rows;
  }

  private async buildContext(
    client: PoolClient,
    userId: string,
    threadId?: string
  ): Promise<BrainContext> {
    let thread: Thread | undefined;
    let messages: Message[] = [];
    let goals: Goal[] = [];

    if (threadId) {
      const threadResult = await client.query<Thread>(
        `SELECT id, user_id as "userId", title, status, 
                created_at as "createdAt", updated_at as "updatedAt"
         FROM threads WHERE id = $1`,
        [threadId]
      );
      thread = threadResult.rows[0];

      const messagesResult = await client.query<Message>(
        `SELECT id, thread_id as "threadId", text, source, created_at as "createdAt"
         FROM messages WHERE thread_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [threadId]
      );
      messages = messagesResult.rows;

      const goalsResult = await client.query<Goal>(
        `SELECT id, user_id as "userId", thread_id as "threadId", title, description,
                constraints, budget, status, progress, metrics,
                created_at as "createdAt", updated_at as "updatedAt"
         FROM goals WHERE thread_id = $1`,
        [threadId]
      );
      goals = goalsResult.rows;
    }

    return { userId, threadId, thread, messages, goals, client };
  }

  private async processBrainOutput(
    client: PoolClient,
    userId: string,
    threadId: string | undefined,
    output: BrainOutput
  ): Promise<Event> {
    const seq = await this.getNextSeq(client, userId);
    
    const eventEnvelope = mapBrainOutputToEvent(output, { seq, threadId });
    
    let uiPayloadId: string | undefined;
    if ('ui' in eventEnvelope && eventEnvelope.ui) {
      const uiResult = await client.query<{ id: string }>(
        'INSERT INTO ui_payloads (component, version, props, actions) VALUES ($1, $2, $3, $4) RETURNING id',
        [
          eventEnvelope.ui.component,
          eventEnvelope.ui.version,
          eventEnvelope.ui.props,
          'actions' in eventEnvelope.ui ? eventEnvelope.ui.actions : null,
        ]
      );
      uiPayloadId = uiResult.rows[0].id;
    }

    const eventResult = await client.query<Event>(
      `INSERT INTO events (user_id, seq, type, thread_id, payload, ui_payload_id, fallback_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, user_id as "userId", seq, type, thread_id as "threadId",
                 payload, ui_payload_id as "uiPayloadId", fallback_text as "fallbackText",
                 created_at as "createdAt"`,
      [
        userId,
        seq,
        eventEnvelope.type,
        threadId,
        eventEnvelope.payload,
        uiPayloadId,
        'fallbackText' in eventEnvelope ? eventEnvelope.fallbackText : null,
      ]
    );

    if (eventEnvelope.type === 'ask') {
      await this.createAsk(client, threadId!, eventEnvelope.payload as Record<string, unknown>);
    }

    if (eventEnvelope.type === 'message') {
      const payload = eventEnvelope.payload as Record<string, unknown>;
      await client.query(
        'INSERT INTO messages (thread_id, text, source) VALUES ($1, $2, $3)',
        [threadId, payload.text, payload.source]
      );
    }

    return eventResult.rows[0];
  }

  private async getNextSeq(client: PoolClient, userId: string): Promise<number> {
    const result = await client.query<{ seq: number }>(
      'SELECT get_next_event_seq($1) as seq',
      [userId]
    );
    return result.rows[0].seq;
  }

  private async createAsk(
    client: PoolClient,
    threadId: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    await client.query(
      `INSERT INTO asks (id, thread_id, ask_type, title, description, blocking, risk, cost_effect, questions)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        payload.askId,
        threadId,
        payload.askType,
        payload.title,
        payload.description,
        payload.blocking,
        payload.risk,
        payload.costEffect ? JSON.stringify(payload.costEffect) : null,
        JSON.stringify(payload.questions),
      ]
    );

    const questions = payload.questions as Array<Record<string, unknown>>;
    for (const question of questions) {
      await client.query(
        `INSERT INTO ask_questions (ask_id, question_id, type, label, required, options, constraints)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          payload.askId,
          question.id,
          question.type,
          question.label,
          question.required ?? true,
          question.options ? JSON.stringify(question.options) : null,
          question.constraints ? JSON.stringify(question.constraints) : null,
        ]
      );
    }

    await client.query(
      `INSERT INTO inbox_items (user_id, thread_id, type, title, description, priority, related_ask_id)
       SELECT t.user_id, $1, 'ask', $2, $3, 'high', $4
       FROM threads t WHERE t.id = $1`,
      [threadId, payload.title, payload.description, payload.askId]
    );
  }

  private async handleAskAnswer(
    client: PoolClient,
    payload: AnswerAskPayload
  ): Promise<void> {
    await client.query(
      `UPDATE asks SET status = 'answered', answered_at = NOW(), answer = $1 WHERE id = $2`,
      [JSON.stringify(payload), payload.askId]
    );

    await client.query(
      `UPDATE inbox_items SET status = 'resolved', updated_at = NOW() 
       WHERE related_ask_id = $1`,
      [payload.askId]
    );

    const seq = await this.getNextSeq(client, (await client.query('SELECT user_id FROM asks WHERE id = $1', [payload.askId])).rows[0].user_id);
    
    await client.query(
      `INSERT INTO events (user_id, seq, type, thread_id, payload)
       SELECT a.thread_id, $1, 'ask_resolved', a.thread_id, $2
       FROM asks a WHERE a.id = $3`,
      [seq, JSON.stringify({ askId: payload.askId, resolution: 'answered' }), payload.askId]
    );
  }

  private async createGoal(
    client: PoolClient,
    userId: string,
    threadId: string,
    payload: CreateGoalPayload
  ): Promise<void> {
    await client.query(
      `INSERT INTO goals (user_id, thread_id, title, description, constraints, budget, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft')`,
      [
        userId,
        threadId,
        payload.title,
        payload.description,
        JSON.stringify(payload.constraints),
        JSON.stringify(payload.budget),
      ]
    );
  }

  private async processControl(
    client: PoolClient,
    userId: string,
    command: Command,
    envelope: CommandEnvelope
  ): Promise<{ command: Command; events: Event[] }> {
    const payload = envelope.payload as ControlPayload;
    
    const seq = await this.getNextSeq(client, userId);
    
    const eventResult = await client.query<Event>(
      `INSERT INTO events (user_id, seq, type, thread_id, payload)
       VALUES ($1, $2, 'status', $3, $4)
       RETURNING id, user_id as "userId", seq, type, thread_id as "threadId",
                 payload, ui_payload_id as "uiPayloadId", fallback_text as "fallbackText",
                 created_at as "createdAt"`,
      [
        userId,
        seq,
        envelope.threadId,
        JSON.stringify({
          state: payload.action,
          message: `Execution ${payload.action}`,
        }),
      ]
    );

    const event = eventResult.rows[0];
    await this.addToOutbox(client, userId, event.id);

    await client.query(
      'UPDATE commands SET status = $1, processed_at = NOW() WHERE id = $2',
      ['processed', command.id]
    );

    return { command, events: [event] };
  }

  private async createErrorEvent(
    client: PoolClient,
    userId: string,
    threadId: string | undefined,
    code: string,
    message: string
  ): Promise<Event> {
    const seq = await this.getNextSeq(client, userId);
    
    const result = await client.query<Event>(
      `INSERT INTO events (user_id, seq, type, thread_id, payload)
       VALUES ($1, $2, 'error', $3, $4)
       RETURNING id, user_id as "userId", seq, type, thread_id as "threadId",
                 payload, ui_payload_id as "uiPayloadId", fallback_text as "fallbackText",
                 created_at as "createdAt"`,
      [userId, seq, threadId, JSON.stringify({ code, message })]
    );

    return result.rows[0];
  }

  private async addToOutbox(
    client: PoolClient,
    userId: string,
    eventId: string
  ): Promise<void> {
    await client.query(
      'INSERT INTO outbox (user_id, event_id) VALUES ($1, $2)',
      [userId, eventId]
    );
  }
}
