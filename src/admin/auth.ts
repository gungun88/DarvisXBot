import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../lib/config.js";
import { prisma } from "../lib/prisma.js";

export const adminRoles = ["owner", "admin", "operator", "viewer"] as const;
export type AdminRole = (typeof adminRoles)[number];

export type AdminToken = {
  sub: string;
  jti: string;
  username: string;
  role: AdminRole;
};

export function credentialsMatch(config: AppConfig, username: string, password: string) {
  return safeEqual(config.adminUsername, username) && safeEqual(config.adminPassword, password);
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify<AdminToken>();
  } catch {
    return reply.code(401).send({ error: "登录已失效，请重新登录" });
  }

  const token = request.user as AdminToken;
  if (!token.jti) {
    return reply.code(401).send({ error: "管理会话已升级，请重新登录" });
  }
  const [session, account] = await Promise.all([
    prisma.adminSession.findUnique({ where: { jti: token.jti } }),
    prisma.adminAccount.findUnique({ where: { id: token.sub } })
  ]);
  if (!session || session.revokedAt || session.expiresAt <= new Date() || session.username !== token.username || session.role !== token.role || !account?.enabled || account.username !== token.username || account.role !== token.role) {
    return reply.code(401).send({ error: "管理会话已撤销或过期，请重新登录" });
  }
  if (token.role === "viewer" && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    return reply.code(403).send({ error: "只读管理员不能执行写入操作" });
  }
}

export async function requireOwner(request: FastifyRequest, reply: FastifyReply) {
  await requireAdmin(request, reply);
  if (reply.sent) return;
  if ((request.user as AdminToken).role !== "owner") return reply.code(403).send({ error: "仅所有者可以管理管理员账号" });
}

export async function requireFinancialAdmin(request: FastifyRequest, reply: FastifyReply) {
  await requireAdmin(request, reply);
  if (reply.sent) return;
  if (!["owner", "admin"].includes((request.user as AdminToken).role)) {
    return reply.code(403).send({ error: "当前角色不能执行资金或权益操作" });
  }
}

export function adminSessionExpiresAt(ttl: string, now = new Date()) {
  const match = /^(\d+)([smhd])$/.exec(ttl.trim());
  if (!match) throw new Error("ADMIN_TOKEN_TTL 格式无效");
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return new Date(now.getTime() + amount * multiplier);
}

function safeEqual(expected: string, actual: string) {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}
