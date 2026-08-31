import { randomUUID } from "node:crypto";
import {
  ChatStatus,
  BotSubscriptionStatus,
  GiveawayStatus,
  PointProductCodeStatus,
  PointRedemptionStatus,
  PointTransactionType,
  PaymentOrderStatus,
  Prisma,
  RuleAction,
  RuleType,
  ScheduledMessageStatus
} from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { cancelGiveawayDrawJob, enqueueGiveawayDraw } from "../giveaways/giveaway.service.js";
import { cancelScheduledMessageJob, enqueueScheduledMessage } from "../scheduled-messages/scheduled-message.service.js";
import {
  createPointProduct,
  deletePointProduct,
  getPointRedemptionDelivery,
  markPointRedemptionDelivered,
  markPointRedemptionDeliveryFailed,
  refundPointRedemption,
  replacePointProductCodes,
  updatePointProduct
} from "../points/point-exchange.service.js";
import { botFeatureLimits, cancelSubscription, grantManualSubscription, membershipPlans, paymentsAvailable } from "../subscriptions/subscription.service.js";
import {
  createPaymentProvider,
  deletePaymentProvider,
  getPaymentProvider,
  listPaymentProviders,
  updatePaymentProvider,
  type PaymentProviderInput
} from "../payments/payment-provider.service.js";
import {
  markPaymentOrderRefunded,
  reconcileNowPaymentsOrder,
  retryNowPaymentsOrder
} from "../subscriptions/subscription.service.js";
import type { AppConfig } from "../lib/config.js";
import { getOperationsHealth } from "../operations/health.service.js";

export type ListInput = {
  page: number;
  pageSize: number;
  search?: string | undefined;
  status?: string | undefined;
  chatId?: string | undefined;
};

export type PointProductInput = {
  chatId: string;
  name: string;
  cost: number;
  dailyLimit: number;
  listed: boolean;
  codes?: string[] | undefined;
};

const membershipUiSettingsKey = "membership_ui";

type MembershipUiSettings = {
  plansTabLabel: string;
};

const defaultMembershipUiSettings: MembershipUiSettings = {
  plansTabLabel: "套餐权益"
};

export class AdminService {
  async dashboard() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const sevenDaysAgo = new Date(today);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);

    const [
      totalChats,
      activeChats,
      totalUsers,
      newUsersToday,
      pendingMessages,
      failedMessages,
      activeGiveaways,
      failedGiveaways,
      moderationEventsToday,
      pendingRedemptions,
      activeSubscriptions,
      waitingPayments,
      messagesToday,
      activity,
      recentAudit
    ] = await Promise.all([
      prisma.chat.count(),
      prisma.chat.count({ where: { status: ChatStatus.ACTIVE } }),
      prisma.user.count(),
      prisma.user.count({ where: { createdAt: { gte: today } } }),
      prisma.scheduledMessage.count({ where: { status: ScheduledMessageStatus.PENDING } }),
      prisma.scheduledMessage.count({ where: { status: ScheduledMessageStatus.FAILED } }),
      prisma.giveaway.count({ where: { status: GiveawayStatus.ACTIVE } }),
      prisma.giveaway.count({ where: { status: GiveawayStatus.FAILED } }),
      prisma.moderationEvent.count({ where: { createdAt: { gte: today } } }),
      prisma.pointRedemption.count({ where: { status: PointRedemptionStatus.DELIVERY_PENDING } }),
      prisma.botSubscription.count({ where: { status: BotSubscriptionStatus.ACTIVE, expiresAt: { gt: new Date() } } }),
      prisma.paymentOrder.count({ where: { status: { in: [PaymentOrderStatus.PENDING, PaymentOrderStatus.WAITING, PaymentOrderStatus.CONFIRMED] } } }),
      prisma.chatDailyMessageStat.aggregate({
        where: { statDate: this.dayKey(today) },
        _sum: { messageCount: true }
      }),
      prisma.chatDailyMessageStat.groupBy({
        by: ["statDate"],
        where: { statDate: { gte: this.dayKey(sevenDaysAgo) } },
        _sum: { messageCount: true },
        orderBy: { statDate: "asc" }
      }),
      prisma.auditLog.findMany({
        take: 8,
        orderBy: { createdAt: "desc" },
        include: { chat: { select: { id: true, title: true } } }
      })
    ]);

    return {
      metrics: {
        totalChats,
        activeChats,
        totalUsers,
        newUsersToday,
        pendingMessages,
        failedMessages,
        activeGiveaways,
        failedGiveaways,
        moderationEventsToday,
        pendingRedemptions,
        activeSubscriptions,
        waitingPayments,
        messagesToday: messagesToday._sum.messageCount ?? 0
      },
      activity: activity.map((item) => ({
        date: item.statDate,
        messages: item._sum.messageCount ?? 0
      })),
      recentAudit: recentAudit.map((item) => ({
        id: item.id,
        action: item.action,
        targetType: item.targetType,
        targetId: item.targetId,
        metadata: item.metadata,
        chat: item.chat,
        createdAt: item.createdAt
      }))
    };
  }

  async listChats(input: ListInput) {
    const where: Prisma.ChatWhereInput = {};
    if (input.status && Object.values(ChatStatus).includes(input.status as ChatStatus)) {
      where.status = input.status as ChatStatus;
    }
    if (input.search) {
      const telegramChatId = this.bigIntOrUndefined(input.search);
      where.OR = [
        { title: { contains: input.search, mode: "insensitive" } },
        { username: { contains: input.search.replace(/^@/, ""), mode: "insensitive" } },
        ...(telegramChatId ? [{ telegramChatId }] : [])
      ];
    }
    const [items, total] = await Promise.all([
      prisma.chat.findMany({
        where,
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
        orderBy: { updatedAt: "desc" },
        include: {
          owner: { select: { id: true, username: true, firstName: true } },
          _count: { select: { admins: true, scheduledMessages: true, giveaways: true } }
        }
      }),
      prisma.chat.count({ where })
    ]);
    return {
      items: items.map((item) => ({ ...item, telegramChatId: item.telegramChatId.toString() })),
      total,
      page: input.page,
      pageSize: input.pageSize
    };
  }

  async getChat(id: string) {
    const chat = await prisma.chat.findUnique({
      where: { id },
      include: {
        owner: { select: { id: true, telegramUserId: true, username: true, firstName: true } },
        admins: {
          include: { user: { select: { id: true, telegramUserId: true, username: true, firstName: true } } }
        },
        settings: { orderBy: { key: "asc" } },
        moderationRules: { orderBy: { updatedAt: "desc" } },
        inviteLinks: {
          take: 20,
          orderBy: { createdAt: "desc" },
          include: {
            creator: { select: { id: true, username: true, firstName: true } },
            _count: { select: { joins: true } }
          }
        },
        _count: { select: { scheduledMessages: true, giveaways: true, auditLogs: true, pointBalances: true, inviteLinks: true, joinVerifications: true } }
      }
    });
    if (!chat) return null;
    return {
      ...chat,
      telegramChatId: chat.telegramChatId.toString(),
      owner: chat.owner ? { ...chat.owner, telegramUserId: chat.owner.telegramUserId.toString() } : null,
      admins: chat.admins.map((admin) => ({
        ...admin,
        user: { ...admin.user, telegramUserId: admin.user.telegramUserId.toString() }
      }))
    };
  }

  async updateChat(id: string, data: { status?: ChatStatus | undefined; timezone?: string | undefined }, adminUsername: string) {
    const changes: Prisma.ChatUpdateInput = {
      ...(data.status ? { status: data.status } : {}),
      ...(data.timezone ? { timezone: data.timezone } : {})
    };
    const updated = await prisma.chat.update({ where: { id }, data: changes });
    await prisma.auditLog.create({
      data: {
        chatId: id,
        action: "admin.chat.updated",
        targetType: "chat",
        targetId: id,
        metadata: { adminUsername, changes: data }
      }
    });
    return { ...updated, telegramChatId: updated.telegramChatId.toString() };
  }

  async updateChatSetting(chatId: string, key: string, value: Prisma.InputJsonValue, adminUsername: string) {
    const existing = await prisma.setting.findUnique({ where: { chatId_key: { chatId, key } } });
    if (!existing) throw new Error("只能编辑机器人已经创建的功能配置");
    const setting = await prisma.setting.update({ where: { id: existing.id }, data: { value } });
    await prisma.auditLog.create({
      data: {
        chatId,
        action: "admin.setting.updated",
        targetType: "setting",
        targetId: setting.id,
        metadata: { adminUsername, key }
      }
    });
    return setting;
  }

  async updateModerationRule(id: string, enabled: boolean, adminUsername: string) {
    const current = await prisma.moderationRule.findUnique({ where: { id } });
    if (!current) return null;
    const rule = await prisma.moderationRule.update({ where: { id }, data: { enabled } });
    await prisma.auditLog.create({
      data: {
        chatId: current.chatId,
        action: "admin.moderation_rule.updated",
        targetType: "moderation_rule",
        targetId: id,
        metadata: { adminUsername, enabled }
      }
    });
    return rule;
  }

  async createModerationRule(input: { chatId: string; ruleType: RuleType; pattern: string; action: RuleAction; enabled: boolean }, adminUsername: string) {
    const rule = await prisma.moderationRule.create({ data: input });
    await this.writeAdminAudit(input.chatId, "admin.moderation_rule.created", "moderation_rule", rule.id, adminUsername, { ruleType: input.ruleType, action: input.action });
    return rule;
  }

  async editModerationRule(id: string, input: { ruleType: RuleType; pattern: string; action: RuleAction; enabled: boolean }, adminUsername: string) {
    const current = await prisma.moderationRule.findUnique({ where: { id } });
    if (!current) return null;
    const rule = await prisma.moderationRule.update({ where: { id }, data: input });
    await this.writeAdminAudit(current.chatId, "admin.moderation_rule.updated", "moderation_rule", id, adminUsername, { changes: input });
    return rule;
  }

  async deleteModerationRule(id: string, adminUsername: string) {
    const current = await prisma.moderationRule.findUnique({ where: { id } });
    if (!current) return null;
    await prisma.moderationRule.delete({ where: { id } });
    await this.writeAdminAudit(current.chatId, "admin.moderation_rule.deleted", "moderation_rule", id, adminUsername);
    return { deleted: true };
  }

  async listUsers(input: ListInput) {
    const where: Prisma.UserWhereInput = {};
    if (input.search) {
      const telegramUserId = this.bigIntOrUndefined(input.search);
      where.OR = [
        { username: { contains: input.search.replace(/^@/, ""), mode: "insensitive" } },
        { firstName: { contains: input.search, mode: "insensitive" } },
        { lastName: { contains: input.search, mode: "insensitive" } },
        ...(telegramUserId ? [{ telegramUserId }] : [])
      ];
    }
    const [items, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
        orderBy: { updatedAt: "desc" },
        include: { _count: { select: { ownedChats: true, adminAssignments: true, pointBalances: true } } }
      }),
      prisma.user.count({ where })
    ]);
    return {
      items: items.map((item) => ({ ...item, telegramUserId: item.telegramUserId.toString() })),
      total,
      page: input.page,
      pageSize: input.pageSize
    };
  }

  async getUser(id: string) {
    const user = await prisma.user.findUnique({
      where: { id },
      include: {
        ownedChats: { select: { id: true, title: true, status: true } },
        adminAssignments: { include: { chat: { select: { id: true, title: true, status: true } } } },
        memberships: { include: { chat: { select: { id: true, title: true } } }, orderBy: { updatedAt: "desc" } },
        pointBalances: { include: { chat: { select: { id: true, title: true } } }, orderBy: { balance: "desc" } },
        pointTransactions: { take: 20, orderBy: { createdAt: "desc" }, include: { chat: { select: { id: true, title: true } } } }
      }
    });
    return user ? { ...user, telegramUserId: user.telegramUserId.toString() } : null;
  }

  async listScheduledMessages(input: ListInput) {
    const where: Prisma.ScheduledMessageWhereInput = {};
    if (input.chatId) where.chatId = input.chatId;
    if (input.status && Object.values(ScheduledMessageStatus).includes(input.status as ScheduledMessageStatus)) {
      where.status = input.status as ScheduledMessageStatus;
    }
    if (input.search) {
      where.chat = { title: { contains: input.search, mode: "insensitive" } };
    }
    const [items, total] = await Promise.all([
      prisma.scheduledMessage.findMany({
        where,
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
        orderBy: { sendAt: "desc" },
        include: { chat: { select: { id: true, title: true, username: true } } }
      }),
      prisma.scheduledMessage.count({ where })
    ]);
    return { items, total, page: input.page, pageSize: input.pageSize };
  }

  async createScheduledMessage(input: { chatId: string; name: string; text: string; sendAt: string; repeatIntervalMinutes?: number | undefined }, adminUsername: string) {
    const sendAt = new Date(input.sendAt);
    if (Number.isNaN(sendAt.getTime()) || sendAt <= new Date()) throw new Error("发送时间必须晚于当前时间");
    const chat = await prisma.chat.findUnique({ where: { id: input.chatId }, select: { id: true, status: true } });
    if (!chat || chat.status !== ChatStatus.ACTIVE) throw new Error("群组不存在或未启用");
    const message = await prisma.scheduledMessage.create({
      data: {
        chatId: input.chatId,
        contentType: "text",
        content: { name: input.name, text: input.text, deletePrevious: false, pin: false },
        sendAt,
        repeatRule: input.repeatIntervalMinutes ? { intervalMinutes: input.repeatIntervalMinutes } : Prisma.DbNull,
        status: ScheduledMessageStatus.PENDING
      }
    });
    try {
      await enqueueScheduledMessage(message.id, sendAt);
    } catch (error) {
      await prisma.scheduledMessage.update({ where: { id: message.id }, data: { status: ScheduledMessageStatus.FAILED, lastError: error instanceof Error ? error.message : "入队失败" } });
      throw error;
    }
    await this.writeAdminAudit(input.chatId, "admin.scheduled_message.created", "scheduled_message", message.id, adminUsername, { sendAt: sendAt.toISOString() });
    return message;
  }

  async cancelScheduledMessage(id: string, adminUsername: string) {
    const current = await prisma.scheduledMessage.findUnique({ where: { id } });
    if (!current) return null;
    if (current.status === ScheduledMessageStatus.SENT) throw new Error("已发送的消息不能取消");
    await cancelScheduledMessageJob(id);
    const updated = await prisma.scheduledMessage.update({
      where: { id },
      data: { status: ScheduledMessageStatus.CANCELLED }
    });
    await prisma.auditLog.create({
      data: {
        chatId: current.chatId,
        action: "admin.scheduled_message.cancelled",
        targetType: "scheduled_message",
        targetId: id,
        metadata: { adminUsername }
      }
    });
    return updated;
  }

  async retryScheduledMessage(id: string, adminUsername: string) {
    const current = await prisma.scheduledMessage.findUnique({ where: { id } });
    if (!current) return null;
    if (current.status !== ScheduledMessageStatus.FAILED) throw new Error("只有失败的消息可以重试");

    const sendAt = new Date();
    const updated = await prisma.scheduledMessage.update({
      where: { id },
      data: {
        status: ScheduledMessageStatus.PENDING,
        sendAt,
        attemptCount: 0,
        lastError: null,
        lastAttemptAt: null
      }
    });
    try {
      await enqueueScheduledMessage(id, sendAt);
    } catch (error) {
      await prisma.scheduledMessage.update({
        where: { id },
        data: { status: ScheduledMessageStatus.FAILED, lastError: error instanceof Error ? error.message : "重新入队失败" }
      });
      throw error;
    }
    await prisma.auditLog.create({
      data: {
        chatId: current.chatId,
        action: "admin.scheduled_message.retried",
        targetType: "scheduled_message",
        targetId: id,
        metadata: { adminUsername }
      }
    });
    return updated;
  }

  async listGiveaways(input: ListInput) {
    const where: Prisma.GiveawayWhereInput = {};
    if (input.chatId) where.chatId = input.chatId;
    if (input.status && Object.values(GiveawayStatus).includes(input.status as GiveawayStatus)) {
      where.status = input.status as GiveawayStatus;
    }
    if (input.search) {
      where.OR = [
        { title: { contains: input.search, mode: "insensitive" } },
        { prize: { contains: input.search, mode: "insensitive" } },
        { chat: { title: { contains: input.search, mode: "insensitive" } } }
      ];
    }
    const [items, total] = await Promise.all([
      prisma.giveaway.findMany({
        where,
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
        orderBy: { drawAt: "desc" },
        include: {
          chat: { select: { id: true, title: true } },
          creator: { select: { id: true, username: true, firstName: true } },
          _count: { select: { entries: true } }
        }
      }),
      prisma.giveaway.count({ where })
    ]);
    return { items, total, page: input.page, pageSize: input.pageSize };
  }

  async createGiveaway(input: { chatId: string; title: string; prize: string; winnersCount: number; drawAt: string; keyword: string }, adminUsername: string) {
    const drawAt = new Date(input.drawAt);
    if (Number.isNaN(drawAt.getTime()) || drawAt <= new Date()) throw new Error("开奖时间必须晚于当前时间");
    const chat = await prisma.chat.findUnique({ where: { id: input.chatId }, include: { admins: { take: 1 } } });
    const creatorUserId = chat?.ownerUserId ?? chat?.admins[0]?.userId;
    if (!chat || chat.status !== ChatStatus.ACTIVE) throw new Error("群组不存在或未启用");
    if (!creatorUserId) throw new Error("群组没有可用的创建者，请先绑定所有者或管理员");
    const giveaway = await prisma.giveaway.create({
      data: {
        chatId: input.chatId,
        title: input.title,
        prize: input.prize,
        winnersCount: input.winnersCount,
        drawAt,
        createdBy: creatorUserId,
        status: GiveawayStatus.ACTIVE,
        joinRequirements: { type: "common", entry: "keyword", keyword: input.keyword, drawMode: "timed" }
      }
    });
    try {
      await enqueueGiveawayDraw(giveaway.id, drawAt);
    } catch (error) {
      await prisma.giveaway.update({ where: { id: giveaway.id }, data: { status: GiveawayStatus.FAILED, lastError: error instanceof Error ? error.message : "入队失败" } });
      throw error;
    }
    await this.writeAdminAudit(input.chatId, "admin.giveaway.created", "giveaway", giveaway.id, adminUsername, { drawAt: drawAt.toISOString(), keyword: input.keyword });
    return giveaway;
  }

  async cancelGiveaway(id: string, adminUsername: string) {
    const current = await prisma.giveaway.findUnique({ where: { id } });
    if (!current) return null;
    if (current.status === GiveawayStatus.DRAWN) throw new Error("已开奖的抽奖不能取消");
    await cancelGiveawayDrawJob(id);
    const updated = await prisma.giveaway.update({ where: { id }, data: { status: GiveawayStatus.CANCELLED } });
    await prisma.auditLog.create({
      data: {
        chatId: current.chatId,
        action: "admin.giveaway.cancelled",
        targetType: "giveaway",
        targetId: id,
        metadata: { adminUsername }
      }
    });
    return updated;
  }

  async retryGiveaway(id: string, adminUsername: string) {
    const current = await prisma.giveaway.findUnique({ where: { id } });
    if (!current) return null;
    if (current.status !== GiveawayStatus.FAILED) throw new Error("只有失败的抽奖可以重试");

    const drawAt = new Date();
    const updated = await prisma.giveaway.update({
      where: { id },
      data: {
        status: GiveawayStatus.ACTIVE,
        drawAt,
        attemptCount: 0,
        lastError: null,
        lastAttemptAt: null
      }
    });
    try {
      await enqueueGiveawayDraw(id, drawAt);
    } catch (error) {
      await prisma.giveaway.update({
        where: { id },
        data: { status: GiveawayStatus.FAILED, lastError: error instanceof Error ? error.message : "重新入队失败" }
      });
      throw error;
    }
    await prisma.auditLog.create({
      data: {
        chatId: current.chatId,
        action: "admin.giveaway.retried",
        targetType: "giveaway",
        targetId: id,
        metadata: { adminUsername }
      }
    });
    return updated;
  }

  async listPointTransactions(input: ListInput & { type?: string | undefined }) {
    const where: Prisma.ChatPointTransactionWhereInput = {};
    if (input.chatId) where.chatId = input.chatId;
    if (input.type && Object.values(PointTransactionType).includes(input.type as PointTransactionType)) {
      where.type = input.type as PointTransactionType;
    }
    if (input.search) {
      where.OR = [
        { user: { username: { contains: input.search.replace(/^@/, ""), mode: "insensitive" } } },
        { note: { contains: input.search, mode: "insensitive" } },
        { chat: { title: { contains: input.search, mode: "insensitive" } } }
      ];
    }
    const [items, total] = await Promise.all([
      prisma.chatPointTransaction.findMany({
        where,
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
        orderBy: { createdAt: "desc" },
        include: {
          chat: { select: { id: true, title: true } },
          user: { select: { id: true, telegramUserId: true, username: true, firstName: true } },
          actor: { select: { id: true, username: true, firstName: true } }
        }
      }),
      prisma.chatPointTransaction.count({ where })
    ]);
    return {
      items: items.map((item) => ({
        ...item,
        user: { ...item.user, telegramUserId: item.user.telegramUserId.toString() }
      })),
      total,
      page: input.page,
      pageSize: input.pageSize
    };
  }

  async adjustPoints(input: { chatId: string; userId: string; delta: number; note: string }, adminUsername: string) {
    return prisma.$transaction(async (tx) => {
      const [chat, user] = await Promise.all([
        tx.chat.findUnique({ where: { id: input.chatId }, select: { id: true } }),
        tx.user.findUnique({ where: { id: input.userId }, select: { id: true } })
      ]);
      if (!chat || !user) throw new Error("群组或用户不存在");
      const balance = await tx.chatPointBalance.upsert({
        where: { chatId_userId: { chatId: input.chatId, userId: input.userId } },
        create: { chatId: input.chatId, userId: input.userId, balance: input.delta, lastTransactionAt: new Date() },
        update: { balance: { increment: input.delta }, lastTransactionAt: new Date() }
      });
      const transaction = await tx.chatPointTransaction.create({
        data: {
          chatId: input.chatId,
          userId: input.userId,
          type: "MANUAL",
          delta: input.delta,
          balanceAfter: balance.balance,
          referenceKey: `admin-${randomUUID()}`,
          note: input.note,
          metadata: { adminUsername }
        }
      });
      await tx.auditLog.create({
        data: {
          chatId: input.chatId,
          action: "admin.points.adjusted",
          targetType: "user",
          targetId: input.userId,
          metadata: { adminUsername, delta: input.delta, note: input.note, balanceAfter: balance.balance }
        }
      });
      return transaction;
    });
  }

  async listPointProducts(input: ListInput & { listed?: string | undefined }) {
    const where: Prisma.PointProductWhereInput = { archivedAt: null };
    if (input.chatId) where.chatId = input.chatId;
    if (input.listed === "true") where.listed = true;
    if (input.listed === "false") where.listed = false;
    if (input.search) {
      where.OR = [
        { name: { contains: input.search, mode: "insensitive" } },
        { externalId: { contains: input.search, mode: "insensitive" } },
        { chat: { title: { contains: input.search, mode: "insensitive" } } }
      ];
    }
    const [items, total] = await Promise.all([
      prisma.pointProduct.findMany({
        where,
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
        orderBy: { updatedAt: "desc" },
        include: {
          chat: { select: { id: true, title: true } },
          codes: {
            where: { status: PointProductCodeStatus.AVAILABLE },
            select: { value: true },
            orderBy: { createdAt: "asc" }
          },
          _count: { select: { codes: true, redemptions: true } }
        }
      }),
      prisma.pointProduct.count({ where })
    ]);
    return {
      items: items.map(({ codes, ...item }) => ({ ...item, availableCodes: codes.map((code) => code.value) })),
      total,
      page: input.page,
      pageSize: input.pageSize
    };
  }

  async createPointProduct(input: PointProductInput, adminUsername: string) {
    const chat = await prisma.chat.findUnique({ where: { id: input.chatId }, select: { id: true } });
    if (!chat) throw new Error("群组不存在");
    const externalId = await createPointProduct(input.chatId);
    try {
      const product = await updatePointProduct(input.chatId, externalId, input);
      if (input.codes) await replacePointProductCodes(input.chatId, externalId, input.codes);
      await this.writeAdminAudit(input.chatId, "admin.point_product.created", "point_product", product.id, adminUsername, {
        externalId,
        name: input.name,
        codeCount: input.codes?.length ?? 0
      });
      return product;
    } catch (error) {
      await deletePointProduct(input.chatId, externalId).catch(() => undefined);
      throw error;
    }
  }

  async updatePointProduct(chatId: string, externalId: string, input: Omit<PointProductInput, "chatId" | "codes">, adminUsername: string) {
    const product = await updatePointProduct(chatId, externalId, input);
    await this.writeAdminAudit(chatId, "admin.point_product.updated", "point_product", product.id, adminUsername, {
      externalId,
      changes: input
    });
    return product;
  }

  async replacePointProductCodes(chatId: string, externalId: string, codes: string[], adminUsername: string) {
    await replacePointProductCodes(chatId, externalId, codes);
    const product = await prisma.pointProduct.findUnique({ where: { chatId_externalId: { chatId, externalId } } });
    if (!product) throw new Error("商品不存在");
    await this.writeAdminAudit(chatId, "admin.point_product.inventory_replaced", "point_product", product.id, adminUsername, {
      externalId,
      availableCount: [...new Set(codes.map((code) => code.trim()).filter(Boolean))].length
    });
    return product;
  }

  async archivePointProduct(chatId: string, externalId: string, adminUsername: string) {
    const product = await prisma.pointProduct.findUnique({ where: { chatId_externalId: { chatId, externalId } } });
    if (!product) return null;
    await deletePointProduct(chatId, externalId);
    await this.writeAdminAudit(chatId, "admin.point_product.archived", "point_product", product.id, adminUsername, { externalId });
    return { archived: true };
  }

  async listPointRedemptions(input: ListInput & { redemptionStatus?: string | undefined }) {
    const where: Prisma.PointRedemptionWhereInput = {};
    if (input.chatId) where.chatId = input.chatId;
    if (input.redemptionStatus && Object.values(PointRedemptionStatus).includes(input.redemptionStatus as PointRedemptionStatus)) {
      where.status = input.redemptionStatus as PointRedemptionStatus;
    }
    if (input.search) {
      where.OR = [
        { product: { name: { contains: input.search, mode: "insensitive" } } },
        { product: { externalId: { contains: input.search, mode: "insensitive" } } },
        { user: { username: { contains: input.search.replace(/^@/, ""), mode: "insensitive" } } },
        { chat: { title: { contains: input.search, mode: "insensitive" } } }
      ];
    }
    const [items, total] = await Promise.all([
      prisma.pointRedemption.findMany({
        where,
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
        orderBy: { createdAt: "desc" },
        include: {
          chat: { select: { id: true, title: true } },
          product: { select: { externalId: true, name: true } },
          code: { select: { value: true } },
          user: { select: { id: true, telegramUserId: true, username: true, firstName: true } }
        }
      }),
      prisma.pointRedemption.count({ where })
    ]);
    return {
      items: items.map((item) => ({
        ...item,
        user: { ...item.user, telegramUserId: item.user.telegramUserId.toString() }
      })),
      total,
      page: input.page,
      pageSize: input.pageSize
    };
  }

  async retryPointRedemption(id: string, botToken: string, adminUsername: string) {
    const redemption = await getPointRedemptionDelivery(id);
    if (!redemption) return null;
    if (redemption.status !== PointRedemptionStatus.DELIVERY_PENDING) throw new Error("只有待交付的兑换可以补发");
    try {
      const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: redemption.user.telegramUserId.toString(),
          text: [`兑换成功：${this.escapeHtml(redemption.product.name || "未命名商品")}`, `卡密：<code>${this.escapeHtml(redemption.code.value)}</code>`].join("\n"),
          parse_mode: "HTML"
        })
      });
      const result = await response.json() as { ok?: boolean; description?: string };
      if (!response.ok || !result.ok) throw new Error(result.description || `Telegram 请求失败 (${response.status})`);
      await markPointRedemptionDelivered(id);
      await this.writeAdminAudit(redemption.chatId, "admin.point_redemption.redelivered", "point_redemption", id, adminUsername);
      return { delivered: true };
    } catch (error) {
      await markPointRedemptionDeliveryFailed(id, error);
      throw error;
    }
  }

  async refundPointRedemption(id: string, note: string, adminUsername: string) {
    const current = await prisma.pointRedemption.findUnique({ where: { id }, select: { chatId: true } });
    if (!current) return null;
    const redemption = await refundPointRedemption(id, note);
    await this.writeAdminAudit(current.chatId, "admin.point_redemption.refunded", "point_redemption", id, adminUsername, { note });
    return redemption;
  }

  async listAuditLogs(input: ListInput & { action?: string | undefined }) {
    const where: Prisma.AuditLogWhereInput = {};
    if (input.chatId) where.chatId = input.chatId;
    if (input.action) where.action = { contains: input.action, mode: "insensitive" };
    if (input.search) {
      where.OR = [
        { action: { contains: input.search, mode: "insensitive" } },
        { targetId: { contains: input.search, mode: "insensitive" } },
        { chat: { title: { contains: input.search, mode: "insensitive" } } }
      ];
    }
    const [items, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
        orderBy: { createdAt: "desc" },
        include: {
          chat: { select: { id: true, title: true } },
          actor: { select: { id: true, username: true, firstName: true } }
        }
      }),
      prisma.auditLog.count({ where })
    ]);
    return { items, total, page: input.page, pageSize: input.pageSize };
  }

  async listModerationEvents(input: ListInput & { eventType?: string | undefined; moderationAction?: string | undefined }) {
    const where: Prisma.ModerationEventWhereInput = {};
    if (input.chatId) where.chatId = input.chatId;
    if (input.eventType) where.eventType = input.eventType;
    if (input.moderationAction) where.action = input.moderationAction;
    if (input.search) {
      const telegramUserId = this.bigIntOrUndefined(input.search);
      where.OR = [
        { reason: { contains: input.search, mode: "insensitive" } },
        { matchedPattern: { contains: input.search, mode: "insensitive" } },
        { chat: { title: { contains: input.search, mode: "insensitive" } } },
        ...(telegramUserId ? [{ telegramUserId }] : [])
      ];
    }
    const [items, total] = await Promise.all([
      prisma.moderationEvent.findMany({ where, skip: (input.page - 1) * input.pageSize, take: input.pageSize, orderBy: { createdAt: "desc" }, include: { chat: { select: { id: true, title: true } } } }),
      prisma.moderationEvent.count({ where })
    ]);
    return { items: items.map((item) => ({ ...item, telegramUserId: item.telegramUserId?.toString() ?? null })), total, page: input.page, pageSize: input.pageSize };
  }

  async membershipOverview(config: AppConfig) {
    const now = new Date();
    const sevenDaysFromNow = new Date(now);
    sevenDaysFromNow.setUTCDate(sevenDaysFromNow.getUTCDate() + 7);
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);
    const [activeMembers, expiringMembers, waitingPayments, failedPayments, paidOrders, refundedOrders, revenue, recentOrders] = await Promise.all([
      prisma.botSubscription.count({ where: { status: BotSubscriptionStatus.ACTIVE, expiresAt: { gt: now } } }),
      prisma.botSubscription.count({ where: { status: BotSubscriptionStatus.ACTIVE, expiresAt: { gt: now, lte: sevenDaysFromNow } } }),
      prisma.paymentOrder.count({ where: { status: { in: [PaymentOrderStatus.PENDING, PaymentOrderStatus.WAITING, PaymentOrderStatus.CONFIRMED] } } }),
      prisma.paymentOrder.count({ where: { status: PaymentOrderStatus.FAILED, updatedAt: { gte: thirtyDaysAgo } } }),
      prisma.paymentOrder.count({ where: { status: PaymentOrderStatus.FINISHED, paidAt: { gte: thirtyDaysAgo } } }),
      prisma.paymentOrder.count({ where: { status: PaymentOrderStatus.REFUNDED, updatedAt: { gte: thirtyDaysAgo } } }),
      prisma.paymentOrder.aggregate({ where: { status: PaymentOrderStatus.FINISHED, paidAt: { gte: thirtyDaysAgo } }, _sum: { amountUsd: true } }),
      prisma.paymentOrder.findMany({
        orderBy: { createdAt: "desc" },
        take: 6,
        include: { user: { select: { id: true, telegramUserId: true, username: true, firstName: true } } }
      })
    ]);
    return {
      checkedAt: now.toISOString(),
      paymentConfigured: await paymentsAvailable(config),
      metrics: {
        activeMembers,
        expiringMembers,
        waitingPayments,
        paidOrders30d: paidOrders,
        failedPayments30d: failedPayments,
        refundedOrders30d: refundedOrders,
        revenue30dUsd: revenue._sum.amountUsd?.toString() ?? "0"
      },
      plans: Object.entries(membershipPlans).map(([key, plan]) => ({ key, ...plan })),
      featureLimits: botFeatureLimits,
      recentOrders: recentOrders.map((order) => {
        const { rawPayload: _rawPayload, ...safeOrder } = order;
        return {
          ...safeOrder,
          amountUsd: order.amountUsd.toString(),
          user: { ...order.user, telegramUserId: order.user.telegramUserId.toString() }
        };
      })
    };
  }

  async listPaymentProviders() {
    return { items: await listPaymentProviders(false) };
  }

  async getPaymentProviderDetail(id: number, revealSecret: boolean, adminUsername: string) {
    const provider = await getPaymentProvider(id, revealSecret);
    if (provider && revealSecret) {
      await this.writePaymentProviderAudit("admin.payment_provider.secret_revealed", provider.id, adminUsername, { providerKey: provider.providerKey });
    }
    return provider;
  }

  async createPaymentProviderEntry(input: PaymentProviderInput, adminUsername: string) {
    const provider = await createPaymentProvider(input);
    await this.writePaymentProviderAudit("admin.payment_provider.created", provider.id, adminUsername, {
      providerKey: provider.providerKey,
      name: provider.name,
      enabled: provider.enabled,
      supportedTypes: provider.supportedTypes,
      configuredFields: Object.keys(input.config ?? {})
    });
    return provider;
  }

  async updatePaymentProviderEntry(id: number, input: PaymentProviderInput, adminUsername: string) {
    const provider = await updatePaymentProvider(id, input);
    if (!provider) return null;
    await this.writePaymentProviderAudit("admin.payment_provider.updated", provider.id, adminUsername, {
      providerKey: provider.providerKey,
      name: provider.name,
      enabled: provider.enabled,
      supportedTypes: provider.supportedTypes,
      changedFields: Object.keys(input),
      configuredFields: Object.keys(input.config ?? {})
    });
    return provider;
  }

  async deletePaymentProviderEntry(id: number, adminUsername: string) {
    const provider = await getPaymentProvider(id, false);
    if (!provider) return null;
    await deletePaymentProvider(id);
    await this.writePaymentProviderAudit("admin.payment_provider.deleted", id, adminUsername, {
      providerKey: provider.providerKey,
      name: provider.name
    });
    return { deleted: true };
  }

  private async writePaymentProviderAudit(action: string, providerId: number, adminUsername: string, metadata: Record<string, unknown>) {
    await prisma.auditLog.create({
      data: {
        action,
        targetType: "payment_provider",
        targetId: String(providerId),
        metadata: { adminUsername, ...metadata }
      }
    });
  }

  async membershipUiSettings() {
    return this.loadMembershipUiSettings();
  }

  async updateMembershipUiSettings(input: MembershipUiSettings, adminUsername: string) {
    const current = await this.loadMembershipUiSettings();
    const next = normalizeMembershipUiSettings(input);
    await prisma.appSetting.upsert({
      where: { key: membershipUiSettingsKey },
      create: { key: membershipUiSettingsKey, value: next },
      update: { value: next }
    });
    await prisma.auditLog.create({
      data: {
        action: "admin.membership_ui.updated",
        targetType: "app_setting",
        targetId: membershipUiSettingsKey,
        metadata: { adminUsername, changes: { before: current, after: next } }
      }
    });
    return next;
  }

  async listSubscriptions(input: ListInput & { subscriptionStatus?: string | undefined }) {
    const where: Prisma.BotSubscriptionWhereInput = {};
    if (input.subscriptionStatus && Object.values(BotSubscriptionStatus).includes(input.subscriptionStatus as BotSubscriptionStatus)) where.status = input.subscriptionStatus as BotSubscriptionStatus;
    if (input.search) {
      const id = this.bigIntOrUndefined(input.search);
      where.user = { OR: [{ username: { contains: input.search.replace(/^@/, ""), mode: "insensitive" } }, { firstName: { contains: input.search, mode: "insensitive" } }, ...(id ? [{ telegramUserId: id }] : [])] };
    }
    const [items, total] = await Promise.all([
      prisma.botSubscription.findMany({ where, skip: (input.page - 1) * input.pageSize, take: input.pageSize, orderBy: { expiresAt: "asc" }, include: { user: { select: { id: true, telegramUserId: true, username: true, firstName: true } } } }),
      prisma.botSubscription.count({ where })
    ]);
    return { items: items.map((item) => ({ ...item, user: { ...item.user, telegramUserId: item.user.telegramUserId.toString() } })), total, page: input.page, pageSize: input.pageSize };
  }

  async listPaymentOrders(input: ListInput & { orderStatus?: string | undefined }) {
    const where: Prisma.PaymentOrderWhereInput = {};
    if (input.orderStatus && Object.values(PaymentOrderStatus).includes(input.orderStatus as PaymentOrderStatus)) where.status = input.orderStatus as PaymentOrderStatus;
    if (input.search) {
      where.OR = [
        { id: { contains: input.search, mode: "insensitive" } },
        { providerPaymentId: { contains: input.search, mode: "insensitive" } },
        { user: { username: { contains: input.search.replace(/^@/, ""), mode: "insensitive" } } }
      ];
    }
    const [items, total] = await Promise.all([
      prisma.paymentOrder.findMany({ where, skip: (input.page - 1) * input.pageSize, take: input.pageSize, orderBy: { createdAt: "desc" }, include: { user: { select: { id: true, telegramUserId: true, username: true, firstName: true } } } }),
      prisma.paymentOrder.count({ where })
    ]);
    return {
      items: items.map((item) => {
        const { rawPayload: _rawPayload, ...safeItem } = item;
        return { ...safeItem, amountUsd: item.amountUsd.toString(), user: { ...item.user, telegramUserId: item.user.telegramUserId.toString() } };
      }),
      total,
      page: input.page,
      pageSize: input.pageSize
    };
  }

  async reconcilePaymentOrder(id: string, config: AppConfig, adminUsername: string) {
    const result = await reconcileNowPaymentsOrder(id, config);
    await prisma.auditLog.create({
      data: { action: "admin.payment_order.reconciled", targetType: "payment_order", targetId: id, metadata: { adminUsername, status: result.order.status } }
    });
    return result.order;
  }

  async retryPaymentOrder(id: string, config: AppConfig, adminUsername: string) {
    const order = await retryNowPaymentsOrder(id, config);
    await prisma.auditLog.create({
      data: { action: "admin.payment_order.retried", targetType: "payment_order", targetId: id, metadata: { adminUsername, providerPaymentId: order.providerPaymentId } }
    });
    return order;
  }

  async markPaymentOrderRefunded(id: string, note: string, adminUsername: string) {
    const order = await markPaymentOrderRefunded(id, note, adminUsername);
    await prisma.auditLog.create({
      data: { action: "admin.payment_order.refund_recorded", targetType: "payment_order", targetId: id, metadata: { adminUsername, note, subscriptionChanged: false } }
    });
    return order;
  }

  async grantSubscription(userId: string, months: number, adminUsername: string) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new Error("用户不存在");
    const subscription = await grantManualSubscription(userId, months, `manual:${adminUsername}`);
    await prisma.auditLog.create({ data: { actorUserId: userId, action: "admin.subscription.granted", targetType: "bot_subscription", targetId: subscription.id, metadata: { adminUsername, months, expiresAt: subscription.expiresAt.toISOString() } } });
    return subscription;
  }

  async cancelSubscription(userId: string, adminUsername: string) {
    const result = await cancelSubscription(userId);
    if (result.count) await prisma.auditLog.create({ data: { actorUserId: userId, action: "admin.subscription.cancelled", targetType: "bot_subscription", targetId: userId, metadata: { adminUsername } } });
    return result;
  }

  async operations(config: AppConfig) {
    return getOperationsHealth(config, false);
  }

  private bigIntOrUndefined(value: string) {
    try {
      return BigInt(value.replace(/^[-+]?/, (prefix) => prefix));
    } catch {
      return undefined;
    }
  }

  private dayKey(date: Date) {
    return date.toISOString().slice(0, 10);
  }

  private async loadMembershipUiSettings(): Promise<MembershipUiSettings> {
    const record = await prisma.appSetting.findUnique({ where: { key: membershipUiSettingsKey } });
    return normalizeMembershipUiSettings(record?.value);
  }

  private async writeAdminAudit(chatId: string, action: string, targetType: string, targetId: string, adminUsername: string, metadata: Record<string, unknown> = {}) {
    await prisma.auditLog.create({
      data: { chatId, action, targetType, targetId, metadata: { adminUsername, ...metadata } }
    });
  }

  private escapeHtml(value: string) {
    return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  }
}

function normalizeMembershipUiSettings(value: unknown): MembershipUiSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaultMembershipUiSettings;
  const source = value as Record<string, unknown>;
  const plansTabLabel = typeof source.plansTabLabel === "string"
    ? source.plansTabLabel.trim()
    : "";
  return {
    plansTabLabel: plansTabLabel || defaultMembershipUiSettings.plansTabLabel
  };
}

export const adminService = new AdminService();
