import { Activity, CalendarClock, Gift, MessageSquareText, ShieldCheck, TriangleAlert, UserPlus, Users } from "lucide-react";
import { Link } from "react-router-dom";
import { useResource } from "../hooks/useResource";
import { ErrorState, formatDate, LoadingState, PageHeader, RefreshButton, StatusBadge } from "../components/Ui";

type DashboardData = {
  metrics: {
    totalChats: number; activeChats: number; totalUsers: number; newUsersToday: number;
    pendingMessages: number; failedMessages: number; activeGiveaways: number; failedGiveaways: number; moderationEventsToday: number; pendingRedemptions: number; activeSubscriptions: number; waitingPayments: number; messagesToday: number;
  };
  activity: { date: string; messages: number }[];
  recentAudit: { id: string; action: string; targetType: string | null; chat: { id: string; title: string | null } | null; createdAt: string }[];
};

export function DashboardPage() {
  const state = useResource<DashboardData>("/api/admin/dashboard");
  if (state.loading) return <LoadingState />;
  if (state.error || !state.data) return <ErrorState message={state.error ?? "暂无数据"} retry={state.reload} />;
  const { metrics, activity, recentAudit } = state.data;
  const maxActivity = Math.max(1, ...activity.map((item) => item.messages));
  const metricsList = [
    { label: "活跃群组", value: metrics.activeChats, detail: `共 ${metrics.totalChats} 个`, icon: ShieldCheck, tone: "teal", href: "/chats" },
    { label: "用户总数", value: metrics.totalUsers, detail: `今日新增 ${metrics.newUsersToday}`, icon: Users, tone: "blue", href: "/users" },
    { label: "今日消息", value: metrics.messagesToday, detail: "已统计消息", icon: MessageSquareText, tone: "violet", href: "/dashboard" },
    { label: "待发消息", value: metrics.pendingMessages, detail: `${metrics.failedMessages} 个失败`, icon: CalendarClock, tone: metrics.failedMessages ? "amber" : "green", href: "/scheduled" }
  ];

  return <>
    <PageHeader title="运营仪表盘" description="群组业务与运行信号" actions={<><StatusBadge value={metrics.failedMessages ? "degraded" : "healthy"} /><RefreshButton onClick={state.reload} spinning={state.refreshing} /></>} />
    <section className="metric-grid">
      {metricsList.map(({ label, value, detail, icon: Icon, tone, href }) => <Link to={href} className="metric-card" key={label}>
        <div className={`metric-icon tone-${tone}`}><Icon size={19} /></div>
        <div className="metric-label">{label}</div><strong>{value.toLocaleString("zh-CN")}</strong><span>{detail}</span>
      </Link>)}
    </section>
    <div className="dashboard-grid">
      <section className="panel activity-panel">
        <div className="panel-header"><div><h2>近 7 日消息活跃度</h2><p>群组消息量趋势</p></div><Activity size={19} /></div>
        {activity.length ? <div className="bar-chart">
          {activity.map((item) => <div className="bar-column" key={item.date} title={`${item.date}: ${item.messages}`}>
            <div className="bar-value">{item.messages}</div><div className="bar-track"><div className="bar-fill" style={{ height: `${Math.max(5, item.messages / maxActivity * 100)}%` }} /></div><span>{item.date.slice(5)}</span>
          </div>)}
        </div> : <div className="chart-empty"><MessageSquareText size={25} /><span>本周期暂无消息统计</span></div>}
      </section>
      <section className="panel attention-panel">
        <div className="panel-header"><div><h2>需要关注</h2><p>待处理运营事项</p></div><TriangleAlert size={19} /></div>
        <div className="attention-list">
          <Link to="/scheduled?status=FAILED"><span className={`attention-icon ${metrics.failedMessages ? "danger" : "success"}`}><TriangleAlert size={17} /></span><div><strong>失败的定时消息</strong><small>{metrics.failedMessages ? "存在投递失败记录" : "当前无失败记录"}</small></div><b>{metrics.failedMessages}</b></Link>
          <Link to="/scheduled?status=PENDING"><span className="attention-icon warning"><CalendarClock size={17} /></span><div><strong>待执行定时消息</strong><small>队列中的内容任务</small></div><b>{metrics.pendingMessages}</b></Link>
          <Link to="/giveaways?status=ACTIVE"><span className="attention-icon info"><Gift size={17} /></span><div><strong>进行中抽奖</strong><small>等待开奖的活动</small></div><b>{metrics.activeGiveaways}</b></Link>
          <Link to="/giveaways?status=FAILED"><span className={`attention-icon ${metrics.failedGiveaways ? "danger" : "success"}`}><TriangleAlert size={17} /></span><div><strong>失败的抽奖任务</strong><small>{metrics.failedGiveaways ? "需要重新执行或取消" : "当前无失败任务"}</small></div><b>{metrics.failedGiveaways}</b></Link>
          <Link to="/moderation"><span className="attention-icon warning"><ShieldCheck size={17} /></span><div><strong>今日风控事件</strong><small>自动审核与处罚记录</small></div><b>{metrics.moderationEventsToday}</b></Link>
          <Link to="/points?tab=redemptions&status=DELIVERY_PENDING"><span className={`attention-icon ${metrics.pendingRedemptions ? "danger" : "success"}`}><TriangleAlert size={17} /></span><div><strong>待交付兑换</strong><small>需要自动补发或人工处理</small></div><b>{metrics.pendingRedemptions}</b></Link>
          <Link to="/memberships"><span className="attention-icon info"><Users size={17} /></span><div><strong>有效会员</strong><small>{metrics.waitingPayments} 笔订单等待支付</small></div><b>{metrics.activeSubscriptions}</b></Link>
          <Link to="/users"><span className="attention-icon neutral"><UserPlus size={17} /></span><div><strong>今日新增用户</strong><small>新进入业务的用户</small></div><b>{metrics.newUsersToday}</b></Link>
        </div>
      </section>
      <section className="panel audit-preview">
        <div className="panel-header"><div><h2>最近操作</h2><p>跨群组审计事件</p></div><Link className="text-link" to="/audit">查看全部</Link></div>
        <div className="audit-list">
          {recentAudit.length ? recentAudit.map((item) => <div className="audit-row" key={item.id}><span className="audit-marker" /><div><strong>{actionLabel(item.action)}</strong><small>{item.chat?.title ?? item.targetType ?? "系统"}</small></div><time>{formatDate(item.createdAt)}</time></div>) : <div className="inline-empty">暂无审计事件</div>}
        </div>
      </section>
    </div>
  </>;
}

function actionLabel(action: string) {
  const labels: Record<string, string> = {
    "giveaway.created": "创建抽奖", "giveaway.drawn": "抽奖已开奖", "admin.chat.updated": "更新群组配置",
    "admin.setting.updated": "更新群组设置", "admin.points.adjusted": "人工调整积分",
    "admin.scheduled_message.cancelled": "取消定时消息", "admin.giveaway.cancelled": "取消抽奖",
    "admin.auth.login_succeeded": "管理员登录成功", "admin.auth.login_failed": "管理员登录失败",
    "admin.auth.logout": "管理员退出登录", "admin.auth.session_revoked": "撤销管理会话",
    "admin.account.created": "创建管理员账号", "admin.account.updated": "更新管理员账号",
    "admin.payment_order.reconciled": "支付订单对账", "admin.payment_order.retried": "重试支付订单",
    "admin.payment_order.refunded": "记录支付退款"
  };
  return labels[action] ?? action;
}
