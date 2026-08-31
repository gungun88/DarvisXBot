import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../lib/config.js";
import { markPaymentOrderPaidByProvider } from "../subscriptions/subscription.service.js";
import {
  EASYPAY_SUCCESS_STATUS,
  decryptWxpayResource,
  minorUnitsFromMoney,
  verifyAirwallexSignature,
  verifyAlipaySignature,
  verifyEasypaySignature,
  verifyStripeSignature,
  verifyWxpaySignature
} from "./payment-gateway.service.js";
import { findEasypayProviderForCallback, findEnabledProvider, paymentReturnPath } from "./payment-provider.service.js";

function decodeJsonPayload(payload: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(payload) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function queryParams(request: FastifyRequest): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.query as Record<string, unknown>)) {
    result[key] = Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
  }
  return result;
}

function headerValue(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function pageCsp(reply: FastifyReply, scriptSources: string[], connectSources: string[] = []) {
  const script = ["'unsafe-inline'", ...scriptSources].join(" ");
  const connect = ["'self'", ...connectSources].join(" ");
  void reply.header(
    "content-security-policy",
    `default-src 'none'; script-src ${script}; style-src 'unsafe-inline'; img-src data:; connect-src ${connect}; frame-src https:; form-action https:; base-uri 'none'`
  );
}

function htmlPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #f6f7fb; font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; color: #111827; }
    main { width: min(420px, calc(100vw - 32px)); padding: 28px; border: 1px solid #e5e7eb; border-radius: 12px; background: #fff; text-align: center; box-shadow: 0 18px 50px rgba(15, 23, 42, .08); }
    h1 { margin: 0 0 16px; font-size: 20px; }
    p { margin: 12px 0 0; color: #6b7280; font-size: 14px; line-height: 1.6; }
    a.button { display: inline-flex; margin-top: 18px; padding: 9px 16px; border-radius: 8px; background: #2563eb; color: #fff; text-decoration: none; font-size: 14px; }
    canvas, img.qr { width: 260px; height: 260px; image-rendering: pixelated; }
    .status-icon { font-size: 44px; line-height: 1; }
  </style>
</head>
<body>
  <main>${body}</main>
</body>
</html>`;
}

export async function registerPaymentRoutes(app: FastifyInstance, config: AppConfig) {
  await app.register(async (scope) => {
    // Webhook handlers verify raw payload signatures, so parse bodies as plain strings.
    scope.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => done(null, body));
    scope.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => done(null, body));
    scope.addContentTypeParser("*", { parseAs: "string" }, (_request, body, done) => done(null, body));

    const easypayNotify = async (request: FastifyRequest, reply: FastifyReply) => {
      const params = queryParams(request);
      const provider = await findEasypayProviderForCallback(params, verifyEasypaySignature);
      if (!provider) return reply.type("text/plain").send("fail");
      if (params.trade_status !== EASYPAY_SUCCESS_STATUS) return reply.type("text/plain").send("fail");
      const orderId = params.out_trade_no ?? "";
      const tradeNo = params.trade_no ?? "";
      if (!orderId || !tradeNo) return reply.type("text/plain").send("fail");
      try {
        await markPaymentOrderPaidByProvider(orderId, {
          provider: "easypay",
          providerOrderId: tradeNo,
          amountMinorUnits: minorUnitsFromMoney(params.money),
          payload: params
        });
      } catch (error) {
        request.log.warn({ error, orderId }, "easypay notify rejected");
        return reply.type("text/plain").send("fail");
      }
      return reply.type("text/plain").send("success");
    };
    scope.get("/api/payments/webhook/easypay", easypayNotify);
    scope.get("/api/payments/easypay/notify", easypayNotify);

    scope.get("/api/payments/easypay/return", async (request, reply) => {
      const params = queryParams(request);
      const provider = await findEasypayProviderForCallback(params, verifyEasypaySignature);
      const ok = Boolean(provider) && params.trade_status === EASYPAY_SUCCESS_STATUS;
      const query = new URLSearchParams({ payment: ok ? "success" : "failed", order: params.out_trade_no ?? "" });
      return reply.redirect(`${paymentReturnPath}?${query.toString()}`, 302);
    });

    scope.post("/api/payments/webhook/stripe", async (request, reply) => {
      const payload = typeof request.body === "string" ? request.body : "";
      const provider = await findEnabledProvider("stripe");
      const webhookSecret = String(provider?.config.webhookSecret ?? "");
      if (!payload || !verifyStripeSignature(payload, headerValue(request, "stripe-signature"), webhookSecret)) {
        return reply.code(400).type("text/plain").send("fail");
      }
      const event = decodeJsonPayload(payload);
      if (!event) return reply.code(400).type("text/plain").send("fail");
      const eventType = String(event.type ?? "");
      const data = event.data && typeof event.data === "object" ? (event.data as Record<string, unknown>).object : null;
      if (!data || typeof data !== "object" || Array.isArray(data)) return reply.type("text/plain").send("ignored");
      if (!["checkout.session.completed", "payment_intent.succeeded"].includes(eventType)) return reply.type("text/plain").send("ignored");
      const dataObject = data as Record<string, unknown>;
      const metadata = dataObject.metadata && typeof dataObject.metadata === "object" ? dataObject.metadata as Record<string, unknown> : {};
      const orderId = String(dataObject.client_reference_id ?? metadata.order_id ?? "");
      const providerOrderId = String(dataObject.payment_intent ?? dataObject.id ?? event.id ?? "");
      const amountMinorUnits = Number(dataObject.amount_total ?? dataObject.amount_received ?? 0);
      if (!orderId) return reply.code(400).type("text/plain").send("fail");
      try {
        await markPaymentOrderPaidByProvider(orderId, { provider: "stripe", providerOrderId, amountMinorUnits, payload: event });
      } catch (error) {
        request.log.warn({ error, orderId }, "stripe webhook rejected");
        return reply.code(400).type("text/plain").send("fail");
      }
      return reply.type("text/plain").send("success");
    });

    scope.post("/api/payments/webhook/alipay", async (request, reply) => {
      const body = typeof request.body === "string" ? request.body : "";
      const params: Record<string, string> = {};
      for (const [key, value] of new URLSearchParams(body)) params[key] = value;
      const provider = await findEnabledProvider("alipay");
      if (!verifyAlipaySignature(params, String(provider?.config.publicKey ?? ""))) {
        return reply.code(400).type("text/plain").send("fail");
      }
      if (!["TRADE_SUCCESS", "TRADE_FINISHED"].includes(params.trade_status ?? "")) return reply.type("text/plain").send("success");
      const orderId = params.out_trade_no ?? "";
      const tradeNo = params.trade_no ?? "";
      if (!orderId || !tradeNo) return reply.code(400).type("text/plain").send("fail");
      try {
        await markPaymentOrderPaidByProvider(orderId, {
          provider: "alipay",
          providerOrderId: tradeNo,
          amountMinorUnits: minorUnitsFromMoney(params.total_amount),
          payload: params
        });
      } catch (error) {
        request.log.warn({ error, orderId }, "alipay webhook rejected");
        return reply.code(400).type("text/plain").send("fail");
      }
      return reply.type("text/plain").send("success");
    });

    scope.post("/api/payments/webhook/wxpay", async (request, reply) => {
      const payload = typeof request.body === "string" ? request.body : "";
      const provider = await findEnabledProvider("wxpay");
      const wxHeaders = {
        "wechatpay-signature": headerValue(request, "wechatpay-signature"),
        "wechatpay-timestamp": headerValue(request, "wechatpay-timestamp"),
        "wechatpay-nonce": headerValue(request, "wechatpay-nonce")
      };
      if (!payload || !verifyWxpaySignature(payload, wxHeaders, String(provider?.config.publicKey ?? ""))) {
        return reply.code(400).type("application/json").send({ code: "FAIL", message: "invalid signature" });
      }
      const event = decodeJsonPayload(payload);
      const resource = event?.resource && typeof event.resource === "object" && !Array.isArray(event.resource) ? event.resource as Record<string, unknown> : {};
      let transaction: Record<string, unknown>;
      try {
        transaction = decryptWxpayResource(resource, String(provider?.config.apiV3Key ?? ""));
      } catch {
        return reply.code(400).type("application/json").send({ code: "FAIL", message: "decrypt failed" });
      }
      if (transaction.trade_state !== "SUCCESS") return reply.type("application/json").send({ code: "SUCCESS", message: "ignored" });
      const orderId = String(transaction.out_trade_no ?? "");
      const amount = transaction.amount && typeof transaction.amount === "object" ? transaction.amount as Record<string, unknown> : {};
      try {
        await markPaymentOrderPaidByProvider(orderId, {
          provider: "wxpay",
          providerOrderId: String(transaction.transaction_id ?? ""),
          amountMinorUnits: Number(amount.total ?? 0),
          payload: transaction
        });
      } catch (error) {
        request.log.warn({ error, orderId }, "wxpay webhook rejected");
        return reply.code(400).type("application/json").send({ code: "FAIL", message: "order failed" });
      }
      return reply.type("application/json").send({ code: "SUCCESS", message: "success" });
    });

    scope.post("/api/payments/webhook/airwallex", async (request, reply) => {
      const payload = typeof request.body === "string" ? request.body : "";
      const provider = await findEnabledProvider("airwallex");
      const timestamp = headerValue(request, "x-timestamp");
      const signature = headerValue(request, "x-signature");
      if (!payload || !verifyAirwallexSignature(payload, timestamp, signature, String(provider?.config.webhookSecret ?? ""))) {
        return reply.code(400).type("text/plain").send("fail");
      }
      const event = decodeJsonPayload(payload);
      if (!event) return reply.code(400).type("text/plain").send("fail");
      const eventType = String(event.name ?? event.type ?? "");
      const data = event.data && typeof event.data === "object" && !Array.isArray(event.data) ? event.data as Record<string, unknown> : event;
      const paymentIntent = data.payment_intent && typeof data.payment_intent === "object" && !Array.isArray(data.payment_intent)
        ? data.payment_intent as Record<string, unknown>
        : data;
      if (!eventType.toLowerCase().includes("succeeded") && String(paymentIntent.status ?? "").toUpperCase() !== "SUCCEEDED") {
        return reply.type("text/plain").send("ignored");
      }
      const metadata = paymentIntent.metadata && typeof paymentIntent.metadata === "object" ? paymentIntent.metadata as Record<string, unknown> : {};
      const orderId = String(paymentIntent.merchant_order_id ?? metadata.order_id ?? paymentIntent.request_id ?? "");
      try {
        await markPaymentOrderPaidByProvider(orderId, {
          provider: "airwallex",
          providerOrderId: String(paymentIntent.id ?? event.id ?? ""),
          amountMinorUnits: minorUnitsFromMoney(paymentIntent.amount),
          payload: event
        });
      } catch (error) {
        request.log.warn({ error, orderId }, "airwallex webhook rejected");
        return reply.code(400).type("text/plain").send("fail");
      }
      return reply.type("text/plain").send("success");
    });

    scope.get("/api/payments/wxpay/native-page", async (request, reply) => {
      const params = queryParams(request);
      const codeUrl = params.code_url ?? "";
      const orderId = params.order ?? "";
      if (!codeUrl) return reply.code(400).send({ error: "缺少微信支付二维码" });
      pageCsp(reply, ["https://cdn.jsdelivr.net"]);
      const resultQuery = new URLSearchParams({ payment: "success", order: orderId });
      return reply.type("text/html").send(htmlPage("微信支付", `
    <h1>微信扫码支付</h1>
    <canvas id="qr" width="260" height="260"></canvas>
    <p>请使用微信扫码完成支付。支付成功后可返回订单页面查看状态。</p>
    <a class="button" href="${paymentReturnPath}?${resultQuery.toString()}">返回订单结果</a>
    <script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.4/build/qrcode.min.js"></script>
    <script>
      QRCode.toCanvas(document.getElementById("qr"), ${JSON.stringify(codeUrl)}, { width: 260, margin: 1 });
    </script>`));
    });

    scope.get("/payments/airwallex/checkout", async (request, reply) => {
      const params = queryParams(request);
      const intentId = params.intent_id ?? "";
      const clientSecret = params.client_secret ?? "";
      const currency = params.currency || "USD";
      const countryCode = params.country_code || "CN";
      const env = params.env === "demo" ? "demo" : "prod";
      pageCsp(reply, ["https://checkout.airwallex.com", "https://static.airwallex.com"], ["https://*.airwallex.com"]);
      return reply.type("text/html").send(htmlPage("Airwallex 收银台", `
    <h1 id="title">正在打开 Airwallex 收银台</h1>
    <p id="detail">请稍候，不要关闭当前页面。</p>
    <script src="https://checkout.airwallex.com/assets/elements.bundle.min.js"></script>
    <script>
      (function () {
        var intentId = ${JSON.stringify(intentId)};
        var clientSecret = ${JSON.stringify(clientSecret)};
        function fail(message) {
          document.getElementById("title").textContent = "无法打开支付页面";
          document.getElementById("detail").textContent = message;
        }
        try {
          if (!intentId || !clientSecret) return fail("支付参数缺失");
          if (!window.Airwallex) return fail("Airwallex SDK 不可用");
          window.Airwallex.init({ env: ${JSON.stringify(env)}, origin: window.location.origin, currency: ${JSON.stringify(currency)} });
          window.Airwallex.redirectToCheckout({
            intent_id: intentId,
            client_secret: clientSecret,
            currency: ${JSON.stringify(currency)},
            country_code: ${JSON.stringify(countryCode)}
          });
        } catch (error) {
          fail(error && error.message ? error.message : "无法打开 Airwallex 收银台");
        }
      })();
    </script>`));
    });

    scope.get(paymentReturnPath, async (request, reply) => {
      const params = queryParams(request);
      const ok = params.payment === "success";
      const orderId = params.order ?? "";
      pageCsp(reply, []);
      return reply.type("text/html").send(htmlPage("支付结果", `
    <div class="status-icon">${ok ? "✅" : "❌"}</div>
    <h1>${ok ? "支付已提交" : "支付未完成"}</h1>
    <p>${ok
      ? "支付确认后会员将自动开通，稍后可在机器人内查看会员状态。"
      : "支付未成功或已取消，可返回机器人重新发起支付。"}${orderId ? `<br>订单号：${orderId.replace(/[^\w-]/g, "")}` : ""}</p>
    <a class="button" href="https://t.me/${encodeURIComponent(config.botUsername)}">返回 Telegram</a>`));
    });
  });
}
