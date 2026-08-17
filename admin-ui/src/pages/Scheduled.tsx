import { Ban, CalendarClock, ExternalLink, Plus, RotateCcw, X } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { useState } from "react";
import { api } from "../api";
import { useToast } from "../components/Toast";
import { EmptyState, ErrorState, formatDate, LoadingState, PageHeader, Pagination, RefreshButton, SearchBox, StatusBadge } from "../components/Ui";
import { useResource } from "../hooks/useResource";
import type { Chat, PageResult, ScheduledMessage } from "../types";

export function ScheduledPage() {
  const [params, setParams] = useSearchParams();
  const page = Number(params.get("page") ?? 1); const search = params.get("search") ?? ""; const status = params.get("status") ?? "";
  const state = useResource<PageResult<ScheduledMessage>>(`/api/admin/scheduled-messages?page=${page}&pageSize=20&search=${encodeURIComponent(search)}&status=${status}`);
  const [creating, setCreating] = useState(false);
  const setFilter = (key: string, value: string) => { const next = new URLSearchParams(params); value ? next.set(key, value) : next.delete(key); if (key !== "page") next.delete("page"); setParams(next, { replace: true }); };
  return <>
    <PageHeader title="定时消息" description="内容投递队列与发送状态" actions={<><button className="button primary" onClick={() => setCreating(true)}><Plus size={16} />新建消息</button><RefreshButton onClick={state.reload} spinning={state.refreshing} /></>} />
    <section className="panel table-panel"><div className="filter-bar"><SearchBox value={search} onChange={(value) => setFilter("search", value)} placeholder="搜索群组" /><select value={status} onChange={(event) => setFilter("status", event.target.value)}><option value="">全部状态</option><option value="PENDING">待执行</option><option value="SENT">已发送</option><option value="FAILED">失败</option><option value="CANCELLED">已取消</option></select></div>
      {state.loading ? <LoadingState /> : state.error || !state.data ? <ErrorState message={state.error ?? "暂无数据"} retry={state.reload} /> : state.data.items.length === 0 ? <EmptyState title="暂无定时消息" /> : <><div className="table-scroll"><table><thead><tr><th>内容</th><th>群组</th><th>发送时间</th><th>重复规则</th><th>状态</th><th>操作</th></tr></thead><tbody>{state.data.items.map((item) => <ScheduledRow item={item} onChanged={state.reload} key={item.id} />)}</tbody></table></div><Pagination page={state.data.page} pageSize={state.data.pageSize} total={state.data.total} onPage={(value) => setFilter("page", String(value))} /></>}
    </section>
    {creating && <CreateScheduledDialog close={() => setCreating(false)} onSaved={() => { setCreating(false); state.reload(); }} />}
  </>;
}

function CreateScheduledDialog({ close, onSaved }: { close: () => void; onSaved: () => void }) {
  const toast = useToast(); const chats = useResource<PageResult<Chat>>("/api/admin/chats?page=1&pageSize=100&status=ACTIVE"); const [chatId, setChatId] = useState(""); const [name, setName] = useState(""); const [text, setText] = useState(""); const [sendAt, setSendAt] = useState(""); const [repeatMinutes, setRepeatMinutes] = useState(""); const [working, setWorking] = useState(false);
  const submit = async () => { const date = new Date(sendAt); if (!chatId || !name.trim() || !text.trim() || !sendAt || Number.isNaN(date.getTime())) { toast.notify("请完整填写消息信息", "error"); return; } setWorking(true); try { await api("/api/admin/scheduled-messages", { method: "POST", body: JSON.stringify({ chatId, name: name.trim(), text: text.trim(), sendAt: date.toISOString(), ...(Number(repeatMinutes) > 0 ? { repeatIntervalMinutes: Number(repeatMinutes) } : {}) }) }); toast.notify("定时消息已创建并入队"); onSaved(); } catch (caught) { toast.notify(caught instanceof Error ? caught.message : "创建失败", "error"); } finally { setWorking(false); } };
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}><section className="modal setting-modal"><div className="modal-header"><div><h2>新建定时消息</h2><p>创建后立即进入发送队列</p></div><button className="icon-button" title="关闭" onClick={close}><X size={18} /></button></div><div className="form-stack"><label><span>群组或频道</span><select value={chatId} onChange={(event) => setChatId(event.target.value)}><option value="">选择目标</option>{chats.data?.items.map((chat) => <option key={chat.id} value={chat.id}>{chat.title ?? chat.telegramChatId}</option>)}</select></label><label><span>任务名称</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={64} /></label><label><span>消息正文</span><textarea className="content-editor" value={text} onChange={(event) => setText(event.target.value)} maxLength={4096} /></label><label><span>首次发送时间</span><input type="datetime-local" value={sendAt} onChange={(event) => setSendAt(event.target.value)} /></label><label><span>重复间隔（分钟，留空表示单次）</span><input type="number" min="1" max="43200" value={repeatMinutes} onChange={(event) => setRepeatMinutes(event.target.value)} /></label></div><div className="modal-actions"><button className="button secondary" onClick={close}>取消</button><button className="button primary" disabled={working} onClick={submit}><CalendarClock size={16} />创建任务</button></div></section></div>;
}

function ScheduledRow({ item, onChanged }: { item: ScheduledMessage; onChanged: () => void }) {
  const toast = useToast(); const [working, setWorking] = useState(false); const content = item.content ?? {};
  const cancel = async () => {
    if (!window.confirm("确认取消这条定时消息？")) return;
    setWorking(true); try { await api(`/api/admin/scheduled-messages/${item.id}/cancel`, { method: "POST" }); toast.notify("定时消息已取消"); onChanged(); } catch (caught) { toast.notify(caught instanceof Error ? caught.message : "操作失败", "error"); } finally { setWorking(false); }
  };
  const retry = async () => {
    if (!window.confirm("确认重新投递这条定时消息？")) return;
    setWorking(true); try { await api(`/api/admin/scheduled-messages/${item.id}/retry`, { method: "POST" }); toast.notify("定时消息已重新入队"); onChanged(); } catch (caught) { toast.notify(caught instanceof Error ? caught.message : "重试失败", "error"); } finally { setWorking(false); }
  };
  return <tr><td><div className="primary-cell"><span className="entity-avatar message-avatar"><CalendarClock size={16} /></span><div><strong>{content.name || content.text?.slice(0, 42) || item.contentType}</strong><small>{item.contentType}</small>{item.lastError && <small className="task-error" title={item.lastError}>{item.lastError}</small>}</div></div></td><td><Link className="table-link" to={`/chats/${item.chat.id}`}>{item.chat.title ?? "未命名群组"}</Link></td><td>{formatDate(item.sendAt)}</td><td>{item.repeatRule ? "周期任务" : "单次"}</td><td><StatusBadge value={item.status} />{item.attemptCount > 0 && <small className="table-subline">已尝试 {item.attemptCount} 次</small>}</td><td><div className="row-actions">{item.status === "FAILED" && <button className="icon-button small" disabled={working} onClick={retry} title="重新投递"><RotateCcw size={16} /></button>}{["PENDING", "DRAFT", "FAILED"].includes(item.status) && <button className="icon-button danger-button small" disabled={working} onClick={cancel} title="取消消息"><Ban size={16} /></button>}<Link className="icon-button small" to={`/chats/${item.chat.id}`} title="查看群组"><ExternalLink size={15} /></Link></div></td></tr>;
}
