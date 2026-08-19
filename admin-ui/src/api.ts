const tokenKey = "darvisx_admin_token";
const userKey = "darvisx_admin_user";

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

export function hasToken() {
  return Boolean(sessionStorage.getItem(tokenKey));
}

export function clearToken() {
  sessionStorage.removeItem(tokenKey);
  sessionStorage.removeItem(userKey);
}

export function getAdminUser(): AdminUser | null {
  try {
    return JSON.parse(sessionStorage.getItem(userKey) ?? "null") as AdminUser | null;
  } catch {
    return null;
  }
}

export async function login(username: string, password: string, code?: string) {
  const result = await request<{ token: string; user: AdminUser }>("/api/admin/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password, ...(code ? { code } : {}) })
  }, false);
  sessionStorage.setItem(tokenKey, result.token);
  sessionStorage.setItem(userKey, JSON.stringify(result.user));
  return result.user;
}

export async function logout() {
  try {
    await request<{ ok: true }>("/api/admin/auth/logout", { method: "POST" }, true);
  } finally {
    clearToken();
  }
}

export async function api<T>(path: string, options: RequestInit = {}) {
  return request<T>(path, options, true);
}

async function request<T>(path: string, options: RequestInit, authenticated: boolean) {
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body) headers.set("Content-Type", "application/json");
  if (authenticated) {
    const token = sessionStorage.getItem(tokenKey);
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }
  const response = await fetch(path, { ...options, headers });
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) {
    if (authenticated && response.status === 401) {
      clearToken();
      window.location.href = "/admin/login";
    }
    throw new ApiError(payload.error ?? `请求失败 (${response.status})`, response.status);
  }
  return payload as T;
}

export type AdminUser = { username: string; role: "owner" | "admin" | "operator" | "viewer" };
