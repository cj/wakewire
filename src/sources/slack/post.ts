import { WebClient } from "@slack/web-api";

export interface SlackPostInput {
  botToken: string;
  channel: string;
  text: string;
  threadTs?: string | undefined;
}

export interface SlackPostResult {
  channel: string;
  ts: string;
}

export interface SlackChatClient {
  chat: {
    postMessage: (args: {
      channel: string;
      text: string;
      thread_ts?: string;
    }) => Promise<{ ok?: boolean; channel?: string; ts?: string; error?: string }>;
  };
}

export class SlackPostError extends Error {}

/**
 * Post a message with the workspace bot token. Used by the loopback
 * POST /api/slack/post path so the token never leaves the Mac.
 */
export async function postSlackMessage(
  input: SlackPostInput,
  client?: SlackChatClient,
): Promise<SlackPostResult> {
  const web: SlackChatClient = client ?? new WebClient(input.botToken);
  const args: { channel: string; text: string; thread_ts?: string } = {
    channel: input.channel,
    text: input.text,
  };
  if (input.threadTs) args.thread_ts = input.threadTs;
  let response: { ok?: boolean; channel?: string; ts?: string; error?: string };
  try {
    response = await web.chat.postMessage(args);
  } catch (err) {
    throw new SlackPostError(
      `slack chat.postMessage failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!response.ok || !response.ts) {
    throw new SlackPostError(
      `slack chat.postMessage rejected: ${response.error ?? "unknown error"}`,
    );
  }
  return { channel: response.channel ?? input.channel, ts: response.ts };
}
