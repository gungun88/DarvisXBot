import { ArrowLeft, ExternalLink, UserRound, WalletCards } from "lucide-react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useResource } from "../hooks/useResource";
import { displayName, EmptyState, ErrorState, formatDate, LoadingState, PageHeader, Pagination, RefreshButton, SearchBox } from "../components/Ui";
import type { PageResult, User } from "../types";

export function UsersPage() {
  const [params, setParams] = useSearchParams();
  const page = Number(params.get("page") ?? 1);
  const search = params.get("search") ?? "";
  const state = useResource<PageResult<User>>(`/api/admin/users?page=${page}&pageSize=20&search=${encodeURIComponent(search)}`);
  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params); value ? next.set(key, value) : next.delete(key); if (key !== "page") next.delete("page"); setParams(next, { replace: true });
  };
  return <>
    <PageHeader title="用户管理" description="Telegram 用户身份与积分关联" actions={<RefreshButton onClick={state.reload} spinning={state.refreshing} />} />
    <section className="panel table-panel">
      <div className="filter-bar"><SearchBox value={search} onChange={(value) => setFilter("search", value)} placeholder="用户名、姓名或 Telegram ID" /></div>
      {state.loading ? <LoadingState /> : state.error || !state.data ? <ErrorState message={state.error ?? "暂无数据"} retry={state.reload} /> : state.data.items.length === 0 ? <EmptyState title="没有符合条件的用户" /> : <><div className="table-scroll"><table><thead><tr><th>用户</th><th>Telegram ID</th><th>语言 / 时区</th><th>群组关系</th><th>积分账户</th><th>最近更新</th><th /></tr></thead><tbody>{state.data.items.map((user) => <tr key={user.id}><td><div className="primary-cell"><span className="entity-avatar user-avatar"><UserRound size={16} /></span><div><strong>{displayName(user)}</strong><small>{user.firstName || "未填写姓名"}</small></div></div></td><td><code>{user.telegramUserId}</code></td><td>{user.languageCode ?? "-"}<small className="table-subline">{user.timezone}</small></td><td>{user._count.ownedChats} 所有 · {user._count.adminAssignments} 管理</td><td><span className="inline-icon"><WalletCards size={15} />{user._count.pointBalances}</span></td><td>{formatDate(user.updatedAt)}</td><td><Link className="icon-button small" to={`/users/${user.id}`} title="查看用户"><ExternalLink size={16} /></Link></td></tr>)}</tbody></table></div><Pagination page={state.data.page} pageSize={state.data.pageSize} total={state.data.total} onPage={(value) => setFilter("page", String(value))} /></>}
    </section>
  </>;
}

type UserDetail = User & {
  ownedChats: { id: string; title: string | null; status: string }[];
  adminAssignments: { id: string; role: string; chat: { id: string; title: string | null; status: string } }[];
  memberships: { id: string; status: string; startsAt: string; expiresAt: string; chat: { id: string; title: string | null } }[];
  pointBalances: { id: string; balance: number; chat: { id: string; title: string | null } }[];
  pointTransactions: { id: string; type: string; delta: number; balanceAfter: number | null; note: string | null; createdAt: string; chat: { id: string; title: string | null } }[];
};

export function UserDetailPage() {
  const { id } = useParams();
  const state = useResource<UserDetail>(`/api/admin/users/${id}`);
  if (state.loading) return <LoadingState />;
  if (state.error || !state.data) return <ErrorState message={state.error ?? "用户不存在"} retry={state.reload} />;
  const user = state.data;
  return <>
    <div className="back-row"><Link to="/users"><ArrowLeft size={16} />返回用户列表</Link></div>
    <PageHeader title={displayName(user)} description={`Telegram ID ${user.telegramUserId}`} actions={<RefreshButton onClick={state.reload} spinning={state.refreshing} />} />
    <section className="detail-summary user-summary"><div><span>注册时间</span><strong>{formatDate(user.createdAt)}</strong></div><div><span>语言</span><strong>{user.languageCode ?? "未设置"}</strong></div><div><span>时区</span><strong>{user.timezone}</strong></div><div><span>管理群组</span><strong>{user.adminAssignments.length}</strong></div><div><span>积分余额</span><strong>{user.pointBalances.reduce((sum, item) => sum + item.balance, 0)}</strong></div></section>
    <div className="detail-grid">
      <section className="panel"><div className="panel-header"><div><h2>群组关系</h2><p>所有权与管理员身份</p></div><UserRound size={19} /></div><div className="compact-list">{user.ownedChats.map((chat) => <Link to={`/chats/${chat.id}`} key={`owner-${chat.id}`}><span className="entity-avatar chat-avatar">O</span><div><strong>{chat.title ?? "未命名群组"}</strong><small>所有者 · {chat.status}</small></div></Link>)}{user.adminAssignments.map((assignment) => <Link to={`/chats/${assignment.chat.id}`} key={assignment.id}><span className="entity-avatar">A</span><div><strong>{assignment.chat.title ?? "未命名群组"}</strong><small>{assignment.role}</small></div></Link>)}{!user.ownedChats.length && !user.adminAssignments.length && <div className="inline-empty">暂无群组关系</div>}</div></section>
      <section className="panel"><div className="panel-header"><div><h2>积分账户</h2><p>按群组聚合的余额</p></div><WalletCards size={19} /></div><div className="balance-list">{user.pointBalances.length ? user.pointBalances.map((balance) => <div key={balance.id}><span>{balance.chat.title ?? "未命名群组"}</span><strong>{balance.balance.toLocaleString("zh-CN")}</strong></div>) : <div className="inline-empty">暂无积分账户</div>}</div></section>
      <section className="panel wide"><div className="panel-header"><div><h2>成员权益</h2><p>群组会员状态与有效期</p></div></div>{user.memberships.length ? <div className="table-scroll"><table><thead><tr><th>群组</th><th>状态</th><th>开始时间</th><th>到期时间</th></tr></thead><tbody>{user.memberships.map((membership) => <tr key={membership.id}><td><Link className="table-link" to={`/chats/${membership.chat.id}`}>{membership.chat.title ?? "未命名群组"}</Link></td><td>{membership.status}</td><td>{formatDate(membership.startsAt)}</td><td>{formatDate(membership.expiresAt)}</td></tr>)}</tbody></table></div> : <EmptyState title="暂无成员权益" />}</section>
      <section className="panel wide"><div className="panel-header"><div><h2>积分流水</h2><p>最近 20 条变动</p></div></div>{user.pointTransactions.length ? <div className="table-scroll"><table><thead><tr><th>群组</th><th>类型</th><th>变动</th><th>余额</th><th>备注</th><th>时间</th></tr></thead><tbody>{user.pointTransactions.map((transaction) => <tr key={transaction.id}><td>{transaction.chat.title ?? "未命名群组"}</td><td>{transaction.type}</td><td className={transaction.delta >= 0 ? "amount-positive" : "amount-negative"}>{transaction.delta > 0 ? "+" : ""}{transaction.delta}</td><td>{transaction.balanceAfter ?? "-"}</td><td>{transaction.note ?? "-"}</td><td>{formatDate(transaction.createdAt)}</td></tr>)}</tbody></table></div> : <EmptyState title="暂无积分流水" />}</section>
    </div>
  </>;
}
