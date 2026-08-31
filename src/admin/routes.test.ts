import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../lib/config.js";
import { prisma } from "../lib/prisma.js";
import { createServer } from "../server.js";

test("admin API rejects unauthenticated access and issues a scoped token", async (t) => {
  const app = await createServer(loadConfig());
  t.after(async () => { await app.close(); });

  const unauthorized = await app.inject({ method: "GET", url: "/api/admin/dashboard" });
  assert.equal(unauthorized.statusCode, 401);

  const invalid = await app.inject({
    method: "POST",
    url: "/api/admin/auth/login",
    payload: { username: "admin", password: "definitely-wrong" }
  });
  assert.equal(invalid.statusCode, 401);

  const config = loadConfig();
  const login = await app.inject({
    method: "POST",
    url: "/api/admin/auth/login",
    payload: { username: config.adminUsername, password: config.adminPassword }
  });
  assert.equal(login.statusCode, 200);
  const token = login.json().token as string;
  assert.ok(token);

  const me = await app.inject({
    method: "GET",
    url: "/api/admin/auth/me",
    headers: { authorization: `Bearer ${token}` }
  });
  assert.deepEqual(me.json().user, { username: config.adminUsername, role: "owner" });

  const sessions = await app.inject({
    method: "GET",
    url: "/api/admin/auth/sessions",
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(sessions.statusCode, 200);
  assert.equal(sessions.json().items.some((item: { current: boolean }) => item.current), true);

  const logout = await app.inject({
    method: "POST",
    url: "/api/admin/auth/logout",
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(logout.statusCode, 200);
  const revoked = await app.inject({
    method: "GET",
    url: "/api/admin/auth/me",
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(revoked.statusCode, 401);
});

test("owner manages accounts while viewer remains read-only", async (t) => {
  const config = loadConfig();
  const app = await createServer(config);
  const username = `viewer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const initialPassword = "viewer-initial-password";
  const replacementPassword = "viewer-replacement-password";
  t.after(async () => {
    await prisma.adminSession.deleteMany({ where: { username } });
    await prisma.adminAccount.deleteMany({ where: { username } });
    await app.close();
  });

  const ownerLogin = await app.inject({
    method: "POST",
    url: "/api/admin/auth/login",
    payload: { username: config.adminUsername, password: config.adminPassword }
  });
  assert.equal(ownerLogin.statusCode, 200);
  const ownerToken = ownerLogin.json().token as string;

  const created = await app.inject({
    method: "POST",
    url: "/api/admin/accounts",
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { username, password: initialPassword, role: "viewer" }
  });
  assert.equal(created.statusCode, 200);
  assert.equal(created.json().role, "viewer");
  assert.equal("passwordHash" in created.json(), false);
  const accountId = created.json().id as string;

  const viewerLogin = await app.inject({
    method: "POST",
    url: "/api/admin/auth/login",
    payload: { username, password: initialPassword }
  });
  assert.equal(viewerLogin.statusCode, 200);
  const viewerToken = viewerLogin.json().token as string;

  const viewerRead = await app.inject({
    method: "GET",
    url: "/api/admin/dashboard",
    headers: { authorization: `Bearer ${viewerToken}` }
  });
  assert.equal(viewerRead.statusCode, 200);

  const viewerWrite = await app.inject({
    method: "POST",
    url: "/api/admin/accounts",
    headers: { authorization: `Bearer ${viewerToken}` },
    payload: { username: `${username}-forbidden`, password: initialPassword, role: "viewer" }
  });
  assert.equal(viewerWrite.statusCode, 403);

  const reset = await app.inject({
    method: "PATCH",
    url: `/api/admin/accounts/${accountId}`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { password: replacementPassword }
  });
  assert.equal(reset.statusCode, 200);

  const revoked = await app.inject({
    method: "GET",
    url: "/api/admin/auth/me",
    headers: { authorization: `Bearer ${viewerToken}` }
  });
  assert.equal(revoked.statusCode, 401);

  const oldPassword = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username, password: initialPassword } });
  const newPassword = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username, password: replacementPassword } });
  assert.equal(oldPassword.statusCode, 401);
  assert.equal(newPassword.statusCode, 200);
});

test("membership overview exposes business metrics without provider payloads", async (t) => {
  const config = loadConfig();
  const app = await createServer(config);
  t.after(async () => { await app.close(); });

  const login = await app.inject({
    method: "POST",
    url: "/api/admin/auth/login",
    payload: { username: config.adminUsername, password: config.adminPassword }
  });
  assert.equal(login.statusCode, 200);
  const authorization = { authorization: `Bearer ${login.json().token as string}` };

  const response = await app.inject({ method: "GET", url: "/api/admin/membership-overview", headers: authorization });
  assert.equal(response.statusCode, 200);
  const overview = response.json();
  assert.equal(typeof overview.metrics.activeMembers, "number");
  assert.equal(typeof overview.metrics.revenue30dUsd, "string");
  assert.ok(Array.isArray(overview.plans));
  assert.ok(overview.featureLimits.free);
  assert.ok(Array.isArray(overview.recentOrders));
  assert.equal(overview.recentOrders.some((item: Record<string, unknown>) => "rawPayload" in item), false);

  const orders = await app.inject({ method: "GET", url: "/api/admin/payment-orders?page=1&pageSize=5", headers: authorization });
  assert.equal(orders.statusCode, 200);
  assert.equal(orders.json().items.some((item: Record<string, unknown>) => "rawPayload" in item), false);
});

test("payment providers support masked CRUD with financial role enforcement", async (t) => {
  const config = loadConfig();
  const app = await createServer(config);
  const operatorUsername = `operator-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const operatorPassword = "operator-initial-password";
  let providerId = 0;
  t.after(async () => {
    if (providerId) await prisma.paymentProvider.deleteMany({ where: { id: providerId } });
    await prisma.auditLog.deleteMany({ where: { targetType: "payment_provider", targetId: String(providerId) } });
    await prisma.adminSession.deleteMany({ where: { username: operatorUsername } });
    await prisma.adminAccount.deleteMany({ where: { username: operatorUsername } });
    await app.close();
  });

  const login = await app.inject({
    method: "POST",
    url: "/api/admin/auth/login",
    payload: { username: config.adminUsername, password: config.adminPassword }
  });
  assert.equal(login.statusCode, 200);
  const authorization = { authorization: `Bearer ${login.json().token as string}` };

  const list = await app.inject({ method: "GET", url: "/api/admin/payment-providers", headers: authorization });
  assert.equal(list.statusCode, 200);
  assert.ok(Array.isArray(list.json().items));

  const created = await app.inject({
    method: "POST",
    url: "/api/admin/payment-providers",
    headers: authorization,
    payload: {
      name: "测试易支付",
      providerKey: "easypay",
      enabled: false,
      config: { pid: "9001", pkey: "super-secret-merchant-key", apiBase: "https://pay.example.com" },
      limits: JSON.stringify({ alipay: { singleMin: 1 } }),
      publicBaseUrl: "https://bot.example.com"
    }
  });
  assert.equal(created.statusCode, 200);
  providerId = created.json().id as number;
  assert.ok(providerId > 0);
  assert.equal(created.json().secretConfigured, true);
  assert.equal("pkey" in created.json().config, false);
  assert.equal(JSON.stringify(created.json()).includes("super-secret-merchant-key"), false);

  const revealed = await app.inject({ method: "GET", url: `/api/admin/payment-providers/${providerId}?reveal=true`, headers: authorization });
  assert.equal(revealed.statusCode, 200);
  assert.equal(revealed.json().config.pkey, "super-secret-merchant-key");

  const patched = await app.inject({
    method: "PATCH",
    url: `/api/admin/payment-providers/${providerId}`,
    headers: authorization,
    payload: { config: { pid: "9002", pkey: "" }, supportedTypes: ["alipay"] }
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().config.pid, "9002");
  assert.equal(patched.json().secretConfigured, true);
  assert.deepEqual(patched.json().supportedTypes, ["alipay"]);

  const operatorCreated = await app.inject({
    method: "POST",
    url: "/api/admin/accounts",
    headers: authorization,
    payload: { username: operatorUsername, password: operatorPassword, role: "operator" }
  });
  assert.equal(operatorCreated.statusCode, 200);
  const operatorLogin = await app.inject({
    method: "POST",
    url: "/api/admin/auth/login",
    payload: { username: operatorUsername, password: operatorPassword }
  });
  assert.equal(operatorLogin.statusCode, 200);
  const operatorAuth = { authorization: `Bearer ${operatorLogin.json().token as string}` };

  const operatorList = await app.inject({ method: "GET", url: "/api/admin/payment-providers", headers: operatorAuth });
  assert.equal(operatorList.statusCode, 200);
  const operatorWrite = await app.inject({
    method: "PATCH",
    url: `/api/admin/payment-providers/${providerId}`,
    headers: operatorAuth,
    payload: { enabled: false }
  });
  assert.equal(operatorWrite.statusCode, 403);
  const operatorReveal = await app.inject({ method: "GET", url: `/api/admin/payment-providers/${providerId}?reveal=true`, headers: operatorAuth });
  assert.equal(operatorReveal.statusCode, 403);

  const deleted = await app.inject({ method: "DELETE", url: `/api/admin/payment-providers/${providerId}`, headers: authorization });
  assert.equal(deleted.statusCode, 200);
  const missing = await app.inject({ method: "GET", url: `/api/admin/payment-providers/${providerId}`, headers: authorization });
  assert.equal(missing.statusCode, 404);
});

test("membership UI labels can be edited from the admin API", async (t) => {
  const config = loadConfig();
  const app = await createServer(config);
  t.after(async () => {
    await prisma.auditLog.deleteMany({ where: { action: "admin.membership_ui.updated", targetId: "membership_ui" } });
    await prisma.appSetting.deleteMany({ where: { key: "membership_ui" } });
    await app.close();
  });
  await prisma.appSetting.deleteMany({ where: { key: "membership_ui" } });

  const login = await app.inject({
    method: "POST",
    url: "/api/admin/auth/login",
    payload: { username: config.adminUsername, password: config.adminPassword }
  });
  assert.equal(login.statusCode, 200);
  const authorization = { authorization: `Bearer ${login.json().token as string}` };

  const initial = await app.inject({ method: "GET", url: "/api/admin/membership-ui", headers: authorization });
  assert.equal(initial.statusCode, 200);
  assert.equal(initial.json().plansTabLabel, "套餐权益");

  const updated = await app.inject({
    method: "PUT",
    url: "/api/admin/membership-ui",
    headers: authorization,
    payload: { plansTabLabel: "权益配置" }
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().plansTabLabel, "权益配置");

  const reloaded = await app.inject({ method: "GET", url: "/api/admin/membership-ui", headers: authorization });
  assert.equal(reloaded.statusCode, 200);
  assert.equal(reloaded.json().plansTabLabel, "权益配置");
});
