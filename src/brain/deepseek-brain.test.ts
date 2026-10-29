import { describe, it, expect } from 'vitest';
import type { PoolClient } from 'pg';
import type { CommandEnvelope } from '@smallseedlabs/proba-protocol';
import { DeepSeekBrain, type BrainLimits, type DeepSeekBrainOptions } from './deepseek-brain.js';
import type { BrainContext } from '../types.js';

const limits: BrainLimits = {
  maxOutputTokens: 800,
  maxToolCallsPerTurn: 1,
  maxActionSpend: 200,
  maxPlanBudget: 1000,
  allowedTools: ['adjust_budget'],
  maxContextMessages: 3,
};

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: { model: string; max_tokens: number; response_format: unknown; messages: Array<{ role: string; content: string }> };
}

/** A fetch that records the request and answers with `content` as the model's message. */
function fakeFetch(content: unknown, status = 200) {
  const captured: Captured[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    captured.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
    return new Response(JSON.stringify({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }), { status });
  }) as unknown as typeof fetch;
  return { impl, captured };
}

function brain(content: unknown, overrides: Partial<DeepSeekBrainOptions> = {}, status = 200) {
  const { impl, captured } = fakeFetch(content, status);
  return {
    captured,
    brain: new DeepSeekBrain({
      apiKey: 'sk-key', baseUrl: 'https://llm.example/v1', model: 'deepseek-chat', timeoutMs: 1000, limits, fetch: impl, ...overrides,
    }),
  };
}

const command = (type: CommandEnvelope['type'], payload: unknown): CommandEnvelope => ({
  kind: 'command', clientMsgId: 'c1', type, threadId: 't1', payload, sentAt: new Date().toISOString(),
});

const context = (messages: BrainContext['messages'] = []): BrainContext => ({
  userId: 'u1', threadId: 't1', messages, goals: [], client: {} as PoolClient,
});


const message = (text: string, source: string, minute: number) => ({
  id: `m${minute}`, threadId: 't1', text, source, createdAt: new Date(2026, 0, 1, 0, minute),
});

const tool = (proposed: number, name = 'adjust_budget') => ({
  type: 'tool_call', tool: name, parameters: { dailyBudget: proposed }, needsApproval: false, risk: 'medium', costImpact: { current: 100, proposed },
});

describe('DeepSeekBrain', () => {
  it('requires an API key', () => {
    expect(() => new DeepSeekBrain({ apiKey: '', baseUrl: 'x', model: 'm', timeoutMs: 1, limits })).toThrow(/DEEPSEEK_API_KEY/);
  });

  it('calls the chat completions endpoint with the configured model, key, token cap and JSON mode', async () => {
    const { brain: b, captured } = brain({ outputs: [{ type: 'reply', text: 'Hi' }] });
    const out = await b.process(command('send_message', { text: 'hello' }), context());
    expect(out).toEqual([{ type: 'reply', text: 'Hi' }]);
    expect(captured[0].url).toBe('https://llm.example/v1/chat/completions');
    expect(captured[0].headers.authorization).toBe('Bearer sk-key');
    expect(captured[0].body).toMatchObject({ model: 'deepseek-chat', max_tokens: 800, response_format: { type: 'json_object' } });
  });

  it('sends history oldest first (capped), maps sources to roles, and does not repeat the typed message', async () => {
    const { brain: b, captured } = brain({ outputs: [{ type: 'reply', text: 'ok' }] });
    // Newest first, as the Hub loads them; maxContextMessages is 3.
    const history = [message('latest', 'user', 4), message('answer', 'brain', 3), message('question', 'user', 2), message('too old', 'user', 1)];
    await b.process(command('send_message', { text: 'latest' }), context(history));
    const sent = captured[0].body.messages;
    expect(sent.map((m) => [m.role, m.content])).toEqual([
      ['system', expect.any(String)],
      ['user', 'question'],
      ['assistant', 'answer'],
      ['user', 'latest'],
    ]);
  });

  it('describes other commands to the model', async () => {
    const { brain: b, captured } = brain({ outputs: [{ type: 'reply', text: 'ok' }] });
    await b.process(command('answer_ask', { askId: 'a1', choice: 'reject' }), context());
    const last = captured[0].body.messages.at(-1)!;
    expect(last.role).toBe('user');
    expect(JSON.parse(last.content)).toEqual({ command: 'answer_ask', payload: { askId: 'a1', choice: 'reject' } });
  });

  it('states the configured limits in the system prompt', async () => {
    const { brain: b, captured } = brain({ outputs: [{ type: 'reply', text: 'ok' }] });
    await b.process(command('send_message', { text: 'x' }), context());
    const system = captured[0].body.messages[0].content;
    expect(system).toContain('At most 1 tool call');
    expect(system).toContain('at most 200 USD');
    expect(system).toContain('at most 1000 USD');
    expect(system).toContain('Allowed tools: adjust_budget');
  });

  it('accepts a bare array or a single output as well as {outputs}', async () => {
    expect(await brain([{ type: 'reply', text: 'a' }]).brain.process(command('send_message', { text: 'x' }), context())).toHaveLength(1);
    expect(await brain({ type: 'reply', text: 'a' }).brain.process(command('send_message', { text: 'x' }), context())).toHaveLength(1);
  });

  it('drops outputs the protocol does not accept, and fails when none is valid', async () => {
    const mixed = brain({ outputs: [{ type: 'nonsense' }, { type: 'reply', text: 'kept' }] });
    expect(await mixed.brain.process(command('send_message', { text: 'x' }), context())).toEqual([{ type: 'reply', text: 'kept' }]);
    await expect(brain({ outputs: [{ type: 'nonsense' }] }).brain.process(command('send_message', { text: 'x' }), context())).rejects.toThrow(/no valid output/);
  });

  it('fails on non-JSON content, empty content and HTTP errors without leaking the response body', async () => {
    await expect(brain('not json').brain.process(command('send_message', { text: 'x' }), context())).rejects.toThrow(/not JSON/);
    await expect(brain('').brain.process(command('send_message', { text: 'x' }), context())).rejects.toThrow(/no content/);
    const failing = brain('secret prompt echo', {}, 500);
    const error = await failing.brain.process(command('send_message', { text: 'x' }), context()).catch((e: Error) => e);
    expect((error as Error).message).toBe('DeepSeek request failed with status 500');
    expect((error as Error).message).not.toContain('secret');
  });

  it('answers control commands without calling the model', async () => {
    const { brain: b, captured } = brain({ outputs: [] });
    expect(await b.process(command('control', { action: 'pause' }), context())).toEqual([
      { type: 'reply', text: 'Control action pause acknowledged' },
    ]);
    expect(captured).toHaveLength(0);
  });

  describe('limits', () => {
    it('always asks for approval, whatever the model says', async () => {
      const [out] = await brain({ outputs: [tool(150)] }).brain.process(command('send_message', { text: 'x' }), context());
      expect(out).toMatchObject({ type: 'tool_call', needsApproval: true });
    });

    it('refuses a tool call above the spend limit and says why', async () => {
      const out = await brain({ outputs: [tool(500)] }).brain.process(command('send_message', { text: 'x' }), context());
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ type: 'reply' });
      expect((out[0] as { text: string }).text).toContain('limit of 200 USD');
    });

    it('refuses tools that are not allowed and tool calls beyond the per-answer cap', async () => {
      const notAllowed = await brain({ outputs: [tool(10, 'delete_campaign')] }).brain.process(command('send_message', { text: 'x' }), context());
      expect(notAllowed.map((o) => o.type)).toEqual(['reply']);
      expect((notAllowed[0] as { text: string }).text).toContain('"delete_campaign"');

      const capped = await brain({ outputs: [tool(10), tool(20)] }).brain.process(command('send_message', { text: 'x' }), context());
      expect(capped.map((o) => o.type)).toEqual(['tool_call', 'reply']);
    });

    it('allows any tool name when no allowlist is configured, and no cap when the limit is 0', async () => {
      const open = brain({ outputs: [tool(99999, 'anything')] }, { limits: { ...limits, allowedTools: [], maxActionSpend: 0 } });
      const [out] = await open.brain.process(command('send_message', { text: 'x' }), context());
      expect(out).toMatchObject({ type: 'tool_call', tool: 'anything' });
    });

    it('refuses a plan above the plan budget (totalCost, or the sum of its steps)', async () => {
      const plan = (extra: object) => ({
        type: 'plan', title: 'Plan', description: 'd',
        steps: [{ id: 's1', title: 'a', description: 'a', estimatedCost: 700 }, { id: 's2', title: 'b', description: 'b', estimatedCost: 700 }],
        ...extra,
      });
      for (const extra of [{ totalCost: 1400 }, {}]) {
        const out = await brain({ outputs: [plan(extra)] }).brain.process(command('send_message', { text: 'x' }), context());
        expect(out.map((o) => o.type)).toEqual(['reply']);
      }
      const ok = await brain({ outputs: [plan({ totalCost: 900 })] }).brain.process(command('send_message', { text: 'x' }), context());
      expect(ok.map((o) => o.type)).toEqual(['plan']);
    });
  });
});
