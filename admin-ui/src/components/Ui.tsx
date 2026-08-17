import type { ReactNode } from "react";
import { AlertTriangle, Inbox, LoaderCircle, RefreshCw, Search } from "lucide-react";

export function PageHeader({ title, description, actions }: { title: string; description: string; actions?: ReactNode }) {
  return <header className="page-header">
    <div><h1>{title}</h1><p>{description}</p></div>
    {actions && <div className="page-actions">{actions}</div>}
  </header>;
}

export function StatusBadge({ value }: { value: string }) {
  const tone = statusTone(value);
  return <span className={`status-badge status-${tone}`}><span className="status-dot" />{statusLabel(value)}</span>;
}

export function LoadingState() {
  return <div className="state-block"><LoaderCircle className="spin" size={24} /><span>正在加载</span></div>;
}

export function ErrorState({ message, retry }: { message: string; retry: () => void }) {
  return <div className="state-block state-error"><AlertTriangle size={24} /><strong>数据加载失败</strong><span>{message}</span><button className="button secondary" onClick={retry}><RefreshCw size={16} />重试</button></div>;
}

export function EmptyState({ title = "暂无记录" }: { title?: string }) {
  return <div className="state-block"><Inbox size={26} /><strong>{title}</strong></div>;
}

export function SearchBox({ value, onChange, placeholder = "搜索" }: { value: string; onChange: (value: string) => void; placeholder?: string }) {
  return <label className="search-box"><Search size={16} /><input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /></label>;
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return <div className="pagination"><span>共 {total} 条</span><div><button className="button secondary compact" disabled={page <= 1} onClick={() => onPage(page - 1)}>上一页</button><span>{page} / {pages}</span><button className="button secondary compact" disabled={page >= pages} onClick={() => onPage(page + 1)}>下一页</button></div></div>;
}

export function RefreshButton({ onClick, spinning }: { onClick: () => void; spinning?: boolean }) {
  return <button className="icon-button" onClick={onClick} title="刷新"><RefreshCw className={spinning ? "spin" : ""} size={18} /></button>;
}

export function displayName(user: { username?: string | null; firstName?: string | null; lastName?: string | null }) {
  return user.username ? `@${user.username}` : [user.firstName, user.lastName].filter(Boolean).join(" ") || "未命名用户";
}

export function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function statusTone(value: string) {
  if (["ACTIVE", "SENT", "DRAWN", "FULFILLED", "healthy", "success"].includes(value)) return "success";
  if (["PENDING", "DRAFT", "DELIVERY_PENDING", "delayed", "waiting"].includes(value)) return "warning";
  if (["FAILED", "unhealthy", "degraded", "missing", "stale"].includes(value)) return "danger";
  if (["DISABLED", "ARCHIVED", "CANCELLED", "REFUNDED", "EXPIRED", "delete_only", "inactive", "disabled"].includes(value)) return "neutral";
  return "info";
}

function statusLabel(value: string) {
  const labels: Record<string, string> = {
    ACTIVE: "活跃", DISABLED: "已停用", ARCHIVED: "已归档", PENDING: "待执行", DRAFT: "草稿",
    SENT: "已发送", CANCELLED: "已取消", FAILED: "失败", DRAWN: "已开奖", healthy: "正常", WAITING: "等待支付", FINISHED: "已完成", CONFIRMED: "已确认", EXPIRED: "已过期",
    unhealthy: "异常", degraded: "需关注", missing: "缺失", stale: "已过期", disabled: "未启用", DELIVERY_PENDING: "待交付", FULFILLED: "已交付", REFUNDED: "已退款", delete_only: "仅删除", warn: "警告", retry: "要求重试", decline_join_request: "拒绝入群", mute: "禁言", kick: "踢出", ban: "封禁"
  };
  return labels[value] ?? value;
}
