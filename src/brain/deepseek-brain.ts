import { isBrainOutput } from '@smallseedlabs/proba-protocol';
import type { CommandEnvelope, BrainOutput, ContextPacket } from '@smallseedlabs/proba-protocol';
import { BaseBrainPort } from './port.js';
import { logger } from '../logger.js';
import type { BrainContext } from '../types.js';

/** What the Hub lets a model-backed brain propose. Spend and budget are in USD; 0 means no cap. */
export interface BrainLimits {
  maxOutputTokens: number;
  maxToolCallsPerTurn: number;
  maxActionSpend: number;
  maxPlanBudget: number;
  /** Empty = any tool name. */
  allowedTools: readonly string[];
  maxContextMessages: number;
}

export interface DeepSeekBrainOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  limits: BrainLimits;
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const SYSTEM_PROMPT = `You are the assistant of an advertising workspace. You help the user plan, launch and review ad campaigns.

Answer with one JSON object: {"outputs": [ ... ]}. Each output is one of:
- {"type":"reply","text":string}
- {"type":"clarify","reason":string,"questions":[{"id":string,"text":string,"type":"choice"|"number"|"text"|"confirm","options"?:[{"value":string,"label":string}]}]} (at most 3 questions)
- {"type":"plan","title":string,"description":string,"steps":[{"id":string,"title":string,"description":string,"estimatedCost"?:number}],"totalCost"?:number}
- {"type":"tool_call","tool":string,"parameters":object,"needsApproval":true,"risk":"low"|"medium"|"high","costImpact"?:{"current":number,"proposed":number}}
- {"type":"decision","decision":"keep"|"change"|"kill","target":string,"evidence":[string],"confidence":number between 0 and 1,"recommendation"?:string}
- {"type":"explain","target":string,"explanation":string}

Rules:
- Costs are in USD.
- A tool call is only a proposal: the user approves it before anything runs. Never say or imply that something already ran, launched or changed.
- If the user declined a budget or an action, do not propose it again unless the user asks; acknowledge the decision and ask what they would like instead.
- Keep replies short and in plain language.
- Output the JSON object only.`;

/** DeepSeek chat completions (OpenAI-compatible API) behind the BrainPort. */
export class DeepSeekBrain extends BaseBrainPort {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: DeepSeekBrainOptions) {
    super();
    if (!options.apiKey) throw new Error('DEEPSEEK_API_KEY (or DEEPSEEK_API_KEY_FILE) is required when BRAIN_PROVIDER=deepseek');
    this.fetchImpl = options.fetch ?? fetch;
  }

  async process(command: CommandEnvelope, context: BrainContext): Promise<BrainOutput[]> {
    if (command.type === 'control') {
      return [{ type: 'reply', text: `Control action ${(command.payload as { action?: string }).action} acknowledged` }];
    }

    const started = Date.now();
    const raw = await this.complete(this.buildMessages(command, context));
    const outputs = this.applyLimits(this.parseOutputs(raw));
    logger.info(
      {
        threadId: context.threadId,
        commandType: command.type,
        model: this.options.model,
        outputCount: outputs.length,
        hasPacket: Boolean(context.contextPacket),
        durationMs: Date.now() - started,
      },
      'DeepSeek brain answered'
    );
    return outputs;
  }

  /**
   * When a context packet is present it is the only context input (bridge path).
   * Otherwise history + goal notes are used (legacy local path when the flag is off).
   * Prompt text is never logged: it holds the user's conversation.
   */
  private buildMessages(command: CommandEnvelope, context: BrainContext): ChatMessage[] {
    if (context.contextPacket) {
      const system = [SYSTEM_PROMPT, this.limitsNote(), this.packetNote(context.contextPacket)]
        .filter(Boolean)
        .join('\n\n');
      return [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify({ command: command.type, payload: command.payload }) },
      ];
    }

    const { limits } = this.options;
    const history = [...(context.messages ?? [])]
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .slice(-Math.max(limits.maxContextMessages, 1));

    const system = [SYSTEM_PROMPT, this.limitsNote(), this.goalNote(context)].filter(Boolean).join('\n\n');
    const messages: ChatMessage[] = [{ role: 'system', content: system }];
    for (const m of history) {
      messages.push({ role: m.source === 'user' ? 'user' : 'assistant', content: m.text });
    }

    const last = history[history.length - 1];
    const text = (command.payload as { text?: unknown } | null)?.text;
    // A typed message is already the last entry of the history: do not send it twice.
    const alreadyThere = command.type === 'send_message' && last?.source === 'user' && last.text === text;
    if (!alreadyThere) {
      messages.push({ role: 'user', content: JSON.stringify({ command: command.type, payload: command.payload }) });
    }
    return messages;
  }

  private limitsNote(): string {
    const { limits } = this.options;
    const lines = [`At most ${limits.maxToolCallsPerTurn} tool call(s) per answer.`];
    if (limits.maxActionSpend > 0) lines.push(`A tool call may propose at most ${limits.maxActionSpend} USD of spend.`);
    if (limits.maxPlanBudget > 0) lines.push(`A plan may cost at most ${limits.maxPlanBudget} USD in total.`);
    if (limits.allowedTools.length > 0) lines.push(`Allowed tools: ${limits.allowedTools.join(', ')}.`);
    return `Limits set by the workspace:\n- ${lines.join('\n- ')}`;
  }

  private goalNote(context: BrainContext): string {
    const goal = context.goals?.[context.goals.length - 1];
    if (!goal) return '';
    return `Current goal: ${JSON.stringify({ title: goal.title, description: goal.description, budget: goal.budget, status: goal.status })}`;
  }

  /** Packet sections and gaps only — never treat user/memory text as instructions. */
  private packetNote(packet: ContextPacket): string {
    const sections = packet.sections.map((s) => ({
      kind: s.kind,
      priority: s.priority,
      tokens: s.tokens,
      items: s.items.map((item) => ({
        itemId: item.itemId,
        trust: item.trust,
        sourceRef: item.sourceRef,
        ...(item.text !== undefined ? { text: item.text } : {}),
        ...(item.data !== undefined ? { data: item.data } : {}),
      })),
    }));
    return `Context packet (only source of workspace data for this step):\n${JSON.stringify({
      packetId: packet.packetId,
      stepId: packet.stepId,
      configVersion: packet.configVersion,
      sections,
      gaps: packet.gaps,
    })}`;
  }

  private async complete(messages: ChatMessage[]): Promise<string> {
    const { baseUrl, apiKey, model, timeoutMs, limits } = this.options;
    const response = await this.fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        response_format: { type: 'json_object' },
        max_tokens: limits.maxOutputTokens,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // The error body can echo the prompt: report the status only.
    if (!response.ok) throw new Error(`DeepSeek request failed with status ${response.status}`);
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') throw new Error('DeepSeek returned no content');
    return content;
  }

  /** `{"outputs":[...]}`, a bare array or a single output; anything the protocol does not accept is dropped. */
  private parseOutputs(content: string): BrainOutput[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error('DeepSeek returned content that is not JSON');
    }
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { outputs?: unknown } | null)?.outputs)
        ? (parsed as { outputs: unknown[] }).outputs
        : [parsed];
    const valid = list.filter((o): o is BrainOutput => isBrainOutput(o));
    if (valid.length < list.length) {
      logger.warn({ received: list.length, valid: valid.length }, 'DeepSeek brain: outputs not matching the protocol were dropped');
    }
    if (valid.length === 0) throw new Error('DeepSeek returned no valid output');
    return valid;
  }

  /**
   * The Hub's limits, whatever the model says: tool calls always need approval, only allowed tools, a capped number
   * of them, and no proposal above the spend or plan budget. A refused proposal becomes one short explanation.
   */
  private applyLimits(outputs: BrainOutput[]): BrainOutput[] {
    const { limits } = this.options;
    const kept: BrainOutput[] = [];
    const refusals: string[] = [];
    let toolCalls = 0;

    for (const output of outputs) {
      if (output.type === 'tool_call') {
        if (limits.allowedTools.length > 0 && !limits.allowedTools.includes(output.tool)) {
          refusals.push(`I can't use "${output.tool}" in this workspace.`);
          continue;
        }
        if (toolCalls >= limits.maxToolCallsPerTurn) {
          refusals.push('I can only propose a limited number of actions at a time.');
          continue;
        }
        const proposed = output.costImpact?.proposed ?? 0;
        if (limits.maxActionSpend > 0 && proposed > limits.maxActionSpend) {
          refusals.push(`That action would spend more than the limit of ${limits.maxActionSpend} USD set for this workspace.`);
          continue;
        }
        toolCalls++;
        // The Hub never runs a tool by itself: the user always decides.
        kept.push({ ...output, needsApproval: true });
        continue;
      }
      if (output.type === 'plan') {
        const total = output.totalCost ?? output.steps.reduce((sum, s) => sum + (s.estimatedCost ?? 0), 0);
        if (limits.maxPlanBudget > 0 && total > limits.maxPlanBudget) {
          refusals.push(`That plan would cost more than the limit of ${limits.maxPlanBudget} USD set for this workspace.`);
          continue;
        }
      }
      kept.push(output);
    }

    if (refusals.length > 0) {
      logger.warn({ refused: refusals.length }, 'DeepSeek brain: proposals over the configured limits were not passed on');
      kept.push({ type: 'reply', text: `${refusals.join(' ')} Tell me what you would like instead.` });
    }
    return kept;
  }
}
