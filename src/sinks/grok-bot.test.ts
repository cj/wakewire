import pino from "pino";
import { describe, expect, it } from "vitest";
import type { SecretStore } from "../secrets/store.js";
import { secretNames } from "../secrets/store.js";
import {
  GrokBotAdapter,
  hasConfiguredGrokBotAgent,
  lookupGrokBotAgent,
  rememberGrokBotAgent,
  wrapGrokBotWake,
} from "./grok-bot.js";
import { PermanentError, UnreachableError } from "./types.js";

const logger = pino({ level: "silent" });
const opts = { sandbox: "read-only" as const };

class MemorySecrets implements SecretStore {
  readonly backend = "file" as const;
  private readonly data = new Map<string, string>();
  get(name: string): string | null {
    return this.data.get(name) ?? null;
  }
  set(name: string, value: string): void {
    this.data.set(name, value);
  }
  delete(name: string): void {
    this.data.delete(name);
  }
}

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GrokBotAdapter", () => {
  it("POSTs the wake with Bearer sender key and resolves on 2xx without waiting for the agent", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const adapter = new GrokBotAdapter(logger, {
      lookupAgent: (id) =>
        id === "oncall"
          ? {
              webhookUrl: "https://api2.cursor.sh/automations/webhook/abc",
              senderKey: "crsr_secret",
            }
          : null,
      hasConfiguredAgent: () => true,
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return jsonResponse(202, { ok: true });
      },
    });

    const result = await adapter.deliverToThread("oncall", "hello specialist", opts);
    expect(result).toEqual({ threadId: "oncall" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api2.cursor.sh/automations/webhook/abc");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.redirect).toBe("error");
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer crsr_secret");
    expect(headers.get("content-type")).toBe("application/json");
    const body = JSON.parse(String(calls[0]?.init.body)) as { context: string };
    expect(body.context).toContain("hello specialist");
    expect(body.context).toContain("/api/slack/post");
    expect(body.context).toContain("~/.wakewire/daemon.json");
    expect(body.context).not.toMatch(/xoxb-/);
    expect(body.context).not.toContain("smee.io");
    expect(body.context).not.toContain("crsr_secret");
  });

  it("throws PermanentError for a non-https webhook and does not fetch", async () => {
    const calls: unknown[] = [];
    const adapter = new GrokBotAdapter(logger, {
      lookupAgent: () => ({
        webhookUrl: "http://evil.test/hook",
        senderKey: "crsr_secret",
      }),
      hasConfiguredAgent: () => true,
      fetch: async () => {
        calls.push("fetched");
        throw new Error("should not fetch");
      },
    });
    await expect(adapter.deliverToThread("oncall", "hi", opts)).rejects.toBeInstanceOf(
      PermanentError,
    );
    expect(calls).toEqual([]);
  });

  it("throws PermanentError for an unknown specialist", async () => {
    const adapter = new GrokBotAdapter(logger, {
      lookupAgent: () => null,
      hasConfiguredAgent: () => false,
      fetch: async () => {
        throw new Error("should not fetch");
      },
    });
    await expect(adapter.deliverToThread("missing", "hi", opts)).rejects.toBeInstanceOf(
      PermanentError,
    );
  });

  it("throws PermanentError when the webhook rejects the specialist", async () => {
    const adapter = new GrokBotAdapter(logger, {
      lookupAgent: () => ({ webhookUrl: "https://example.test/hook", senderKey: "k" }),
      hasConfiguredAgent: () => true,
      fetch: async () => jsonResponse(404, { error: "nope" }),
    });
    await expect(adapter.deliverToThread("oncall", "hi", opts)).rejects.toBeInstanceOf(
      PermanentError,
    );
  });

  it("throws UnreachableError on transport failure or 5xx", async () => {
    const down = new GrokBotAdapter(logger, {
      lookupAgent: () => ({ webhookUrl: "https://example.test/hook", senderKey: "k" }),
      hasConfiguredAgent: () => true,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(down.deliverToThread("oncall", "hi", opts)).rejects.toBeInstanceOf(
      UnreachableError,
    );

    const five = new GrokBotAdapter(logger, {
      lookupAgent: () => ({ webhookUrl: "https://example.test/hook", senderKey: "k" }),
      hasConfiguredAgent: () => true,
      fetch: async () => jsonResponse(503),
    });
    await expect(five.deliverToThread("oncall", "hi", opts)).rejects.toBeInstanceOf(
      UnreachableError,
    );
  });

  it("startThread is PermanentError unless a default specialist is configured", async () => {
    const none = new GrokBotAdapter(logger, {
      lookupAgent: () => null,
      hasConfiguredAgent: () => false,
    });
    await expect(none.startThread("hi", opts)).rejects.toBeInstanceOf(PermanentError);

    const calls: string[] = [];
    const withDefault = new GrokBotAdapter(logger, {
      defaultAgentId: "triage",
      lookupAgent: (id) => {
        calls.push(id);
        return { webhookUrl: "https://example.test/hook", senderKey: "k" };
      },
      hasConfiguredAgent: () => true,
      fetch: async () => jsonResponse(200),
    });
    const result = await withDefault.startThread("hi", opts);
    expect(result.threadId).toBe("triage");
    expect(calls).toEqual(["triage"]);
  });

  it("probe reflects whether a specialist webhook+key exist", async () => {
    const empty = new GrokBotAdapter(logger, {
      lookupAgent: () => null,
      hasConfiguredAgent: () => false,
    });
    expect(await empty.probe()).toBe(false);
    const ready = new GrokBotAdapter(logger, {
      lookupAgent: () => ({ webhookUrl: "https://example.test/hook", senderKey: "k" }),
      hasConfiguredAgent: () => true,
    });
    expect(await ready.probe()).toBe(true);
  });
});

describe("wrapGrokBotWake", () => {
  it("tells the specialist to post via localhost and never embeds tokens or reply-smee", () => {
    const wrapped = wrapGrokBotWake("EVENT BODY");
    expect(wrapped).toContain("EVENT BODY");
    expect(wrapped).toContain("127.0.0.1");
    expect(wrapped).toContain("/api/slack/post");
    expect(wrapped).toContain("sourceId");
    expect(wrapped).toContain("thread_ts");
    expect(wrapped).toContain("Never reply as @Cursor");
    expect(wrapped).not.toMatch(/xoxb-/);
    expect(wrapped).not.toContain("/ingress/slack-reply");
    expect(wrapped).not.toContain("smee.io");
  });
});

describe("secret-store helpers", () => {
  it("round-trips specialist credentials without exposing them via the index", () => {
    const secrets = new MemorySecrets();
    expect(hasConfiguredGrokBotAgent(secrets)).toBe(false);
    secrets.set(secretNames.grokBotWebhookUrl("oncall"), "https://example.test/hook");
    secrets.set(secretNames.grokBotSenderKey("oncall"), "crsr_secret");
    rememberGrokBotAgent(secrets, "oncall");
    expect(hasConfiguredGrokBotAgent(secrets)).toBe(true);
    expect(lookupGrokBotAgent(secrets, "oncall")).toEqual({
      webhookUrl: "https://example.test/hook",
      senderKey: "crsr_secret",
    });
    expect(secrets.get(secretNames.grokBotAgents)).toBe('["oncall"]');
  });
});
