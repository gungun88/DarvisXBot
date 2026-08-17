import { createHmac, timingSafeEqual } from "node:crypto";
import { BotSubscriptionStatus, PaymentOrderStatus, Prisma } from "@prisma/client";
import type { AppConfig } from "../lib/config.js";
import { prisma } from "../lib/prisma.js";

export const membershipPlans = {
  "1m": { months: 1, amountUsd: "10", label: "10U 1个月" },
  "3m": { months: 3, amountUsd: "29", label: "29U 3个月" },
  "6m": { months: 6, amountUsd: "55", label: "55U 6个月" },
  "12m": { months: 12, amountUsd: "100", label: "100U 1年" }
} as const;

export type MembershipPlanKey = keyof typeof membershipPlans;

export const botFeatureLimits = {
  free: {
    scheduledMessagesPerChat: 5,
    channelSyncTargetsPerSource: 2,
    autoReplyRulesPerChat: 10,
    requiredChannelSubscriptions: 1
  },
  premium: {
    scheduledMessagesPerChat: 50,
    channelSyncTargetsPerSource: 20,
    autoReplyRulesPerChat: 300,
    requiredChannelSubscriptions: 3
  }
} as const;

export type BotFeatureLimits = (typeof botFeatureLimits)[keyof typeof botFeatureLimits];

export function getMembershipPlan(value: string): { key: MembershipPlanKey; months: number; amountUsd: string; label: string } | null {
  if (!(value in membershipPlans)) return null;
  const key = value as MembershipPlanKey;
  return { key, ...membershipPlans[key] };
}

export function paymentsConfigured(config: AppConfig) {
  return Boolean(config.nowPaymentsApiKey && config.nowPaymentsIpnSecret && config.publicBaseUrl);
}

export async function getBotSubscription(userId: string) {
  const subscription = await prisma.botSubscription.findUnique({ where: { userId } });
  if (!subscription) return null;
  if (subscription.status === BotSubscriptionStatus.ACTIVE && subscription.expiresAt <= new Date()) {
    return prisma.botSubscription.update({ where: { id: subscription.id }, data: { status: BotSubscriptionStatus.EXPIRED } });
  }
  return subscription;
}

export async function getBotFeatureLimits(userId: string | undefined | null): Promise<BotFeatureLimits> {
  if (!userId) return botFeatureLimits.free;
  return await hasActiveBotSubscription(userId)
    ? botFeatureLimits.premium
    : botFeatureLimits.free;
}

export async function hasActiveBotSubscription(userId: string | undefined | null): Promise<boolean> {
  if (!userId) return false;
  const subscription = await getBotSubscription(userId);
  return subscription?.status === BotSubscriptionStatus.ACTIVE && subscription.expiresAt > new Date();
}

export async function hasActiveBotSubscriptionForChat(chatId: string): Promise<boolean> {
  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    select: { ownerUserId: true }
  });
  return hasActiveBotSubscription(chat?.ownerUserId);
}

export async function getBotFeatureLimitsByTelegramUserId(telegramUserId: number): Promise<BotFeatureLimits> {
  const user = await prisma.user.findUnique({
    where: { telegramUserId: BigInt(telegramUserId) },
    select: { id: true }
  });
  return getBotFeatureLimits(user?.id);
}

export async function getBotFeatureLimitsForChat(chatId: string): Promise<BotFeatureLimits> {
  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    select: { ownerUserId: true }
  });
  return getBotFeatureLimits(chat?.ownerUserId);
}

export async function hasActiveBotSubscriptionByTelegramUserId(telegramUserId: number): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { telegramUserId: BigInt(telegramUserId) },
    select: { id: true }
  });
  return user ? hasActiveBotSubscription(user.id) : false;
}

export async function createMembershipPaymentOrder(userId: string, planKey: string, config: AppConfig) {
  const plan = getMembershipPlan(planKey);
  if (!plan) throw new Error("会员套餐不存在");
  if (!paymentsConfigured(config)) throw new Error("支付服务尚未配置，请联系管理员");

  const order = await prisma.paymentOrder.create({
    data: {
      userId,
      planKey: plan.key,
      months: plan.months,
      amountUsd: new Prisma.Decimal(plan.amountUsd),
      provider: "nowpayments",
      status: PaymentOrderStatus.PENDING
    }
  });
  try {
    const response = await fetch(`${config.nowPaymentsApiBase}/invoice`, {
      method: "POST",
      headers: { "x-api-key": config.nowPaymentsApiKey!, "content-type": "application/json" },
      body: JSON.stringify({
        price_amount: Number(plan.amountUsd),
        price_currency: "usd",
        order_id: order.id,
        order_description: `DarvisXBot ${plan.label}`,
        ipn_callback_url: `${config.publicBaseUrl!.replace(/\/$/, "")}/api/payments/nowpayments/ipn`
      })
    });
    const payload = await response.json() as { id?: string | number; invoice_url?: string; message?: string };
    if (!response.ok || !payload.id) throw new Error(payload.message || `支付服务请求失败 (${response.status})`);
    return prisma.paymentOrder.update({
      where: { id: order.id },
      data: {
        status: PaymentOrderStatus.WAITING,
        providerPaymentId: String(payload.id),
        payUrl: payload.invoice_url ?? null,
        rawPayload: payload
      }
    });
  } catch (error) {
    await prisma.paymentOrder.update({
      where: { id: order.id },
      data: { status: PaymentOrderStatus.FAILED, rawPayload: { error: error instanceof Error ? error.message : String(error) } }
    });
    throw error;
  }
}

export async function processNowPaymentsIpn(rawBody: string | Record<string, unknown>, signature: string | undefined, config: AppConfig) {
  if (!config.nowPaymentsIpnSecret) throw new Error("支付回调密钥未配置");
  const payload = typeof rawBody === "string" ? JSON.parse(rawBody) as Record<string, unknown> : rawBody;
  if (!signature || !verifyPayloadSignature(payload, signature, config.nowPaymentsIpnSecret)) throw new Error("支付回调签名无效");
  const orderId = typeof payload.order_id === "string" ? payload.order_id : "";
  if (!orderId) throw new Error("支付回调缺少订单信息");
  return applyNowPaymentsPayload(orderId, payload, "nowpayments");
}

export async function reconcileNowPaymentsOrder(orderId: string, config: AppConfig) {
  if (!config.nowPaymentsApiKey) throw new Error("支付服务尚未配置");
  const order = await prisma.paymentOrder.findUnique({ where: { id: orderId } });
  if (!order) throw new Error("支付订单不存在");
  if (!order.providerPaymentId) throw new Error("订单尚未生成支付单，无法对账");
  const response = await fetch(`${config.nowPaymentsApiBase}/payment/${encodeURIComponent(order.providerPaymentId)}`, {
    headers: { "x-api-key": config.nowPaymentsApiKey }
  });
  const payload = await response.json() as Record<string, unknown> & { message?: string };
  if (!response.ok) throw new Error(payload.message || `支付对账请求失败 (${response.status})`);
  const providerOrderId = typeof payload.order_id === "string" ? payload.order_id : "";
  if (providerOrderId && providerOrderId !== order.id) throw new Error("支付商返回的订单号不匹配");
  return applyNowPaymentsPayload(order.id, payload, "nowpayments-reconcile");
}

export async function retryNowPaymentsOrder(orderId: string, config: AppConfig) {
  if (!paymentsConfigured(config)) throw new Error("支付服务尚未配置");
  const order = await prisma.paymentOrder.findUnique({ where: { id: orderId } });
  if (!order) throw new Error("支付订单不存在");
  if (order.providerPaymentId) throw new Error("订单已有支付单，请执行对账而不是重试创建");
  if (order.status !== PaymentOrderStatus.PENDING && order.status !== PaymentOrderStatus.FAILED) throw new Error("当前订单状态不能重试创建支付单");
  const plan = validatePaymentOrderPlan(order);
  try {
    const response = await fetch(`${config.nowPaymentsApiBase}/invoice`, {
      method: "POST",
      headers: { "x-api-key": config.nowPaymentsApiKey!, "content-type": "application/json" },
      body: JSON.stringify({
        price_amount: Number(plan.amountUsd),
        price_currency: "usd",
        order_id: order.id,
        order_description: `DarvisXBot ${plan.label}`,
        ipn_callback_url: `${config.publicBaseUrl!.replace(/\/$/, "")}/api/payments/nowpayments/ipn`
      })
    });
    const payload = await response.json() as { id?: string | number; invoice_url?: string; message?: string };
    if (!response.ok || !payload.id) throw new Error(payload.message || `支付服务请求失败 (${response.status})`);
    return prisma.paymentOrder.update({
      where: { id: order.id },
      data: { status: PaymentOrderStatus.WAITING, providerPaymentId: String(payload.id), payUrl: payload.invoice_url ?? null, rawPayload: payload }
    });
  } catch (error) {
    await prisma.paymentOrder.update({
      where: { id: order.id },
      data: { status: PaymentOrderStatus.FAILED, rawPayload: { error: error instanceof Error ? error.message : String(error) } }
    });
    throw error;
  }
}

export async function markPaymentOrderRefunded(orderId: string, note: string, adminUsername: string) {
  const order = await prisma.paymentOrder.findUnique({ where: { id: orderId } });
  if (!order) throw new Error("支付订单不存在");
  if (order.status !== PaymentOrderStatus.FINISHED && order.status !== PaymentOrderStatus.CONFIRMED) throw new Error("只有已确认或已完成订单可以标记退款");
  return prisma.paymentOrder.update({
    where: { id: order.id },
    data: {
      status: PaymentOrderStatus.REFUNDED,
      rawPayload: mergeJson(order.rawPayload, { refund: { note, adminUsername, recordedAt: new Date().toISOString(), external: true } })
    }
  });
}

async function applyNowPaymentsPayload(orderId: string, payload: Record<string, unknown>, source: string) {
  const status = typeof payload.payment_status === "string" ? payload.payment_status.toLowerCase() : "";
  if (!status) throw new Error("支付状态缺失");

  const order = await prisma.paymentOrder.findUnique({ where: { id: orderId } });
  if (!order) throw new Error("支付订单不存在");
  const plan = validatePaymentOrderPlan(order);
  if (payload.price_amount !== undefined && Math.abs(Number(payload.price_amount) - Number(plan.amountUsd)) > 0.00000001) {
    throw new Error("支付金额与订单不一致");
  }

  if (["finished", "confirmed"].includes(status)) {
    return prisma.$transaction(async (tx) => {
      const current = await tx.paymentOrder.findUnique({ where: { id: order.id } });
      if (!current) throw new Error("支付订单不存在");
      if (current.status === PaymentOrderStatus.FINISHED) return { order: current, subscription: await tx.botSubscription.findUnique({ where: { userId: current.userId } }) };
      if (current.status === PaymentOrderStatus.REFUNDED) throw new Error("已退款订单不能重新确认");
      const now = new Date();
      const currentSubscription = await tx.botSubscription.findUnique({ where: { userId: current.userId } });
      const startAt = currentSubscription?.status === BotSubscriptionStatus.ACTIVE && currentSubscription.expiresAt > now ? currentSubscription.expiresAt : now;
      const expiresAt = new Date(startAt);
      expiresAt.setUTCMonth(expiresAt.getUTCMonth() + plan.months);
      const subscription = await tx.botSubscription.upsert({
        where: { userId: current.userId },
        create: { userId: current.userId, expiresAt, status: BotSubscriptionStatus.ACTIVE, source },
        update: { expiresAt, status: BotSubscriptionStatus.ACTIVE, source }
      });
      const updated = await tx.paymentOrder.update({
        where: { id: current.id },
        data: { status: PaymentOrderStatus.FINISHED, paidAt: current.paidAt ?? now, rawPayload: toJson(payload), providerPaymentId: typeof payload.payment_id === "string" || typeof payload.payment_id === "number" ? String(payload.payment_id) : current.providerPaymentId }
      });
      return { order: updated, subscription };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  const nextStatus = status === "failed"
    ? PaymentOrderStatus.FAILED
    : status === "expired"
      ? PaymentOrderStatus.EXPIRED
      : status === "refunded"
        ? PaymentOrderStatus.REFUNDED
        : status === "confirming"
          ? PaymentOrderStatus.CONFIRMED
          : PaymentOrderStatus.WAITING;
  return { order: await prisma.paymentOrder.update({ where: { id: order.id }, data: { status: nextStatus, rawPayload: toJson(payload) } }), subscription: null };
}

function validatePaymentOrderPlan(order: { planKey: string; months: number; amountUsd: Prisma.Decimal }) {
  const plan = getMembershipPlan(order.planKey);
  if (!plan || order.months !== plan.months || order.amountUsd.toString() !== plan.amountUsd) throw new Error("订单套餐信息异常");
  return plan;
}

function mergeJson(current: Prisma.JsonValue | null, addition: Record<string, unknown>) {
  const base = current && typeof current === "object" && !Array.isArray(current) ? current as Record<string, unknown> : {};
  return toJson({ ...base, ...addition });
}

export function verifySignature(rawBody: string, provided: string, secret: string) {
  const expected = createHmac("sha512", secret).update(rawBody).digest("hex");
  const left = Buffer.from(expected, "utf8"); const right = Buffer.from(provided, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifyPayloadSignature(payload: Record<string, unknown>, provided: string, secret: string) {
  return verifySignature(JSON.stringify(sortObject(payload)), provided, secret);
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value as Record<string, unknown>).sort().reduce<Record<string, unknown>>((result, key) => {
    result[key] = sortObject((value as Record<string, unknown>)[key]);
    return result;
  }, {});
}

function toJson(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function grantManualSubscription(userId: string, months: number, source: string) {
  if (!Number.isInteger(months) || months < 1 || months > 120) throw new Error("会员时长无效");
  const now = new Date();
  const current = await prisma.botSubscription.findUnique({ where: { userId } });
  const startAt = current?.status === BotSubscriptionStatus.ACTIVE && current.expiresAt > now ? current.expiresAt : now;
  const expiresAt = new Date(startAt);
  expiresAt.setUTCMonth(expiresAt.getUTCMonth() + months);
  return prisma.botSubscription.upsert({ where: { userId }, create: { userId, expiresAt, status: BotSubscriptionStatus.ACTIVE, source }, update: { expiresAt, status: BotSubscriptionStatus.ACTIVE, source } });
}

export async function cancelSubscription(userId: string) {
  return prisma.botSubscription.updateMany({ where: { userId, status: BotSubscriptionStatus.ACTIVE }, data: { status: BotSubscriptionStatus.CANCELLED } });
}
