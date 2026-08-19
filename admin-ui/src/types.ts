export type PageResult<T> = { items: T[]; total: number; page: number; pageSize: number };

export type Chat = {
  id: string;
  telegramChatId: string;
  type: string;
  title: string | null;
  username: string | null;
  timezone: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  owner?: { id: string; username: string | null; firstName: string | null } | null;
  _count: { admins: number; scheduledMessages: number; giveaways: number };
};

export type User = {
  id: string;
  telegramUserId: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  languageCode: string | null;
  timezone: string;
  createdAt: string;
  updatedAt: string;
  _count: { ownedChats: number; adminAssignments: number; pointBalances: number };
};

export type ScheduledMessage = {
  id: string;
  contentType: string;
  content: { name?: string; text?: string };
  sendAt: string;
  repeatRule: unknown;
  status: string;
  lastError: string | null;
  attemptCount: number;
  lastAttemptAt: string | null;
  updatedAt: string;
  chat: { id: string; title: string | null; username: string | null };
};

export type Giveaway = {
  id: string;
  title: string;
  prize: string;
  winnersCount: number;
  drawAt: string;
  status: string;
  lastError: string | null;
  attemptCount: number;
  lastAttemptAt: string | null;
  chat: { id: string; title: string | null };
  creator: { id: string; username: string | null; firstName: string | null };
  _count: { entries: number };
};

export type PointTransaction = {
  id: string;
  type: string;
  delta: number;
  balanceAfter: number | null;
  note: string | null;
  createdAt: string;
  chat: { id: string; title: string | null };
  user: { id: string; telegramUserId: string; username: string | null; firstName: string | null };
  actor: { id: string; username: string | null; firstName: string | null } | null;
};

export type PointProduct = {
  id: string;
  chatId: string;
  externalId: string;
  name: string;
  cost: number;
  listed: boolean;
  dailyLimit: number;
  soldCount: number;
  availableCodes: string[];
  createdAt: string;
  updatedAt: string;
  chat: { id: string; title: string | null };
  _count: { codes: number; redemptions: number };
};

export type PointRedemption = {
  id: string;
  cost: number;
  status: string;
  deliveryError: string | null;
  deliveredAt: string | null;
  refundedAt: string | null;
  createdAt: string;
  chat: { id: string; title: string | null };
  product: { externalId: string; name: string };
  code: { value: string };
  user: { id: string; telegramUserId: string; username: string | null; firstName: string | null };
};

export type BotSubscription = {
  id: string;
  userId: string;
  expiresAt: string;
  status: string;
  source: string;
  user: { id: string; telegramUserId: string; username: string | null; firstName: string | null };
};

export type PaymentOrder = {
  id: string;
  userId: string;
  planKey: string;
  months: number;
  amountUsd: string;
  provider: string;
  payCurrency: string | null;
  providerPaymentId: string | null;
  payUrl: string | null;
  status: string;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
  user: { id: string; telegramUserId: string; username: string | null; firstName: string | null };
};

export type MembershipUiSettings = {
  plansTabLabel: string;
};

export type MembershipOverview = {
  checkedAt: string;
  paymentConfigured: boolean;
  metrics: {
    activeMembers: number;
    expiringMembers: number;
    waitingPayments: number;
    paidOrders30d: number;
    failedPayments30d: number;
    refundedOrders30d: number;
    revenue30dUsd: string;
  };
  plans: Array<{ key: string; months: number; amountUsd: string; label: string }>;
  featureLimits: {
    free: Record<string, number>;
    premium: Record<string, number>;
  };
  recentOrders: PaymentOrder[];
};

export type PaymentSettings = {
  provider: string;
  configured: boolean;
  mode: string;
  webhookPath: string;
  webhookUrl: string | null;
  fields: Array<{ key: string; label: string; value: string | null; configured: boolean; secret: boolean }>;
  checklist: Array<{ label: string; done: boolean }>;
};

export type ModerationEvent = {
  id: string;
  telegramUserId: string | null;
  eventType: string;
  action: string;
  reason: string | null;
  matchedPattern: string | null;
  messageId: number | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  chat: { id: string; title: string | null };
};

export type AuditLog = {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  chat: { id: string; title: string | null } | null;
  actor: { id: string; username: string | null; firstName: string | null } | null;
};

export type AdminRole = "owner" | "admin" | "operator" | "viewer";

export type AdminAccount = {
  id: string;
  username: string;
  role: AdminRole;
  enabled: boolean;
  bootstrapManaged: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
};
