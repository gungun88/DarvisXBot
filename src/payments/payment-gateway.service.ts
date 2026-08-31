import { createDecipheriv, createHash, createHmac, createSign, createVerify, randomBytes, timingSafeEqual } from "node:crypto";
import type { AppConfig } from "../lib/config.js";
import {
  paymentReturnPath,
  providerWebhookPaths,
  selectPaymentProvider,
  validateSinglePaymentLimit,
  type PaymentProviderView
} from "./payment-provider.service.js";

export const EASYPAY_SUCCESS_STATUS = "TRADE_SUCCESS";

const STRIPE_CHECKOUT_SESSION_URL = "https://api.stripe.com/v1/checkout/sessions";
const ALIPAY_GATEWAY_URL = "https://openapi.alipay.com/gateway.do";
const WXPAY_NATIVE_URL = "https://api.mch.weixin.qq.com/v3/pay/transactions/native";

export type PaymentIntentOrder = {
  id: string;
  amountUsd: string;
  planLabel: string;
  userId: string;
};

export type PaymentIntentResult = {
  providerKey: string;
  payType: string;
  paymentUrl: string;
  providerOrderId: string;
  raw?: Record<string, unknown> | undefined;
};

export function moneyFromUsd(amountUsd: string | number): string {
  const amount = Number(amountUsd);
  if (!Number.isFinite(amount)) throw new Error("订单金额无效");
  return amount.toFixed(2);
}

export function minorUnitsFromUsd(amountUsd: string | number): number {
  const amount = Number(amountUsd);
  if (!Number.isFinite(amount)) throw new Error("订单金额无效");
  return Math.round(amount * 100);
}

export function minorUnitsFromMoney(value: unknown): number {
  const amount = Number(String(value ?? "0"));
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100);
}

export function publicBaseUrl(provider: PaymentProviderView | null, config: AppConfig): string {
  const configured = (provider?.publicBaseUrl || config.publicBaseUrl || "").trim().replace(/\/$/, "");
  if (!configured) throw new Error("服务商未配置公网地址，且 PUBLIC_BASE_URL 未设置");
  return configured;
}

export function paymentResultUrl(base: string, orderId: string, ok: boolean): string {
  const target = `${base}${paymentReturnPath}`;
  const query = new URLSearchParams({ payment: ok ? "success" : "failed", order: orderId });
  return `${target}?${query.toString()}`;
}

// ---------------------------------------------------------------------------
// EasyPay (易支付)
// ---------------------------------------------------------------------------

function signContentEntries(params: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(params)
    .filter(([key, value]) => key !== "sign" && key !== "sign_type" && value !== null && value !== undefined && String(value) !== "")
    .map(([key, value]) => [key, String(value)] as [string, string])
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}

export function signEasypayParams(params: Record<string, unknown>, key: string): string {
  const payload = signContentEntries(params).map(([name, value]) => `${name}=${value}`).join("&");
  return createHash("md5").update(payload + key, "utf8").digest("hex");
}

export function verifyEasypaySignature(params: Record<string, string>, key: string): boolean {
  const received = String(params.sign ?? "").toLowerCase();
  if (!received) return false;
  return signEasypayParams(params, key).toLowerCase() === received;
}

export function deriveEasypayUrls(apiBase: string): { submitUrl: string; mapiUrl: string; apiUrl: string } {
  const base = String(apiBase ?? "").trim().replace(/\/$/, "");
  if (!base) return { submitUrl: "", mapiUrl: "", apiUrl: "" };
  return { submitUrl: `${base}/submit.php`, mapiUrl: `${base}/mapi.php`, apiUrl: `${base}/api.php` };
}

function buildEasypaySubmitUrl(order: PaymentIntentOrder, payType: string, provider: PaymentProviderView, config: AppConfig): string {
  const pid = String(provider.config.pid ?? "").trim();
  const pkey = String(provider.config.pkey ?? "").trim();
  const { submitUrl } = deriveEasypayUrls(provider.config.apiBase ?? "");
  if (!pid || !pkey || !submitUrl) throw new Error("易支付商户 ID、密钥或 API 地址未配置");
  if (payType !== "alipay" && payType !== "wxpay") throw new Error("支付方式无效");
  const base = publicBaseUrl(provider, config);
  const notifyUrl = String(provider.config.notifyUrl ?? "").trim() || `${base}${providerWebhookPaths.easypay}`;
  const returnUrl = String(provider.config.returnUrl ?? "").trim() || `${base}${paymentReturnPath}`;
  const params: Record<string, string> = {
    pid,
    type: payType,
    out_trade_no: order.id,
    notify_url: notifyUrl,
    return_url: returnUrl,
    name: `DarvisXBot ${order.planLabel}`,
    money: moneyFromUsd(order.amountUsd),
    param: order.userId,
    sign_type: "MD5"
  };
  const channelId = payType === "wxpay" ? String(provider.config.cidWxpay ?? "") : String(provider.config.cidAlipay ?? "");
  if (channelId) params.cid = channelId;
  params.sign = signEasypayParams(params, pkey);
  return `${submitUrl}?${new URLSearchParams(params).toString()}`;
}

// ---------------------------------------------------------------------------
// Alipay official (支付宝官方)
// ---------------------------------------------------------------------------

export function normalizePem(value: string, marker: string): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text.includes("-----BEGIN")) return text;
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += 64) chunks.push(text.slice(index, index + 64));
  return `-----BEGIN ${marker}-----\n${chunks.join("\n")}\n-----END ${marker}-----`;
}

export function alipaySignContent(params: Record<string, unknown>): string {
  return signContentEntries(params).map(([name, value]) => `${name}=${value}`).join("&");
}

export function rsa2Sign(privateKey: string, content: string): string {
  return createSign("RSA-SHA256").update(content, "utf8").sign(normalizePem(privateKey, "PRIVATE KEY"), "base64");
}

export function verifyAlipaySignature(params: Record<string, string>, publicKey: string): boolean {
  const signature = String(params.sign ?? "");
  if (!signature || !publicKey) return false;
  try {
    return createVerify("RSA-SHA256")
      .update(alipaySignContent(params), "utf8")
      .verify(normalizePem(publicKey, "PUBLIC KEY"), signature, "base64");
  } catch {
    return false;
  }
}

function createAlipayPagePayUrl(order: PaymentIntentOrder, payType: string, provider: PaymentProviderView, config: AppConfig): PaymentIntentResult {
  const appId = String(provider.config.appId ?? "").trim();
  const privateKey = String(provider.config.privateKey ?? "").trim();
  if (!appId || !privateKey) throw new Error("支付宝 App ID 或私钥未配置");
  const base = publicBaseUrl(provider, config);
  const returnUrl = String(provider.config.returnUrl ?? "").trim() || paymentResultUrl(base, order.id, true);
  const notifyUrl = String(provider.config.notifyUrl ?? "").trim() || `${base}${providerWebhookPaths.alipay}`;
  const timestamp = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
  const params: Record<string, string> = {
    app_id: appId,
    method: "alipay.trade.page.pay",
    format: "JSON",
    charset: "utf-8",
    sign_type: "RSA2",
    timestamp,
    version: "1.0",
    notify_url: notifyUrl,
    return_url: returnUrl,
    biz_content: JSON.stringify({
      out_trade_no: order.id,
      product_code: "FAST_INSTANT_TRADE_PAY",
      total_amount: moneyFromUsd(order.amountUsd),
      subject: `DarvisXBot ${order.planLabel}`
    })
  };
  params.sign = rsa2Sign(privateKey, alipaySignContent(params));
  return {
    providerKey: "alipay",
    payType: payType || "alipay",
    paymentUrl: `${ALIPAY_GATEWAY_URL}?${new URLSearchParams(params).toString()}`,
    providerOrderId: ""
  };
}

// ---------------------------------------------------------------------------
// WeChat Pay official (微信官方 API v3)
// ---------------------------------------------------------------------------

export function wechatpayAuthorization(input: { method: string; urlPath: string; body: string; mchId: string; certSerial: string; privateKey: string }): string {
  const nonce = randomBytes(16).toString("hex");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const message = `${input.method}\n${input.urlPath}\n${timestamp}\n${nonce}\n${input.body}\n`;
  const signature = createSign("RSA-SHA256").update(message, "utf8").sign(normalizePem(input.privateKey, "PRIVATE KEY"), "base64");
  return `WECHATPAY2-SHA256-RSA2048 mchid="${input.mchId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${input.certSerial}",signature="${signature}"`;
}

async function createWxpayNativePayment(order: PaymentIntentOrder, payType: string, provider: PaymentProviderView, config: AppConfig): Promise<PaymentIntentResult> {
  const appId = String(provider.config.appId ?? "").trim();
  const mchId = String(provider.config.mchId ?? "").trim();
  const privateKey = String(provider.config.privateKey ?? "").trim();
  const certSerial = String(provider.config.certSerial ?? "").trim();
  if (!appId || !mchId || !privateKey || !certSerial) throw new Error("微信支付 App ID、商户号、私钥或证书序列号未配置");
  const base = publicBaseUrl(provider, config);
  const notifyUrl = String(provider.config.notifyUrl ?? "").trim() || `${base}${providerWebhookPaths.wxpay}`;
  const body = JSON.stringify({
    appid: appId,
    mchid: mchId,
    description: `DarvisXBot ${order.planLabel}`.slice(0, 127),
    out_trade_no: order.id,
    notify_url: notifyUrl,
    amount: { total: minorUnitsFromUsd(order.amountUsd), currency: "CNY" }
  });
  const response = await fetch(WXPAY_NATIVE_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: wechatpayAuthorization({ method: "POST", urlPath: "/v3/pay/transactions/native", body, mchId, certSerial, privateKey })
    },
    body
  });
  const payload = await response.json().catch(() => ({})) as { code_url?: string; message?: string };
  if (!response.ok) throw new Error(`微信支付创建订单失败：${payload.message ?? response.status}`);
  const codeUrl = String(payload.code_url ?? "");
  if (!codeUrl) throw new Error("微信支付未返回二维码链接");
  const pageUrl = `${base}/api/payments/wxpay/native-page?${new URLSearchParams({ code_url: codeUrl, order: order.id }).toString()}`;
  return { providerKey: "wxpay", payType: payType || "wxpay", paymentUrl: pageUrl, providerOrderId: "" };
}

export function verifyWxpaySignature(payload: string, headers: Record<string, string | undefined>, publicKey: string): boolean {
  const signature = headers["wechatpay-signature"] ?? "";
  const timestamp = headers["wechatpay-timestamp"] ?? "";
  const nonce = headers["wechatpay-nonce"] ?? "";
  if (!signature || !timestamp || !nonce || !publicKey) return false;
  const message = `${timestamp}\n${nonce}\n${payload}\n`;
  try {
    return createVerify("RSA-SHA256").update(message, "utf8").verify(normalizePem(publicKey, "PUBLIC KEY"), signature, "base64");
  } catch {
    return false;
  }
}

export function decryptWxpayResource(resource: Record<string, unknown>, apiV3Key: string): Record<string, unknown> {
  const key = Buffer.from(String(apiV3Key ?? ""), "utf8");
  if (key.length !== 32) throw new Error("微信 API v3 密钥长度无效");
  const nonce = Buffer.from(String(resource.nonce ?? ""), "utf8");
  const associatedData = Buffer.from(String(resource.associated_data ?? ""), "utf8");
  const combined = Buffer.from(String(resource.ciphertext ?? ""), "base64");
  if (combined.length <= 16) throw new Error("微信支付回调解密失败");
  const authTag = combined.subarray(combined.length - 16);
  const ciphertext = combined.subarray(0, combined.length - 16);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(associatedData);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(plaintext) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid payload");
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("微信支付回调解密失败");
  }
}

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

function stripePaymentMethodTypes(payType: string): string[] {
  const mapping: Record<string, string> = { card: "card", alipay: "alipay", wxpay: "wechat_pay", link: "link", stripe: "card" };
  return [mapping[payType] ?? "card"];
}

async function createStripeCheckoutSession(order: PaymentIntentOrder, payType: string, provider: PaymentProviderView, config: AppConfig): Promise<PaymentIntentResult> {
  const secretKey = String(provider.config.secretKey ?? "").trim();
  if (!secretKey) throw new Error("Stripe 密钥未配置");
  const base = publicBaseUrl(provider, config);
  const currency = (String(provider.config.currency ?? "").trim() || "USD").toLowerCase();
  const data = new URLSearchParams({
    mode: "payment",
    success_url: paymentResultUrl(base, order.id, true),
    cancel_url: paymentResultUrl(base, order.id, false),
    client_reference_id: order.id,
    "metadata[order_id]": order.id,
    "payment_intent_data[metadata][order_id]": order.id,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": currency,
    "line_items[0][price_data][unit_amount]": String(minorUnitsFromUsd(order.amountUsd)),
    "line_items[0][price_data][product_data][name]": `DarvisXBot ${order.planLabel}`
  });
  stripePaymentMethodTypes(payType).forEach((methodType, index) => data.set(`payment_method_types[${index}]`, methodType));
  const response = await fetch(STRIPE_CHECKOUT_SESSION_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/x-www-form-urlencoded" },
    body: data.toString()
  });
  const payload = await response.json().catch(() => ({})) as { id?: string; url?: string; error?: { message?: string } };
  if (!response.ok) throw new Error(`Stripe 创建支付失败：${payload.error?.message ?? response.status}`);
  if (!payload.url) throw new Error("Stripe 未返回支付链接");
  return { providerKey: "stripe", payType, paymentUrl: payload.url, providerOrderId: String(payload.id ?? "") };
}

export function verifyStripeSignature(payload: string, signatureHeader: string, webhookSecret: string, toleranceSeconds = 300, nowMs = Date.now()): boolean {
  if (!signatureHeader || !webhookSecret) return false;
  const parts = new Map<string, string[]>();
  for (const item of signatureHeader.split(",")) {
    const index = item.indexOf("=");
    if (index < 0) continue;
    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1);
    parts.set(key, [...parts.get(key) ?? [], value]);
  }
  const timestamp = parts.get("t")?.[0] ?? "";
  const signatures = parts.get("v1") ?? [];
  if (!timestamp || !signatures.length) return false;
  const timestampSeconds = Number(timestamp);
  if (!Number.isInteger(timestampSeconds)) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - timestampSeconds) > toleranceSeconds) return false;
  const expected = createHmac("sha256", webhookSecret).update(`${timestamp}.${payload}`, "utf8").digest("hex");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return signatures.some((signature) => {
    const received = Buffer.from(signature, "utf8");
    return received.length === expectedBuffer.length && timingSafeEqual(received, expectedBuffer);
  });
}

// ---------------------------------------------------------------------------
// Airwallex
// ---------------------------------------------------------------------------

async function createAirwallexPaymentIntent(order: PaymentIntentOrder, payType: string, provider: PaymentProviderView, config: AppConfig): Promise<PaymentIntentResult> {
  const clientId = String(provider.config.clientId ?? "").trim();
  const apiKey = String(provider.config.apiKey ?? "").trim();
  const apiBase = (String(provider.config.apiBase ?? "").trim() || "https://api.airwallex.com/api/v1").replace(/\/$/, "");
  const currency = (String(provider.config.currency ?? "").trim() || "USD").toUpperCase();
  const countryCode = (String(provider.config.countryCode ?? "").trim() || "CN").toUpperCase();
  if (!clientId || !apiKey) throw new Error("Airwallex Client ID 或 API Key 未配置");
  const authResponse = await fetch(`${apiBase}/authentication/login`, {
    method: "POST",
    headers: { "x-client-id": clientId, "x-api-key": apiKey }
  });
  const authPayload = await authResponse.json().catch(() => ({})) as { token?: string };
  if (!authResponse.ok) throw new Error(`Airwallex 登录失败 (${authResponse.status})`);
  const token = String(authPayload.token ?? "");
  if (!token) throw new Error("Airwallex 未返回访问令牌");
  const base = publicBaseUrl(provider, config);
  const intentHeaders: Record<string, string> = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const accountId = String(provider.config.accountId ?? "").trim();
  if (accountId) intentHeaders["x-on-behalf-of"] = accountId;
  const intentResponse = await fetch(`${apiBase}/pa/payment_intents/create`, {
    method: "POST",
    headers: intentHeaders,
    body: JSON.stringify({
      request_id: order.id,
      amount: moneyFromUsd(order.amountUsd),
      currency,
      merchant_order_id: order.id,
      descriptor: `DarvisXBot`.slice(0, 32),
      return_url: paymentResultUrl(base, order.id, true),
      metadata: { order_id: order.id }
    })
  });
  const intentPayload = await intentResponse.json().catch(() => ({})) as { id?: string; client_secret?: string; message?: string };
  if (!intentResponse.ok) throw new Error(`Airwallex 创建支付失败：${intentPayload.message ?? intentResponse.status}`);
  const intentId = String(intentPayload.id ?? "");
  const clientSecret = String(intentPayload.client_secret ?? "");
  if (!intentId || !clientSecret) throw new Error("Airwallex 未返回支付意图");
  const checkoutUrl = `${base}/payments/airwallex/checkout?${new URLSearchParams({
    intent_id: intentId,
    client_secret: clientSecret,
    currency,
    country_code: countryCode,
    order: order.id,
    env: apiBase.includes("api-demo.airwallex.com") ? "demo" : "prod"
  }).toString()}`;
  return { providerKey: "airwallex", payType: payType || "airwallex", paymentUrl: checkoutUrl, providerOrderId: intentId };
}

export function verifyAirwallexSignature(payload: string, timestamp: string, signature: string, webhookSecret: string): boolean {
  if (!timestamp || !signature || !webhookSecret) return false;
  const expected = createHmac("sha256", webhookSecret).update(`${timestamp}.${payload}`, "utf8").digest("hex");
  const received = signature.includes("=") ? signature.slice(signature.lastIndexOf("=") + 1) : signature;
  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(received, "utf8");
  return receivedBuffer.length === expectedBuffer.length && timingSafeEqual(receivedBuffer, expectedBuffer);
}

// ---------------------------------------------------------------------------
// NOWPayments
// ---------------------------------------------------------------------------

export type NowPaymentsAccess = { apiBase: string; apiKey: string; ipnCallbackUrl: string };

export function nowPaymentsAccessFromProvider(provider: PaymentProviderView | null, config: AppConfig): NowPaymentsAccess | null {
  const apiKey = String(provider?.config.apiKey ?? "").trim() || config.nowPaymentsApiKey || "";
  if (!apiKey) return null;
  const apiBase = (String(provider?.config.apiBase ?? "").trim() || config.nowPaymentsApiBase).replace(/\/$/, "");
  const configuredNotify = String(provider?.config.notifyUrl ?? "").trim();
  let ipnCallbackUrl = configuredNotify;
  if (!ipnCallbackUrl) {
    const base = (provider?.publicBaseUrl || config.publicBaseUrl || "").trim().replace(/\/$/, "");
    if (!base) return null;
    ipnCallbackUrl = `${base}${providerWebhookPaths.nowpayments}`;
  }
  return { apiBase, apiKey, ipnCallbackUrl };
}

export async function createNowPaymentsInvoice(access: NowPaymentsAccess, order: PaymentIntentOrder): Promise<PaymentIntentResult> {
  const response = await fetch(`${access.apiBase}/invoice`, {
    method: "POST",
    headers: { "x-api-key": access.apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      price_amount: Number(order.amountUsd),
      price_currency: "usd",
      order_id: order.id,
      order_description: `DarvisXBot ${order.planLabel}`,
      ipn_callback_url: access.ipnCallbackUrl
    })
  });
  const payload = await response.json() as { id?: string | number; invoice_url?: string; message?: string };
  if (!response.ok || !payload.id) throw new Error(payload.message || `支付服务请求失败 (${response.status})`);
  return {
    providerKey: "nowpayments",
    payType: "crypto",
    paymentUrl: String(payload.invoice_url ?? ""),
    providerOrderId: String(payload.id),
    raw: payload as Record<string, unknown>
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function createPaymentIntent(order: PaymentIntentOrder, requestedPayType: string, config: AppConfig): Promise<PaymentIntentResult> {
  const selection = await selectPaymentProvider(requestedPayType);
  if (!selection) throw new Error("未启用支付服务商");
  return createPaymentIntentWithProvider(order, selection.provider, selection.payType, config);
}

export async function createPaymentIntentWithProvider(order: PaymentIntentOrder, provider: PaymentProviderView, payType: string, config: AppConfig): Promise<PaymentIntentResult> {
  validateSinglePaymentLimit(provider, payType, Number(order.amountUsd));
  switch (provider.providerKey) {
    case "easypay":
      return { providerKey: "easypay", payType, paymentUrl: buildEasypaySubmitUrl(order, payType, provider, config), providerOrderId: "" };
    case "stripe":
      return createStripeCheckoutSession(order, payType, provider, config);
    case "alipay":
      return createAlipayPagePayUrl(order, payType, provider, config);
    case "wxpay":
      return createWxpayNativePayment(order, payType, provider, config);
    case "airwallex":
      return createAirwallexPaymentIntent(order, payType, provider, config);
    case "nowpayments": {
      const access = nowPaymentsAccessFromProvider(provider, config);
      if (!access) throw new Error("NOWPayments API Key 或回调地址未配置");
      return createNowPaymentsInvoice(access, order);
    }
    default:
      throw new Error(`${provider.name} 支付创建尚未接入`);
  }
}
