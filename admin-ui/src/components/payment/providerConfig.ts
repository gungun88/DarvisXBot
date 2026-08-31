import type { PaymentProviderKey } from "../../types";

export type ConfigFieldDef = {
  key: string;
  label: string;
  sensitive: boolean;
  optional?: boolean;
  defaultValue?: string;
  type?: "text" | "password" | "textarea" | "select";
  options?: Array<{ value: string; label: string }>;
};

export const PROVIDER_KEYS: PaymentProviderKey[] = ["easypay", "alipay", "wxpay", "stripe", "airwallex", "nowpayments"];

export const PROVIDER_SUPPORTED_TYPES: Record<string, string[]> = {
  easypay: ["alipay", "wxpay"],
  alipay: ["alipay"],
  wxpay: ["wxpay"],
  stripe: ["card", "alipay", "wxpay", "link"],
  airwallex: ["airwallex"],
  nowpayments: ["crypto"]
};

export const PAYMENT_CURRENCY_OPTIONS = [
  { value: "USD", label: "USD" },
  { value: "CNY", label: "CNY" },
  { value: "HKD", label: "HKD" },
  { value: "EUR", label: "EUR" },
  { value: "GBP", label: "GBP" },
  { value: "AUD", label: "AUD" },
  { value: "CAD", label: "CAD" },
  { value: "SGD", label: "SGD" },
  { value: "JPY", label: "JPY" },
  { value: "KRW", label: "KRW" },
  { value: "NZD", label: "NZD" }
];

export const WEBHOOK_PATHS: Record<string, string> = {
  easypay: "/api/payments/webhook/easypay",
  alipay: "/api/payments/webhook/alipay",
  wxpay: "/api/payments/webhook/wxpay",
  stripe: "/api/payments/webhook/stripe",
  airwallex: "/api/payments/webhook/airwallex",
  nowpayments: "/api/payments/nowpayments/ipn"
};

export const RETURN_PATH = "/payments/result";

export const PROVIDER_CALLBACK_PATHS: Record<string, { notifyUrl?: string; returnUrl?: string }> = {
  easypay: { notifyUrl: WEBHOOK_PATHS.easypay, returnUrl: RETURN_PATH },
  alipay: { notifyUrl: WEBHOOK_PATHS.alipay, returnUrl: RETURN_PATH },
  wxpay: { notifyUrl: WEBHOOK_PATHS.wxpay },
  stripe: { notifyUrl: WEBHOOK_PATHS.stripe, returnUrl: RETURN_PATH },
  airwallex: { notifyUrl: WEBHOOK_PATHS.airwallex, returnUrl: RETURN_PATH },
  nowpayments: { notifyUrl: WEBHOOK_PATHS.nowpayments }
};

export const PROVIDER_CONFIG_FIELDS: Record<string, ConfigFieldDef[]> = {
  easypay: [
    { key: "pid", label: "PID（商户 ID）", sensitive: false },
    { key: "pkey", label: "PKey（商户密钥）", sensitive: true },
    { key: "apiBase", label: "API 基础地址", sensitive: false },
    { key: "cidAlipay", label: "支付宝渠道 ID", sensitive: false, optional: true },
    { key: "cidWxpay", label: "微信渠道 ID", sensitive: false, optional: true }
  ],
  alipay: [
    { key: "appId", label: "App ID", sensitive: false },
    { key: "privateKey", label: "私钥", sensitive: true, type: "textarea" },
    { key: "publicKey", label: "公钥", sensitive: true, type: "textarea" }
  ],
  wxpay: [
    { key: "appId", label: "App ID", sensitive: false },
    { key: "mchId", label: "商户号", sensitive: false },
    { key: "privateKey", label: "私钥", sensitive: true, type: "textarea" },
    { key: "apiV3Key", label: "API v3 密钥", sensitive: true, type: "textarea" },
    { key: "certSerial", label: "证书序列号", sensitive: false },
    { key: "publicKey", label: "公钥", sensitive: true, type: "textarea" },
    { key: "publicKeyId", label: "公钥 ID", sensitive: false, optional: true }
  ],
  stripe: [
    { key: "secretKey", label: "密钥", sensitive: true, type: "textarea" },
    { key: "publishableKey", label: "公开密钥", sensitive: false },
    { key: "webhookSecret", label: "Webhook 密钥", sensitive: true },
    { key: "currency", label: "支付币种", sensitive: false, defaultValue: "USD", type: "select", options: PAYMENT_CURRENCY_OPTIONS }
  ],
  airwallex: [
    { key: "clientId", label: "Client ID", sensitive: false },
    { key: "apiKey", label: "API Key", sensitive: true, type: "textarea" },
    { key: "webhookSecret", label: "Webhook 密钥", sensitive: true },
    { key: "apiBase", label: "API 基础地址", sensitive: false, defaultValue: "https://api.airwallex.com/api/v1" },
    { key: "countryCode", label: "国家/地区代码", sensitive: false, defaultValue: "CN" },
    { key: "currency", label: "支付币种", sensitive: false, defaultValue: "USD", type: "select", options: PAYMENT_CURRENCY_OPTIONS },
    { key: "accountId", label: "Airwallex 账户 ID", sensitive: false, optional: true }
  ],
  nowpayments: [
    { key: "apiKey", label: "API Key", sensitive: true },
    { key: "ipnSecret", label: "IPN Secret", sensitive: true },
    { key: "apiBase", label: "API 基础地址", sensitive: false, defaultValue: "https://api.nowpayments.io/v1" }
  ]
};

export function providerLabel(providerKey: string) {
  const labels: Record<string, string> = {
    easypay: "易支付",
    alipay: "支付宝官方",
    wxpay: "微信官方",
    stripe: "Stripe",
    airwallex: "Airwallex",
    nowpayments: "NOWPayments"
  };
  return labels[providerKey] ?? providerKey;
}

export function typeLabel(type: string) {
  const labels: Record<string, string> = {
    alipay: "支付宝",
    wxpay: "微信支付",
    card: "银行卡",
    link: "Link",
    airwallex: "Airwallex",
    crypto: "加密货币"
  };
  return labels[type] ?? type;
}

export function webhookNote(providerKey: string) {
  if (providerKey === "stripe") {
    return "请在 Stripe Dashboard 中将以下地址配置为 Webhook 端点，事件至少选择 checkout.session.completed：";
  }
  if (providerKey === "airwallex") {
    return "请在 Airwallex 后台将以下地址配置为 Webhook 端点；事件至少选择 Payment Intent -> Succeeded（payment_intent.succeeded）：";
  }
  if (providerKey === "nowpayments") {
    return "请在 NOWPayments 后台 Settings -> Payments -> Instant payment notifications 中保存以下回调地址：";
  }
  return "";
}

export function providerWebhookUrl(providerKey: string, origin: string) {
  const path = WEBHOOK_PATHS[providerKey];
  if (!path) return "";
  return `${origin.replace(/\/$/, "")}${path}`;
}
