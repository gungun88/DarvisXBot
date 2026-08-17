import { randomInt, randomUUID } from "node:crypto";
import {
  PointProductCodeStatus,
  PointRedemptionStatus,
  PointTransactionType,
  Prisma
} from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export class PointExchangeError extends Error {
  constructor(public readonly code: "PRODUCT_UNAVAILABLE" | "OUT_OF_STOCK" | "INSUFFICIENT_POINTS" | "DAILY_LIMIT") {
    super(code);
  }
}

class InventoryConflictError extends Error {}

export type PointProductView = {
  id: string;
  name: string;
  cost: number;
  listed: boolean;
  codes: string[];
  soldCount: number;
  dailyLimit: number;
  reservedCount: number;
};

export async function listPointProducts(chatId: string): Promise<PointProductView[]> {
  const products = await prisma.pointProduct.findMany({
    where: { chatId, archivedAt: null },
    orderBy: { createdAt: "asc" },
    include: { codes: { orderBy: { createdAt: "asc" } } }
  });
  return products.map((product) => ({
    id: product.externalId,
    name: product.name,
    cost: product.cost,
    listed: product.listed,
    codes: product.codes.filter((code) => code.status === PointProductCodeStatus.AVAILABLE).map((code) => code.value),
    soldCount: product.soldCount,
    dailyLimit: product.dailyLimit,
    reservedCount: product.codes.filter((code) => code.status === PointProductCodeStatus.RESERVED).length
  }));
}

export async function createPointProduct(chatId: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const externalId = String(randomInt(1000, 10000));
    try {
      const product = await prisma.pointProduct.create({
        data: { chatId, externalId, name: "", cost: 1, listed: false }
      });
      return product.externalId;
    } catch (error) {
      if (isUniqueConstraint(error)) continue;
      throw error;
    }
  }
  throw new Error("无法生成商品编号，请重试");
}

export async function updatePointProduct(chatId: string, externalId: string, data: {
  name?: string;
  cost?: number;
  listed?: boolean;
  dailyLimit?: number;
}) {
  const changes: Prisma.PointProductUpdateInput = {};
  if (data.name !== undefined) changes.name = data.name;
  if (data.cost !== undefined) changes.cost = data.cost;
  if (data.listed !== undefined) changes.listed = data.listed;
  if (data.dailyLimit !== undefined) changes.dailyLimit = data.dailyLimit;
  return prisma.pointProduct.update({
    where: { chatId_externalId: { chatId, externalId } },
    data: changes
  });
}

export async function replacePointProductCodes(chatId: string, externalId: string, values: string[]) {
  const product = await prisma.pointProduct.findUnique({ where: { chatId_externalId: { chatId, externalId } } });
  if (!product || product.archivedAt) throw new Error("商品不存在");
  const codes = normalizeCodes(values);
  await prisma.$transaction(async (tx) => {
    await tx.pointProductCode.deleteMany({
      where: { productId: product.id, status: PointProductCodeStatus.AVAILABLE }
    });
    if (codes.length) {
      await tx.pointProductCode.createMany({
        data: codes.map((value) => ({ productId: product.id, value })),
        skipDuplicates: true
      });
    }
  });
}

export async function deletePointProduct(chatId: string, externalId: string) {
  const product = await prisma.pointProduct.findUnique({
    where: { chatId_externalId: { chatId, externalId } },
    include: { _count: { select: { redemptions: true } } }
  });
  if (!product) return false;
  if (product._count.redemptions > 0) {
    await prisma.pointProduct.update({
      where: { id: product.id },
      data: { listed: false, archivedAt: new Date() }
    });
  } else {
    await prisma.pointProduct.delete({ where: { id: product.id } });
  }
  return true;
}

export async function redeemPointProduct(input: { chatId: string; externalId: string; userId: string; dayKey: string }) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const product = await tx.pointProduct.findUnique({
          where: { chatId_externalId: { chatId: input.chatId, externalId: input.externalId } }
        });
        if (!product || !product.listed || product.archivedAt) throw new PointExchangeError("PRODUCT_UNAVAILABLE");

        if (product.dailyLimit > 0) {
          const redeemedToday = await tx.pointRedemption.count({
            where: {
              chatId: input.chatId,
              userId: input.userId,
              productId: product.id,
              dayKey: input.dayKey,
              status: { in: [PointRedemptionStatus.DELIVERY_PENDING, PointRedemptionStatus.FULFILLED] }
            }
          });
          if (redeemedToday >= product.dailyLimit) throw new PointExchangeError("DAILY_LIMIT");
        }

        const code = await tx.pointProductCode.findFirst({
          where: { productId: product.id, status: PointProductCodeStatus.AVAILABLE },
          orderBy: { createdAt: "asc" }
        });
        if (!code) throw new PointExchangeError("OUT_OF_STOCK");

        const balance = await tx.chatPointBalance.findUnique({
          where: { chatId_userId: { chatId: input.chatId, userId: input.userId } }
        });
        if (!balance || balance.balance < product.cost) throw new PointExchangeError("INSUFFICIENT_POINTS");

        const claimed = await tx.pointProductCode.updateMany({
          where: { id: code.id, status: PointProductCodeStatus.AVAILABLE },
          data: { status: PointProductCodeStatus.RESERVED, reservedAt: new Date() }
        });
        if (claimed.count !== 1) throw new InventoryConflictError("Inventory conflict");

        const debited = await tx.chatPointBalance.updateMany({
          where: { id: balance.id, balance: { gte: product.cost } },
          data: { balance: { decrement: product.cost }, lastTransactionAt: new Date() }
        });
        if (debited.count !== 1) throw new PointExchangeError("INSUFFICIENT_POINTS");
        const currentBalance = balance.balance - product.cost;
        const redemptionId = randomUUID();
        const transaction = await tx.chatPointTransaction.create({
          data: {
            chatId: input.chatId,
            userId: input.userId,
            type: PointTransactionType.EXCHANGE,
            delta: -product.cost,
            balanceAfter: currentBalance,
            referenceKey: `exchange:${product.externalId}:${redemptionId}`,
            dayKey: input.dayKey,
            metadata: { productId: product.externalId, productName: product.name, redemptionId }
          }
        });
        const redemption = await tx.pointRedemption.create({
          data: {
            id: redemptionId,
            chatId: input.chatId,
            productId: product.id,
            codeId: code.id,
            userId: input.userId,
            transactionId: transaction.id,
            cost: product.cost,
            dayKey: input.dayKey
          }
        });
        await tx.pointProduct.update({ where: { id: product.id }, data: { soldCount: { increment: 1 } } });
        return { redemptionId: redemption.id, code: code.value, productName: product.name, currentBalance };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if ((error instanceof InventoryConflictError || isTransactionConflict(error)) && attempt < 2) continue;
      throw error;
    }
  }
  throw new Error("兑换事务重试失败");
}

export async function markPointRedemptionDelivered(id: string) {
  await prisma.$transaction(async (tx) => {
    const redemption = await tx.pointRedemption.findUnique({ where: { id } });
    if (!redemption || redemption.status !== PointRedemptionStatus.DELIVERY_PENDING) return;
    const deliveredAt = new Date();
    await tx.pointRedemption.update({
      where: { id },
      data: { status: PointRedemptionStatus.FULFILLED, deliveredAt, deliveryError: null }
    });
    await tx.pointProductCode.update({
      where: { id: redemption.codeId },
      data: { status: PointProductCodeStatus.DELIVERED, deliveredAt }
    });
  });
}

export async function markPointRedemptionDeliveryFailed(id: string, error: unknown) {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 4000);
  await prisma.pointRedemption.updateMany({
    where: { id, status: PointRedemptionStatus.DELIVERY_PENDING },
    data: { deliveryError: message || "卡密发送失败" }
  });
}

export async function getPointRedemptionDelivery(id: string) {
  return prisma.pointRedemption.findUnique({
    where: { id },
    include: {
      user: { select: { telegramUserId: true } },
      product: { select: { name: true } },
      code: { select: { value: true } }
    }
  });
}

export async function listPendingPointRedemptionDeliveries(telegramUserId: bigint) {
  return prisma.pointRedemption.findMany({
    where: {
      status: PointRedemptionStatus.DELIVERY_PENDING,
      user: { telegramUserId }
    },
    take: 20,
    orderBy: { createdAt: "asc" },
    include: {
      product: { select: { name: true } },
      code: { select: { value: true } }
    }
  });
}

export async function refundPointRedemption(id: string, note: string) {
  return prisma.$transaction(async (tx) => {
    const redemption = await tx.pointRedemption.findUnique({ where: { id } });
    if (!redemption) return null;
    if (redemption.status !== PointRedemptionStatus.DELIVERY_PENDING) {
      throw new Error("只有待交付的兑换可以退款");
    }

    const balance = await tx.chatPointBalance.upsert({
      where: { chatId_userId: { chatId: redemption.chatId, userId: redemption.userId } },
      create: {
        chatId: redemption.chatId,
        userId: redemption.userId,
        balance: redemption.cost,
        lastTransactionAt: new Date()
      },
      update: { balance: { increment: redemption.cost }, lastTransactionAt: new Date() }
    });
    await tx.chatPointTransaction.create({
      data: {
        chatId: redemption.chatId,
        userId: redemption.userId,
        type: PointTransactionType.EXCHANGE,
        delta: redemption.cost,
        balanceAfter: balance.balance,
        referenceKey: `exchange-refund:${redemption.id}:${randomUUID()}`,
        dayKey: redemption.dayKey,
        note,
        metadata: { redemptionId: redemption.id, refund: true }
      }
    });
    await tx.pointProductCode.update({
      where: { id: redemption.codeId },
      data: { status: PointProductCodeStatus.AVAILABLE, reservedAt: null, deliveredAt: null }
    });
    await tx.pointProduct.updateMany({
      where: { id: redemption.productId, soldCount: { gt: 0 } },
      data: { soldCount: { decrement: 1 } }
    });
    return tx.pointRedemption.update({
      where: { id },
      data: {
        status: PointRedemptionStatus.REFUNDED,
        refundedAt: new Date(),
        deliveryError: null
      }
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

function normalizeCodes(values: string[]) {
  return [...new Set(values.map((value) => value.trim().slice(0, 255)).filter(Boolean))].slice(0, 10000);
}

function isUniqueConstraint(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function isTransactionConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}
