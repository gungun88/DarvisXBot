import jwt from "@fastify/jwt";
import { randomUUID } from "node:crypto";
import { ChatStatus, Prisma, RuleAction, RuleType } from "@prisma/client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../lib/config.js";
import { prisma } from "../lib/prisma.js";
import { adminRoles, adminSessionExpiresAt, requireAdmin, requireFinancialAdmin, requireOwner, type AdminRole, type AdminToken } from "./auth.js";
import { hashAdminPassword, verifyAdminPassword, verifyTotpCode } from "./password.js";
import { adminService } from "./service.js";

const loginSchema = z.object({ username: z.string().min(1), password: z.string().min(1), code: z.string().regex(/^\d{6}$/).optional() });
const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).optional(),
  status: z.string().trim().optional(),
  chatId: z.string().trim().optional()
});
const idParamsSchema = z.object({ id: z.string().min(1) });

export async function registerAdminApi(app: FastifyInstance, config: AppConfig) {
  await app.register(jwt, { secret: config.adminJwtSecret });
  await ensureBootstrapAdmin(config);
  const loginAttempts = new Map<string, { failures: number; blockedUntil: number }>();
  const dummyPasswordHash = hashAdminPassword("invalid-admin-password");

  app.post("/api/admin/auth/login", async (request, reply) => {
    const attempt = loginAttempts.get(request.ip);
    if (attempt && attempt.blockedUntil > Date.now()) {
      reply.header("retry-after", String(Math.ceil((attempt.blockedUntil - Date.now()) / 1000)));
      return reply.code(429).send({ error: "登录尝试过多，请稍后重试" });
    }
    const parsed = loginSchema.safeParse(request.body);
    const account = parsed.success ? await prisma.adminAccount.findUnique({ where: { username: parsed.data.username } }) : null;
    const passwordMatches = parsed.success && verifyAdminPassword(account?.passwordHash ?? dummyPasswordHash, parsed.data.password);
    const totpMatches = !config.adminTotpSecret || (parsed.success && verifyTotpCode(config.adminTotpSecret, parsed.data.code));
    if (!parsed.success || !account?.enabled || !passwordMatches || !totpMatches || !isAdminRole(account.role)) {
      const failures = (attempt?.blockedUntil && attempt.blockedUntil <= Date.now() ? 0 : attempt?.failures ?? 0) + 1;
      loginAttempts.set(request.ip, { failures, blockedUntil: failures >= 5 ? Date.now() + 15 * 60 * 1000 : 0 });
      await recordAdminAuthAudit("admin.auth.login_failed", parsed.success ? parsed.data.username : "invalid", request, { failures }).catch(() => undefined);
      return reply.code(401).send({ error: "用户名或密码错误" });
    }
    loginAttempts.delete(request.ip);
    const jti = randomUUID();
    const expiresAt = adminSessionExpiresAt(config.adminTokenTtl);
    const session = await prisma.adminSession.create({
      data: {
        jti,
        username: account.username,
        role: account.role,
        ipAddress: request.ip.slice(0, 64),
        userAgent: request.headers["user-agent"]?.slice(0, 512) ?? null,
        expiresAt
      }
    });
    const payload: AdminToken = { sub: account.id, jti, username: account.username, role: account.role };
    const token = await reply.jwtSign(payload, { expiresIn: config.adminTokenTtl });
    await prisma.adminAccount.update({ where: { id: account.id }, data: { lastLoginAt: new Date() } });
    await recordAdminAuthAudit("admin.auth.login_succeeded", account.username, request, { sessionId: session.id, expiresAt: expiresAt.toISOString(), role: account.role }).catch(() => undefined);
    return { token, user: { username: account.username, role: account.role } };
  });

  app.get("/api/admin/auth/me", { onRequest: requireAdmin }, async (request) => {
    const admin = request.user as AdminToken;
    return { user: { username: admin.username, role: admin.role } };
  });
  app.post("/api/admin/auth/logout", { onRequest: requireAdmin }, async (request) => {
    const admin = request.user as AdminToken;
    await prisma.adminSession.updateMany({ where: { jti: admin.jti, revokedAt: null }, data: { revokedAt: new Date() } });
    await recordAdminAuthAudit("admin.auth.logout", admin.username, request, { jti: admin.jti }).catch(() => undefined);
    return { ok: true };
  });
  app.get("/api/admin/auth/sessions", { onRequest: requireAdmin }, async (request) => {
    const admin = request.user as AdminToken;
    const sessions = await prisma.adminSession.findMany({
      where: { username: admin.username, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
      take: 20
    });
    return {
      items: sessions.map((session) => {
        const { jti: sessionJti, ...safeSession } = session;
        return { ...safeSession, current: sessionJti === admin.jti };
      })
    };
  });
  app.delete("/api/admin/auth/sessions/:id", { onRequest: requireAdmin }, async (request, reply) => {
    const params = parseOrReply(idParamsSchema, request.params, reply);
    if (!params) return;
    const admin = request.user as AdminToken;
    const result = await prisma.adminSession.updateMany({
      where: { id: params.id, username: admin.username, revokedAt: null },
      data: { revokedAt: new Date() }
    });
    if (!result.count) return reply.code(404).send({ error: "管理会话不存在" });
    await recordAdminAuthAudit("admin.auth.session_revoked", admin.username, request, { sessionId: params.id }).catch(() => undefined);
    return { revoked: true };
  });
  app.get("/api/admin/accounts", { onRequest: requireOwner }, async () => {
    const items = await prisma.adminAccount.findMany({ orderBy: [{ role: "asc" }, { username: "asc" }] });
    return { items: items.map(({ passwordHash: _passwordHash, ...account }) => account) };
  });
  app.post("/api/admin/accounts", { onRequest: requireOwner }, async (request, reply) => {
    const body = parseOrReply(z.object({ username: z.string().trim().min(3).max(128), password: z.string().min(10).max(200), role: z.enum(adminRoles).default("operator") }), request.body, reply);
    if (!body) return;
    return runAction(reply, async () => {
      const account = await prisma.adminAccount.create({ data: { username: body.username, passwordHash: hashAdminPassword(body.password), role: body.role } });
      await recordAdminAuthAudit("admin.account.created", account.username, request, { accountId: account.id, role: account.role });
      const { passwordHash: _passwordHash, ...safeAccount } = account;
      return safeAccount;
    });
  });
  app.patch("/api/admin/accounts/:id", { onRequest: requireOwner }, async (request, reply) => {
    const params = parseOrReply(idParamsSchema, request.params, reply);
    const body = parseOrReply(z.object({ role: z.enum(adminRoles).optional(), enabled: z.boolean().optional(), password: z.string().min(10).max(200).optional() }).refine((value) => value.role !== undefined || value.enabled !== undefined || value.password !== undefined), request.body, reply);
    if (!params || !body) return;
    return runAction(reply, async () => {
      const current = await prisma.adminAccount.findUnique({ where: { id: params.id } });
      if (!current) throw new Error("管理员账号不存在");
      const admin = request.user as AdminToken;
      if (current.id === admin.sub && body.enabled === false) throw new Error("不能停用当前登录账号");
      if (current.role === "owner" && (body.role && body.role !== "owner" || body.enabled === false)) {
        const owners = await prisma.adminAccount.count({ where: { role: "owner", enabled: true } });
        if (owners <= 1) throw new Error("必须保留至少一个启用的所有者账号");
      }
      const account = await prisma.adminAccount.update({
        where: { id: current.id },
        data: {
          ...(body.role ? { role: body.role } : {}),
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          ...(body.password ? { passwordHash: hashAdminPassword(body.password), bootstrapManaged: false } : {})
        }
      });
      if (body.role || body.enabled === false || body.password) {
        await prisma.adminSession.updateMany({ where: { username: account.username, revokedAt: null }, data: { revokedAt: new Date() } });
      }
      await recordAdminAuthAudit("admin.account.updated", account.username, request, { accountId: account.id, role: account.role, enabled: account.enabled, passwordChanged: Boolean(body.password) });
      const { passwordHash: _passwordHash, ...safeAccount } = account;
      return safeAccount;
    });
  });

  app.get("/api/admin/dashboard", { onRequest: requireAdmin }, async () => adminService.dashboard());
  app.get("/api/admin/chats", { onRequest: requireAdmin }, async (request, reply) => {
    const query = parseOrReply(listQuerySchema, request.query, reply);
    if (!query) return;
    return adminService.listChats(query);
  });
  app.get("/api/admin/chats/:id", { onRequest: requireAdmin }, async (request, reply) => {
    const params = parseOrReply(idParamsSchema, request.params, reply);
    if (!params) return;
    const chat = await adminService.getChat(params.id);
    return chat ?? reply.code(404).send({ error: "群组不存在" });
  });
  app.patch("/api/admin/chats/:id", { onRequest: requireAdmin }, async (request, reply) => {
    const params = parseOrReply(idParamsSchema, request.params, reply);
    const body = parseOrReply(z.object({ status: z.nativeEnum(ChatStatus).optional(), timezone: z.string().min(1).max(64).optional() }).refine((value) => value.status || value.timezone), request.body, reply);
    if (!params || !body) return;
    return runAction(reply, () => adminService.updateChat(params.id, body, adminName(request)));
  });
  app.put("/api/admin/chats/:id/settings/:key", { onRequest: requireAdmin }, async (request, reply) => {
    const params = parseOrReply(z.object({ id: z.string().min(1), key: z.string().min(1).max(128) }), request.params, reply);
    const body = parseOrReply(z.object({ value: z.record(z.string(), z.json()).refine((value) => JSON.stringify(value).length <= 65536, "配置内容过大") }), request.body, reply);
    if (!params || !body) return;
    return runAction(reply, () => adminService.updateChatSetting(params.id, params.key, body.value as Prisma.InputJsonValue, adminName(request)));
  });
  app.patch("/api/admin/moderation-rules/:id", { onRequest: requireAdmin }, async (request, reply) => {
    const params = parseOrReply(idParamsSchema, request.params, reply);
    const body = parseOrReply(z.object({ enabled: z.boolean() }), request.body, reply);
    if (!params || !body) return;
    const result = await runAction(reply, () => adminService.updateModerationRule(params.id, body.enabled, adminName(request)));
    return result ?? reply.code(404).send({ error: "规则不存在" });
  });
  const moderationRuleSchema = z.object({ chatId: z.string().min(1), ruleType: z.nativeEnum(RuleType), pattern: z.string().trim().min(1).max(2000), action: z.nativeEnum(RuleAction), enabled: z.boolean() });
  app.post("/api/admin/moderation-rules", { onRequest: requireAdmin }, async (request, reply) => {
    const body = parseOrReply(moderationRuleSchema, request.body, reply);
    if (!body) return;
    return runAction(reply, () => adminService.createModerationRule(body, adminName(request)));
  });
  app.put("/api/admin/moderation-rules/:id", { onRequest: requireAdmin }, async (request, reply) => {
    const params = parseOrReply(idParamsSchema, request.params, reply);
    const body = parseOrReply(moderationRuleSchema.omit({ chatId: true }), request.body, reply);
    if (!params || !body) return;
    const result = await runAction(reply, () => adminService.editModerationRule(params.id, body, adminName(request)));
    return result ?? reply.code(404).send({ error: "规则不存在" });
  });
  app.delete("/api/admin/moderation-rules/:id", { onRequest: requireAdmin }, async (request, reply) => {
    const params = parseOrReply(idParamsSchema, request.params, reply);
    if (!params) return;
    const result = await runAction(reply, () => adminService.deleteModerationRule(params.id, adminName(request)));
    return result ?? reply.code(404).send({ error: "规则不存在" });
  });

  app.get("/api/admin/users", { onRequest: requireAdmin }, async (request, reply) => {
    const query = parseOrReply(listQuerySchema, request.query, reply);
    if (!query) return;
    return adminService.listUsers(query);
  });
  app.get("/api/admin/users/:id", { onRequest: requireAdmin }, async (request, reply) => {
    const params = parseOrReply(idParamsSchema, request.params, reply);
    if (!params) return;
    const user = await adminService.getUser(params.id);
    return user ?? reply.code(404).send({ error: "用户不存在" });
  });

  app.get("/api/admin/scheduled-messages", { onRequest: requireAdmin }, async (request, reply) => {
    const query = parseOrReply(listQuerySchema, request.query, reply);
    if (!query) return;
    return adminService.listScheduledMessages(query);
  });
  app.post("/api/admin/scheduled-messages", { onRequest: requireAdmin }, async (request, reply) => {
    const body = parseOrReply(z.object({ chatId: z.string().min(1), name: z.string().trim().min(1).max(64), text: z.string().trim().min(1).max(4096), sendAt: z.string().datetime(), repeatIntervalMinutes: z.number().int().min(1).max(43200).optional() }), request.body, reply);
    if (!body) return;
    return runAction(reply, () => adminService.createScheduledMessage(body, adminName(request)));
  });
  app.post("/api/admin/scheduled-messages/:id/cancel", { onRequest: requireAdmin }, async (request, reply) => {
    const params = parseOrReply(idParamsSchema, request.params, reply);
    if (!params) return;
    const result = await runAction(reply, () => adminService.cancelScheduledMessage(params.id, adminName(request)));
    return result ?? reply.code(404).send({ error: "定时消息不存在" });
  });
  app.post("/api/admin/scheduled-messages/:id/retry", { onRequest: requireAdmin }, async (request, reply) => {
    const params = parseOrReply(idParamsSchema, request.params, reply);
    if (!params) return;
    const result = await runAction(reply, () => adminService.retryScheduledMessage(params.id, adminName(request)));
    return result ?? reply.code(404).send({ error: "定时消息不存在" });
  });

  app.get("/api/admin/giveaways", { onRequest: requireAdmin }, async (request, reply) => {
    const query = parseOrReply(listQuerySchema, request.query, reply);
    if (!query) return;
    return adminService.listGiveaways(query);
  });
  app.post("/api/admin/giveaways", { onRequest: requireAdmin }, async (request, reply) => {
    const body = parseOrReply(z.object({ chatId: z.string().min(1), title: z.string().trim().min(1).max(255), prize: z.string().trim().min(1).max(255), winnersCount: z.number().int().min(1).max(100), drawAt: z.string().datetime(), keyword: z.string().trim().min(1).max(128) }), request.body, reply);
    if (!body) return;
    return runAction(reply, () => adminService.createGiveaway(body, adminName(request)));
  });
  app.post("/api/admin/giveaways/:id/cancel", { onRequest: requireAdmin }, async (request, reply) => {
    const params = parseOrReply(idParamsSchema, request.params, reply);
    if (!params) return;
    const result = await runAction(reply, () => adminService.cancelGiveaway(params.id, adminName(request)));
    return result ?? reply.code(404).send({ error: "抽奖不存在" });
  });
  app.post("/api/admin/giveaways/:id/retry", { onRequest: requireAdmin }, async (request, reply) => {
    const params = parseOrReply(idParamsSchema, request.params, reply);
    if (!params) return;
    const result = await runAction(reply, () => adminService.retryGiveaway(params.id, adminName(request)));
    return result ?? reply.code(404).send({ error: "抽奖不存在" });
  });

  app.get("/api/admin/points/transactions", { onRequest: requireAdmin }, async (request, reply) => {
    const query = parseOrReply(listQuerySchema.extend({ type: z.string().optional() }), request.query, reply);
    if (!query) return;
    return adminService.listPointTransactions(query);
  });
  app.post("/api/admin/points/adjustments", { onRequest: requireFinancialAdmin }, async (request, reply) => {
    const body = parseOrReply(z.object({
      chatId: z.string().min(1),
      userId: z.string().min(1),
      delta: z.number().int().min(-1000000).max(1000000).refine((value) => value !== 0),
      note: z.string().trim().min(2).max(255)
    }), request.body, reply);
    if (!body) return;
    return runAction(reply, () => adminService.adjustPoints(body, adminName(request)));
  });
  const pointProductBodySchema = z.object({
    chatId: z.string().min(1),
    name: z.string().trim().min(1).max(64),
    cost: z.number().int().min(1).max(100000000),
    dailyLimit: z.number().int().min(0).max(100000),
    listed: z.boolean(),
    codes: z.array(z.string().trim().min(1).max(255)).max(10000).optional()
  });
  const pointProductParamsSchema = z.object({ chatId: z.string().min(1), externalId: z.string().min(1).max(16) });
  app.get("/api/admin/points/products", { onRequest: requireAdmin }, async (request, reply) => {
    const query = parseOrReply(listQuerySchema.extend({ listed: z.preprocess((value) => value === "" ? undefined : value, z.enum(["true", "false"]).optional()) }), request.query, reply);
    if (!query) return;
    return adminService.listPointProducts(query);
  });
  app.post("/api/admin/points/products", { onRequest: requireAdmin }, async (request, reply) => {
    const body = parseOrReply(pointProductBodySchema, request.body, reply);
    if (!body) return;
    return runAction(reply, () => adminService.createPointProduct(body, adminName(request)));
  });
  app.patch("/api/admin/points/products/:chatId/:externalId", { onRequest: requireAdmin }, async (request, reply) => {
    const params = parseOrReply(pointProductParamsSchema, request.params, reply);
    const body = parseOrReply(pointProductBodySchema.omit({ chatId: true, codes: true }), request.body, reply);
    if (!params || !body) return;
    return runAction(reply, () => adminService.updatePointProduct(params.chatId, params.externalId, body, adminName(request)));
  });
  app.put("/api/admin/points/products/:chatId/:externalId/codes", { onRequest: requireAdmin }, async (request, reply) => {
    const params = parseOrReply(pointProductParamsSchema, request.params, reply);
    const body = parseOrReply(z.object({ codes: z.array(z.string().trim().min(1).max(255)).max(10000) }), request.body, reply);
    if (!params || !body) return;
    return runAction(reply, () => adminService.replacePointProductCodes(params.chatId, params.externalId, body.codes, adminName(request)));
  });
  app.delete("/api/admin/points/products/:chatId/:externalId", { onRequest: requireAdmin }, async (request, reply) => {
    const params = parseOrReply(pointProductParamsSchema, request.params, reply);
    if (!params) return;
    const result = await runAction(reply, () => adminService.archivePointProduct(params.chatId, params.externalId, adminName(request)));
    return result ?? reply.code(404).send({ error: "商品不存在" });
  });
  app.get("/api/admin/points/redemptions", { onRequest: requireAdmin }, async (request, reply) => {
    const query = parseOrReply(listQuerySchema.extend({ redemptionStatus: z.string().optional() }), request.query, reply);
    if (!query) return;
    return adminService.listPointRedemptions(query);
  });
  app.post("/api/admin/points/redemptions/:id/retry", { onRequest: requireAdmin }, async (request, reply) => {
    const params = parseOrReply(idParamsSchema, request.params, reply);
    if (!params) return;
    const result = await runAction(reply, () => adminService.retryPointRedemption(params.id, config.botToken, adminName(request)));
    return result ?? reply.code(404).send({ error: "兑换记录不存在" });
  });
  app.post("/api/admin/points/redemptions/:id/refund", { onRequest: requireFinancialAdmin }, async (request, reply) => {
    const params = parseOrReply(idParamsSchema, request.params, reply);
    const body = parseOrReply(z.object({ note: z.string().trim().min(2).max(255) }), request.body, reply);
    if (!params || !body) return;
    const result = await runAction(reply, () => adminService.refundPointRedemption(params.id, body.note, adminName(request)));
    return result ?? reply.code(404).send({ error: "兑换记录不存在" });
  });

  app.get("/api/admin/membership-overview", { onRequest: requireAdmin }, async () => adminService.membershipOverview(config));
  app.get("/api/admin/membership-ui", { onRequest: requireAdmin }, async () => adminService.membershipUiSettings());
  app.put("/api/admin/membership-ui", { onRequest: requireAdmin }, async (request, reply) => {
    const body = parseOrReply(z.object({ plansTabLabel: z.string().trim().min(1).max(24) }), request.body, reply);
    if (!body) return;
    return runAction(reply, () => adminService.updateMembershipUiSettings(body, adminName(request)));
  });
  app.get("/api/admin/payment-settings", { onRequest: requireAdmin }, async () => adminService.paymentSettings(config));
  app.get("/api/admin/subscriptions", { onRequest: requireAdmin }, async (request, reply) => {
    const query = parseOrReply(listQuerySchema.extend({ subscriptionStatus: z.string().optional() }), request.query, reply);
    if (!query) return;
    return adminService.listSubscriptions(query);
  });
  app.post("/api/admin/subscriptions/:userId/grant", { onRequest: requireFinancialAdmin }, async (request, reply) => {
    const params = parseOrReply(z.object({ userId: z.string().min(1) }), request.params, reply);
    const body = parseOrReply(z.object({ months: z.number().int().min(1).max(120) }), request.body, reply);
    if (!params || !body) return;
    return runAction(reply, () => adminService.grantSubscription(params.userId, body.months, adminName(request)));
  });
  app.post("/api/admin/subscriptions/:userId/cancel", { onRequest: requireFinancialAdmin }, async (request, reply) => {
    const params = parseOrReply(z.object({ userId: z.string().min(1) }), request.params, reply);
    if (!params) return;
    return runAction(reply, () => adminService.cancelSubscription(params.userId, adminName(request)));
  });
  app.get("/api/admin/payment-orders", { onRequest: requireAdmin }, async (request, reply) => {
    const query = parseOrReply(listQuerySchema.extend({ orderStatus: z.string().optional() }), request.query, reply);
    if (!query) return;
    return adminService.listPaymentOrders(query);
  });
  app.post("/api/admin/payment-orders/:id/reconcile", { onRequest: requireFinancialAdmin }, async (request, reply) => {
    const params = parseOrReply(idParamsSchema, request.params, reply);
    if (!params) return;
    return runAction(reply, () => adminService.reconcilePaymentOrder(params.id, config, adminName(request)));
  });
  app.post("/api/admin/payment-orders/:id/retry", { onRequest: requireFinancialAdmin }, async (request, reply) => {
    const params = parseOrReply(idParamsSchema, request.params, reply);
    if (!params) return;
    return runAction(reply, () => adminService.retryPaymentOrder(params.id, config, adminName(request)));
  });
  app.post("/api/admin/payment-orders/:id/refund", { onRequest: requireFinancialAdmin }, async (request, reply) => {
    const params = parseOrReply(idParamsSchema, request.params, reply);
    const body = parseOrReply(z.object({ note: z.string().trim().min(2).max(255) }), request.body, reply);
    if (!params || !body) return;
    return runAction(reply, () => adminService.markPaymentOrderRefunded(params.id, body.note, adminName(request)));
  });
  app.get("/api/admin/moderation-events", { onRequest: requireAdmin }, async (request, reply) => {
    const query = parseOrReply(listQuerySchema.extend({ eventType: z.string().optional(), moderationAction: z.string().optional() }), request.query, reply);
    if (!query) return;
    return adminService.listModerationEvents(query);
  });

  app.get("/api/admin/audit-logs", { onRequest: requireAdmin }, async (request, reply) => {
    const query = parseOrReply(listQuerySchema.extend({ action: z.string().optional() }), request.query, reply);
    if (!query) return;
    return adminService.listAuditLogs(query);
  });
  app.get("/api/admin/operations", { onRequest: requireAdmin }, async () => adminService.operations(config));
}

function adminName(request: FastifyRequest) {
  return (request.user as AdminToken).username;
}

function parseOrReply<T extends z.ZodType>(schema: T, value: unknown, reply: FastifyReply): z.output<T> | undefined {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    void reply.code(400).send({ error: "请求参数无效", details: z.flattenError(parsed.error) });
    return undefined;
  }
  return parsed.data;
}

async function runAction<T>(reply: FastifyReply, action: () => Promise<T>) {
  try {
    return await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : "操作失败";
    const notFound = message.includes("Record to update not found");
    return reply.code(notFound ? 404 : 409).send({ error: notFound ? "记录不存在" : message });
  }
}

async function recordAdminAuthAudit(action: string, username: string, request: FastifyRequest, metadata: Record<string, unknown> = {}) {
  await prisma.auditLog.create({
    data: {
      action,
      targetType: "admin_account",
      targetId: username.slice(0, 128),
      metadata: {
        ipAddress: request.ip.slice(0, 64),
        userAgent: request.headers["user-agent"]?.slice(0, 512) ?? null,
        ...metadata
      }
    }
  });
}

async function ensureBootstrapAdmin(config: AppConfig) {
  const existing = await prisma.adminAccount.findUnique({ where: { username: config.adminUsername } });
  if (!existing) {
    await prisma.adminAccount.create({
      data: { username: config.adminUsername, passwordHash: hashAdminPassword(config.adminPassword), role: "owner", enabled: true, bootstrapManaged: true }
    });
    return;
  }
  if (existing.bootstrapManaged && (!verifyAdminPassword(existing.passwordHash, config.adminPassword) || existing.role !== "owner" || !existing.enabled)) {
    await prisma.adminAccount.update({
      where: { id: existing.id },
      data: { passwordHash: hashAdminPassword(config.adminPassword), role: "owner", enabled: true }
    });
  }
}

function isAdminRole(value: string): value is AdminRole {
  return adminRoles.includes(value as AdminRole);
}
