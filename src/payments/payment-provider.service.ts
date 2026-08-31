import type { PaymentProvider, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export const paymentProviderKeys = ["easypay", "alipay", "wxpay", "stripe", "airwallex", "nowpayments"] as const;
export type PaymentProviderKey = (typeof paymentProviderKeys)[number];

export const providerWebhookPaths: Record<PaymentProviderKey, string> = {
  easypay: "/api/payments/webhook/easypay",
  alipay: "/api/payments/webhook/alipay",
  wxpay: "/api/payments/webhook/wxpay",
  stripe: "/api/payments/webhook/stripe",
  airwallex: "/api/payments/webhook/airwallex",
  nowpayments: "/api/payments/nowpayments/ipn"
};

export const paymentReturnPath = "/payments/result";

export const providerDefaultSupportedTypes: Record<PaymentProviderKey, string[]> = {
  easypay: ["alipay", "wxpay"],
  alipay: ["alipay"],
  wxpay: ["wxpay"],
  stripe: ["card", "alipay", "wxpay", "link"],
  airwallex: ["airwallex"],
  nowpayments: ["crypto"]
};

export const providerConfigFields: Record<PaymentProviderKey, string[]> = {
  easypay: ["pid", "pkey", "apiBase", "cidAlipay", "cidWxpay", "notifyUrl", "returnUrl"],
  alipay: ["appId", "privateKey", "publicKey", "notifyUrl", "returnUrl"],
  wxpay: ["appId", "mchId", "privateKey", "apiV3Key", "certSerial", "publicKey", "publicKeyId", "notifyUrl"],
  stripe: ["secretKey", "publishableKey", "webhookSecret", "currency", "notifyUrl", "returnUrl"],
  airwallex: ["clientId", "apiKey", "webhookSecret", "apiBase", "countryCode", "currency", "accountId", "notifyUrl", "returnUrl"],
  nowpayments: ["apiKey", "ipnSecret", "apiBase", "notifyUrl"]
};

export const providerConfigDefaults: Record<PaymentProviderKey, Record<string, string>> = {
  easypay: { pid: "", pkey: "", apiBase: "", cidAlipay: "", cidWxpay: "", notifyUrl: "", returnUrl: "" },
  alipay: { appId: "", privateKey: "", publicKey: "", notifyUrl: "", returnUrl: "" },
  wxpay: { appId: "", mchId: "", privateKey: "", apiV3Key: "", certSerial: "", publicKey: "", publicKeyId: "", notifyUrl: "" },
  stripe: { secretKey: "", publishableKey: "", webhookSecret: "", currency: "USD", notifyUrl: "", returnUrl: "" },
  airwallex: { clientId: "", apiKey: "", webhookSecret: "", apiBase: "https://api.airwallex.com/api/v1", countryCode: "CN", currency: "USD", accountId: "", notifyUrl: "", returnUrl: "" },
  nowpayments: { apiKey: "", ipnSecret: "", apiBase: "https://api.nowpayments.io/v1", notifyUrl: "" }
};

export const providerSensitiveConfigFields: Record<PaymentProviderKey, ReadonlySet<string>> = {
  easypay: new Set(["pkey"]),
  alipay: new Set(["privateKey", "publicKey"]),
  wxpay: new Set(["privateKey", "apiV3Key", "publicKey"]),
  stripe: new Set(["secretKey", "webhookSecret"]),
  airwallex: new Set(["apiKey", "webhookSecret"]),
  nowpayments: new Set(["apiKey", "ipnSecret"])
};

const providerDefaultNames: Record<PaymentProviderKey, string> = {
  easypay: "易支付",
  alipay: "支付宝官方",
  wxpay: "微信官方",
  stripe: "Stripe",
  airwallex: "Airwallex",
  nowpayments: "NOWPayments"
};

export type PaymentLimitRule = { singleMin?: number; singleMax?: number; dailyLimit?: number };

export type PaymentProviderView = {
  id: number;
  name: string;
  providerKey: PaymentProviderKey;
  enabled: boolean;
  refundEnabled: boolean;
  supportedTypes: string[];
  config: Record<string, string>;
  limits: Record<string, PaymentLimitRule>;
  publicBaseUrl: string;
  sortOrder: number;
  secretConfigured: boolean;
  secretMasked: string;
  webhookPath: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PaymentProviderInput = {
  name?: string | undefined;
  providerKey?: string | undefined;
  enabled?: boolean | undefined;
  refundEnabled?: boolean | undefined;
  supportedTypes?: string[] | undefined;
  config?: Record<string, string> | undefined;
  limits?: string | Record<string, Record<string, number | string>> | undefined;
  publicBaseUrl?: string | undefined;
  sortOrder?: number | undefined;
};

export function normalizeProviderKey(value: unknown): PaymentProviderKey {
  const key = String(value ?? "").trim();
  return (paymentProviderKeys as readonly string[]).includes(key) ? key as PaymentProviderKey : "easypay";
}

export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 2)}${"*".repeat(6)}${value.slice(-4)}`;
}

function decodeRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

export function defaultProviderConfig(providerKey: PaymentProviderKey): Record<string, string> {
  return { ...providerConfigDefaults[providerKey] };
}

export function normalizeProviderConfig(providerKey: PaymentProviderKey, incoming: unknown, current?: Record<string, unknown>): Record<string, string> {
  const fields = providerConfigFields[providerKey];
  const sensitive = providerSensitiveConfigFields[providerKey];
  const merged = defaultProviderConfig(providerKey);
  if (current) {
    for (const [key, value] of Object.entries(current)) {
      if (value !== null && value !== undefined) merged[key] = String(value);
    }
  }
  const source = decodeRecord(incoming);
  for (const key of fields) {
    if (!(key in source)) continue;
    const next = source[key];
    if (next === null || next === undefined) continue;
    const text = String(next);
    if (text === "" && sensitive.has(key)) continue;
    merged[key] = text;
  }
  return Object.fromEntries(fields.map((key) => [key, String(merged[key] ?? "")]));
}

export function providerConfigResponse(providerKey: PaymentProviderKey, config: Record<string, string>, revealSecret: boolean): Record<string, string> {
  const sensitive = providerSensitiveConfigFields[providerKey];
  const result: Record<string, string> = {};
  for (const key of providerConfigFields[providerKey]) {
    if (!revealSecret && sensitive.has(key)) continue;
    result[key] = String(config[key] ?? "");
  }
  return result;
}

export function providerSecret(providerKey: PaymentProviderKey, config: Record<string, string>): string {
  if (providerKey === "easypay") return config.pkey ?? "";
  return config.privateKey || config.secretKey || config.apiKey || config.ipnSecret || config.webhookSecret || "";
}

export function normalizePaymentLimits(value: unknown): Record<string, PaymentLimitRule> {
  const source = decodeRecord(value);
  const result: Record<string, PaymentLimitRule> = {};
  for (const [method, raw] of Object.entries(source)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const rule: PaymentLimitRule = {};
    for (const [from, to] of [["single_min", "singleMin"], ["singleMin", "singleMin"], ["single_max", "singleMax"], ["singleMax", "singleMax"], ["daily_limit", "dailyLimit"], ["dailyLimit", "dailyLimit"]] as const) {
      const candidate = item[from];
      if (candidate === "" || candidate === null || candidate === undefined) continue;
      const parsed = Number(candidate);
      if (Number.isFinite(parsed) && parsed >= 0) rule[to] = parsed;
    }
    if (Object.keys(rule).length) result[method] = rule;
  }
  return result;
}

function sanitizeSupportedTypes(value: unknown, providerKey: PaymentProviderKey): string[] {
  const list = Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
  return list.length ? list : [...providerDefaultSupportedTypes[providerKey]];
}

function decodeProvider(row: PaymentProvider, revealSecret: boolean): PaymentProviderView {
  const providerKey = normalizeProviderKey(row.providerKey);
  const config = normalizeProviderConfig(providerKey, decodeRecord(row.config));
  const secret = providerSecret(providerKey, config);
  return {
    id: row.id,
    name: row.name,
    providerKey,
    enabled: row.enabled,
    refundEnabled: row.refundEnabled,
    supportedTypes: sanitizeSupportedTypes(row.supportedTypes, providerKey),
    config: providerConfigResponse(providerKey, config, revealSecret),
    limits: normalizePaymentLimits(row.limits),
    publicBaseUrl: row.publicBaseUrl,
    sortOrder: row.sortOrder,
    secretConfigured: Boolean(secret),
    secretMasked: maskSecret(secret),
    webhookPath: providerWebhookPaths[providerKey],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export async function listPaymentProviders(revealSecret = false): Promise<PaymentProviderView[]> {
  const rows = await prisma.paymentProvider.findMany({ orderBy: [{ sortOrder: "asc" }, { id: "asc" }] });
  return rows.map((row) => decodeProvider(row, revealSecret));
}

export async function getPaymentProvider(id: number, revealSecret = false): Promise<PaymentProviderView | null> {
  const row = await prisma.paymentProvider.findUnique({ where: { id } });
  return row ? decodeProvider(row, revealSecret) : null;
}

export async function createPaymentProvider(input: PaymentProviderInput): Promise<PaymentProviderView> {
  const providerKey = normalizeProviderKey(input.providerKey);
  const existing = await prisma.paymentProvider.count();
  const created = await prisma.paymentProvider.create({
    data: {
      name: (input.name ?? "").trim() || providerDefaultNames[providerKey],
      providerKey,
      enabled: existing === 0 ? true : input.enabled ?? true,
      refundEnabled: input.refundEnabled ?? true,
      supportedTypes: sanitizeSupportedTypes(input.supportedTypes, providerKey),
      config: normalizeProviderConfig(providerKey, input.config ?? {}),
      limits: normalizePaymentLimits(input.limits) as Prisma.InputJsonValue,
      publicBaseUrl: (input.publicBaseUrl ?? "").trim(),
      sortOrder: input.sortOrder ?? 0
    }
  });
  const row = input.sortOrder === undefined
    ? await prisma.paymentProvider.update({ where: { id: created.id }, data: { sortOrder: created.id } })
    : created;
  return decodeProvider(row, false);
}

export async function updatePaymentProvider(id: number, input: PaymentProviderInput): Promise<PaymentProviderView | null> {
  const current = await prisma.paymentProvider.findUnique({ where: { id } });
  if (!current) return null;
  const providerKey = normalizeProviderKey(current.providerKey);
  const updated = await prisma.paymentProvider.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim() || current.name } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.refundEnabled !== undefined ? { refundEnabled: input.refundEnabled } : {}),
      ...(input.supportedTypes !== undefined ? { supportedTypes: sanitizeSupportedTypes(input.supportedTypes, providerKey) } : {}),
      ...(input.config !== undefined ? { config: normalizeProviderConfig(providerKey, input.config, decodeRecord(current.config)) } : {}),
      ...(input.limits !== undefined ? { limits: normalizePaymentLimits(input.limits) as Prisma.InputJsonValue } : {}),
      ...(input.publicBaseUrl !== undefined ? { publicBaseUrl: input.publicBaseUrl.trim() } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {})
    }
  });
  return decodeProvider(updated, false);
}

export async function deletePaymentProvider(id: number): Promise<boolean> {
  const result = await prisma.paymentProvider.deleteMany({ where: { id } });
  return result.count > 0;
}

export function primaryPaymentProvider(providers: PaymentProviderView[]): PaymentProviderView | null {
  return providers.find((provider) => provider.enabled) ?? providers[0] ?? null;
}

export function choosePayType(provider: PaymentProviderView, requested: string): string {
  if (requested && provider.supportedTypes.includes(requested)) return requested;
  if (provider.supportedTypes.length) return provider.supportedTypes[0]!;
  if (provider.providerKey === "wxpay") return "wxpay";
  if (provider.providerKey === "stripe") return "card";
  if (provider.providerKey === "airwallex") return "airwallex";
  if (provider.providerKey === "nowpayments") return "crypto";
  return "alipay";
}

export async function selectPaymentProvider(requestedPayType = ""): Promise<{ provider: PaymentProviderView; payType: string } | null> {
  const providers = await listPaymentProviders(true);
  const enabled = providers.filter((provider) => provider.enabled);
  if (!enabled.length) return null;
  if (requestedPayType) {
    const match = enabled.find((provider) => provider.supportedTypes.includes(requestedPayType));
    if (match) return { provider: match, payType: requestedPayType };
  }
  const provider = enabled[0]!;
  return { provider, payType: choosePayType(provider, requestedPayType) };
}

export function validateSinglePaymentLimit(provider: PaymentProviderView, payType: string, amountUsd: number): void {
  const rule = provider.limits[payType]
    ?? provider.limits[provider.providerKey]
    ?? (provider.providerKey === "stripe" ? provider.limits.stripe : undefined)
    ?? {};
  if (rule.singleMin !== undefined && amountUsd < rule.singleMin) {
    throw new Error(`订单金额低于服务商单笔最低限额 ${rule.singleMin}`);
  }
  if (rule.singleMax !== undefined && amountUsd > rule.singleMax) {
    throw new Error(`订单金额高于服务商单笔最高限额 ${rule.singleMax}`);
  }
}

export async function findEnabledProvider(providerKey: PaymentProviderKey): Promise<PaymentProviderView | null> {
  const providers = await listPaymentProviders(true);
  return providers.find((provider) => provider.enabled && provider.providerKey === providerKey) ?? null;
}

export async function findEasypayProviderForCallback(params: Record<string, string>, verify: (params: Record<string, string>, key: string) => boolean): Promise<PaymentProviderView | null> {
  const merchantId = String(params.pid ?? "").trim();
  const providers = await listPaymentProviders(true);
  const candidates = providers.filter((provider) =>
    provider.enabled
    && provider.providerKey === "easypay"
    && Boolean(provider.config.pkey)
    && (!merchantId || String(provider.config.pid ?? "") === merchantId));
  return candidates.find((provider) => verify(params, provider.config.pkey ?? "")) ?? null;
}
