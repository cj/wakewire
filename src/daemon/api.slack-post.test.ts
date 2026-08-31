import pino from "pino";
import { describe, expect, it } from "vitest";
import type { DaemonConfig } from "../config.js";
import { DeliveryQueue } from "../core/queue.js";
import { openDatabase } from "../db/db.js";
import { createStores } from "../db/repos.js";
import type { SecretStore } from "../secrets/store.js";
import { secretNames } from "../secrets/store.js";
import type { AgentAdapter } from "../sinks/types.js";
import { createApi, type SlackPoster } from "./api.js";
import { SourceManager } from "./sources.js";

const logger = pino({ level: "silent" });
const TOKEN = "test-daemon-token";

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

function fakeAdapter(): AgentAdapter {
  return {
    name: "fake",
    deliverToThread: async (threadId) => ({ threadId }),
    startThread: async () => ({ threadId: "new" }),
    probe: async () => true,
  };
}

function testConfig(): DaemonConfig {
  return {
    adapter: "codex-app-server",
    codexPath: undefined,
    model: undefined,
    appServerConnection: "auto",
    appServerListen: undefined,
    ratePerMinute: 10,
    apiPort: 0,
    apiToken: TOKEN,
    grokBotDefaultAgent: undefined,
  };
}

function makeApp(opts: { slackPoster?: SlackPoster; secrets?: MemorySecrets } = {}) {
  const stores = createStores(openDatabase(":memory:"));
  const secrets = opts.secrets ?? new MemorySecrets();
  const adapter = fakeAdapter();
  const queue = new DeliveryQueue(stores, adapter, logger, { autoWake: false });
  const sources = new SourceManager(stores, secrets, logger, () => {});
  const app = createApi({
    stores,
    queue,
    sources,
    secrets,
    adapter,
    config: testConfig(),
    logger,
    startedAt: "2026-08-31T00:00:00.000Z",
    ...(opts.slackPoster ? { slackPoster: opts.slackPoster } : {}),
  });
  return { app, stores, secrets };
}

describe("POST /api/slack/post", () => {
  it("rejects missing bearer", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/slack/post", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId: "slack-default", channel: "C1", text: "hi" }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects a wrong bearer", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/slack/post", {
      method: "POST",
      headers: {
        authorization: "Bearer wrong-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ sourceId: "slack-default", channel: "C1", text: "hi" }),
    });
    expect(res.status).toBe(401);
  });

  it("posts via the Slack helper when authorized", async () => {
    const posts: unknown[] = [];
    const slackPoster: SlackPoster = async (input) => {
      posts.push(input);
      return { channel: input.channel, ts: "9.001" };
    };
    const { app, stores, secrets } = makeApp({ slackPoster });
    stores.sources.upsert({
      id: "slack-default",
      kind: "slack",
      config: { team: "default" },
    });
    secrets.set(secretNames.slackBotToken("slack-default"), "xoxb-test");

    const res = await app.request("/api/slack/post", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sourceId: "slack-default",
        channel: "C456",
        text: "shipped",
        thread_ts: "1.234",
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, channel: "C456", ts: "9.001" });
    expect(posts).toEqual([
      {
        botToken: "xoxb-test",
        channel: "C456",
        text: "shipped",
        threadTs: "1.234",
      },
    ]);
  });

  it("400s when the slack source has no bot token", async () => {
    const { app, stores } = makeApp({
      slackPoster: async () => ({ channel: "C", ts: "1" }),
    });
    stores.sources.upsert({
      id: "slack-default",
      kind: "slack",
      config: { team: "default" },
    });
    const res = await app.request("/api/slack/post", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sourceId: "slack-default", channel: "C1", text: "hi" }),
    });
    expect(res.status).toBe(400);
  });

  it("404s an unknown or non-slack source", async () => {
    const { app, stores } = makeApp({
      slackPoster: async () => ({ channel: "C", ts: "1" }),
    });
    stores.sources.upsert({ id: "github-acme", kind: "github", config: {} });
    const missing = await app.request("/api/slack/post", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sourceId: "nope", channel: "C1", text: "hi" }),
    });
    expect(missing.status).toBe(404);
    const wrongKind = await app.request("/api/slack/post", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sourceId: "github-acme", channel: "C1", text: "hi" }),
    });
    expect(wrongKind.status).toBe(404);
  });
});
