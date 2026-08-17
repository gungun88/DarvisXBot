import { Archive, ArrowDownLeft, ArrowUpRight, Box, PackagePlus, Pencil, Plus, RefreshCw, RotateCcw, Send, WalletCards, X } from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useToast } from "../components/Toast";
import { EmptyState, ErrorState, formatDate, LoadingState, PageHeader, Pagination, RefreshButton, SearchBox, StatusBadge } from "../components/Ui";
import { useResource } from "../hooks/useResource";
import type { Chat, PageResult, PointProduct, PointRedemption, PointTransaction, User } from "../types";

type PointTab = "transactions" | "products" | "redemptions";

export function PointsPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as PointTab | null) ?? "transactions";
  const setTab = (value: PointTab) => setParams(value === "transactions" ? {} : { tab: value }, { replace: true });
  return <>
    <PageHeader title="积分与兑换" description="积分流水、商品库存和卡密交付统一管理" />
    <nav className="page-tabs" aria-label="积分管理视图">
      <button className={tab === "transactions" ? "active" : ""} onClick={() => setTab("transactions")}>积分流水</button>
      <button className={tab === "products" ? "active" : ""} onClick={() => setTab("products")}>商品库存</button>
      <button className={tab === "redemptions" ? "active" : ""} onClick={() => setTab("redemptions")}>兑换交付</button>
    </nav>
    {tab === "transactions" && <TransactionsView />}
    {tab === "products" && <ProductsView />}
    {tab === "redemptions" && <RedemptionsView />}
  </>;
}

function TransactionsView() {
  const [params, setParams] = useSearchParams();
  const page = Number(params.get("page") ?? 1); const search = params.get("search") ?? ""; const type = params.get("type") ?? "";
  const state = useResource<PageResult<PointTransaction>>(`/api/admin/points/transactions?page=${page}&pageSize=20&search=${encodeURIComponent(search)}&type=${type}`);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const setFilter = (key: string, value: string) => updateFilter(params, setParams, key, value);
  return <>
    <div className="view-actions"><button className="button primary" onClick={() => setAdjustOpen(true)}><Plus size={16} />人工调整</button><RefreshButton onClick={state.reload} spinning={state.refreshing} /></div>
    <section className="panel table-panel"><div className="filter-bar"><SearchBox value={search} onChange={(value) => setFilter("search", value)} placeholder="用户、备注或群组" /><select value={type} onChange={(event) => setFilter("type", event.target.value)}><option value="">全部类型</option><option value="SIGN_IN">签到</option><option value="SPEECH">发言</option><option value="INVITE">邀请</option><option value="MANUAL">人工</option><option value="LOTTERY">抽奖</option><option value="EXCHANGE">兑换</option></select></div>
      {state.loading ? <LoadingState /> : state.error || !state.data ? <ErrorState message={state.error ?? "暂无数据"} retry={state.reload} /> : state.data.items.length === 0 ? <EmptyState title="暂无积分流水" /> : <><div className="table-scroll"><table><thead><tr><th>用户</th><th>群组</th><th>类型</th><th>变动</th><th>变动后余额</th><th>备注</th><th>时间</th></tr></thead><tbody>{state.data.items.map((item) => <tr key={item.id}><td><strong>{userName(item.user)}</strong></td><td>{item.chat.title ?? "未命名群组"}</td><td>{item.type}</td><td className={item.delta >= 0 ? "amount-positive" : "amount-negative"}>{item.delta >= 0 ? <ArrowUpRight size={15} /> : <ArrowDownLeft size={15} />}{item.delta > 0 ? "+" : ""}{item.delta}</td><td>{item.balanceAfter ?? "-"}</td><td>{item.note ?? "-"}</td><td>{formatDate(item.createdAt)}</td></tr>)}</tbody></table></div><Pagination page={state.data.page} pageSize={state.data.pageSize} total={state.data.total} onPage={(value) => setFilter("page", String(value))} /></>}
    </section>
    {adjustOpen && <AdjustmentDialog close={() => setAdjustOpen(false)} onSaved={() => { setAdjustOpen(false); state.reload(); }} />}
  </>;
}

function ProductsView() {
  const [params, setParams] = useSearchParams();
  const page = Number(params.get("page") ?? 1); const search = params.get("search") ?? ""; const listed = params.get("listed") ?? "";
  const state = useResource<PageResult<PointProduct>>(`/api/admin/points/products?page=${page}&pageSize=20&search=${encodeURIComponent(search)}&listed=${listed}`);
  const [editing, setEditing] = useState<PointProduct | "new" | null>(null);
  const [inventory, setInventory] = useState<PointProduct | null>(null);
  const toast = useToast();
  const setFilter = (key: string, value: string) => updateFilter(params, setParams, key, value);
  const archive = async (product: PointProduct) => {
    if (!window.confirm(`确认下架并归档“${product.name}”？历史兑换记录会保留。`)) return;
    try { await api(`/api/admin/points/products/${product.chatId}/${product.externalId}`, { method: "DELETE" }); toast.notify("商品已归档"); state.reload(); }
    catch (caught) { toast.notify(errorMessage(caught, "归档失败"), "error"); }
  };
  return <>
    <div className="view-actions"><button className="button primary" onClick={() => setEditing("new")}><PackagePlus size={16} />新建商品</button><RefreshButton onClick={state.reload} spinning={state.refreshing} /></div>
    <section className="panel table-panel"><div className="filter-bar"><SearchBox value={search} onChange={(value) => setFilter("search", value)} placeholder="商品、编号或群组" /><select value={listed} onChange={(event) => setFilter("listed", event.target.value)}><option value="">全部状态</option><option value="true">已上架</option><option value="false">未上架</option></select></div>
      {state.loading ? <LoadingState /> : state.error || !state.data ? <ErrorState message={state.error ?? "暂无数据"} retry={state.reload} /> : state.data.items.length === 0 ? <EmptyState title="暂无兑换商品" /> : <><div className="table-scroll"><table><thead><tr><th>商品</th><th>群组</th><th>积分</th><th>可用库存</th><th>已兑换</th><th>每日限额</th><th>状态</th><th /></tr></thead><tbody>{state.data.items.map((item) => <tr key={item.id}><td><div className="primary-cell"><span className="entity-avatar"><Box size={16} /></span><div><strong>{item.name}</strong><small>编号 {item.externalId}</small></div></div></td><td>{item.chat.title ?? "未命名群组"}</td><td>{item.cost.toLocaleString("zh-CN")}</td><td><strong>{item.availableCodes.length}</strong><small className="table-subline">共 {item._count.codes} 条记录</small></td><td>{item.soldCount}</td><td>{item.dailyLimit || "不限"}</td><td><StatusBadge value={item.listed ? "ACTIVE" : "inactive"} /></td><td><div className="row-actions"><button className="icon-button small" title="编辑商品" onClick={() => setEditing(item)}><Pencil size={15} /></button><button className="icon-button small" title="管理库存" onClick={() => setInventory(item)}><Box size={15} /></button><button className="icon-button small danger-button" title="归档商品" onClick={() => archive(item)}><Archive size={15} /></button></div></td></tr>)}</tbody></table></div><Pagination page={state.data.page} pageSize={state.data.pageSize} total={state.data.total} onPage={(value) => setFilter("page", String(value))} /></>}
    </section>
    {editing && <ProductDialog product={editing === "new" ? undefined : editing} close={() => setEditing(null)} onSaved={() => { setEditing(null); state.reload(); }} />}
    {inventory && <InventoryDialog product={inventory} close={() => setInventory(null)} onSaved={() => { setInventory(null); state.reload(); }} />}
  </>;
}

function RedemptionsView() {
  const [params, setParams] = useSearchParams();
  const page = Number(params.get("page") ?? 1); const search = params.get("search") ?? ""; const status = params.get("status") ?? "";
  const state = useResource<PageResult<PointRedemption>>(`/api/admin/points/redemptions?page=${page}&pageSize=20&search=${encodeURIComponent(search)}&redemptionStatus=${status}`);
  const setFilter = (key: string, value: string) => updateFilter(params, setParams, key, value);
  return <>
    <div className="view-actions"><RefreshButton onClick={state.reload} spinning={state.refreshing} /></div>
    <section className="panel table-panel"><div className="filter-bar"><SearchBox value={search} onChange={(value) => setFilter("search", value)} placeholder="商品、用户或群组" /><select value={status} onChange={(event) => setFilter("status", event.target.value)}><option value="">全部状态</option><option value="DELIVERY_PENDING">待交付</option><option value="FULFILLED">已交付</option><option value="REFUNDED">已退款</option></select></div>
      {state.loading ? <LoadingState /> : state.error || !state.data ? <ErrorState message={state.error ?? "暂无数据"} retry={state.reload} /> : state.data.items.length === 0 ? <EmptyState title="暂无兑换记录" /> : <><div className="table-scroll"><table><thead><tr><th>用户</th><th>商品</th><th>群组</th><th>积分</th><th>卡密</th><th>状态</th><th>交付信息</th><th>时间</th><th /></tr></thead><tbody>{state.data.items.map((item) => <RedemptionRow key={item.id} item={item} onChanged={state.reload} />)}</tbody></table></div><Pagination page={state.data.page} pageSize={state.data.pageSize} total={state.data.total} onPage={(value) => setFilter("page", String(value))} /></>}
    </section>
  </>;
}

function RedemptionRow({ item, onChanged }: { item: PointRedemption; onChanged: () => void }) {
  const toast = useToast(); const [working, setWorking] = useState(false);
  const retry = async () => { if (!window.confirm("确认通过 Telegram 私聊重新发送卡密？")) return; setWorking(true); try { await api(`/api/admin/points/redemptions/${item.id}/retry`, { method: "POST" }); toast.notify("卡密已补发"); onChanged(); } catch (caught) { toast.notify(errorMessage(caught, "补发失败"), "error"); } finally { setWorking(false); } };
  const refund = async () => { const note = window.prompt("请输入退款原因", "卡密交付失败，退回积分"); if (!note?.trim()) return; setWorking(true); try { await api(`/api/admin/points/redemptions/${item.id}/refund`, { method: "POST", body: JSON.stringify({ note: note.trim() }) }); toast.notify("积分已退回，卡密已释放"); onChanged(); } catch (caught) { toast.notify(errorMessage(caught, "退款失败"), "error"); } finally { setWorking(false); } };
  return <tr><td><strong>{userName(item.user)}</strong><small className="table-subline">{item.user.telegramUserId}</small></td><td>{item.product.name}<small className="table-subline">编号 {item.product.externalId}</small></td><td>{item.chat.title ?? "未命名群组"}</td><td>{item.cost}</td><td><code>{item.code.value}</code></td><td><StatusBadge value={item.status} /></td><td>{item.deliveryError ? <span className="task-error" title={item.deliveryError}>{item.deliveryError}</span> : item.deliveredAt ? formatDate(item.deliveredAt) : "等待发送"}</td><td>{formatDate(item.createdAt)}</td><td>{item.status === "DELIVERY_PENDING" && <div className="row-actions"><button className="icon-button small" title="补发卡密" disabled={working} onClick={retry}><Send size={15} /></button><button className="icon-button small danger-button" title="退回积分" disabled={working} onClick={refund}><RotateCcw size={15} /></button></div>}</td></tr>;
}

function ProductDialog({ product, close, onSaved }: { product?: PointProduct; close: () => void; onSaved: () => void }) {
  const toast = useToast(); const chats = useResource<PageResult<Chat>>("/api/admin/chats?page=1&pageSize=100&status=ACTIVE");
  const [chatId, setChatId] = useState(product?.chatId ?? ""); const [name, setName] = useState(product?.name ?? ""); const [cost, setCost] = useState(String(product?.cost ?? 1)); const [dailyLimit, setDailyLimit] = useState(String(product?.dailyLimit ?? 0)); const [listed, setListed] = useState(product?.listed ?? false); const [working, setWorking] = useState(false);
  const submit = async () => { if (!chatId || !name.trim() || Number(cost) < 1 || Number(dailyLimit) < 0) { toast.notify("请完整填写商品信息", "error"); return; } setWorking(true); try { const body = JSON.stringify({ chatId, name: name.trim(), cost: Number(cost), dailyLimit: Number(dailyLimit), listed }); await api(product ? `/api/admin/points/products/${product.chatId}/${product.externalId}` : "/api/admin/points/products", { method: product ? "PATCH" : "POST", body }); toast.notify(product ? "商品已更新" : "商品已创建"); onSaved(); } catch (caught) { toast.notify(errorMessage(caught, "保存失败"), "error"); } finally { setWorking(false); } };
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}><section className="modal"><div className="modal-header"><div><h2>{product ? "编辑商品" : "新建兑换商品"}</h2><p>库存创建后可单独批量维护</p></div><button className="icon-button" onClick={close} title="关闭"><X size={18} /></button></div><div className="form-stack"><label><span>群组</span><select value={chatId} disabled={Boolean(product)} onChange={(event) => setChatId(event.target.value)}><option value="">选择群组</option>{chats.data?.items.map((chat) => <option value={chat.id} key={chat.id}>{chat.title ?? chat.telegramChatId}</option>)}</select></label><label><span>商品名称</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={64} /></label><label><span>所需积分</span><input type="number" min="1" value={cost} onChange={(event) => setCost(event.target.value)} /></label><label><span>单用户每日限额（0 表示不限）</span><input type="number" min="0" value={dailyLimit} onChange={(event) => setDailyLimit(event.target.value)} /></label><label className="toggle-row"><span><strong>立即上架</strong><small>库存不足时用户仍会看到商品，但无法兑换</small></span><span className="switch"><input type="checkbox" checked={listed} onChange={(event) => setListed(event.target.checked)} /><span /></span></label></div><div className="modal-actions"><button className="button secondary" onClick={close}>取消</button><button className="button primary" disabled={working} onClick={submit}><WalletCards size={16} />保存商品</button></div></section></div>;
}

function InventoryDialog({ product, close, onSaved }: { product: PointProduct; close: () => void; onSaved: () => void }) {
  const toast = useToast(); const [codes, setCodes] = useState(product.availableCodes.join("\n")); const [working, setWorking] = useState(false); const count = uniqueLines(codes).length;
  const submit = async () => { if (!window.confirm(`确认用当前 ${count} 条卡密替换全部可用库存？已预留或已交付的卡密不会被修改。`)) return; setWorking(true); try { await api(`/api/admin/points/products/${product.chatId}/${product.externalId}/codes`, { method: "PUT", body: JSON.stringify({ codes: uniqueLines(codes) }) }); toast.notify("可用库存已更新"); onSaved(); } catch (caught) { toast.notify(errorMessage(caught, "库存更新失败"), "error"); } finally { setWorking(false); } };
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}><section className="modal inventory-modal"><div className="modal-header"><div><h2>管理商品库存</h2><p>{product.name} · 当前可用 {product.availableCodes.length} 条</p></div><button className="icon-button" onClick={close} title="关闭"><X size={18} /></button></div><div className="form-stack"><label><span>卡密列表（每行一条，自动去重）</span><textarea className="inventory-editor" value={codes} onChange={(event) => setCodes(event.target.value)} placeholder="CODE-001\nCODE-002" /></label><div className="inventory-summary"><Box size={16} /><span>保存后可用库存为 <strong>{count}</strong> 条</span></div></div><div className="modal-actions"><button className="button secondary" onClick={close}>取消</button><button className="button primary" disabled={working} onClick={submit}><RefreshCw size={16} />替换库存</button></div></section></div>;
}

function AdjustmentDialog({ close, onSaved }: { close: () => void; onSaved: () => void }) {
  const toast = useToast(); const chats = useResource<PageResult<Chat>>("/api/admin/chats?page=1&pageSize=100&status=ACTIVE"); const users = useResource<PageResult<User>>("/api/admin/users?page=1&pageSize=100");
  const [chatId, setChatId] = useState(""); const [userId, setUserId] = useState(""); const [delta, setDelta] = useState(""); const [note, setNote] = useState(""); const [working, setWorking] = useState(false);
  const submit = async () => { if (!chatId || !userId || !Number(delta) || note.trim().length < 2) { toast.notify("请完整填写调整信息", "error"); return; } setWorking(true); try { await api("/api/admin/points/adjustments", { method: "POST", body: JSON.stringify({ chatId, userId, delta: Number(delta), note: note.trim() }) }); toast.notify("积分已调整"); onSaved(); } catch (caught) { toast.notify(errorMessage(caught, "调整失败"), "error"); } finally { setWorking(false); } };
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}><section className="modal"><div className="modal-header"><div><h2>人工调整积分</h2><p>记录会同步写入审计日志</p></div><button className="icon-button" onClick={close} title="关闭"><X size={18} /></button></div><div className="form-stack"><label><span>群组</span><select value={chatId} onChange={(event) => setChatId(event.target.value)}><option value="">选择群组</option>{chats.data?.items.map((chat) => <option value={chat.id} key={chat.id}>{chat.title ?? chat.telegramChatId}</option>)}</select></label><label><span>用户</span><select value={userId} onChange={(event) => setUserId(event.target.value)}><option value="">选择用户</option>{users.data?.items.map((user) => <option value={user.id} key={user.id}>{userName(user)}</option>)}</select></label><label><span>积分变动</span><input type="number" value={delta} onChange={(event) => setDelta(event.target.value)} placeholder="正数增加，负数扣减" /></label><label><span>备注</span><input value={note} onChange={(event) => setNote(event.target.value)} placeholder="填写调整原因" maxLength={255} /></label></div><div className="modal-actions"><button className="button secondary" onClick={close}>取消</button><button className="button primary" disabled={working} onClick={submit}><WalletCards size={16} />确认调整</button></div></section></div>;
}

function updateFilter(params: URLSearchParams, setParams: ReturnType<typeof useSearchParams>[1], key: string, value: string) { const next = new URLSearchParams(params); value ? next.set(key, value) : next.delete(key); if (key !== "page") next.delete("page"); setParams(next, { replace: true }); }
function uniqueLines(value: string) { return [...new Set(value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))]; }
function userName(user: { username: string | null; firstName: string | null; telegramUserId: string }) { return user.username ? `@${user.username}` : user.firstName ?? user.telegramUserId; }
function errorMessage(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }
