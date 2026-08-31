import readline from "node:readline/promises";
import { settingKeys } from "../config.js";
import { openDatabase } from "../db/db.js";
import { createStores } from "../db/repos.js";
import type { Logger } from "../logging.js";
import { createSecretStore, secretNames } from "../secrets/store.js";
import { rememberGrokBotAgent } from "../sinks/grok-bot.js";
import { promptHidden } from "./prompt.js";

/**
 * Store a Grok Bot routine webhook URL + sender key for one specialist.
 * `thread` is the route target.threadId that maps to that specialist.
 * Values go in the secret store and are never logged.
 */
export async function authGrokBot(
  logger: Logger,
  opts: {
    thread?: string;
    webhookUrl?: string;
    senderKey?: string;
    asDefault?: boolean;
  },
): Promise<void> {
  const threadId = opts.thread?.trim();
  if (!threadId) {
    console.error(
      "Pass --thread <specialist-id> (the route target.threadId that maps to this Grok Bot agent).",
    );
    process.exitCode = 1;
    return;
  }

  const webhookUrl = opts.webhookUrl ?? (await promptVisible("Grok Bot routine webhook URL: "));
  if (!isHttpUrl(webhookUrl)) {
    console.error("webhook URL must be an https URL");
    process.exitCode = 1;
    return;
  }
  const senderKey = opts.senderKey ?? (await promptHidden("Sender key (Bearer token): "));
  if (!senderKey) {
    console.error("no sender key provided");
    process.exitCode = 1;
    return;
  }

  const secrets = await createSecretStore(logger);
  secrets.set(secretNames.grokBotWebhookUrl(threadId), webhookUrl);
  secrets.set(secretNames.grokBotSenderKey(threadId), senderKey);
  rememberGrokBotAgent(secrets, threadId);

  if (opts.asDefault) {
    const db = openDatabase();
    createStores(db).settings.set(settingKeys.grokBotDefaultAgent, threadId);
    db.close();
  }

  console.log(
    `Stored grok-bot webhook for specialist ${threadId} (${secrets.backend})${opts.asDefault ? " and set it as sink.grokBotDefaultAgent" : ""}.`,
  );
  console.log(
    "The sender key is not printed. Restart the daemon if you changed sink.adapter or sink.grokBotDefaultAgent.",
  );
}

async function promptVisible(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}
