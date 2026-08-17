import { useState, type FormEvent } from "react";
import { Bot, Eye, EyeOff, KeyRound, LoaderCircle, LockKeyhole, UserRound } from "lucide-react";
import { Navigate, useNavigate } from "react-router-dom";
import { hasToken, login } from "../api";

export function LoginPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [visible, setVisible] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  if (hasToken()) return <Navigate to="/dashboard" replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await login(username, password, code.trim() || undefined);
      navigate("/dashboard", { replace: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "登录失败");
    } finally {
      setSubmitting(false);
    }
  };

  return <div className="login-page">
    <section className="login-panel">
      <div className="login-brand"><span><Bot size={23} /></span><div><strong>DarvisXBot</strong><small>Administration</small></div></div>
      <div className="login-heading"><h1>管理员登录</h1><p>进入运营与系统管理控制台</p></div>
      <form onSubmit={submit}>
        <label><span>用户名</span><div className="input-with-icon"><UserRound size={17} /><input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required /></div></label>
        <label><span>密码</span><div className="input-with-icon"><LockKeyhole size={17} /><input type={visible ? "text" : "password"} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /><button type="button" className="password-toggle" onClick={() => setVisible(!visible)} title={visible ? "隐藏密码" : "显示密码"}>{visible ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></label>
        <label><span>二步验证码（如已启用）</span><div className="input-with-icon"><KeyRound size={17} /><input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} /></div></label>
        {error && <div className="form-error">{error}</div>}
        <button className="button primary login-button" disabled={submitting}>{submitting && <LoaderCircle className="spin" size={17} />}登录</button>
      </form>
      <footer>DarvisXBot Operations Console</footer>
    </section>
  </div>;
}
