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
  LockKeyhole,
  LogOut,
  Plus,
  RefreshCw,
  Save,
  ServerCog,
  Settings2,
  ShieldCheck,
  Trash2,
  UsersRound,
  X,
  XCircle,
} from "lucide-react";
import { api } from "./api.js";

const NAVIGATION = [
  { id: "overview", label: "监控", icon: CircleGauge, admin: false },
  { id: "events", label: "事件", icon: ListChecks, admin: false },
  { id: "audit", label: "审计", icon: FileClock, admin: true },
  { id: "settings", label: "配置", icon: Settings2, admin: true },
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

function RuntimeBadge({ monitor }) {
  const status = monitor.runtime?.running ? "running" : monitor.enabled ? monitor.runtime?.status : "disabled";
  const label = status === "running" ? "检查中" : status === "error" ? "异常" : status === "disabled" ? "已暂停" : "运行中";
  return <span className={`runtime-badge ${status}`}><i />{label}</span>;
}

function Toast({ toast, onClose }) {
  if (!toast) return null;
  const Icon = toast.kind === "error" ? AlertCircle : CheckCircle2;
  return (
    <div className={`toast toast-${toast.kind}`} role="status">
      <Icon size={18} /><span>{toast.message}</span>
      <button className="icon-button small" onClick={onClose} aria-label="关闭"><X size={16} /></button>
    </div>
  );
}

function LoginDialog({ open, onClose, onAuthenticated }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    if (open) { setPassword(""); setError(""); }
  }, [open]);
  if (!open) return null;

  async function submit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await api.login(password);
      await onAuthenticated();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <section className="login-panel dialog-panel" role="dialog" aria-modal="true" aria-labelledby="admin-login" onMouseDown={(event) => event.stopPropagation()}>
        <button className="icon-button dialog-close" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        <div className="brand-mark"><LockKeyhole size={22} /></div>
        <div><h1 id="admin-login">后台登录</h1><p className="muted">SubMonitor 管理控制台</p></div>
        <form onSubmit={submit}>
          <label htmlFor="password">管理员密码</label>
          <div className="input-with-icon"><KeyRound size={17} /><input id="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus required /></div>
          {error && <div className="form-error"><AlertCircle size={16} />{error}</div>}
          <button className="button primary full" disabled={submitting}>{submitting ? <LoaderCircle className="spin" size={17} /> : <ShieldCheck size={17} />}登录后台</button>
        </form>
      </section>
    </div>
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
  return <svg className="sparkline" viewBox="0 0 100 38" preserveAspectRatio="none" aria-hidden="true"><line x1="0" y1="34" x2="100" y2="34" /><polyline points={points} /></svg>;
}

function QuotaPanel({ selector, snapshot, history, now, candidate }) {
  const usage = snapshot ? Math.max(0, Math.min(100, snapshot.usedPercent)) : 0;
  return (
    <article className="quota-panel">
      <div className="quota-head">
        <div><span className="eyebrow">{snapshot?.role || "额度窗口"}</span><h3>{selector}</h3></div>
        {candidate ? <span className="availability pending">确认 {candidate.confirmations}</span> : <span className={`availability ${snapshot?.allowed ? "online" : "limited"}`}>{snapshot ? (snapshot.allowed ? "可用" : "受限") : "未采集"}</span>}
      </div>
      <div className="usage-row"><strong>{snapshot ? `${usage.toFixed(1)}%` : "--"}</strong><span>已使用</span></div>
      <div className="progress-track"><span style={{ width: `${usage}%` }} /></div>
      <Sparkline snapshots={history} />
      <div className="quota-meta"><span><Clock3 size={15} />{snapshot ? formatCountdown(snapshot.resetAt, now) : "--"}</span><span>重置 {formatDate(snapshot?.resetAt)}</span></div>
    </article>
  );
}

function actionCounts(event) {
  if (event.actionSummary) return event.actionSummary;
  const actions = [event.actions?.sourceRecovery, ...Object.values(event.actions?.targetAccounts || {}), ...Object.values(event.actions?.subscriptions || {})].filter(Boolean);
  return { total: actions.length, completed: actions.filter((action) => ["success", "preview", "skipped"].includes(action.status)).length, failed: actions.filter((action) => action.status === "failed").length };
}

function EventTable({ events, onSelect, compact = false }) {
  if (!events?.length) return <EmptyState icon={ListChecks} title="暂无重置事件" />;
  return (
    <div className="table-wrap"><table><thead><tr><th>时间</th><th>监控任务</th><th>账号</th><th>窗口</th><th>使用率</th><th>动作</th><th>状态</th><th aria-label="详情" /></tr></thead>
      <tbody>{events.slice(0, compact ? 6 : undefined).map((event) => {
        const summary = actionCounts(event);
        return <tr key={event.id} onClick={() => onSelect(event)} className="clickable-row"><td>{formatDate(event.confirmedAt, true)}</td><td>{event.monitorName || "--"}</td><td>#{event.sourceAccountId}</td><td><span className="window-pill">{event.window}</span></td><td>{event.baseline.usedPercent}% <span className="arrow">→</span> {event.resetSnapshot.usedPercent}%</td><td><span className={summary.failed ? "count-failed" : "action-count"}>{summary.completed}/{summary.total}</span></td><td><StatusBadge status={event.status} /></td><td><ChevronRight size={17} /></td></tr>;
      })}</tbody></table></div>
  );
}

function EmptyState({ icon: Icon, title, action }) {
  return <div className="empty-state"><Icon size={24} /><span>{title}</span>{action}</div>;
}

function MonitorPicker({ monitors, selectedId, onSelect }) {
  return (
    <div className="monitor-picker">
      {monitors.map((monitor) => {
        const latest = latestBySelector(monitor.snapshots);
        const first = latest[monitor.monitorWindows[0]];
        return <button key={monitor.id} className={selectedId === monitor.id ? "active" : ""} onClick={() => onSelect(monitor.id)}>
          <span><strong>{monitor.name}</strong><small>#{monitor.sourceAccountId || "--"}</small></span>
          <span className="picker-metric">{first ? `${Number(first.usedPercent).toFixed(1)}%` : "--"}</span>
          <RuntimeBadge monitor={monitor} />
        </button>;
      })}
    </div>
  );
}

function Overview({ data, selectedId, onSelectMonitor, onSelectEvent, now, onAdmin }) {
  const monitor = data.monitors.find((item) => item.id === selectedId) || data.monitors[0];
  if (!monitor) return <EmptyState icon={CircleGauge} title="暂无监控任务" action={<button className="button secondary" onClick={onAdmin}><Settings2 size={16} />进入后台</button>} />;
  const latest = latestBySelector(monitor.snapshots);
  const monitorEvents = data.events.filter((event) => event.monitorId === monitor.id);
  return (
    <div className="page-stack">
      <section><div className="section-heading"><div><span className="eyebrow">MONITORS</span><h2>账号监控</h2></div><span className="source-id">{data.monitors.length} 个任务</span></div><MonitorPicker monitors={data.monitors} selectedId={monitor.id} onSelect={onSelectMonitor} /></section>
      <section><div className="section-heading"><div><span className="eyebrow">CODEX OAUTH</span><h2>{monitor.name}</h2></div><div className="monitor-title-meta"><RuntimeBadge monitor={monitor} /><span className="source-id">源账号 #{monitor.sourceAccountId || "--"}</span></div></div>
        <div className="quota-grid">{monitor.monitorWindows.map((selector) => <QuotaPanel key={selector} selector={selector} snapshot={latest[selector]} history={monitor.snapshots.filter((item) => item.selector === selector)} now={now} candidate={monitor.candidates?.[selector]} />)}</div>
      </section>
      <section className="metrics-band"><div><span>运行模式</span><strong>{monitor.dryRun ? "预览" : "自动执行"}</strong></div><div><span>确认次数</span><strong>{monitor.confirmationsRequired} 次</strong></div><div><span>轮询间隔</span><strong>{monitor.pollIntervalSeconds} 秒</strong></div><div><span>目标账号</span><strong>{monitor.targetAccountCount}</strong></div><div><span>上次检查</span><strong>{formatDate(monitor.runtime.lastPollAt)}</strong></div></section>
      <section><div className="section-heading"><div><span className="eyebrow">AUTOMATION</span><h2>最近事件</h2></div></div><EventTable events={monitorEvents} onSelect={onSelectEvent} compact /></section>
    </div>
  );
}

function EventsPage({ events, onSelect }) {
  const [filter, setFilter] = useState("all");
  const visible = filter === "all" ? events : events.filter((event) => event.status === filter);
  return <div className="page-stack"><div className="page-title-row"><div><span className="eyebrow">PUBLIC HISTORY</span><h2>重置事件</h2></div><div className="segmented compact">{[["all", "全部"], ["complete", "完成"], ["pending", "处理中"], ["preview", "预览"]].map(([value, label]) => <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{label}</button>)}</div></div><EventTable events={visible} onSelect={onSelect} /></div>;
}

function AuditPage({ entries }) {
  return <div className="page-stack"><div className="page-title-row"><div><span className="eyebrow">ADMIN</span><h2>审计日志</h2></div></div>{!entries?.length ? <EmptyState icon={FileClock} title="暂无审计记录" /> : <div className="audit-list">{entries.map((entry) => <div className="audit-row" key={entry.id}><span className={`audit-icon ${entry.level}`}>{entry.level === "error" ? <XCircle size={16} /> : entry.level === "warn" ? <AlertCircle size={16} /> : <Check size={16} />}</span><div><strong>{entry.message}</strong><small>{entry.action}{entry.details?.monitorId ? ` · ${entry.details.monitorId.slice(0, 8)}` : ""}</small></div><time>{formatDate(entry.createdAt, true)}</time></div>)}</div>}</div>;
}

function Toggle({ checked, onChange, label }) {
  return <button type="button" className={`toggle ${checked ? "on" : ""}`} onClick={() => onChange(!checked)} aria-pressed={checked}><span /><strong>{label}</strong></button>;
}

function ChoiceButtons({ values, selected, onChange }) {
  function toggle(value) {
    if (selected.includes(value)) { if (selected.length > 1) onChange(selected.filter((item) => item !== value)); }
    else onChange([...selected, value]);
  }
  return <div className="segmented">{values.map((value) => <button type="button" key={value} className={selected.includes(value) ? "active" : ""} onClick={() => toggle(value)}>{value}</button>)}</div>;
}

function numberList(value) {
  if (!String(value || "").trim()) return [];
  const parsed = String(value).split(",").map((item) => Number(item.trim()));
  if (parsed.some((item) => !Number.isSafeInteger(item) || item <= 0)) throw new Error("账号和分组 ID 必须是逗号分隔的正整数");
  return [...new Set(parsed)];
}

function MonitorForm({ monitor, onSaved, onDeleted, notify }) {
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState("");
  useEffect(() => setForm({ ...monitor, authSecret: "", targetAccountIdsText: monitor.targetAccountIds.join(", "), subscriptionGroupIdsText: monitor.subscriptionGroupIds.join(", ") }), [monitor]);
  if (!form) return null;
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const payload = () => ({ ...form, targetAccountIds: numberList(form.targetAccountIdsText), subscriptionGroupIds: numberList(form.subscriptionGroupIdsText) });

  async function save(event) {
    event.preventDefault(); setBusy("save");
    try { const result = await api.saveMonitor(monitor.id, payload()); onSaved(result.monitor); notify("success", "监控任务已保存"); }
    catch (error) { notify("error", error.message); }
    finally { setBusy(""); }
  }
  async function test() {
    setBusy("test");
    try { const result = await api.testConnection(monitor.id); notify("success", `连接成功，读取到 ${result.snapshots.length} 个额度窗口`); }
    catch (error) { notify("error", error.message); }
    finally { setBusy(""); }
  }
  async function check() {
    setBusy("check");
    try { await api.checkNow(monitor.id); notify("success", "额度检查完成"); }
    catch (error) { notify("error", error.message); }
    finally { setBusy(""); }
  }
  async function remove() {
    if (!window.confirm(`删除监控任务“${monitor.name}”及其本地历史数据？`)) return;
    setBusy("delete");
    try { await api.deleteMonitor(monitor.id); onDeleted(monitor.id); notify("success", "监控任务已删除"); }
    catch (error) { notify("error", error.message); setBusy(""); }
  }

  return <form className="settings-form" onSubmit={save}>
    <div className="page-title-row"><div><span className="eyebrow">MONITOR CONFIG</span><h2>{monitor.name}</h2></div><div className="button-row"><button type="button" className="icon-button danger" onClick={remove} disabled={busy} title="删除任务"><Trash2 size={17} /></button><button type="button" className="button secondary" onClick={test} disabled={busy || !monitor.authSecretConfigured}>{busy === "test" ? <LoaderCircle className="spin" size={17} /> : <Activity size={17} />}测试连接</button><button type="button" className="button secondary" onClick={check} disabled={busy || !monitor.authSecretConfigured}>{busy === "check" ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}立即检查</button><button className="button primary" disabled={busy}>{busy === "save" ? <LoaderCircle className="spin" size={17} /> : <Save size={17} />}保存</button></div></div>
    <section className="form-section"><div className="form-section-title"><ServerCog size={19} /><div><h3>Sub2API 连接</h3><span>任务独立凭据</span></div></div><div className="form-grid"><label className="field wide"><span>任务名称</span><input value={form.name} maxLength="80" onChange={(e) => update("name", e.target.value)} /></label><label className="field wide"><span>服务地址</span><input type="url" value={form.baseUrl} onChange={(e) => update("baseUrl", e.target.value)} placeholder="https://sub2api.example.com" /></label><label className="field"><span>认证方式</span><select value={form.authType} onChange={(e) => update("authType", e.target.value)}><option value="apiKey">API Key</option><option value="jwt">管理员 JWT</option></select></label><label className="field wide"><span>管理凭据 {monitor.authSecretConfigured && <em>已保存</em>}</span><input type="password" value={form.authSecret} onChange={(e) => update("authSecret", e.target.value)} placeholder={monitor.authSecretConfigured ? "留空保持不变" : "输入管理凭据"} autoComplete="new-password" /></label></div></section>
    <section className="form-section"><div className="form-section-title"><CircleGauge size={19} /><div><h3>额度监控</h3><span>Codex OAuth</span></div></div><div className="form-grid"><label className="field"><span>源账号 ID</span><input type="number" min="1" value={form.sourceAccountId || ""} onChange={(e) => update("sourceAccountId", e.target.value)} /></label><label className="field wide"><span>目标账号 ID</span><input value={form.targetAccountIdsText} onChange={(e) => update("targetAccountIdsText", e.target.value)} placeholder="34, 35" /></label><div className="field wide"><span>监控窗口</span><ChoiceButtons values={["5h", "7d", "primary", "secondary"]} selected={form.monitorWindows} onChange={(value) => update("monitorWindows", value)} /></div><label className="field"><span>轮询间隔（秒）</span><input type="number" min="15" value={form.pollIntervalSeconds} onChange={(e) => update("pollIntervalSeconds", e.target.value)} /></label><label className="field"><span>连续确认次数</span><input type="number" min="1" max="10" value={form.confirmationsRequired} onChange={(e) => update("confirmationsRequired", e.target.value)} /></label><label className="field"><span>请求超时（秒）</span><input type="number" min="5" value={form.requestTimeoutSeconds} onChange={(e) => update("requestTimeoutSeconds", e.target.value)} /></label><label className="field"><span>周期容差（秒）</span><input type="number" min="1" value={form.resetGraceSeconds} onChange={(e) => update("resetGraceSeconds", e.target.value)} /></label></div></section>
    <section className="form-section"><div className="form-section-title"><UsersRound size={19} /><div><h3>订阅级联</h3><span>有效用户订阅</span></div></div><div className="form-grid"><label className="field"><span>分组来源</span><select value={form.subscriptionGroupMode} onChange={(e) => update("subscriptionGroupMode", e.target.value)}><option value="none">关闭</option><option value="auto">源账号自动发现</option><option value="explicit">指定分组</option></select></label>{form.subscriptionGroupMode === "explicit" && <label className="field wide"><span>订阅分组 ID</span><input value={form.subscriptionGroupIdsText} onChange={(e) => update("subscriptionGroupIdsText", e.target.value)} placeholder="10, 11" /></label>}<div className="field wide"><span>重置周期</span><ChoiceButtons values={["daily", "weekly", "monthly"]} selected={form.subscriptionResetWindows} onChange={(value) => update("subscriptionResetWindows", value)} /></div></div></section>
    <section className="form-section mode-section"><div><Toggle checked={form.dryRun} onChange={(value) => update("dryRun", value)} label="预览模式" /><small>确认事件不执行写操作</small></div><div><Toggle checked={form.enabled} onChange={(value) => update("enabled", value)} label="启用监控" /><small>后台按轮询间隔运行</small></div></section>
  </form>;
}

function SettingsPage({ adminData, selectedId, onSelect, reload, notify }) {
  const monitor = adminData.monitors.find((item) => item.id === selectedId) || adminData.monitors[0];
  async function create() {
    try { const created = await api.createMonitor({ name: `Codex 账号 ${adminData.monitors.length + 1}` }); await reload(); onSelect(created.id); notify("success", "已创建监控任务"); }
    catch (error) { notify("error", error.message); }
  }
  return <div className="admin-layout"><aside className="monitor-admin-list"><div className="admin-list-head"><div><span className="eyebrow">ACCOUNTS</span><h3>监控任务</h3></div><button className="icon-button" onClick={create} title="添加任务"><Plus size={18} /></button></div><div>{adminData.monitors.map((item) => <button key={item.id} className={monitor?.id === item.id ? "active" : ""} onClick={() => onSelect(item.id)}><span><strong>{item.name}</strong><small>#{item.sourceAccountId || "未配置"}</small></span><span className={`status-dot ${item.enabled ? item.runtime.status : "disabled"}`} /></button>)}</div></aside><div className="admin-form-area">{monitor ? <MonitorForm monitor={monitor} onSaved={async () => reload()} onDeleted={async () => { await reload(); onSelect(null); }} notify={notify} /> : <EmptyState icon={ServerCog} title="暂无监控任务" action={<button className="button primary" onClick={create}><Plus size={16} />添加任务</button>} />}</div></div>;
}

function EventDrawer({ event, onClose }) {
  if (!event) return null;
  const summary = actionCounts(event);
  return <div className="drawer-backdrop" onMouseDown={onClose}><aside className="drawer" onMouseDown={(e) => e.stopPropagation()}><div className="drawer-head"><div><span className="eyebrow">RESET EVENT</span><h2>{event.monitorName || "监控任务"}</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={20} /></button></div><div className="event-hero"><StatusBadge status={event.status} /><strong>#{event.sourceAccountId}</strong><time>{formatDate(event.confirmedAt, true)}</time></div><div className="event-delta"><div><span>旧周期</span><strong>{event.baseline.usedPercent}%</strong><small>{formatDate(event.baseline.resetAt, true)}</small></div><ChevronRight size={22} /><div><span>新周期</span><strong>{event.resetSnapshot.usedPercent}%</strong><small>{formatDate(event.resetSnapshot.resetAt, true)}</small></div></div><section className="public-action-summary"><div><span>动作总数</span><strong>{summary.total}</strong></div><div><span>已完成</span><strong>{summary.completed}</strong></div><div><span>失败</span><strong>{summary.failed}</strong></div></section></aside></div>;
}

function AppShell({ publicData, adminData, authenticated, initialPage, onRequireAdmin, onLogout, reloadAdmin }) {
  const [page, setPage] = useState(initialPage || "overview");
  const [selectedMonitorId, setSelectedMonitorId] = useState(publicData.monitors[0]?.id || null);
  const [selectedAdminId, setSelectedAdminId] = useState(adminData?.monitors[0]?.id || null);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [toast, setToast] = useState(null);
  const [now, setNow] = useState(Date.now());
  const timer = useRef(null);
  const unhealthyCount = publicData.monitors.filter((monitor) => monitor.runtime?.hasError || monitor.runtime?.status === "error").length;
  useEffect(() => { if (!publicData.monitors.some((item) => item.id === selectedMonitorId)) setSelectedMonitorId(publicData.monitors[0]?.id || null); }, [publicData.monitors, selectedMonitorId]);
  useEffect(() => { if (adminData && !adminData.monitors.some((item) => item.id === selectedAdminId)) setSelectedAdminId(adminData.monitors[0]?.id || null); }, [adminData, selectedAdminId]);
  useEffect(() => { const interval = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(interval); }, []);
  function notify(kind, message) { setToast({ kind, message }); clearTimeout(timer.current); timer.current = setTimeout(() => setToast(null), 5000); }
  function navigate(item) { if (item.admin && !authenticated) onRequireAdmin(item.id); else setPage(item.id); }

  return <div className="app-shell"><aside className="sidebar"><div className="sidebar-brand"><div className="brand-mark small"><Activity size={20} /></div><span>SubMonitor</span></div><nav>{NAVIGATION.map((item) => { const Icon = item.icon; return <button key={item.id} className={page === item.id ? "active" : ""} onClick={() => navigate(item)}><Icon size={19} /><span>{item.label}</span>{item.admin && !authenticated && <LockKeyhole className="nav-lock" size={11} />}</button>; })}</nav>{authenticated ? <button className="logout-button" onClick={onLogout}><LogOut size={18} /><span>退出后台</span></button> : <button className="logout-button" onClick={() => onRequireAdmin("settings")}><KeyRound size={18} /><span>后台登录</span></button>}</aside>
    <div className="workspace"><header className="topbar"><div className="runtime-state"><span className={`status-dot ${unhealthyCount ? "error" : "idle"}`} /><strong>{unhealthyCount ? `${unhealthyCount} 个任务异常` : "公开监控"}</strong><small>{publicData.monitors.length} 个任务 · 更新 {formatDate(publicData.generatedAt, true)}</small></div><button className="button secondary" onClick={() => authenticated ? setPage("settings") : onRequireAdmin("settings")}>{authenticated ? <Settings2 size={17} /> : <KeyRound size={17} />}{authenticated ? "管理后台" : "后台登录"}</button></header>
      <main className="content">{page === "overview" && <Overview data={publicData} selectedId={selectedMonitorId} onSelectMonitor={setSelectedMonitorId} onSelectEvent={setSelectedEvent} now={now} onAdmin={() => authenticated ? setPage("settings") : onRequireAdmin("settings")} />}{page === "events" && <EventsPage events={publicData.events} onSelect={setSelectedEvent} />}{page === "audit" && adminData && <AuditPage entries={adminData.audit} />}{page === "settings" && adminData && <SettingsPage adminData={adminData} selectedId={selectedAdminId} onSelect={setSelectedAdminId} reload={reloadAdmin} notify={notify} />}</main></div>
    <EventDrawer event={selectedEvent} onClose={() => setSelectedEvent(null)} /><Toast toast={toast} onClose={() => setToast(null)} />
  </div>;
}

export default function App() {
  const [publicData, setPublicData] = useState(null);
  const [adminData, setAdminData] = useState(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [pendingPage, setPendingPage] = useState("settings");
  const refreshTimer = useRef(null);

  const loadPublic = useCallback(async () => setPublicData(await api.publicDashboard()), []);
  const loadAdmin = useCallback(async () => { const data = await api.adminDashboard(); setAdminData(data); return data; }, []);

  useEffect(() => {
    void loadPublic();
    api.session().then(async (session) => { setAuthenticated(session.authenticated); if (session.authenticated) await loadAdmin(); }).catch(() => {});
  }, [loadAdmin, loadPublic]);
  useEffect(() => {
    const stream = new EventSource("/api/public/stream");
    const refresh = () => { clearTimeout(refreshTimer.current); refreshTimer.current = setTimeout(() => void loadPublic(), 200); };
    stream.addEventListener("refresh", refresh);
    return () => { clearTimeout(refreshTimer.current); stream.close(); };
  }, [loadPublic]);
  useEffect(() => {
    if (!authenticated) return undefined;
    const stream = new EventSource("/api/stream");
    const refresh = () => { clearTimeout(refreshTimer.current); refreshTimer.current = setTimeout(() => { void loadPublic(); void loadAdmin(); }, 200); };
    ["runtime", "snapshot", "event", "audit", "config"].forEach((type) => stream.addEventListener(type, refresh));
    return () => stream.close();
  }, [authenticated, loadAdmin, loadPublic]);

  function requireAdmin(page) { setPendingPage(page); setLoginOpen(true); }
  async function loggedIn() { setAuthenticated(true); await Promise.all([loadAdmin(), loadPublic()]); setLoginOpen(false); }
  async function logout() { await api.logout().catch(() => {}); setAuthenticated(false); setAdminData(null); }

  if (!publicData) return <div className="app-loading"><Activity size={26} /><span>SubMonitor</span></div>;
  return <><AppShell key={`${authenticated}-${pendingPage}`} publicData={publicData} adminData={adminData} authenticated={authenticated} initialPage={authenticated ? pendingPage : "overview"} onRequireAdmin={requireAdmin} onLogout={logout} reloadAdmin={loadAdmin} /><LoginDialog open={loginOpen} onClose={() => setLoginOpen(false)} onAuthenticated={loggedIn} /></>;
}
