import type { Logger } from "../logging.js";
import type { SecretStore } from "../secrets/store.js";
import { secretNames } from "../secrets/store.js";
import type { AgentAdapter, DeliveryOptions, DeliveryResult } from "./types.js";
import { PermanentError, UnreachableError } from "./types.js";

export interface GrokBotCredentials {
  webhookUrl: string;
  senderKey: string;
}

export interface GrokBotAdapterConfig {
  lookupAgent: (threadId: string) => GrokBotCredentials | null;
  /** Specialist used by startThread. If unset, startThread is a PermanentError. */
  defaultAgentId?: string | undefined;
  /** Cheap probe: true when at least one specialist has both URL and sender key. */
  hasConfiguredAgent: () => boolean;
  fetch?: typeof fetch;
  /** HTTP accept timeout — we do not wait for the specialist to finish. */
  timeoutMs?: number | undefined;
}

export const GROK_BOT_WAKE_TIMEOUT_MS = 15_000;

/**
 * Fire-and-forget sink: POST the rendered wake to a Grok Bot routine webhook
 * (one URL + sender key per specialist). `threadId` is the specialist id,
 * not a Codex session. The HTTP round-trip only waits for the webhook to
 * accept; it does not wait for the agent to finish the turn.
 *
 * Replies do not come back through this adapter. Slack replies are posted by
 * the specialist curling the daemon's loopback POST /api/slack/post.
 */
export class GrokBotAdapter implements AgentAdapter {
  readonly name = "grok-bot";

  constructor(
    private readonly logger: Logger,
    private readonly config: GrokBotAdapterConfig,
  ) {}

  async deliverToThread(
    threadId: string,
    prompt: string,
    _opts: DeliveryOptions,
  ): Promise<DeliveryResult> {
    const agent = this.config.lookupAgent(threadId);
    if (!agent) {
      throw new PermanentError(
        `unknown grok-bot specialist "${threadId}" — store its webhook with: wakewire auth grok-bot --thread ${threadId}`,
      );
    }
    await this.postWake(threadId, agent, prompt);
    return { threadId };
  }

  async startThread(prompt: string, opts: DeliveryOptions): Promise<DeliveryResult> {
    const id = this.config.defaultAgentId;
    if (!id) {
      throw new PermanentError(
        "grok-bot adapter cannot start a new thread — route to a named specialist (target.type=thread, threadId=<specialist id>) whose webhook is stored via wakewire auth grok-bot. Optionally set sink.grokBotDefaultAgent to allow new-thread routes.",
      );
    }
    return this.deliverToThread(id, prompt, opts);
  }

  async probe(): Promise<boolean> {
    return this.config.hasConfiguredAgent();
  }

  private async postWake(
    threadId: string,
    agent: GrokBotCredentials,
    prompt: string,
  ): Promise<void> {
    const fetchImpl = this.config.fetch ?? fetch;
    const timeoutMs = this.config.timeoutMs ?? GROK_BOT_WAKE_TIMEOUT_MS;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(agent.webhookUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${agent.senderKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ context: wrapGrokBotWake(prompt) }),
        signal: ac.signal,
      });
    } catch (err) {
      throw toUnreachable(err);
    } finally {
      clearTimeout(timer);
    }

    if (response.ok) {
      this.logger.info({ threadId, status: response.status }, "grok-bot wake accepted");
      return;
    }

    const status = response.status;
    // Drain the body so the socket can close, but never log it (may echo secrets).
    await response.text().catch(() => "");
    if (status === 401 || status === 403 || status === 404) {
      throw new PermanentError(
        `grok-bot webhook rejected specialist "${threadId}" (HTTP ${status})`,
      );
    }
    throw new UnreachableError(`grok-bot webhook HTTP ${status} for specialist "${threadId}"`);
  }
}

/**
 * Trusted prefix telling the specialist how to reply without embedding the
 * Slack bot token or a public reply URL in the wake.
 */
export function wrapGrokBotWake(prompt: string): string {
  return [
    "[wakewire grok-bot] Fire-and-forget wake — posting this webhook is delivery. Do not wait in this chat for a human.",
    "",
    "HOW TO REPLY (trusted adapter instructions):",
    "When the event is Slack, post the reply from a Shell on this Mac. The Slack bot token never leaves the WakeWire daemon — it is not in this wake, and there is no public reply URL or smee channel for Slack.",
    "1. Read ~/.wakewire/daemon.json for `port` and `token` (do not log the token). If WAKEWIRE_HOME is set, read $WAKEWIRE_HOME/daemon.json instead.",
    "2. POST http://127.0.0.1:<port>/api/slack/post with header Authorization: Bearer <token>",
    '   JSON body: { "sourceId": <event.sourceId>, "channel": <event.channel>, "text": <your reply>, "thread_ts": <event.threadTs or event.ts> }',
    "3. Prefer threadTs so the reply stays in the Slack thread. Never reply as @Cursor. If the event is not Slack, do not call /api/slack/post.",
    "",
    prompt,
  ].join("\n");
}

function toUnreachable(err: unknown): UnreachableError {
  if (err instanceof UnreachableError) return err;
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);
  if (name === "AbortError" || /aborted/i.test(message)) {
    return new UnreachableError("grok-bot webhook timed out");
  }
  return new UnreachableError(`grok-bot webhook unreachable: ${message}`);
}

export function lookupGrokBotAgent(
  secrets: SecretStore,
  threadId: string,
): GrokBotCredentials | null {
  const webhookUrl = secrets.get(secretNames.grokBotWebhookUrl(threadId));
  const senderKey = secrets.get(secretNames.grokBotSenderKey(threadId));
  if (!webhookUrl || !senderKey) return null;
  return { webhookUrl, senderKey };
}

export function grokBotAgentIds(secrets: SecretStore): string[] {
  const raw = secrets.get(secretNames.grokBotAgents);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

export function rememberGrokBotAgent(secrets: SecretStore, threadId: string): void {
  const ids = grokBotAgentIds(secrets);
  if (!ids.includes(threadId)) ids.push(threadId);
  secrets.set(secretNames.grokBotAgents, JSON.stringify(ids));
}

export function hasConfiguredGrokBotAgent(secrets: SecretStore): boolean {
  const ids = grokBotAgentIds(secrets);
  if (ids.some((id) => lookupGrokBotAgent(secrets, id) !== null)) return true;
  return false;
}
