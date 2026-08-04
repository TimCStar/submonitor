import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleGauge,
  Clock3,
  FileClock,
  KeyRound,
  ListChecks,
  LoaderCircle,
  LogOut,
  RefreshCw,
  Save,
  ServerCog,
  Settings2,
  ShieldCheck,
  UsersRound,
  X,
  XCircle,
} from "lucide-react";
import { api } from "./api.js";

const NAVIGATION = [
  { id: "overview", label: "监控", icon: CircleGauge },
  { id: "events", label: "事件", icon: ListChecks },
  { id: "audit", label: "审计", icon: FileClock },
  { id: "settings", label: "配置", icon: Settings2 },
];

const STATUS_TEXT = {
  complete: "已完成",
  preview: "预览",
  pending: "处理中",
  success: "成功",
  failed: "失败",
  in_progress: "执行中",
  skipped: "已跳过",
  cancelled: "已取消",
};

function formatDate(value, includeSeconds = false) {
  if (!value) return "--";
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    ...(includeSeconds ? { second: "2-digit" } : {}),
    hour12: false,
  }).format(date);
}

function formatCountdown(timestamp, now) {
  if (!timestamp) return "未知";
  const seconds = Math.max(0, Math.floor(timestamp - now / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days} 天 ${hours} 小时`;
  if (hours) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分钟`;
}

function latestBySelector(snapshots) {
  const result = {};
  for (const snapshot of snapshots || []) result[snapshot.selector] ||= snapshot;
  return result;
}

function StatusBadge({ status }) {
  return <span className={`status-badge status-${status}`}>{STATUS_TEXT[status] || status || "未知"}</span>;
}

function Toast({ toast, onClose }) {
  if (!toast) return null;
  const Icon = toast.kind === "error" ? AlertCircle : CheckCircle2;
  return (
    <div className={`toast toast-${toast.kind}`} role="status">
      <Icon size={18} />
      <span>{toast.message}</span>
      <button className="icon-button small" onClick={onClose} aria-label="关闭"><X size={16} /></button>
    </div>
  );
}

function Login({ onAuthenticated }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await api.login(password);
      onAuthenticated();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-panel">
        <div className="brand-mark"><Activity size={24} /></div>
        <div>
          <h1>SubMonitor</h1>
          <p className="muted">管理控制台</p>
        </div>
        <form onSubmit={submit}>
          <label htmlFor="password">管理员密码</label>
          <div className="input-with-icon">
            <KeyRound size={17} />
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoFocus
              required
            />
          </div>
          {error && <div className="form-error"><AlertCircle size={16} />{error}</div>}
          <button className="button primary full" disabled={submitting}>
            {submitting ? <LoaderCircle className="spin" size={17} /> : <ShieldCheck size={17} />}
            登录
          </button>
        </form>
      </section>
    </main>
  );
}

function Sparkline({ snapshots }) {
  const values = [...snapshots].reverse().slice(-30);
  if (values.length < 2) return <div className="sparkline-empty" />;
  const points = values.map((item, index) => {
    const x = (index / (values.length - 1)) * 100;
    const y = 34 - Math.max(0, Math.min(100, item.usedPercent)) * 0.3;
    return `${x},${y}`;
  }).join(" ");
  return (
    <svg className="sparkline" viewBox="0 0 100 38" preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" y1="34" x2="100" y2="34" />
      <polyline points={points} />
    </svg>
  );
}

function QuotaPanel({ selector, snapshot, history, now }) {
  const usage = snapshot ? Math.max(0, Math.min(100, snapshot.usedPercent)) : 0;
  return (
    <article className="quota-panel">
      <div className="quota-head">
        <div>
          <span className="eyebrow">{snapshot?.role || "额度窗口"}</span>
          <h3>{selector}</h3>
        </div>
        <span className={`availability ${snapshot?.allowed ? "online" : "limited"}`}>
          {snapshot ? (snapshot.allowed ? "可用" : "受限") : "未采集"}
        </span>
      </div>
      <div className="usage-row">
        <strong>{snapshot ? `${usage.toFixed(1)}%` : "--"}</strong>
        <span>已使用</span>
      </div>
      <div className="progress-track"><span style={{ width: `${usage}%` }} /></div>
      <Sparkline snapshots={history} />
      <div className="quota-meta">
        <span><Clock3 size={15} />{snapshot ? formatCountdown(snapshot.resetAt, now) : "--"}</span>
        <span>重置 {formatDate(snapshot?.resetAt)}</span>
      </div>
    </article>
  );
}

function ActionSummary({ event }) {
  const actions = [
    event.actions?.sourceRecovery,
    ...Object.values(event.actions?.targetAccounts || {}),
    ...Object.values(event.actions?.subscriptions || {}),
  ].filter(Boolean);
  const success = actions.filter((action) => ["success", "preview", "skipped"].includes(action.status)).length;
  return <span className="action-count">{success}/{actions.length}</span>;
}

function EventTable({ events, onSelect, compact = false }) {
  if (!events?.length) return <EmptyState icon={ListChecks} title="暂无重置事件" />;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>时间</th><th>账号</th><th>窗口</th><th>使用率</th><th>动作</th><th>状态</th><th aria-label="详情" />
          </tr>
        </thead>
        <tbody>
          {events.slice(0, compact ? 6 : undefined).map((event) => (
            <tr key={event.id} onClick={() => onSelect(event)} className="clickable-row">
              <td>{formatDate(event.confirmedAt, true)}</td>
              <td>#{event.sourceAccountId}</td>
              <td><span className="window-pill">{event.window}</span></td>
              <td>{event.baseline.usedPercent}% <span className="arrow">→</span> {event.resetSnapshot.usedPercent}%</td>
              <td><ActionSummary event={event} /></td>
              <td><StatusBadge status={event.status} /></td>
              <td><ChevronRight size={17} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyState({ icon: Icon, title }) {
  return <div className="empty-state"><Icon size={24} /><span>{title}</span></div>;
}

function Overview({ data, onSelectEvent, now, onNavigate }) {
  const latest = latestBySelector(data.snapshots);
  const selectors = data.config.monitorWindows || ["7d"];
  const pending = Object.values(data.events || []).filter((event) => event.status === "pending").length;
  const completed = Object.values(data.events || []).filter((event) => event.status === "complete").length;
  return (
    <div className="page-stack">
      {!data.config.authSecretConfigured && (
        <button className="setup-banner" onClick={() => onNavigate("settings")}>
          <ServerCog size={20} />
          <span><strong>连接尚未配置</strong><small>填写 Sub2API 地址、凭据和源账号</small></span>
          <ChevronRight size={18} />
        </button>
      )}
      <section>
        <div className="section-heading">
          <div><span className="eyebrow">CODEX OAUTH</span><h2>额度窗口</h2></div>
          <span className="source-id">源账号 #{data.config.sourceAccountId || "--"}</span>
        </div>
        <div className="quota-grid">
          {selectors.map((selector) => (
            <QuotaPanel
              key={selector}
              selector={selector}
              snapshot={latest[selector]}
              history={(data.snapshots || []).filter((item) => item.selector === selector)}
              now={now}
            />
          ))}
        </div>
      </section>
      <section className="metrics-band">
        <div><span>运行模式</span><strong>{data.config.dryRun ? "预览" : "自动执行"}</strong></div>
        <div><span>确认次数</span><strong>{data.config.confirmationsRequired} 次</strong></div>
        <div><span>待处理</span><strong>{pending}</strong></div>
        <div><span>已完成</span><strong>{completed}</strong></div>
        <div><span>目标账号</span><strong>{data.config.targetAccountIds.length}</strong></div>
      </section>
      <section>
        <div className="section-heading">
          <div><span className="eyebrow">AUTOMATION</span><h2>最近事件</h2></div>
          <button className="text-button" onClick={() => onNavigate("events")}>查看全部 <ChevronRight size={16} /></button>
        </div>
        <EventTable events={data.events} onSelect={onSelectEvent} compact />
      </section>
    </div>
  );
}

function EventsPage({ events, onSelect }) {
  const [filter, setFilter] = useState("all");
  const visible = filter === "all" ? events : events.filter((event) => event.status === filter);
  return (
    <div className="page-stack">
      <div className="page-title-row">
        <div><span className="eyebrow">HISTORY</span><h2>重置事件</h2></div>
        <div className="segmented compact">
          {[['all', '全部'], ['complete', '完成'], ['pending', '处理中'], ['preview', '预览']].map(([value, label]) => (
            <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{label}</button>
          ))}
        </div>
      </div>
      <EventTable events={visible} onSelect={onSelect} />
    </div>
  );
}

function AuditPage({ entries }) {
  return (
    <div className="page-stack">
      <div className="page-title-row"><div><span className="eyebrow">SYSTEM</span><h2>审计日志</h2></div></div>
      {!entries?.length ? <EmptyState icon={FileClock} title="暂无审计记录" /> : (
        <div className="audit-list">
          {entries.map((entry) => (
            <div className="audit-row" key={entry.id}>
              <span className={`audit-icon ${entry.level}`}>
                {entry.level === "error" ? <XCircle size={16} /> : entry.level === "warn" ? <AlertCircle size={16} /> : <Check size={16} />}
              </span>
              <div><strong>{entry.message}</strong><small>{entry.action}</small></div>
              <time>{formatDate(entry.createdAt, true)}</time>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Toggle({ checked, onChange, label }) {
  return (
    <button type="button" className={`toggle ${checked ? "on" : ""}`} onClick={() => onChange(!checked)} aria-pressed={checked}>
      <span /><strong>{label}</strong>
    </button>
  );
}

function ChoiceButtons({ values, selected, onChange, multiple = true }) {
  function toggle(value) {
    if (!multiple) return onChange([value]);
    if (selected.includes(value)) {
      if (selected.length > 1) onChange(selected.filter((item) => item !== value));
    } else onChange([...selected, value]);
  }
  return (
    <div className="segmented">
      {values.map((value) => (
        <button type="button" key={value} className={selected.includes(value) ? "active" : ""} onClick={() => toggle(value)}>{value}</button>
      ))}
    </div>
  );
}

function numberList(value) {
  if (!String(value || "").trim()) return [];
  const items = String(value).split(",").map((item) => item.trim());
  const parsed = items.map((item) => Number(item));
  if (parsed.some((item) => !Number.isSafeInteger(item) || item <= 0)) {
    throw new Error("账号和分组 ID 必须是逗号分隔的正整数");
  }
  return [...new Set(parsed)];
}

function SettingsPage({ config, onSaved, notify }) {
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  useEffect(() => {
    setForm({
      ...config,
      authSecret: "",
      targetAccountIdsText: config.targetAccountIds.join(", "),
      subscriptionGroupIdsText: config.subscriptionGroupIds.join(", "),
    });
  }, [config]);
  if (!form) return null;
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  async function save(event) {
    event.preventDefault();
    setSaving(true);
    try {
      const payload = {
        ...form,
        targetAccountIds: numberList(form.targetAccountIdsText),
        subscriptionGroupIds: numberList(form.subscriptionGroupIdsText),
      };
      const result = await api.saveConfig(payload);
      onSaved(result.config);
      notify("success", "配置已保存");
    } catch (error) {
      notify("error", error.message);
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    try {
      const result = await api.testConnection();
      notify("success", `连接成功，读取到 ${result.snapshots.length} 个额度窗口`);
    } catch (error) {
      notify("error", error.message);
    } finally {
      setTesting(false);
    }
  }

  return (
    <form className="settings-form" onSubmit={save}>
      <div className="page-title-row">
        <div><span className="eyebrow">CONTROL PLANE</span><h2>监控配置</h2></div>
        <div className="button-row">
          <button type="button" className="button secondary" onClick={test} disabled={testing || !config.authSecretConfigured}>
            {testing ? <LoaderCircle className="spin" size={17} /> : <Activity size={17} />}测试连接
          </button>
          <button className="button primary" disabled={saving}>
            {saving ? <LoaderCircle className="spin" size={17} /> : <Save size={17} />}保存
          </button>
        </div>
      </div>

      <section className="form-section">
        <div className="form-section-title"><ServerCog size={19} /><div><h3>Sub2API 连接</h3><span>服务器端凭据</span></div></div>
        <div className="form-grid">
          <label className="field wide"><span>服务地址</span><input type="url" value={form.baseUrl} onChange={(e) => update("baseUrl", e.target.value)} placeholder="https://sub2api.example.com" /></label>
          <label className="field"><span>认证方式</span><select value={form.authType} onChange={(e) => update("authType", e.target.value)}><option value="apiKey">API Key</option><option value="jwt">管理员 JWT</option></select></label>
          <label className="field wide"><span>管理凭据 {config.authSecretConfigured && <em>已保存</em>}</span><input type="password" value={form.authSecret} onChange={(e) => update("authSecret", e.target.value)} placeholder={config.authSecretConfigured ? "留空保持不变" : "输入管理凭据"} autoComplete="new-password" /></label>
        </div>
      </section>

      <section className="form-section">
        <div className="form-section-title"><CircleGauge size={19} /><div><h3>额度监控</h3><span>Codex OAuth</span></div></div>
        <div className="form-grid">
          <label className="field"><span>源账号 ID</span><input type="number" min="1" value={form.sourceAccountId || ""} onChange={(e) => update("sourceAccountId", e.target.value)} /></label>
          <label className="field wide"><span>目标账号 ID</span><input value={form.targetAccountIdsText} onChange={(e) => update("targetAccountIdsText", e.target.value)} placeholder="34, 35" /></label>
          <div className="field wide"><span>监控窗口</span><ChoiceButtons values={["5h", "7d", "primary", "secondary"]} selected={form.monitorWindows} onChange={(value) => update("monitorWindows", value)} /></div>
          <label className="field"><span>轮询间隔（秒）</span><input type="number" min="15" value={form.pollIntervalSeconds} onChange={(e) => update("pollIntervalSeconds", e.target.value)} /></label>
          <label className="field"><span>连续确认次数</span><input type="number" min="1" max="10" value={form.confirmationsRequired} onChange={(e) => update("confirmationsRequired", e.target.value)} /></label>
          <label className="field"><span>请求超时（秒）</span><input type="number" min="5" value={form.requestTimeoutSeconds} onChange={(e) => update("requestTimeoutSeconds", e.target.value)} /></label>
          <label className="field"><span>周期容差（秒）</span><input type="number" min="1" value={form.resetGraceSeconds} onChange={(e) => update("resetGraceSeconds", e.target.value)} /></label>
        </div>
      </section>

      <section className="form-section">
        <div className="form-section-title"><UsersRound size={19} /><div><h3>订阅级联</h3><span>有效用户订阅</span></div></div>
        <div className="form-grid">
          <label className="field"><span>分组来源</span><select value={form.subscriptionGroupMode} onChange={(e) => update("subscriptionGroupMode", e.target.value)}><option value="none">关闭</option><option value="auto">源账号自动发现</option><option value="explicit">指定分组</option></select></label>
          {form.subscriptionGroupMode === "explicit" && <label className="field wide"><span>订阅分组 ID</span><input value={form.subscriptionGroupIdsText} onChange={(e) => update("subscriptionGroupIdsText", e.target.value)} placeholder="10, 11" /></label>}
          <div className="field wide"><span>重置周期</span><ChoiceButtons values={["daily", "weekly", "monthly"]} selected={form.subscriptionResetWindows} onChange={(value) => update("subscriptionResetWindows", value)} /></div>
        </div>
      </section>

      <section className="form-section mode-section">
        <div><Toggle checked={form.dryRun} onChange={(value) => update("dryRun", value)} label="预览模式" /><small>确认事件不执行写操作</small></div>
        <div><Toggle checked={form.enabled} onChange={(value) => update("enabled", value)} label="启用监控" /><small>后台按轮询间隔运行</small></div>
      </section>
    </form>
  );
}

function EventDrawer({ event, onClose }) {
  if (!event) return null;
  const targets = Object.entries(event.actions?.targetAccounts || {});
  const subscriptions = Object.entries(event.actions?.subscriptions || {});
  return (
    <div className="drawer-backdrop" onMouseDown={onClose}>
      <aside className="drawer" onMouseDown={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div><span className="eyebrow">RESET EVENT</span><h2>{event.window} 周期切换</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={20} /></button>
        </div>
        <div className="event-hero">
          <StatusBadge status={event.status} />
          <strong>#{event.sourceAccountId}</strong>
          <time>{formatDate(event.confirmedAt, true)}</time>
        </div>
        <div className="event-delta">
          <div><span>旧周期</span><strong>{event.baseline.usedPercent}%</strong><small>{formatDate(event.baseline.resetAt, true)}</small></div>
          <ChevronRight size={22} />
          <div><span>新周期</span><strong>{event.resetSnapshot.usedPercent}%</strong><small>{formatDate(event.resetSnapshot.resetAt, true)}</small></div>
        </div>
        <div className="action-group">
          <h3>源账号</h3>
          <ActionRow label={`恢复账号 #${event.sourceAccountId}`} action={event.actions.sourceRecovery} />
        </div>
        <div className="action-group">
          <h3>目标账号 <span>{targets.length}</span></h3>
          {targets.length ? targets.map(([id, action]) => <ActionRow key={id} label={`账号 #${id}`} action={action} />) : <p className="muted compact-text">无目标账号</p>}
        </div>
        <div className="action-group">
          <h3>用户订阅 <span>{subscriptions.length}</span></h3>
          {subscriptions.length ? subscriptions.map(([id, action]) => <ActionRow key={id} label={`订阅 #${id}`} action={action} />) : <p className="muted compact-text">无匹配订阅</p>}
        </div>
      </aside>
    </div>
  );
}

function ActionRow({ label, action }) {
  return (
    <div className="action-row">
      <span className={`action-state ${action.status}`}>
        {action.status === "failed"
          ? <XCircle size={17} />
          : action.status === "in_progress"
            ? <LoaderCircle className="spin" size={17} />
            : action.status === "pending"
              ? <Clock3 size={17} />
              : <CheckCircle2 size={17} />}
      </span>
      <div><strong>{label}</strong>{action.error && <small>{action.error}</small>}</div>
      <StatusBadge status={action.status} />
    </div>
  );
}

function AppShell({ data, setData, onLogout }) {
  const [page, setPage] = useState("overview");
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [checking, setChecking] = useState(false);
  const [toast, setToast] = useState(null);
  const [now, setNow] = useState(Date.now());
  const toastTimer = useRef(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);

  function notify(kind, message) {
    setToast({ kind, message });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4500);
  }

  async function checkNow() {
    setChecking(true);
    try {
      await api.checkNow();
      const next = await api.dashboard();
      setData(next);
      notify("success", "额度检查完成");
    } catch (error) {
      notify("error", error.message);
    } finally {
      setChecking(false);
    }
  }

  const runtimeLabel = data.runtime.running ? "检查中" : data.config.enabled ? (data.runtime.status === "error" ? "异常" : "运行中") : "已暂停";
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand"><div className="brand-mark small"><Activity size={20} /></div><span>SubMonitor</span></div>
        <nav>
          {NAVIGATION.map(({ id, label, icon: Icon }) => (
            <button key={id} className={page === id ? "active" : ""} onClick={() => setPage(id)}><Icon size={19} /><span>{label}</span></button>
          ))}
        </nav>
        <button className="logout-button" onClick={onLogout}><LogOut size={18} /><span>退出</span></button>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="runtime-state"><span className={`status-dot ${data.runtime.status}`} /><strong>{runtimeLabel}</strong><small>上次检查 {formatDate(data.runtime.lastPollAt, true)}</small></div>
          <button className="button secondary" onClick={checkNow} disabled={checking || !data.config.authSecretConfigured}>
            <RefreshCw className={checking ? "spin" : ""} size={17} />立即检查
          </button>
        </header>
        <main className="content">
          {page === "overview" && <Overview data={data} onSelectEvent={setSelectedEvent} now={now} onNavigate={setPage} />}
          {page === "events" && <EventsPage events={data.events} onSelect={setSelectedEvent} />}
          {page === "audit" && <AuditPage entries={data.audit} />}
          {page === "settings" && <SettingsPage config={data.config} onSaved={(config) => setData((old) => ({ ...old, config }))} notify={notify} />}
        </main>
      </div>
      <EventDrawer event={selectedEvent} onClose={() => setSelectedEvent(null)} />
      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}

export default function App() {
  const [authState, setAuthState] = useState("loading");
  const [data, setData] = useState(null);
  const reloadTimer = useRef(null);

  const loadDashboard = useCallback(async () => {
    try {
      const next = await api.dashboard();
      setData(next);
      setAuthState("authenticated");
    } catch (error) {
      if (error.status === 401) setAuthState("anonymous");
      else throw error;
    }
  }, []);

  useEffect(() => {
    api.session().then((session) => {
      if (session.authenticated) return loadDashboard();
      setAuthState("anonymous");
    }).catch(() => setAuthState("anonymous"));
  }, [loadDashboard]);

  useEffect(() => {
    if (authState !== "authenticated") return undefined;
    const stream = new EventSource("/api/stream");
    const refresh = () => {
      clearTimeout(reloadTimer.current);
      reloadTimer.current = setTimeout(() => void loadDashboard(), 250);
    };
    ["runtime", "snapshot", "event", "audit", "config"].forEach((type) => stream.addEventListener(type, refresh));
    return () => {
      clearTimeout(reloadTimer.current);
      stream.close();
    };
  }, [authState, loadDashboard]);

  async function logout() {
    await api.logout().catch(() => {});
    setData(null);
    setAuthState("anonymous");
  }

  if (authState === "loading") return <div className="app-loading"><Activity size={26} /><span>SubMonitor</span></div>;
  if (authState === "anonymous") return <Login onAuthenticated={loadDashboard} />;
  return data ? <AppShell data={data} setData={setData} onLogout={logout} /> : null;
}
