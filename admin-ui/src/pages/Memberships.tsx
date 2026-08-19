import { AlertTriangle, BadgeDollarSign, CalendarClock, CheckCircle2, Copy, CreditCard, Crown, Eye, ExternalLink, KeyRound, PackageCheck, Plus, ReceiptText, RefreshCw, RotateCcw, Save, Server, ShieldCheck, SlidersHorizontal, UserRound, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useToast } from "../components/Toast";
import { EmptyState, ErrorState, formatDate, LoadingState, PageHeader, Pagination, RefreshButton, SearchBox, StatusBadge } from "../components/Ui";
import { useResource } from "../hooks/useResource";
import type { BotSubscription, MembershipOverview, MembershipUiSettings, PageResult, PaymentOrder, PaymentSettings, User } from "../types";

type Tab = "overview" | "subscriptions" | "orders" | "plans" | "config";
type MemberUser = Pick<User, "id" | "telegramUserId" | "username" | "firstName"> & { lastName?: string | null };

export function MembershipsPage() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const defaultTab: Tab = location.pathname.startsWith("/commercialization/payment") ? "config" : "overview";
  const tab = (params.get("tab") as Tab | null) ?? defaultTab;
  const setTab = (value: Tab) => setParams(value === defaultTab ? {} : { tab: value }, { replace: true });
  const uiState = useResource<MembershipUiSettings>("/api/admin/membership-ui");
  const plansTabLabel = uiState.data?.plansTabLabel ?? "套餐权益";
  const tabs: Array<{ value: Tab; label: string; icon: typeof Crown }> = [
    { value: "overview", label: "经营概览", icon: BadgeDollarSign },
    { value: "subscriptions", label: "会员状态", icon: Crown },
    { value: "orders", label: "支付订单", icon: CreditCard },
    { value: "plans", label: plansTabLabel, icon: PackageCheck },
    { value: "config", label: "支付配置", icon: SlidersHorizontal }
  ];
  return <>
    <PageHeader title="会员与支付" description="会员有效期、订单状态、套餐权益和人工授权" />
    <nav className="page-tabs">{tabs.map(({ value, label, icon: Icon }) => <button key={value} className={tab === value ? "active" : ""} onClick={() => setTab(value)}><Icon size={15} />{label}</button>)}</nav>
    {tab === "overview" ? <OverviewView /> : tab === "subscriptions" ? <SubscriptionsView /> : tab === "orders" ? <PaymentOrdersView /> : tab === "plans" ? <PlansView plansTabLabel={plansTabLabel} onSettingsSaved={uiState.reload} /> : <PaymentConfigView />}
  </>;
}

function OverviewView() {
  const state = useResource<MembershipOverview>("/api/admin/membership-overview");
  if (state.loading) return <LoadingState />;
  if (state.error || !state.data) return <ErrorState message={state.error ?? "暂无数据"} retry={state.reload} />;
  const { data } = state;
  const metrics = [
    { label: "有效会员", value: String(data.metrics.activeMembers), detail: `${data.metrics.expiringMembers} 人将在 7 天内到期`, icon: Crown, tone: "tone-violet" },
    { label: "待处理支付", value: String(data.metrics.waitingPayments), detail: "待支付、确认中或等待回调", icon: CreditCard, tone: "tone-amber" },
    { label: "近 30 天收入", value: `${data.metrics.revenue30dUsd} USD`, detail: `${data.metrics.paidOrders30d} 笔已完成订单`, icon: BadgeDollarSign, tone: "tone-green" },
    { label: "支付异常", value: String(data.metrics.failedPayments30d), detail: `近 30 天失败 · ${data.metrics.refundedOrders30d} 笔退款`, icon: AlertTriangle, tone: data.metrics.failedPayments30d ? "tone-amber" : "tone-teal" }
  ];
  return <>
    <div className="metric-grid membership-metrics">{metrics.map(({ label, value, detail, icon: Icon, tone }) => <div className="metric-card" key={label}><span className={`metric-icon ${tone}`}><Icon size={19} /></span><span className="metric-label">{label}</span><strong>{value}</strong><span>{detail}</span></div>)}</div>
    <div className="dashboard-grid membership-overview-grid">
      <section className="panel"><div className="panel-header"><div><h2>最近订单</h2><p>优先处理待支付、失败和退款记录</p></div><Link className="text-link" to="/memberships?tab=orders">查看全部</Link></div>{data.recentOrders.length ? <div className="table-scroll"><table><thead><tr><th>订单</th><th>用户</th><th>套餐</th><th>金额</th><th>状态</th><th>时间</th></tr></thead><tbody>{data.recentOrders.map((item) => <tr key={item.id}><td><code>{shortId(item.id)}</code></td><td>{userName(item.user)}</td><td>{item.planKey} · {item.months} 个月</td><td>{item.amountUsd} USD</td><td><StatusBadge value={item.status} /></td><td>{formatDate(item.createdAt)}</td></tr>)}</tbody></table></div> : <EmptyState title="暂无订单记录" />}</section>
      <section className="panel"><div className="panel-header"><div><h2>需要关注</h2><p>来自当前会员和支付数据的提醒</p></div><ShieldCheck size={19} /></div><div className="attention-list membership-attention"><Link to="/memberships?tab=subscriptions&status=ACTIVE"><span className="attention-icon warning"><CalendarClock size={17} /></span><div><strong>即将到期会员</strong><small>未来 7 天内需要续费提醒</small></div><b>{data.metrics.expiringMembers}</b></Link><Link to="/memberships?tab=orders&status=FAILED"><span className={`attention-icon ${data.metrics.failedPayments30d ? "danger" : "success"}`}><AlertTriangle size={17} /></span><div><strong>支付失败订单</strong><small>可尝试重新创建支付单</small></div><b>{data.metrics.failedPayments30d}</b></Link><div className="membership-config"><span className={`status-dot ${data.paymentConfigured ? "is-success" : "is-warning"}`} /><div><strong>{data.paymentConfigured ? "支付服务已配置" : "支付服务未配置"}</strong><small>{data.paymentConfigured ? "NOWPayments 回调可用" : "配置环境变量后才能创建新订单"}</small></div></div></div></section>
    </div>
  </>;
}

function PaymentConfigView() {
  const state = useResource<PaymentSettings>("/api/admin/payment-settings");
  const toast = useToast();
  const copy = async (value: string | null) => {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    toast.notify("已复制");
  };
  if (state.loading) return <LoadingState />;
  if (state.error || !state.data) return <ErrorState message={state.error ?? "暂无配置数据"} retry={state.reload} />;
  const data = state.data;
  return <div className="payment-config-grid">
    <section className="panel payment-provider-panel">
      <div className="panel-header"><div><h2>服务商状态</h2><p>当前会员支付使用 NOWPayments 发票收款</p></div><Server size={19} /></div>
      <div className="payment-provider-card">
        <div className="payment-provider-title"><span className={`status-dot ${data.configured ? "is-success" : "is-warning"}`} /><div><strong>{data.provider}</strong><small>{data.configured ? "创建订单与回调处理已具备必要配置" : "缺少必要环境变量，前台不会创建新支付订单"}</small></div><StatusBadge value={data.configured ? "ACTIVE" : "disabled"} /></div>
        <div className="payment-config-list">{data.fields.map((field) => <div key={field.key}><span>{field.label}</span><strong>{field.value || "未配置"}</strong><StatusBadge value={field.configured ? "ACTIVE" : "disabled"} /></div>)}</div>
      </div>
    </section>
    <section className="panel payment-provider-panel">
      <div className="panel-header"><div><h2>回调配置</h2><p>复制到 NOWPayments 后台的 Instant payment notifications</p></div><KeyRound size={19} /></div>
      <div className="payment-webhook-box">
        <label><span>Webhook URL</span><div><code>{data.webhookUrl ?? "配置 PUBLIC_BASE_URL 后生成"}</code><button className="icon-button small" title="复制 Webhook URL" disabled={!data.webhookUrl} onClick={() => void copy(data.webhookUrl)}><Copy size={14} /></button></div></label>
        <label><span>接口路径</span><div><code>{data.webhookPath}</code><button className="icon-button small" title="复制接口路径" onClick={() => void copy(data.webhookPath)}><Copy size={14} /></button></div></label>
      </div>
    </section>
    <section className="panel payment-config-wide">
      <div className="panel-header"><div><h2>上线检查</h2><p>支付配置来自服务端环境变量，修改后需要重启服务生效</p></div><ShieldCheck size={19} /></div>
      <div className="payment-checklist">{data.checklist.map((item) => <div key={item.label}><StatusBadge value={item.done ? "ACTIVE" : "disabled"} /><span>{item.label}</span></div>)}</div>
      <div className="payment-env-snippet"><code>NOWPAYMENTS_API_BASE=https://api.nowpayments.io/v1</code><code>NOWPAYMENTS_API_KEY=你的_API_KEY</code><code>NOWPAYMENTS_IPN_SECRET=你的_IPN_SECRET</code><code>PUBLIC_BASE_URL=https://你的域名</code></div>
    </section>
  </div>;
}

function SubscriptionsView() {
  const [params, setParams] = useSearchParams();
  const page = Number(params.get("page") ?? 1); const search = params.get("search") ?? ""; const status = params.get("status") ?? "";
  const state = useResource<PageResult<BotSubscription>>(`/api/admin/subscriptions?page=${page}&pageSize=20&search=${encodeURIComponent(search)}&subscriptionStatus=${status}`);
  const [granting, setGranting] = useState<MemberUser | null | "new">(null);
  const toast = useToast();
  const setFilter = (key: string, value: string) => updateFilter(params, setParams, key, value);
  const cancel = async (userId: string) => { if (!window.confirm("确认取消该用户当前会员？")) return; try { await api(`/api/admin/subscriptions/${userId}/cancel`, { method: "POST" }); toast.notify("会员已取消"); state.reload(); } catch (caught) { toast.notify(errorMessage(caught, "取消失败"), "error"); } };
  return <>
    <section className="panel table-panel"><div className="filter-bar"><SearchBox value={search} onChange={(value) => setFilter("search", value)} placeholder="用户名、姓名或 Telegram ID" /><select value={status} onChange={(event) => setFilter("status", event.target.value)}><option value="">全部状态</option><option value="ACTIVE">有效</option><option value="EXPIRED">已过期</option><option value="CANCELLED">已取消</option></select><div className="filter-actions"><button className="button primary" onClick={() => setGranting("new")}><Plus size={16} />人工开通</button><RefreshButton onClick={state.reload} spinning={state.refreshing} /></div></div>{state.loading ? <LoadingState /> : state.error || !state.data ? <ErrorState message={state.error ?? "暂无数据"} retry={state.reload} /> : state.data.items.length === 0 ? <EmptyState title="暂无会员记录" /> : <><div className="table-scroll"><table><thead><tr><th>用户</th><th>状态</th><th>到期时间</th><th>剩余</th><th>来源</th><th /></tr></thead><tbody>{state.data.items.map((item) => <tr key={item.id}><td><div className="primary-cell"><span className="entity-avatar user-avatar"><UserRound size={16} /></span><div><strong>{userName(item.user)}</strong><small>{item.user.telegramUserId}</small></div></div></td><td><StatusBadge value={item.status} /></td><td>{formatDate(item.expiresAt)}</td><td>{remainingDays(item.expiresAt)}</td><td>{item.source}</td><td><div className="row-actions"><button className="icon-button small" title="延长会员" onClick={() => setGranting(item.user)}><Plus size={15} /></button>{item.status === "ACTIVE" && <button className="icon-button small danger-button" title="取消会员" onClick={() => cancel(item.userId)}><RotateCcw size={15} /></button>}</div></td></tr>)}</tbody></table></div><Pagination page={state.data.page} pageSize={state.data.pageSize} total={state.data.total} onPage={(value) => setFilter("page", String(value))} /></>}</section>
    {granting && <GrantSubscriptionModal initialUser={granting === "new" ? null : granting} close={() => setGranting(null)} saved={() => { setGranting(null); state.reload(); }} />}
  </>;
}

function GrantSubscriptionModal({ initialUser, close, saved }: { initialUser: MemberUser | null; close: () => void; saved: () => void }) {
  const [search, setSearch] = useState(initialUser ? userName(initialUser) : ""); const [selected, setSelected] = useState<MemberUser | null>(initialUser); const [months, setMonths] = useState("1"); const [results, setResults] = useState<User[]>([]); const [loading, setLoading] = useState(false); const [saving, setSaving] = useState(false); const toast = useToast();
  useEffect(() => { let cancelled = false; if (selected || search.trim().length < 2) { setResults([]); return; } setLoading(true); void api<PageResult<User>>(`/api/admin/users?page=1&pageSize=8&search=${encodeURIComponent(search.trim())}`).then((data) => { if (!cancelled) setResults(data.items); }).catch(() => { if (!cancelled) setResults([]); }).finally(() => { if (!cancelled) setLoading(false); }); return () => { cancelled = true; }; }, [search, selected]);
  const submit = async () => { if (!selected) { toast.notify("请选择用户", "error"); return; } setSaving(true); try { await api(`/api/admin/subscriptions/${selected.id}/grant`, { method: "POST", body: JSON.stringify({ months: Number(months) }) }); toast.notify("会员已开通"); saved(); } catch (caught) { toast.notify(errorMessage(caught, "开通失败"), "error"); } finally { setSaving(false); } };
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}><section className="modal membership-modal"><div className="modal-header"><div><h2>人工开通会员</h2><p>用于客服补偿、线下付款或测试账号</p></div><button className="icon-button" title="关闭" onClick={close}><X size={18} /></button></div><div className="form-stack"><label><span>选择用户</span>{selected ? <div className="selected-user"><UserRound size={16} /><div><strong>{userName(selected)}</strong><small>{selected.telegramUserId}</small></div><button className="icon-button small" title="重新选择" onClick={() => { setSelected(null); setSearch(""); }}><X size={14} /></button></div> : <><input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="输入用户名、姓名或 Telegram ID" />{loading && <small className="form-hint">正在搜索…</small>}{results.length > 0 && <div className="user-results">{results.map((user) => <button key={user.id} onClick={() => setSelected(user)}><UserRound size={15} /><span><strong>{userName(user)}</strong><small>{user.telegramUserId}</small></span></button>)}</div>}</>}</label><label><span>授权时长</span><select value={months} onChange={(event) => setMonths(event.target.value)}><option value="1">1 个月</option><option value="3">3 个月</option><option value="6">6 个月</option><option value="12">12 个月</option></select></label></div><div className="modal-actions"><button className="button secondary" onClick={close}>取消</button><button className="button primary" disabled={saving || !selected} onClick={() => void submit()}><CheckCircle2 size={16} />确认开通</button></div></section></div>;
}

function PaymentOrdersView() {
  const [params, setParams] = useSearchParams(); const page = Number(params.get("page") ?? 1); const search = params.get("search") ?? ""; const status = params.get("status") ?? "";
  const state = useResource<PageResult<PaymentOrder>>(`/api/admin/payment-orders?page=${page}&pageSize=20&search=${encodeURIComponent(search)}&orderStatus=${status}`); const setFilter = (key: string, value: string) => updateFilter(params, setParams, key, value); const toast = useToast(); const [detail, setDetail] = useState<PaymentOrder | null>(null);
  const run = async (item: PaymentOrder, action: "reconcile" | "retry") => { try { await api(`/api/admin/payment-orders/${item.id}/${action}`, { method: "POST" }); toast.notify(action === "reconcile" ? "订单对账完成" : "支付单已重新创建"); state.reload(); } catch (caught) { toast.notify(errorMessage(caught, "订单操作失败"), "error"); } };
  const refund = async (item: PaymentOrder) => { const note = window.prompt("请输入外部退款凭证或说明", "已在支付商后台完成退款"); if (!note?.trim() || !window.confirm("确认已在支付商完成退款，并将订单标记为已退款？")) return; try { await api(`/api/admin/payment-orders/${item.id}/refund`, { method: "POST", body: JSON.stringify({ note: note.trim() }) }); toast.notify("退款状态已记录"); state.reload(); } catch (caught) { toast.notify(errorMessage(caught, "记录退款失败"), "error"); } };
  return <><section className="panel table-panel"><div className="filter-bar"><SearchBox value={search} onChange={(value) => setFilter("search", value)} placeholder="订单号、支付单号或用户" /><select value={status} onChange={(event) => setFilter("status", event.target.value)}><option value="">全部状态</option><option value="PENDING">待创建支付</option><option value="WAITING">等待支付</option><option value="CONFIRMED">已确认</option><option value="FINISHED">已完成</option><option value="FAILED">失败</option><option value="EXPIRED">已过期</option><option value="REFUNDED">已退款</option></select><div className="filter-actions"><RefreshButton onClick={state.reload} spinning={state.refreshing} /></div></div>{state.loading ? <LoadingState /> : state.error || !state.data ? <ErrorState message={state.error ?? "暂无数据"} retry={state.reload} /> : state.data.items.length === 0 ? <EmptyState title="暂无支付订单" /> : <><div className="table-scroll"><table><thead><tr><th>订单</th><th>用户</th><th>套餐</th><th>金额</th><th>状态</th><th>创建时间</th><th>支付时间</th><th /></tr></thead><tbody>{state.data.items.map((item) => <tr key={item.id}><td><code>{shortId(item.id)}</code><small className="table-subline">{item.providerPaymentId ?? "未生成支付单"}</small></td><td>{userName(item.user)}</td><td>{item.planKey} · {item.months} 个月</td><td>{item.amountUsd} USD</td><td><StatusBadge value={item.status} /></td><td>{formatDate(item.createdAt)}</td><td>{item.paidAt ? formatDate(item.paidAt) : "-"}</td><td><div className="row-actions"><button className="icon-button small" title="查看订单" onClick={() => setDetail(item)}><Eye size={15} /></button>{item.providerPaymentId && item.status !== "REFUNDED" && <button className="icon-button small" title="向支付商对账" onClick={() => run(item, "reconcile")}><RefreshCw size={15} /></button>}{!item.providerPaymentId && ["PENDING", "FAILED"].includes(item.status) && <button className="icon-button small" title="重试创建支付单" onClick={() => run(item, "retry")}><RotateCcw size={15} /></button>}{["CONFIRMED", "FINISHED"].includes(item.status) && <button className="icon-button small danger-button" title="记录外部退款" onClick={() => refund(item)}><ReceiptText size={15} /></button>}</div></td></tr>)}</tbody></table></div><Pagination page={state.data.page} pageSize={state.data.pageSize} total={state.data.total} onPage={(value) => setFilter("page", String(value))} /></>}</section>{detail && <OrderDetailModal item={detail} close={() => setDetail(null)} />}</>;
}

function OrderDetailModal({ item, close }: { item: PaymentOrder; close: () => void }) {
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}><section className="modal order-modal"><div className="modal-header"><div><h2>订单详情</h2><p>{item.id}</p></div><button className="icon-button" title="关闭" onClick={close}><X size={18} /></button></div><div className="order-detail"><div><span>用户</span><strong>{userName(item.user)}</strong><small>{item.user.telegramUserId}</small></div><div><span>订单状态</span><strong><StatusBadge value={item.status} /></strong></div><div><span>套餐</span><strong>{item.planKey} · {item.months} 个月</strong></div><div><span>金额</span><strong>{item.amountUsd} USD</strong></div><div><span>支付渠道</span><strong>{item.provider}</strong></div><div><span>支付币种</span><strong>{item.payCurrency ?? "-"}</strong></div><div><span>创建时间</span><strong>{formatDate(item.createdAt)}</strong></div><div><span>支付时间</span><strong>{item.paidAt ? formatDate(item.paidAt) : "-"}</strong></div></div><div className="modal-actions">{item.payUrl && <a className="button secondary" href={item.payUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} />支付页面</a>}<button className="button primary" onClick={close}>完成</button></div></section></div>;
}

function PlansView({ plansTabLabel, onSettingsSaved }: { plansTabLabel: string; onSettingsSaved: () => void }) {
  const state = useResource<MembershipOverview>("/api/admin/membership-overview");
  const toast = useToast();
  const [labelDraft, setLabelDraft] = useState(plansTabLabel);
  const [savingLabel, setSavingLabel] = useState(false);
  useEffect(() => setLabelDraft(plansTabLabel), [plansTabLabel]);
  const saveLabel = async () => {
    const next = labelDraft.trim();
    if (!next) { toast.notify("页签标题不能为空", "error"); return; }
    setSavingLabel(true);
    try {
      await api("/api/admin/membership-ui", { method: "PUT", body: JSON.stringify({ plansTabLabel: next }) });
      toast.notify("页签标题已更新");
      onSettingsSaved();
    } catch (caught) {
      toast.notify(errorMessage(caught, "保存失败"), "error");
    } finally {
      setSavingLabel(false);
    }
  };
  if (state.loading) return <LoadingState />;
  if (state.error || !state.data) return <ErrorState message={state.error ?? "暂无数据"} retry={state.reload} />;
  const { data } = state;
  const labels: Record<string, string> = { scheduledMessagesPerChat: "每群定时消息", channelSyncTargetsPerSource: "频道同步目标", autoReplyRulesPerChat: "自动回复规则", requiredChannelSubscriptions: "必需频道订阅" };
  return <>
    <section className="panel membership-ui-panel">
      <div className="panel-header"><div><h2>页签文案</h2><p>会员页顶部按钮标题从后台配置读取</p></div><PackageCheck size={19} /></div>
      <div className="membership-ui-form">
        <label><span>套餐权益页签标题</span><input value={labelDraft} maxLength={24} onChange={(event) => setLabelDraft(event.target.value)} /></label>
        <button className="button primary" disabled={savingLabel || !labelDraft.trim()} onClick={() => void saveLabel()}><Save size={16} />保存</button>
      </div>
    </section>
    <div className="summary-callout"><PackageCheck size={19} /><div><strong>套餐价格由服务端固定</strong><span>当前支付配置：{data.paymentConfigured ? "已启用" : "未启用"}。修改价格需要同步校验订单和权益，不在后台直接编辑。</span></div></div>
    <div className="plan-grid">{data.plans.map((plan, index) => <section className={`panel plan-card ${index === data.plans.length - 1 ? "featured" : ""}`} key={plan.key}><div className="plan-card-top"><span className="plan-icon"><Crown size={18} /></span><StatusBadge value="ACTIVE" /></div><h2>{plan.months} 个月</h2><strong>{plan.amountUsd} USD</strong><p>{plan.label}</p><div className="plan-check"><CheckCircle2 size={15} />自动延长当前会员有效期</div><div className="plan-check"><CheckCircle2 size={15} />开通高级功能额度</div></section>)}</div>
    <section className="panel plan-limits"><div className="panel-header"><div><h2>功能额度对比</h2><p>免费账号与有效会员使用上限</p></div><ShieldCheck size={19} /></div><div className="table-scroll"><table><thead><tr><th>功能</th><th>免费</th><th>会员</th></tr></thead><tbody>{Object.entries(data.featureLimits.free).map(([key, value]) => <tr key={key}><td>{labels[key] ?? key}</td><td>{value}</td><td>{data.featureLimits.premium[key] ?? "-"}</td></tr>)}</tbody></table></div></section>
  </>;
}

function updateFilter(params: URLSearchParams, setParams: ReturnType<typeof useSearchParams>[1], key: string, value: string) { const next = new URLSearchParams(params); value ? next.set(key, value) : next.delete(key); if (key !== "page") next.delete("page"); setParams(next, { replace: true }); }
function userName(user: { username: string | null; firstName: string | null; lastName?: string | null; telegramUserId: string }) { return user.username ? `@${user.username}` : [user.firstName, user.lastName].filter(Boolean).join(" ") || user.telegramUserId; }
function remainingDays(value: string) { const days = Math.ceil((new Date(value).getTime() - Date.now()) / 86_400_000); return days > 0 ? `${days} 天` : "已到期"; }
function shortId(value: string) { return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value; }
function errorMessage(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }
