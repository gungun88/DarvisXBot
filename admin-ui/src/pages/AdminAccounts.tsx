import { useMemo, useState } from "react";
import { KeyRound, Plus, Power, Save, ShieldCheck, UserCog, X } from "lucide-react";
import { api, getAdminUser } from "../api";
import { useToast } from "../components/Toast";
import { EmptyState, ErrorState, formatDate, LoadingState, PageHeader, RefreshButton, StatusBadge } from "../components/Ui";
import { useResource } from "../hooks/useResource";
import type { AdminAccount, AdminRole } from "../types";

const roleOptions: { value: AdminRole; label: string; detail: string }[] = [
  { value: "owner", label: "所有者", detail: "账号、资金及全部系统权限" },
  { value: "admin", label: "管理员", detail: "业务、资金及系统操作权限" },
  { value: "operator", label: "运营", detail: "业务配置与日常运营操作" },
  { value: "viewer", label: "只读", detail: "仅查看后台数据" }
];

export function AdminAccountsPage() {
  const state = useResource<{ items: AdminAccount[] }>("/api/admin/accounts");
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<AdminAccount | null>(null);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const currentUsername = getAdminUser()?.username;
  const counts = useMemo(() => {
    const accounts = state.data?.items ?? [];
    return { enabled: accounts.filter((item) => item.enabled).length, owners: accounts.filter((item) => item.enabled && item.role === "owner").length };
  }, [state.data]);

  const patchAccount = async (account: AdminAccount, body: { role?: AdminRole; enabled?: boolean; password?: string }, success: string) => {
    setWorkingId(account.id);
    try {
      await api(`/api/admin/accounts/${account.id}`, { method: "PATCH", body: JSON.stringify(body) });
      toast.notify(success);
      state.reload();
      return true;
    } catch (caught) {
      toast.notify(caught instanceof Error ? caught.message : "操作失败", "error");
      return false;
    } finally {
      setWorkingId(null);
    }
  };

  const changeRole = async (account: AdminAccount, role: AdminRole) => {
    if (role === account.role || !window.confirm(`确认将 ${account.username} 的角色改为“${roleLabel(role)}”？该账号现有会话会被撤销。`)) return;
    await patchAccount(account, { role }, "角色已更新");
  };

  const toggleEnabled = async (account: AdminAccount) => {
    const next = !account.enabled;
    if (!window.confirm(`确认${next ? "启用" : "停用"}账号 ${account.username}？${next ? "" : "现有会话会立即失效。"}`)) return;
    await patchAccount(account, { enabled: next }, next ? "账号已启用" : "账号已停用");
  };

  return <>
    <PageHeader
      title="管理员账号"
      description="分配后台角色并管理账号访问权限"
      actions={<><RefreshButton onClick={state.reload} spinning={state.refreshing} /><button className="button primary" onClick={() => setCreating(true)}><Plus size={16} />新建账号</button></>}
    />
    <section className="access-summary" aria-label="管理员账号摘要">
      <div><span className="ops-icon info"><UserCog size={19} /></span><div><small>账号总数</small><strong>{state.data?.items.length ?? 0}</strong></div></div>
      <div><span className="ops-icon success"><ShieldCheck size={19} /></span><div><small>已启用</small><strong>{counts.enabled}</strong></div></div>
      <div><span className="ops-icon neutral"><KeyRound size={19} /></span><div><small>所有者</small><strong>{counts.owners}</strong></div></div>
    </section>
    <section className="panel table-panel">
      <div className="panel-header"><div><h2>账号与角色</h2><p>修改角色、状态或密码后，该账号的现有会话会被撤销</p></div><UserCog size={19} /></div>
      {state.loading ? <LoadingState /> : state.error || !state.data ? <ErrorState message={state.error ?? "暂无数据"} retry={state.reload} /> : state.data.items.length === 0 ? <EmptyState title="暂无管理员账号" /> : <div className="table-scroll"><table><thead><tr><th>账号</th><th>角色</th><th>状态</th><th>最近登录</th><th>创建时间</th><th /></tr></thead><tbody>{state.data.items.map((account) => {
        const isCurrent = account.username === currentUsername;
        return <tr key={account.id}>
          <td><div className="primary-cell"><span className="entity-avatar"><UserCog size={16} /></span><div><strong>{account.username}</strong><small>{isCurrent ? "当前账号" : account.bootstrapManaged ? "环境引导账号" : "后台创建"}</small></div></div></td>
          <td><select className="table-select" aria-label={`修改 ${account.username} 的角色`} value={account.role} disabled={workingId === account.id} onChange={(event) => void changeRole(account, event.target.value as AdminRole)}>{roleOptions.map((role) => <option value={role.value} key={role.value}>{role.label}</option>)}</select><small className="table-subline">{roleOptions.find((role) => role.value === account.role)?.detail}</small></td>
          <td><StatusBadge value={account.enabled ? "ACTIVE" : "DISABLED"} /></td>
          <td>{account.lastLoginAt ? formatDate(account.lastLoginAt) : "从未登录"}</td>
          <td>{formatDate(account.createdAt)}</td>
          <td><span className="row-actions"><button className="icon-button small" title="重置密码" disabled={workingId === account.id} onClick={() => setResetting(account)}><KeyRound size={15} /></button><button className={`icon-button small ${account.enabled ? "danger-button" : ""}`} title={account.enabled ? "停用账号" : "启用账号"} disabled={workingId === account.id || isCurrent} onClick={() => void toggleEnabled(account)}><Power size={15} /></button></span></td>
        </tr>;
      })}</tbody></table></div>}
    </section>
    {creating && <CreateAccountModal close={() => setCreating(false)} saved={() => { setCreating(false); state.reload(); toast.notify("管理员账号已创建"); }} />}
    {resetting && <PasswordModal account={resetting} close={() => setResetting(null)} save={async (password) => { const saved = await patchAccount(resetting, { password }, "密码已重置"); if (saved) setResetting(null); }} />}
  </>;
}

function CreateAccountModal({ close, saved }: { close: () => void; saved: () => void }) {
  const toast = useToast();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<AdminRole>("operator");
  const [working, setWorking] = useState(false);
  const submit = async () => {
    if (username.trim().length < 3 || password.length < 10) { toast.notify("用户名至少 3 个字符，密码至少 10 个字符", "error"); return; }
    setWorking(true);
    try {
      await api("/api/admin/accounts", { method: "POST", body: JSON.stringify({ username: username.trim(), password, role }) });
      saved();
    } catch (caught) {
      toast.notify(caught instanceof Error ? caught.message : "创建账号失败", "error");
    } finally {
      setWorking(false);
    }
  };
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}><section className="modal"><div className="modal-header"><div><h2>新建管理员账号</h2><p>账号创建后可立即登录后台</p></div><button className="icon-button" title="关闭" onClick={close}><X size={18} /></button></div><div className="form-stack"><label><span>用户名</span><input autoComplete="off" value={username} onChange={(event) => setUsername(event.target.value)} maxLength={128} /></label><label><span>初始密码</span><input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} maxLength={200} /></label><label><span>角色</span><select value={role} onChange={(event) => setRole(event.target.value as AdminRole)}>{roleOptions.map((item) => <option value={item.value} key={item.value}>{item.label} - {item.detail}</option>)}</select></label></div><div className="modal-actions"><button className="button secondary" onClick={close}>取消</button><button className="button primary" disabled={working} onClick={() => void submit()}><Plus size={16} />创建账号</button></div></section></div>;
}

function PasswordModal({ account, close, save }: { account: AdminAccount; close: () => void; save: (password: string) => Promise<void> }) {
  const toast = useToast();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [working, setWorking] = useState(false);
  const submit = async () => {
    if (password.length < 10) { toast.notify("密码至少需要 10 个字符", "error"); return; }
    if (password !== confirmation) { toast.notify("两次输入的密码不一致", "error"); return; }
    setWorking(true);
    try { await save(password); } finally { setWorking(false); }
  };
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}><section className="modal"><div className="modal-header"><div><h2>重置密码</h2><p>{account.username} 的所有现有会话将立即失效</p></div><button className="icon-button" title="关闭" onClick={close}><X size={18} /></button></div><div className="form-stack"><label><span>新密码</span><input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} maxLength={200} /></label><label><span>确认新密码</span><input type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} maxLength={200} /></label></div><div className="modal-actions"><button className="button secondary" onClick={close}>取消</button><button className="button primary" disabled={working} onClick={() => void submit()}><Save size={16} />保存密码</button></div></section></div>;
}

function roleLabel(role: AdminRole) {
  return roleOptions.find((item) => item.value === role)?.label ?? role;
}
