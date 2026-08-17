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
