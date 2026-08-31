import assert from "node:assert/strict";
import { createCipheriv, createSign, generateKeyPairSync, randomBytes, createHmac } from "node:crypto";
import test from "node:test";
import {
  alipaySignContent,
  decryptWxpayResource,
  deriveEasypayUrls,
  minorUnitsFromMoney,
  minorUnitsFromUsd,
  moneyFromUsd,
  normalizePem,
  rsa2Sign,
  signEasypayParams,
  verifyAirwallexSignature,
  verifyAlipaySignature,
  verifyEasypaySignature,
  verifyStripeSignature,
  verifyWxpaySignature
} from "../payments/payment-gateway.service.js";
import {
  maskSecret,
  normalizePaymentLimits,
  normalizeProviderConfig,
  providerConfigResponse,
  providerSecret
} from "../payments/payment-provider.service.js";

test("maskSecret hides the middle of long secrets and everything on short ones", () => {
  assert.equal(maskSecret(""), "");
  assert.equal(maskSecret("abcd"), "****");
  assert.equal(maskSecret("12345678"), "********");
  assert.equal(maskSecret("sk_live_abcdef123456"), "sk******3456");
});

test("normalizeProviderConfig keeps stored secrets when the update sends an empty value", () => {
  const current = { pid: "1001", pkey: "old-secret", apiBase: "https://pay.example.com" };
  const next = normalizeProviderConfig("easypay", { pid: "2002", pkey: "", cidAlipay: "77" }, current);
  assert.equal(next.pid, "2002");
  assert.equal(next.pkey, "old-secret");
  assert.equal(next.apiBase, "https://pay.example.com");
  assert.equal(next.cidAlipay, "77");
});

test("normalizeProviderConfig drops unknown keys and accepts JSON strings", () => {
  const next = normalizeProviderConfig("stripe", JSON.stringify({ secretKey: "sk_test_1", hacker: "1", currency: "JPY" }));
  assert.equal(next.secretKey, "sk_test_1");
  assert.equal(next.currency, "JPY");
  assert.equal("hacker" in next, false);
  assert.equal(next.publishableKey, "");
});

test("providerConfigResponse omits sensitive fields unless revealed", () => {
  const config = normalizeProviderConfig("airwallex", { clientId: "cid", apiKey: "ak-secret", webhookSecret: "whs" });
  const masked = providerConfigResponse("airwallex", config, false);
  assert.equal(masked.clientId, "cid");
  assert.equal("apiKey" in masked, false);
  assert.equal("webhookSecret" in masked, false);
  const revealed = providerConfigResponse("airwallex", config, true);
  assert.equal(revealed.apiKey, "ak-secret");
  assert.equal(revealed.webhookSecret, "whs");
  assert.equal(providerSecret("airwallex", config), "ak-secret");
});

test("normalizePaymentLimits accepts camelCase, snake_case, and JSON strings", () => {
  const limits = normalizePaymentLimits({ alipay: { single_min: "1", singleMax: 200 }, wxpay: { dailyLimit: "" }, bad: "x" });
  assert.deepEqual(limits, { alipay: { singleMin: 1, singleMax: 200 } });
  const fromString = normalizePaymentLimits(JSON.stringify({ card: { singleMin: 5 } }));
  assert.deepEqual(fromString, { card: { singleMin: 5 } });
  assert.deepEqual(normalizePaymentLimits("not-json"), {});
});

test("easypay signature roundtrip verifies and rejects tampered params", () => {
  const params: Record<string, string> = {
    pid: "1001",
    type: "alipay",
    out_trade_no: "order-1",
    notify_url: "https://example.com/api/payments/webhook/easypay",
    money: "10.00",
    sign_type: "MD5",
    empty: ""
  };
  const key = "merchant-key";
  const sign = signEasypayParams(params, key);
  assert.match(sign, /^[0-9a-f]{32}$/);
  assert.equal(verifyEasypaySignature({ ...params, sign }, key), true);
  assert.equal(verifyEasypaySignature({ ...params, money: "0.01", sign }, key), false);
  assert.equal(verifyEasypaySignature({ ...params, sign }, "wrong-key"), false);
  // sign/sign_type/empty values must not affect the signature payload
  assert.equal(signEasypayParams({ ...params, sign: "junk" }, key), sign);
});

test("easypay urls derive from the api base", () => {
  assert.deepEqual(deriveEasypayUrls("https://pay.example.com/"), {
    submitUrl: "https://pay.example.com/submit.php",
    mapiUrl: "https://pay.example.com/mapi.php",
    apiUrl: "https://pay.example.com/api.php"
  });
  assert.deepEqual(deriveEasypayUrls(""), { submitUrl: "", mapiUrl: "", apiUrl: "" });
});

test("alipay sign content sorts keys and drops sign fields", () => {
  const content = alipaySignContent({ b: "2", a: "1", sign: "x", sign_type: "RSA2", empty: "" });
  assert.equal(content, "a=1&b=2");
});

test("normalizePem wraps raw base64 and keeps existing pem", () => {
  const pem = "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----";
  assert.equal(normalizePem(pem, "PUBLIC KEY"), pem);
  const wrapped = normalizePem("A".repeat(70), "PRIVATE KEY");
  assert.ok(wrapped.startsWith("-----BEGIN PRIVATE KEY-----\n"));
  assert.ok(wrapped.includes(`\n${"A".repeat(6)}\n`));
  assert.ok(wrapped.endsWith("-----END PRIVATE KEY-----"));
});

test("alipay RSA2 signature roundtrip verifies notify params", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  const params: Record<string, string> = {
    out_trade_no: "order-9",
    trade_no: "2026123456",
    trade_status: "TRADE_SUCCESS",
    total_amount: "10.00",
    sign_type: "RSA2"
  };
  params.sign = rsa2Sign(privateKey, alipaySignContent(params));
  assert.equal(verifyAlipaySignature(params, publicKey), true);
  assert.equal(verifyAlipaySignature({ ...params, total_amount: "1.00" }, publicKey), false);
  assert.equal(verifyAlipaySignature(params, ""), false);
});

test("wxpay callback signature verifies and resource decrypts", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  const payload = JSON.stringify({ id: "evt-1", resource: {} });
  const timestamp = "1700000000";
  const nonce = "abcdef";
  const message = `${timestamp}\n${nonce}\n${payload}\n`;
  const signature = createSign("RSA-SHA256").update(message, "utf8").sign(privateKey, "base64");
  const headers = { "wechatpay-signature": signature, "wechatpay-timestamp": timestamp, "wechatpay-nonce": nonce };
  assert.equal(verifyWxpaySignature(payload, headers, publicKey), true);
  assert.equal(verifyWxpaySignature(`${payload} `, headers, publicKey), false);

  const apiV3Key = "0123456789abcdef0123456789abcdef";
  const resourceNonce = randomBytes(12).toString("hex").slice(0, 12);
  const associatedData = "transaction";
  const transaction = { out_trade_no: "order-5", trade_state: "SUCCESS", amount: { total: 1000 } };
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(apiV3Key, "utf8"), Buffer.from(resourceNonce, "utf8"));
  cipher.setAAD(Buffer.from(associatedData, "utf8"));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(transaction), "utf8"), cipher.final(), cipher.getAuthTag()]);
  const decrypted = decryptWxpayResource({
    nonce: resourceNonce,
    associated_data: associatedData,
    ciphertext: encrypted.toString("base64")
  }, apiV3Key);
  assert.deepEqual(decrypted, transaction);
  assert.throws(() => decryptWxpayResource({ nonce: resourceNonce, associated_data: "tampered", ciphertext: encrypted.toString("base64") }, apiV3Key));
});

test("stripe webhook signature enforces tolerance and hmac", () => {
  const secret = "whsec_test";
  const payload = JSON.stringify({ type: "checkout.session.completed" });
  const timestamp = Math.floor(Date.now() / 1000);
  const expected = createHmac("sha256", secret).update(`${timestamp}.${payload}`, "utf8").digest("hex");
  const header = `t=${timestamp},v1=${expected}`;
  assert.equal(verifyStripeSignature(payload, header, secret), true);
  assert.equal(verifyStripeSignature(payload, `t=${timestamp},v1=${"0".repeat(64)}`, secret), false);
  const stale = timestamp - 400;
  const staleSig = createHmac("sha256", secret).update(`${stale}.${payload}`, "utf8").digest("hex");
  assert.equal(verifyStripeSignature(payload, `t=${stale},v1=${staleSig}`, secret), false);
  assert.equal(verifyStripeSignature(payload, header, ""), false);
});

test("airwallex webhook signature verifies hmac hex digest", () => {
  const secret = "awx-secret";
  const payload = JSON.stringify({ name: "payment_intent.succeeded" });
  const timestamp = "1700000000";
  const expected = createHmac("sha256", secret).update(`${timestamp}.${payload}`, "utf8").digest("hex");
  assert.equal(verifyAirwallexSignature(payload, timestamp, expected, secret), true);
  assert.equal(verifyAirwallexSignature(payload, timestamp, `sha256=${expected}`, secret), true);
  assert.equal(verifyAirwallexSignature(payload, timestamp, expected, "other"), false);
  assert.equal(verifyAirwallexSignature(payload, "", expected, secret), false);
});

test("usd money helpers convert to strings and minor units", () => {
  assert.equal(moneyFromUsd("10"), "10.00");
  assert.equal(moneyFromUsd("29"), "29.00");
  assert.equal(minorUnitsFromUsd("10"), 1000);
  assert.equal(minorUnitsFromUsd("55"), 5500);
  assert.equal(minorUnitsFromMoney("10.00"), 1000);
  assert.equal(minorUnitsFromMoney("10.005"), 1001);
  assert.equal(minorUnitsFromMoney(undefined), 0);
});
