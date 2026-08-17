import { ArrowLeft, Edit3, ExternalLink, Link2, Plus, Save, Settings2, ShieldCheck, Trash2, UsersRound, X } from "lucide-react";
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useToast } from "../components/Toast";
import { displayName, EmptyState, ErrorState, formatDate, LoadingState, PageHeader, Pagination, RefreshButton, SearchBox, StatusBadge } from "../components/Ui";
import { useResource } from "../hooks/useResource";
import type { Chat, PageResult } from "../types";

export function ChatsPage() {
  const [params, setParams] = useSearchParams();
  const page = Number(params.get("page") ?? 1);
  const search = params.get("search") ?? "";
  const status = params.get("status") ?? "";
  const path = `/api/admin/chats?page=${page}&pageSize=20&search=${encodeURIComponent(search)}&status=${status}`;
  const state = useResource<PageResult<Chat>>(path);
  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    value ? next.set(key, value) : next.delete(key);
    if (key !== "page") next.delete("page");
    setParams(next, { replace: true });
  };
  return <>
    <PageHeader title="群组管理" description="接入状态、所有权与业务配置" actions={<RefreshButton onClick={state.reload} spinning={state.refreshing} />} />
    <section className="panel table-panel">
      <div className="filter-bar"><SearchBox value={search} onChange={(value) => setFilter("search", value)} placeholder="群组名称、用户名或 Telegram ID" /><select value={status} onChange={(event) => setFilter("status", event.target.value)}><option value="">全部状态</option><option value="ACTIVE">活跃</option><option value="DISABLED">已停用</option><option value="ARCHIVED">已归档</option></select></div>
      {state.loading ? <LoadingState /> : state.error || !state.data ? <ErrorState message={state.error ?? "暂无数据"} retry={state.reload} /> : state.data.items.length === 0 ? <EmptyState title="没有符合条件的群组" /> : <>
        <div className="table-scroll"><table><thead><tr><th>群组</th><th>类型</th><th>状态</th><th>管理员</th><th>业务内容</th><th>更新时间</th><th aria-label="操作" /></tr></thead><tbody>
          {state.data.items.map((chat) => <tr key={chat.id}><td><div className="primary-cell"><span className="entity-avatar chat-avatar"><ShieldCheck size={17} /></span><div><strong>{chat.title ?? "未命名群组"}</strong><small>{chat.username ? `@${chat.username}` : chat.telegramChatId}</small></div></div></td><td>{chatType(chat.type)}</td><td><StatusBadge value={chat.status} /></td><td>{chat._count.admins}</td><td><span className="subtle-count">{chat._count.scheduledMessages} 定时 · {chat._count.giveaways} 抽奖</span></td><td>{formatDate(chat.updatedAt)}</td><td><Link className="icon-button small" to={`/chats/${chat.id}`} title="查看详情"><ExternalLink size={16} /></Link></td></tr>)}
        </tbody></table></div><Pagination page={state.data.page} pageSize={state.data.pageSize} total={state.data.total} onPage={(value) => setFilter("page", String(value))} />
      </>}
    </section>
  </>;
}

type ChatDetail = Omit<Chat, "owner" | "_count"> & {
  owner: { id: string; telegramUserId: string; username: string | null; firstName: string | null } | null;
  admins: { id: string; role: string; user: { id: string; telegramUserId: string; username: string | null; firstName: string | null } }[];
  settings: { id: string; key: string; value: unknown; updatedAt: string }[];
  moderationRules: { id: string; ruleType: string; pattern: string; action: string; enabled: boolean }[];
  inviteLinks: { id: string; inviteLink: string; expireAt: string | null; memberLimit: number | null; revokedAt: string | null; createdAt: string; creator: { id: string; username: string | null; firstName: string | null }; _count: { joins: number } }[];
  _count: { scheduledMessages: number; giveaways: number; auditLogs: number; pointBalances: number; inviteLinks: number; joinVerifications: number };
};

export function ChatDetailPage() {
  const { id } = useParams();
  const state = useResource<ChatDetail>(`/api/admin/chats/${id}`);
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [timezone, setTimezone] = useState("");
  const [editingSetting, setEditingSetting] = useState<{ key: string; value: unknown } | null>(null);
  const [editingRule, setEditingRule] = useState<ChatDetail["moderationRules"][number] | "new" | null>(null);
  if (state.loading) return <LoadingState />;
  if (state.error || !state.data) return <ErrorState message={state.error ?? "群组不存在"} retry={state.reload} />;
  const chat = state.data;
  const save = async () => {
    setSaving(true);
    try {
      await api(`/api/admin/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ status: status || chat.status, timezone: timezone || chat.timezone }) });
      toast.notify("群组配置已保存");
      await state.reload();
      setStatus(""); setTimezone("");
    } catch (caught) { toast.notify(caught instanceof Error ? caught.message : "保存失败", "error"); }
    finally { setSaving(false); }
  };
  return <>
    <div className="back-row"><Link to="/chats"><ArrowLeft size={16} />返回群组列表</Link></div>
    <PageHeader title={chat.title ?? "未命名群组"} description={chat.username ? `@${chat.username}` : `Telegram ID ${chat.telegramChatId}`} actions={<StatusBadge value={chat.status} />} />
    <section className="detail-summary">
      <div><span>群组类型</span><strong>{chatType(chat.type)}</strong></div><div><span>积分成员</span><strong>{chat._count.pointBalances}</strong></div><div><span>定时消息</span><strong>{chat._count.scheduledMessages}</strong></div><div><span>抽奖活动</span><strong>{chat._count.giveaways}</strong></div><div><span>待验证成员</span><strong>{chat._count.joinVerifications}</strong></div>
    </section>
    <div className="detail-grid">
      <section className="panel"><div className="panel-header"><div><h2>基本设置</h2><p>接入状态与本地时区</p></div><Settings2 size={19} /></div><div className="form-grid"><label><span>状态</span><select value={status || chat.status} onChange={(event) => setStatus(event.target.value)}><option value="ACTIVE">活跃</option><option value="DISABLED">停用</option><option value="ARCHIVED">归档</option></select></label><label><span>时区</span><input value={timezone || chat.timezone} onChange={(event) => setTimezone(event.target.value)} /></label></div><div className="panel-actions"><button className="button primary" disabled={saving} onClick={save}><Save size={16} />保存设置</button></div></section>
      <section className="panel"><div className="panel-header"><div><h2>管理成员</h2><p>{chat.admins.length} 位已记录管理员</p></div><UsersRound size={19} /></div><div className="compact-list">{chat.admins.length ? chat.admins.map((admin) => <Link to={`/users/${admin.user.id}`} key={admin.id}><span className="entity-avatar">{displayName(admin.user).slice(0, 1).toUpperCase()}</span><div><strong>{displayName(admin.user)}</strong><small>{admin.role} · {admin.user.telegramUserId}</small></div></Link>) : <div className="inline-empty">暂无管理员记录</div>}</div></section>
      <section className="panel wide"><div className="panel-header"><div><h2>功能配置</h2><p>机器人持久化设置</p></div><span className="panel-count">{chat.settings.length}</span></div>{chat.settings.length ? <div className="settings-list">{chat.settings.map((setting) => <div key={setting.id}><div><strong>{setting.key}</strong><small>{formatDate(setting.updatedAt)}</small></div><code>{compactJson(setting.value)}</code><button className="icon-button small" onClick={() => setEditingSetting({ key: setting.key, value: setting.value })} title="编辑设置"><Edit3 size={15} /></button></div>)}</div> : <div className="inline-empty">暂无持久化设置</div>}</section>
      <section className="panel wide"><div className="panel-header"><div><h2>内容规则</h2><p>关键词、链接与自动回复规则</p></div><div className="row-actions"><span className="panel-count">{chat.moderationRules.length}</span><button className="icon-button small" title="新建规则" onClick={() => setEditingRule("new")}><Plus size={15} /></button></div></div>{chat.moderationRules.length ? <div className="table-scroll"><table><thead><tr><th>类型</th><th>匹配内容</th><th>动作</th><th>状态</th><th>启用</th><th /></tr></thead><tbody>{chat.moderationRules.map((rule) => <tr key={rule.id}><td>{rule.ruleType}</td><td><code>{rule.pattern}</code></td><td>{rule.action}</td><td><StatusBadge value={rule.enabled ? "ACTIVE" : "inactive"} /></td><td><label className="switch"><input type="checkbox" checked={rule.enabled} onChange={async (event) => { try { await api(`/api/admin/moderation-rules/${rule.id}`, { method: "PATCH", body: JSON.stringify({ enabled: event.target.checked }) }); toast.notify("规则状态已更新"); state.reload(); } catch (caught) { toast.notify(caught instanceof Error ? caught.message : "操作失败", "error"); } }} /><span /></label></td><td><div className="row-actions"><button className="icon-button small" title="编辑规则" onClick={() => setEditingRule(rule)}><Edit3 size={15} /></button><button className="icon-button small danger-button" title="删除规则" onClick={async () => { if (!window.confirm("确认删除这条内容规则？")) return; try { await api(`/api/admin/moderation-rules/${rule.id}`, { method: "DELETE" }); toast.notify("规则已删除"); state.reload(); } catch (caught) { toast.notify(caught instanceof Error ? caught.message : "删除失败", "error"); } }}><Trash2 size={15} /></button></div></td></tr>)}</tbody></table></div> : <div className="inline-empty">暂无内容规则</div>}</section>
      <section className="panel wide"><div className="panel-header"><div><h2>邀请链接</h2><p>最近创建的邀请入口</p></div><span className="panel-count">{chat._count.inviteLinks}</span></div>{chat.inviteLinks.length ? <div className="table-scroll"><table><thead><tr><th>链接</th><th>创建者</th><th>已加入</th><th>人数限制</th><th>状态</th><th>创建时间</th></tr></thead><tbody>{chat.inviteLinks.map((link) => <tr key={link.id}><td><a className="table-link inline-icon" href={link.inviteLink} target="_blank" rel="noreferrer"><Link2 size={14} />{link.inviteLink}</a></td><td>{displayName(link.creator)}</td><td>{link._count.joins}</td><td>{link.memberLimit ?? "不限"}</td><td><StatusBadge value={link.revokedAt ? "inactive" : "ACTIVE"} /></td><td>{formatDate(link.createdAt)}</td></tr>)}</tbody></table></div> : <div className="inline-empty">暂无邀请链接</div>}</section>
    </div>
    {editingSetting && <SettingDialog chatId={chat.id} setting={editingSetting} close={() => setEditingSetting(null)} onSaved={() => { setEditingSetting(null); state.reload(); }} />}
    {editingRule && <RuleDialog chatId={chat.id} rule={editingRule === "new" ? undefined : editingRule} close={() => setEditingRule(null)} onSaved={() => { setEditingRule(null); state.reload(); }} />}
  </>;
}

function RuleDialog({ chatId, rule, close, onSaved }: { chatId: string; rule?: ChatDetail["moderationRules"][number]; close: () => void; onSaved: () => void }) {
  const toast = useToast(); const [ruleType, setRuleType] = useState(rule?.ruleType ?? "KEYWORD"); const [pattern, setPattern] = useState(rule?.pattern ?? ""); const [action, setAction] = useState(rule?.action ?? "DELETE_MESSAGE"); const [enabled, setEnabled] = useState(rule?.enabled ?? true); const [saving, setSaving] = useState(false);
  const save = async () => { if (!pattern.trim()) { toast.notify("请输入匹配内容", "error"); return; } setSaving(true); try { const body = JSON.stringify({ chatId, ruleType, pattern: pattern.trim(), action, enabled }); await api(rule ? `/api/admin/moderation-rules/${rule.id}` : "/api/admin/moderation-rules", { method: rule ? "PUT" : "POST", body }); toast.notify(rule ? "规则已更新" : "规则已创建"); onSaved(); } catch (caught) { toast.notify(caught instanceof Error ? caught.message : "保存失败", "error"); } finally { setSaving(false); } };
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}><section className="modal"><div className="modal-header"><div><h2>{rule ? "编辑内容规则" : "新建内容规则"}</h2><p>规则会直接参与机器人内容审核</p></div><button className="icon-button" title="关闭" onClick={close}><X size={18} /></button></div><div className="form-stack"><label><span>规则类型</span><select value={ruleType} onChange={(event) => setRuleType(event.target.value)}><option value="KEYWORD">关键词</option><option value="LINK">链接</option><option value="AUTO_REPLY">自动回复</option><option value="SPAM">垃圾消息</option></select></label><label><span>匹配内容</span><input value={pattern} onChange={(event) => setPattern(event.target.value)} /></label><label><span>执行动作</span><select value={action} onChange={(event) => setAction(event.target.value)}><option value="DELETE_MESSAGE">删除消息</option><option value="MUTE_USER">禁言用户</option><option value="BAN_USER">封禁用户</option><option value="REPLY">自动回复</option></select></label><label className="toggle-row"><span><strong>启用规则</strong><small>关闭后保留配置但不参与匹配</small></span><span className="switch"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span /></span></label></div><div className="modal-actions"><button className="button secondary" onClick={close}>取消</button><button className="button primary" disabled={saving} onClick={save}><Save size={16} />保存规则</button></div></section></div>;
}

function SettingDialog({ chatId, setting, close, onSaved }: { chatId: string; setting: { key: string; value: unknown }; close: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [value, setValue] = useState(() => JSON.stringify(setting.value, null, 2));
  const [saving, setSaving] = useState(false);
  const save = async () => {
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { toast.notify("JSON 格式无效", "error"); return; }
    setSaving(true);
    try { await api(`/api/admin/chats/${chatId}/settings/${encodeURIComponent(setting.key)}`, { method: "PUT", body: JSON.stringify({ value: parsed }) }); toast.notify("功能配置已更新"); onSaved(); }
    catch (caught) { toast.notify(caught instanceof Error ? caught.message : "保存失败", "error"); }
    finally { setSaving(false); }
  };
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}><section className="modal setting-modal"><div className="modal-header"><div><h2>{setting.key}</h2><p>功能配置 JSON</p></div><button className="icon-button" onClick={close} title="关闭"><X size={18} /></button></div><div className="form-stack"><textarea className="json-editor" value={value} onChange={(event) => setValue(event.target.value)} spellCheck={false} /></div><div className="modal-actions"><button className="button secondary" onClick={close}>取消</button><button className="button primary" disabled={saving} onClick={save}><Save size={16} />保存配置</button></div></section></div>;
}

function chatType(value: string) {
  return ({ GROUP: "群组", SUPERGROUP: "超级群组", CHANNEL: "频道", PRIVATE: "私聊" } as Record<string, string>)[value] ?? value;
}

function compactJson(value: unknown) {
  const text = JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}
