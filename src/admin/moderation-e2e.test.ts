import assert from "node:assert/strict";
import test from "node:test";
import { ChatType, RuleAction, RuleType } from "@prisma/client";
import { loadConfig } from "../lib/config.js";
import { prisma } from "../lib/prisma.js";
import { recordModerationEvent } from "../moderation/moderation-event.service.js";
import { createServer } from "../server.js";

test("admin moderation rules and Telegram events share the same data path", async (t) => {
  const config = loadConfig();
  const app = await createServer(config);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const chat = await prisma.chat.create({
    data: {
      telegramChatId: -(BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))),
      type: ChatType.SUPERGROUP,
      title: `Moderation integration ${suffix}`
    }
  });

  t.after(async () => {
    await prisma.chat.deleteMany({ where: { id: chat.id } });
    await app.close();
  });

  const login = await app.inject({
    method: "POST",
    url: "/api/admin/auth/login",
    payload: { username: config.adminUsername, password: config.adminPassword }
  });
  assert.equal(login.statusCode, 200);
  const token = login.json().token as string;
  const authorization = { authorization: `Bearer ${token}` };

  const created = await app.inject({
    method: "POST",
    url: "/api/admin/moderation-rules",
    headers: authorization,
    payload: {
      chatId: chat.id,
      ruleType: RuleType.SPAM,
      pattern: `integration-pattern-${suffix}`,
      action: RuleAction.BAN_USER,
      enabled: true
    }
  });
  assert.equal(created.statusCode, 200);

  const storedRule = await prisma.moderationRule.findUnique({
    where: { id: created.json().id as string }
  });
  assert.equal(storedRule?.chatId, chat.id);
  assert.equal(storedRule?.ruleType, RuleType.SPAM);
  assert.equal(storedRule?.action, RuleAction.BAN_USER);

  await recordModerationEvent({
    chatId: chat.id,
    telegramUserId: 987654321n,
    eventType: "anti_spam",
    action: "ban",
    reason: `integration-reason-${suffix}`,
    matchedPattern: storedRule?.pattern,
    messageId: 42,
    metadata: { source: "telegram-handler" }
  });

  const events = await app.inject({
    method: "GET",
    url: `/api/admin/moderation-events?chatId=${chat.id}&eventType=anti_spam&moderationAction=ban`,
    headers: authorization
  });
  assert.equal(events.statusCode, 200);
  const body = events.json() as {
    total: number;
    items: Array<{
      chatId: string;
      telegramUserId: string | null;
      reason: string | null;
      matchedPattern: string | null;
      chat: { id: string; title: string | null };
    }>;
  };
  assert.equal(body.total, 1);
  assert.equal(body.items[0]?.chatId, chat.id);
  assert.equal(body.items[0]?.telegramUserId, "987654321");
  assert.equal(body.items[0]?.reason, `integration-reason-${suffix}`);
  assert.equal(body.items[0]?.matchedPattern, storedRule?.pattern);
  assert.deepEqual(body.items[0]?.chat, { id: chat.id, title: chat.title });

  const logout = await app.inject({ method: "POST", url: "/api/admin/auth/logout", headers: authorization });
  assert.equal(logout.statusCode, 200);
});
