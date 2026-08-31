import { describe, expect, it } from "vitest";
import { postSlackMessage, type SlackChatClient, SlackPostError } from "./post.js";

function mockClient(impl: SlackChatClient["chat"]["postMessage"]): SlackChatClient {
  return { chat: { postMessage: impl } };
}

describe("postSlackMessage", () => {
  it("calls chat.postMessage with channel, text, and optional thread_ts", async () => {
    const calls: unknown[] = [];
    const client = mockClient(async (args) => {
      calls.push(args);
      return { ok: true, channel: args.channel, ts: "1751551200.000200" };
    });
    const result = await postSlackMessage(
      {
        botToken: "xoxb-test-not-used",
        channel: "C123",
        text: "hello from the specialist",
        threadTs: "1751551200.000100",
      },
      client,
    );
    expect(result).toEqual({ channel: "C123", ts: "1751551200.000200" });
    expect(calls).toEqual([
      { channel: "C123", text: "hello from the specialist", thread_ts: "1751551200.000100" },
    ]);
  });

  it("omits thread_ts when not provided", async () => {
    const calls: unknown[] = [];
    const client = mockClient(async (args) => {
      calls.push(args);
      return { ok: true, ts: "1.0", channel: "C1" };
    });
    await postSlackMessage({ botToken: "xoxb-x", channel: "C1", text: "hi" }, client);
    expect(calls).toEqual([{ channel: "C1", text: "hi" }]);
  });

  it("throws SlackPostError when Slack rejects the post", async () => {
    const client = mockClient(async () => ({ ok: false, error: "channel_not_found" }));
    await expect(
      postSlackMessage({ botToken: "xoxb-x", channel: "Cbad", text: "hi" }, client),
    ).rejects.toBeInstanceOf(SlackPostError);
  });
});
