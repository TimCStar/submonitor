import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  ArrowRight,
  BellRing,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleGauge,
  Eye,
  EyeOff,
  FileClock,
  KeyRound,
  ListChecks,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Monitor,
  Moon,
  Plus,
  RefreshCw,
  Save,
  ServerCog,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Trash2,
  UsersRound,
  Wallet,
  X,
  XCircle,
} from "lucide-react";
import { api } from "./api.js";

const TIME_ZONE = "Asia/Shanghai";
const THEME_STORAGE_KEY = "submonitor-theme";
const THEME_COLORS = { light: "#f7f7f8", dark: "#0c0c0e" };
const THEME_OPTIONS = [
  { value: "system", label: "跟随系统", icon: Monitor },
  { value: "light", label: "亮色", icon: Sun },
  { value: "dark", label: "暗色", icon: Moon },
];

function readThemePreference() {
  const value = window.localStorage.getItem(THEME_STORAGE_KEY);
  return THEME_OPTIONS.some((option) => option.value === value) ? value : "system";
}

function resolveTheme(preference) {
  return preference === "system"
    ? (window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light")
    : preference;
}

function applyTheme(preference) {
  const resolved = resolveTheme(preference);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[resolved]);
}

function ThemeSelector({ value, onChange }) {
  return <div className="theme-switcher" role="group" aria-label="主题模式">
    {THEME_OPTIONS.map(({ value: option, label, icon: Icon }) => <button
      type="button"
      key={option}
      className={value === option ? "active" : ""}
      onClick={() => onChange(option)}
      aria-label={label}
      aria-pressed={value === option}
      title={label}
    ><Icon size={15} /></button>)}
  </div>;
}

const NAVIGATION = [
  { id: "overview", label: "监控", icon: CircleGauge, admin: false },
  { id: "events", label: "事件", icon: ListChecks, admin: false },
  { id: "audit", label: "审计", icon: FileClock, admin: true },
  { id: "settings", label: "配置", icon: Settings2, admin: true },
];

/* ---------- formatting ---------- */

function toDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value, includeSeconds = false) {
  const date = toDate(value);
  if (!date) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: TIME_ZONE,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    ...(includeSeconds ? { second: "2-digit" } : {}),
    hour12: false,
  }).format(date);
}

function formatClock(value) {
  const date = toDate(value);
  if (!date) return "--";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function dayKey(value) {
  const date = toDate(value);
  if (!date) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function dayLabel(value, now) {
  const key = dayKey(value);
  if (!key) return "未知日期";
  if (key === dayKey(new Date(now).toISOString())) return "今天";
  if (key === dayKey(new Date(now - 86400000).toISOString())) return "昨天";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: TIME_ZONE, month: "long", day: "numeric", weekday: "short" }).format(toDate(value));
}

function formatRelative(value, now) {
  const date = toDate(value);
  if (!date) return "--";
  const diff = Math.round((now - date.getTime()) / 1000);
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? "前" : "后";
  if (abs < 45) return diff >= 0 ? "刚刚" : "即将";
  if (abs < 3600) return `${Math.max(1, Math.round(abs / 60))} 分钟${suffix}`;
  if (abs < 86400) return `${Math.round(abs / 3600)} 小时${suffix}`;
  if (abs < 86400 * 30) return `${Math.round(abs / 86400)} 天${suffix}`;
  return formatDate(value);
}

function formatCountdown(timestamp, now) {
  const date = toDate(timestamp);
  if (!date) return "未知";
  const seconds = Math.max(0, Math.floor((date.getTime() - now) / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days} 天 ${hours} 小时`;
  if (hours) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分钟`;
}

function formatInterval(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return "--";
  if (value >= 3600 && value % 3600 === 0) return `${value / 3600} 小时`;
  if (value >= 60) return `${Math.round((value / 60) * 10) / 10} 分钟`;
  return `${value} 秒`;
}

function percent(value) {
  const number = Number(value);
  if (value === null || value === undefined || !Number.isFinite(number)) return "--";
  return `${Number.isInteger(number) ? number : number.toFixed(1)}%`;
}

const WINDOW_TEXT = { "5h": "5 小时", "7d": "7 天", primary: "主窗口", secondary: "次窗口" };
function windowLabel(selector) { return WINDOW_TEXT[selector] || selector || "--"; }

function latestBySelector(snapshots) {
  const result = {};
  for (const snapshot of snapshots || []) result[snapshot.selector] ||= snapshot;
  return result;
}

/* ---------- status ---------- */

function monitorState(monitor) {
  const runtime = monitor.runtime || {};
  if (!monitor.enabled) return { tone: "muted", label: "已暂停" };
  if (runtime.hasError || runtime.lastError || runtime.status === "error") return { tone: "danger", label: "异常" };
  if (Object.values(monitor.candidates || {}).some(Boolean)) return { tone: "warning", label: "待确认" };
  if (runtime.running) return { tone: "accent", label: "检查中" };
  return { tone: "success", label: "正常" };
}

const EVENT_STATUS = {
  complete: { tone: "success", label: "已重置" },
  success: { tone: "success", label: "成功" },
  preview: { tone: "muted", label: "预览" },
  pending: { tone: "warning", label: "处理中" },
  in_progress: { tone: "warning", label: "执行中" },
  failed: { tone: "danger", label: "失败" },
  skipped: { tone: "muted", label: "已跳过" },
  cancelled: { tone: "muted", label: "已取消" },
};

function eventState(status) { return EVENT_STATUS[status] || { tone: "muted", label: status || "未知" }; }

function Chip({ tone = "muted", children, dot = true }) {
  return <span className={`chip chip-${tone}`}>{dot && <i />}{children}</span>;
}

/* ---------- small primitives ---------- */

function Toast({ toast, onClose }) {
  if (!toast) return null;
  const Icon = toast.kind === "error" ? AlertCircle : CheckCircle2;
  return (
    <div className={`toast toast-${toast.kind}`} role="status">
      <Icon size={17} /><span>{toast.message}</span>
      <button className="icon-button ghost small" onClick={onClose} aria-label="关闭"><X size={15} /></button>
    </div>
  );
}

function EmptyState({ icon: Icon, title, hint, action }) {
  return <div className="empty-state"><span className="empty-icon"><Icon size={20} /></span><strong>{title}</strong>{hint && <small>{hint}</small>}{action}</div>;
}

function Progress({ value, tone }) {
  const width = Math.max(0, Math.min(100, Number(value) || 0));
  const auto = width >= 90 ? "danger" : width >= 75 ? "warning" : "accent";
  return <div className={`progress progress-${tone || auto}`} role="progressbar" aria-valuenow={Math.round(width)} aria-valuemin="0" aria-valuemax="100"><span style={{ width: `${width}%` }} /></div>;
}

function Sparkline({ values }) {
  if (!values || values.length < 2) return null;
  const max = Math.max(...values, 100);
  const min = Math.min(...values, 0);
  const range = Math.max(1, max - min);
  const points = values
    .map((value, index) => `${(index / (values.length - 1)) * 100},${98 - ((value - min) / range) * 92}`)
    .join(" ");
  return <svg className="sparkline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" /></svg>;
}

function SectionHeader({ title, hint, action }) {
  return <div className="section-header"><div><h2>{title}</h2>{hint && <p>{hint}</p>}</div>{action}</div>;
}

/* ---------- login ---------- */

function LoginDialog({ open, onClose, onAuthenticated }) {
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [twoFactorRequired, setTwoFactorRequired] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    if (open) {
      setPassword("");
      setTotp("");
      setError("");
      api.twoFactorPublicStatus().then((result) => setTwoFactorRequired(result.enabled)).catch(() => setTwoFactorRequired(false));
    }
  }, [open]);
  if (!open) return null;

  async function submit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await api.login(password, totp);
      await onAuthenticated();
    } catch (requestError) {
      if (requestError.code === "TWO_FACTOR_INVALID") setTotp("");
      setError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="admin-login" onMouseDown={(event) => event.stopPropagation()}>
        <button className="icon-button ghost dialog-close" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        <span className="brand-glyph large"><LockKeyhole size={20} /></span>
        <div className="dialog-title"><h1 id="admin-login">后台登录</h1><p>SubMonitor 管理控制台</p></div>
        <form onSubmit={submit} className="stack-form">
          <label className="field"><span className="field-label">管理员密码</span><PasswordInput id="password" autoFocus required value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></label>
          {twoFactorRequired && <label className="field"><span className="field-label">身份验证器验证码</span><input id="totp" type="text" inputMode="numeric" pattern="[0-9]{6}" maxLength="6" autoComplete="one-time-code" value={totp} onChange={(event) => setTotp(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="000000" required /></label>}
          {error && <div className="form-error"><AlertCircle size={15} />{error}</div>}
          <button className="button primary full" disabled={submitting}>{submitting ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}登录</button>
        </form>
      </section>
    </div>
  );
}

/* ---------- overview ---------- */

function actionCounts(event) {
  if (event.actionSummary) return event.actionSummary;
  const actions = [event.actions?.sourceRecovery, ...Object.values(event.actions?.targetAccounts || {}), ...Object.values(event.actions?.subscriptions || {})].filter(Boolean);
  return { total: actions.length, completed: actions.filter((action) => ["success", "preview", "skipped"].includes(action.status)).length, failed: actions.filter((action) => action.status === "failed").length };
}

function MonitorTabs({ monitors, selectedId, onSelect }) {
  if (monitors.length < 2) return null;
  return <div className="monitor-tabs" role="tablist" aria-label="监控任务">
    {monitors.map((monitor) => {
      const latest = latestBySelector(monitor.snapshots);
      const first = latest[monitor.monitorWindows[0]];
      const state = monitorState(monitor);
      return <button key={monitor.id} role="tab" aria-selected={selectedId === monitor.id} className={selectedId === monitor.id ? "active" : ""} onClick={() => onSelect(monitor.id)}>
        <span className={`dot dot-${state.tone}`} title={state.label} />
        <span className="monitor-tab-name">{monitor.name}</span>
        <span className="monitor-tab-value">{first ? percent(first.usedPercent) : "--"}</span>
      </button>;
    })}
  </div>;
}

function Stat({ label, value, sub, tone }) {
  return <div className={`stat ${tone ? `stat-${tone}` : ""}`}><span className="stat-label">{label}</span><strong className="stat-value">{value}</strong>{sub && <span className="stat-sub">{sub}</span>}</div>;
}

function QuotaRow({ selector, snapshot, now, candidate, series }) {
  const usage = snapshot ? Math.max(0, Math.min(100, Number(snapshot.usedPercent) || 0)) : 0;
  return (
    <div className="quota-row">
      <div className="quota-row-head">
        <div className="quota-row-title"><strong>{windowLabel(selector)}</strong>{snapshot?.role && <span className="mono-tag">{snapshot.role}</span>}</div>
        <div className="quota-row-status">
          {candidate ? <Chip tone="warning">待确认 · 已确认 {candidate.confirmations} 次</Chip> : snapshot && !snapshot.allowed ? <Chip tone="danger">受限</Chip> : null}
          <strong className="quota-value">{snapshot ? percent(usage) : "--"}</strong>
        </div>
      </div>
      <Progress value={usage} />
      <div className="quota-row-foot">
        <span>{snapshot ? `${formatCountdown(snapshot.resetAt, now)}后重置` : "尚未采集"}</span>
        <span>{snapshot ? formatDate(snapshot.resetAt) : ""}</span>
      </div>
      {series && series.length > 2 && <Sparkline values={series} />}
    </div>
  );
}

function Overview({ data, selectedId, onSelectMonitor, onSelectEvent, onShowEvents, now, onAdmin }) {
  const monitor = data.monitors.find((item) => item.id === selectedId) || data.monitors[0];
  if (!monitor) return <div className="page"><div className="card"><EmptyState icon={CircleGauge} title="暂无监控任务" hint="在后台添加并启用监控任务后显示" action={<button className="button secondary" onClick={onAdmin}><Settings2 size={15} />进入后台</button>} /></div></div>;
  const latest = latestBySelector(monitor.snapshots);
  const primarySelector = monitor.monitorWindows[0];
  const primary = latest[primarySelector];
  const state = monitorState(monitor);
  const pendingEntry = Object.entries(monitor.candidates || {}).find(([, value]) => value);
  const runtime = monitor.runtime || {};
  const monitorEvents = data.events.filter((event) => event.monitorId === monitor.id);
  const required = monitor.confirmationsRequired || 1;
  const usageTone = primary && primary.usedPercent >= 90 ? "danger" : primary && primary.usedPercent >= 75 ? "warning" : undefined;

  return (
    <div className="page">
      <MonitorTabs monitors={data.monitors} selectedId={monitor.id} onSelect={onSelectMonitor} />

      <section className="card hero">
        <div className="hero-head">
          <div className="hero-title">
            <h1>{monitor.name}</h1>
            <p>Codex OAuth · 源账号 #{monitor.sourceAccountId || "--"}{monitor.dryRun ? " · 预览模式" : ""}</p>
          </div>
          <Chip tone={state.tone}>{state.label}</Chip>
        </div>
        <div className="stats">
          <Stat label="下次重置" value={primary ? formatCountdown(primary.resetAt, now) : "--"} sub={primary ? formatDate(primary.resetAt) : "尚未采集"} />
          <Stat label="已使用" value={primary ? percent(primary.usedPercent) : "--"} sub={`${windowLabel(primarySelector)}窗口`} tone={usageTone} />
          <Stat label="上次检查" value={formatRelative(runtime.lastPollAt, now)} sub={runtime.running ? "检查中" : runtime.nextPollAt ? `下次 ${formatClock(runtime.nextPollAt)}` : "--"} />
          <Stat label="重置确认" value={pendingEntry ? "待确认" : "无候选"} sub={pendingEntry ? `${windowLabel(pendingEntry[0])} · ${pendingEntry[1].confirmations}/${required} 次` : `需 ${required} 次确认`} tone={pendingEntry ? "warning" : undefined} />
        </div>
      </section>

      <section className="card">
        <SectionHeader title="额度窗口" hint="每次轮询后自动刷新" />
        <div className="quota-list">
          {monitor.monitorWindows.map((selector) => <QuotaRow key={selector} selector={selector} snapshot={latest[selector]} now={now} candidate={monitor.candidates?.[selector]} series={monitor.snapshots.filter((snapshot) => snapshot.selector === selector).map((snapshot) => snapshot.usedPercent).reverse()} />)}
          {monitor.concurrency && <div className="quota-row compact">
            <div className="quota-row-head"><div className="quota-row-title"><strong>实时并发</strong></div><strong className="quota-value">{monitor.concurrency.current}<small> / {monitor.concurrency.max}</small></strong></div>
            <Progress value={(monitor.concurrency.current / Math.max(1, monitor.concurrency.max)) * 100} tone="neutral" />
          </div>}
        </div>
      </section>

      {monitor.quotaSharing && <QuotaSharingPanel quota={monitor.quotaSharing} />}

      <PublicSubscriberPreview monitor={monitor} />

      <section className="card">
        <SectionHeader title="最近重置" action={monitorEvents.length > 5 && <button className="text-button" onClick={onShowEvents}>全部<ChevronRight size={14} /></button>} />
        <EventTimeline events={monitorEvents.slice(0, 5)} onSelect={onSelectEvent} now={now} />
      </section>

      <details className="card disclosure">
        <summary><span><SlidersHorizontal size={15} />运行参数</span><ChevronDown size={16} className="chevron" /></summary>
        <dl className="kv-grid">
          <div><dt>运行模式</dt><dd>{monitor.dryRun ? "预览（不执行写操作）" : "自动执行"}</dd></div>
          <div><dt>确认次数</dt><dd>{required} 次</dd></div>
          <div><dt>轮询间隔</dt><dd>{formatInterval(monitor.pollIntervalSeconds)}</dd></div>
          <div><dt>目标账号</dt><dd>{monitor.targetAccountCount} 个</dd></div>
          <div><dt>上次成功</dt><dd>{formatDate(runtime.lastSuccessAt, true)}</dd></div>
          <div><dt>服务启动</dt><dd>{formatDate(runtime.startedAt)}</dd></div>
        </dl>
      </details>
    </div>
  );
}

function EventItem({ event, onSelect, now, showMonitor }) {
  const summary = actionCounts(event);
  const status = eventState(event.status);
  return <li>
    <button className="event-item" onClick={() => onSelect(event)}>
      <span className={`event-marker dot-${status.tone}`} />
      <span className="event-main">
        <span className="event-title">{showMonitor ? <strong>{event.monitorName || "监控任务"}</strong> : <strong>周期重置</strong>}<span className="mono-tag">{event.window}</span></span>
        <span className="event-sub">{percent(event.baseline?.usedPercent)}<ArrowRight size={12} />{percent(event.resetSnapshot?.usedPercent)}<span className="sep" />动作 {summary.completed}/{summary.total}{summary.failed ? <span className="text-danger">&nbsp;· {summary.failed} 失败</span> : null}</span>
      </span>
      <span className="event-side">
        <Chip tone={status.tone}>{status.label}</Chip>
        <time title={formatDate(event.confirmedAt, true)}>{formatRelative(event.confirmedAt, now)}</time>
      </span>
    </button>
  </li>;
}

function EventTimeline({ events, onSelect, now, showMonitor = false }) {
  if (!events?.length) return <EmptyState icon={ListChecks} title="暂无重置事件" hint="检测到周期重置后会显示在这里" />;
  return <ul className="event-list">{events.map((event) => <EventItem key={event.id} event={event} onSelect={onSelect} now={now} showMonitor={showMonitor} />)}</ul>;
}

function EventsPage({ events, onSelect, now }) {
  const [filter, setFilter] = useState("all");
  const [limit, setLimit] = useState(30);
  const filtered = useMemo(() => (filter === "all" ? events : events.filter((event) => event.status === filter)), [events, filter]);
  const groups = useMemo(() => {
    const result = [];
    for (const event of filtered.slice(0, limit)) {
      const key = dayKey(event.confirmedAt);
      const last = result[result.length - 1];
      if (last && last.key === key) last.items.push(event);
      else result.push({ key, label: dayLabel(event.confirmedAt, now), items: [event] });
    }
    return result;
  }, [filtered, limit, now]);
  return <div className="page">
    <div className="page-head">
      <div><h1>重置事件</h1><p>共 {events.length} 条记录 · 北京时间</p></div>
      <div className="segmented">{[["all", "全部"], ["complete", "完成"], ["pending", "处理中"], ["preview", "预览"]].map(([value, label]) => <button key={value} className={filter === value ? "active" : ""} onClick={() => { setFilter(value); setLimit(30); }}>{label}</button>)}</div>
    </div>
    {!groups.length ? <div className="card"><EmptyState icon={ListChecks} title="没有符合条件的事件" /></div> : <div className="card timeline-card">{groups.map((group) => <section className="day-group" key={group.key || group.label}>
      <div className="group-label">{group.label}<span>{group.items.length} 条</span></div>
      <EventTimeline events={group.items} onSelect={onSelect} now={now} showMonitor />
    </section>)}
      {filtered.length > limit && <div className="load-more"><button className="button secondary small" onClick={() => setLimit((current) => current + 30)}>显示更多<span className="load-more-count">还有 {filtered.length - limit} 条</span></button></div>}
    </div>}
  </div>;
}

function AuditPage({ entries, now }) {
  return <div className="page">
    <div className="page-head"><div><h1>审计日志</h1><p>最近 {entries?.length || 0} 条管理操作与系统记录</p></div></div>
    <section className="card">
      {!entries?.length ? <EmptyState icon={FileClock} title="暂无审计记录" /> : <ul className="audit-list">{entries.map((entry) => <li key={entry.id}>
        <span className={`audit-icon tone-${entry.level === "error" ? "danger" : entry.level === "warn" ? "warning" : "muted"}`}>{entry.level === "error" ? <XCircle size={15} /> : entry.level === "warn" ? <AlertCircle size={15} /> : <Check size={15} />}</span>
        <div className="audit-main"><strong>{entry.message}</strong><small>{entry.action}{entry.details?.monitorId ? ` · ${entry.details.monitorId.slice(0, 8)}` : ""}</small></div>
        <time title={formatDate(entry.createdAt, true)}>{formatRelative(entry.createdAt, now)}</time>
      </li>)}</ul>}
    </section>
  </div>;
}

/* ---------- quota sharing ---------- */

function quotaMoney(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value) : "--";
}

function QuotaSharingPanel({ quota, admin = false }) {
  const data = quota || { status: "waiting", note: "等待首次额度采样" };
  const statuses = { waiting: "等待采样", ready: "已估算", preview: "预览", applied: "已同步", unchanged: "无需调整", blocked: "未调整", error: "重算失败" };
  const tone = ["error", "blocked"].includes(data.status) ? "danger" : data.status === "waiting" ? "muted" : "success";
  return <section className={admin ? "inset-panel" : "card"} aria-label="预估周总额度">
    <SectionHeader title="预估周总额度" hint={`更新 ${formatDate(data.checkedAt)} · 周期重置 ${formatDate(data.cycleResetAt)}`} action={<Chip tone={tone}>{statuses[data.status] || "等待采样"}</Chip>} />
    <div className="metric-grid">
      <Stat label="建议每人周上限" value={quotaMoney(data.recommendedWeeklyLimitUsd)} />
      <Stat label="当前每人周上限" value={quotaMoney(data.currentWeeklyLimitUsd)} />
      <Stat label="有效订阅用户" value={data.subscriberCount ?? "--"} sub="人" />
      <Stat label="账号预估总额度" value={quotaMoney(data.estimatedTotalUsd)} />
      <Stat label="可分配额度" value={quotaMoney(data.distributableTotalUsd)} sub={typeof data.reservePercent === "number" ? `预留 ${data.reservePercent}%` : undefined} />
    </div>
    <p className="footnote">{data.note || "按本周期使用率和费用估算，额度可能变化"}{data.estimatedUserTotalUsd !== undefined && Math.abs(data.estimatedUserTotalUsd - data.estimatedTotalUsd) > 0.01 && <> · 用户计费口径总额度 {quotaMoney(data.estimatedUserTotalUsd)}</>}</p>
    {admin && data.lastError && <p className="form-error">{data.lastError}</p>}
  </section>;
}

/* ---------- subscribers ---------- */

function numberList(value) {
  if (!String(value || "").trim()) return [];
  const parsed = String(value).split(",").map((item) => Number(item.trim()));
  if (parsed.some((item) => !Number.isSafeInteger(item) || item <= 0)) throw new Error("账号和分组 ID 必须是逗号分隔的正整数");
  return [...new Set(parsed)];
}

function MaskedIdentity({ identity }) {
  if (!identity) return <span>--</span>;
  return <span className="masked-identity" title="用户信息已脱敏">
    <span>{identity.prefix}{identity.leading}</span>
    {identity.obscured && <span className="masked-fragment" aria-hidden="true">••••</span>}
    <span>{identity.trailing}{identity.suffix}</span>
  </span>;
}

const USAGE_WINDOW_TEXT = { daily: "日", weekly: "周", monthly: "月" };

function SubscriberUsage({ usage }) {
  const entries = Object.entries(usage || {});
  if (!entries.length) return <span className="subscriber-usage-empty">--</span>;
  return <div className="subscriber-usage">{entries.map(([window, metric]) => {
    const percentage = Number.isFinite(metric.percentage) ? metric.percentage : null;
    return <div className="subscriber-usage-row" key={window}>
      <span>{USAGE_WINDOW_TEXT[window] || window}</span>
      <Progress value={percentage ?? 0} />
      <strong>{percentage === null ? "--" : `${percentage.toFixed(1)}%`}</strong>
    </div>;
  })}</div>;
}

function SubscriberList({ data }) {
  return <div className="subscriber-list" role="list">
    {data.subscribers.map((subscriber, index) => <div className="subscriber-row" role="listitem" key={`${subscriber.groupId || "public"}-${index}`}>
      <span className="avatar">{subscriber.identity?.leading?.toUpperCase() || "#"}</span>
      <div className="subscriber-identity">
        <MaskedIdentity identity={subscriber.identity} />
        <small>{subscriber.groupName || (subscriber.groupId ? `分组 #${subscriber.groupId}` : "订阅分组")} · {subscriber.expiresAt ? `${formatDate(subscriber.expiresAt)} 到期` : "长期有效"}</small>
      </div>
      <SubscriberUsage usage={subscriber.usage} />
    </div>)}
    {data.truncated && <div className="list-note">仅显示前 {data.subscribers.length} 位用户</div>}
  </div>;
}

function InlineMessage({ icon: Icon, children, tone, action }) {
  return <div className={`inline-message ${tone ? `tone-${tone}` : ""}`}><Icon size={16} className={Icon === LoaderCircle ? "spin" : ""} /><span>{children}</span>{action}</div>;
}

function PublicSubscriberPreview({ monitor }) {
  const [state, setState] = useState({ loading: false, data: null, error: "" });
  const enabled = monitor.publicSubscriberPreviewEnabled !== false && monitor.subscriptionGroupMode !== "none";
  const load = useCallback(async () => {
    if (!enabled) return;
    setState((current) => ({ ...current, loading: true, error: "" }));
    try {
      const data = await api.publicSubscribers(monitor.id);
      setState({ loading: false, data, error: "" });
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: error.message }));
    }
  }, [enabled, monitor.id]);
  useEffect(() => {
    if (!enabled) return undefined;
    void load();
    const interval = setInterval(() => void load(), 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [enabled, load]);
  if (!enabled) return null;
  const data = state.data;
  return <section className="card">
    <SectionHeader title="订阅用户" hint={data ? `${data.total} 位有效用户 · ${data.groupCount} 个分组` : "有效订阅"} />
    {state.loading && !data && <InlineMessage icon={LoaderCircle}>正在读取订阅用户</InlineMessage>}
    {state.error && !data && <InlineMessage icon={AlertCircle} tone="danger">{state.error}</InlineMessage>}
    {!state.loading && !state.error && data && !data.subscribers.length && <InlineMessage icon={UsersRound}>暂无有效订阅用户</InlineMessage>}
    {data?.subscribers?.length > 0 && <SubscriberList data={data} />}
  </section>;
}

function SubscriberPreview({ monitor, visible }) {
  const [state, setState] = useState({ loading: false, data: null, error: "" });
  const savedEnabled = monitor.subscriptionGroupMode !== "none";
  const ready = Boolean(monitor.baseUrl && monitor.sourceAccountId && monitor.authSecretConfigured && !monitor.authSecretInvalid);
  const load = useCallback(async (refresh = false) => {
    if (!savedEnabled || !ready) return;
    setState((current) => ({ ...current, loading: true, error: "" }));
    try {
      const data = await api.subscribers(monitor.id, refresh);
      setState({ loading: false, data, error: "" });
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: error.message }));
    }
  }, [monitor.id, ready, savedEnabled]);
  useEffect(() => {
    if (savedEnabled && ready) void load(false);
    else setState({ loading: false, data: null, error: "" });
  }, [load, monitor.updatedAt, ready, savedEnabled]);
  if (!visible) return null;

  const data = state.data;
  return <div className="inset-panel">
    <div className="section-header">
      <div><h3>订阅用户</h3><p>{data ? `${data.total} 位有效用户 · ${data.groups.length} 个分组` : "有效订阅"}</p></div>
      <button type="button" className="icon-button small" onClick={() => load(true)} disabled={!savedEnabled || !ready || state.loading} title="刷新订阅用户" aria-label="刷新订阅用户"><RefreshCw className={state.loading ? "spin" : ""} size={15} /></button>
    </div>
    {!savedEnabled && <InlineMessage icon={UsersRound}>保存配置后显示订阅用户</InlineMessage>}
    {savedEnabled && !ready && <InlineMessage icon={AlertCircle}>连接配置完整后显示订阅用户</InlineMessage>}
    {state.error && <InlineMessage icon={AlertCircle} tone="danger" action={<button type="button" className="text-button" onClick={() => load(true)}>重试</button>}>{state.error}</InlineMessage>}
    {state.loading && !data && <InlineMessage icon={LoaderCircle}>正在读取订阅用户</InlineMessage>}
    {!state.loading && !state.error && data && !data.subscribers.length && <InlineMessage icon={UsersRound}>分组中暂无有效订阅用户</InlineMessage>}
    {data?.subscribers?.length > 0 && <SubscriberList data={data} />}
  </div>;
}

/* ---------- form primitives ---------- */

function Toggle({ checked, onChange, label, hint, action }) {
  return <div className="switch-row">
    <button type="button" role="switch" aria-checked={Boolean(checked)} className={`switch ${checked ? "on" : ""}`} onClick={() => onChange(!checked)} aria-label={label}><span /></button>
    <div className="switch-text" onClick={() => onChange(!checked)}><strong>{label}</strong>{hint && <small>{hint}</small>}</div>
    {action}
  </div>;
}

function Field({ label, hint, badge, wide, children }) {
  return <label className={`field ${wide ? "wide" : ""}`}>
    <span className="field-label">{label}{badge}</span>
    {children}
    {hint && <small className="field-hint">{hint}</small>}
  </label>;
}

function FormSection({ icon: Icon, title, description, children, aside }) {
  return <section className="form-section">
    <div className="form-section-head">
      <span className="section-icon"><Icon size={16} /></span>
      <div><h3>{title}</h3>{description && <p>{description}</p>}</div>
      {aside}
    </div>
    {children}
  </section>;
}

function ChoiceButtons({ values, selected, onChange, labels = {} }) {
  function toggle(value) {
    if (selected.includes(value)) { if (selected.length > 1) onChange(selected.filter((item) => item !== value)); }
    else onChange([...selected, value]);
  }
  return <div className="segmented">{values.map((value) => <button type="button" key={value} className={selected.includes(value) ? "active" : ""} onClick={() => toggle(value)} aria-pressed={selected.includes(value)}>{labels[value] || value}</button>)}</div>;
}

function SavedBadge({ configured, invalid, onClear }) {
  if (!configured) return null;
  return <em className={`saved-badge ${invalid ? "invalid" : ""}`}>{invalid ? "需要重新输入" : "已保存"}{!invalid && onClear && <button type="button" className="text-button" onClick={(event) => { event.preventDefault(); onClear(); }}>清除</button>}</em>;
}

function PasswordInput({ value, onChange, placeholder, autoComplete, ...rest }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="password-field">
      <input type={visible ? "text" : "password"} value={value} onChange={onChange} placeholder={placeholder} autoComplete={autoComplete} {...rest} />
      <button type="button" className="password-toggle" onClick={() => setVisible((current) => !current)} aria-label={visible ? "隐藏" : "显示"} tabIndex="-1">{visible ? <EyeOff size={15} /> : <Eye size={15} />}</button>
    </div>
  );
}

function SecurityCodeInput({ value, onChange }) {
  return <input type="text" inputMode="numeric" pattern="[0-9]{6}" maxLength="6" autoComplete="one-time-code" value={value} onChange={(event) => onChange(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="000000" />;
}

function TwoFactorSettings({ notify }) {
  const [security, setSecurity] = useState({ loading: true, enabled: false, pending: false });
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState("");

  useEffect(() => {
    let active = true;
    api.twoFactorStatus().then((result) => {
      if (active) setSecurity({ loading: false, ...result });
    }).catch((error) => {
      if (active) { setSecurity({ loading: false, enabled: false, pending: false }); notify("error", error.message); }
    });
    return () => { active = false; };
  }, [notify]);

  async function generate() {
    setBusy("setup");
    try {
      const result = await api.setupTwoFactor();
      setSetup(result);
      setSecurity({ loading: false, enabled: false, pending: true });
      setCode("");
      notify("success", "绑定密钥已生成，请在身份验证器中添加");
    } catch (error) { notify("error", error.message); }
    finally { setBusy(""); }
  }

  async function enable() {
    setBusy("enable");
    try {
      const result = await api.enableTwoFactor(code);
      setSecurity({ loading: false, ...result });
      setSetup(null);
      setCode("");
      notify("success", "2FA 已启用");
    } catch (error) { notify("error", error.message); }
    finally { setBusy(""); }
  }

  async function disable() {
    setBusy("disable");
    try {
      const result = await api.disableTwoFactor(password, code);
      setSecurity({ loading: false, ...result });
      setPassword("");
      setCode("");
      notify("success", "2FA 已停用");
    } catch (error) { notify("error", error.message); }
    finally { setBusy(""); }
  }

  return <FormSection icon={ShieldCheck} title="双因素认证" description="管理员登录时额外校验身份验证器的 6 位动态码" aside={<Chip tone={security.loading ? "muted" : security.enabled ? "success" : "muted"}>{security.loading ? "读取中" : security.enabled ? "已启用" : "未启用"}</Chip>}>
    {!security.loading && !security.enabled && !setup && <div className="row-actions spread"><span className="field-hint">启用后，登录需要密码和动态验证码。</span><button type="button" className="button secondary" onClick={generate} disabled={Boolean(busy)}><KeyRound size={15} />生成绑定密钥</button></div>}
    {!security.loading && !security.enabled && setup && <div className="form-grid">
      <div className="field wide"><span className="field-label">绑定密钥</span><code className="secret-code">{setup.secret}</code></div>
      <Field label="导入 URI" wide><input readOnly value={setup.otpauthUri} onFocus={(event) => event.target.select()} /></Field>
      <Field label="验证码"><SecurityCodeInput value={code} onChange={setCode} /></Field>
      <div className="field align-end"><button type="button" className="button primary" onClick={enable} disabled={Boolean(busy) || code.length !== 6}>{busy === "enable" ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}启用 2FA</button></div>
    </div>}
    {!security.loading && security.enabled && <div className="form-grid">
      <Field label="管理员密码"><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></Field>
      <Field label="当前验证码"><SecurityCodeInput value={code} onChange={setCode} /></Field>
      <div className="field wide align-end"><button type="button" className="button secondary" onClick={disable} disabled={Boolean(busy) || password.length === 0 || code.length !== 6}>{busy === "disable" ? <LoaderCircle className="spin" size={15} /> : <LockKeyhole size={15} />}停用 2FA</button></div>
    </div>}
  </FormSection>;
}

/* ---------- monitor form ---------- */

function ChannelBlock({ label, hint, enabled, configured, onToggle, onTest, testing, children }) {
  const open = enabled || configured;
  return <div className={`channel ${open ? "open" : ""}`}>
    <Toggle checked={enabled} onChange={onToggle} label={label} hint={hint} action={<button type="button" className="button small secondary" onClick={onTest} disabled={testing}>{testing ? <LoaderCircle className="spin" size={13} /> : null}发送测试</button>} />
    {open && <div className="form-grid channel-fields">{children}</div>}
  </div>;
}

function MonitorForm({ monitor, onSaved, onDeleted, notify }) {
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState("");
  useEffect(() => setForm({ ...monitor, authSecret: "", targetAccountIdsText: monitor.targetAccountIds.join(", "), subscriptionGroupIdsText: monitor.subscriptionGroupIds.join(", ") }), [monitor.id, monitor.updatedAt]);
  if (!form) return null;
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const payload = () => ({ ...form, targetAccountIds: numberList(form.targetAccountIdsText), subscriptionGroupIds: numberList(form.subscriptionGroupIdsText) });
  const credentialsReady = monitor.authSecretConfigured && !monitor.authSecretInvalid;
  const state = monitorState(monitor);

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
  async function recalculateQuota() {
    setBusy("quota-sharing");
    try {
      const result = await api.recalculateQuota(monitor.id);
      await onSaved();
      notify(result.quotaSharing?.status === "blocked" ? "error" : "success", result.quotaSharing?.note || "额度重算完成");
    } catch (error) { notify("error", error.message); }
    finally { setBusy(""); }
  }
  async function testChannel(channel) {
    setBusy(`notify-${channel}`);
    try { await api.notifyTest(monitor.id, channel); notify("success", "测试消息已发送"); }
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
    <div className="page-head">
      <div>
        <div className="title-line"><h1>{monitor.name}</h1><Chip tone={state.tone}>{state.label}</Chip></div>
        <p>源账号 #{monitor.sourceAccountId || "未配置"} · 上次检查 {formatDate(monitor.runtime?.lastPollAt)}</p>
        {monitor.runtime?.lastError && <p className="head-error"><AlertCircle size={14} />{monitor.runtime.lastError}</p>}
      </div>
      <div className="button-row">
        <button type="button" className="button secondary" onClick={test} disabled={Boolean(busy) || !credentialsReady}>{busy === "test" ? <LoaderCircle className="spin" size={15} /> : <Activity size={15} />}测试连接</button>
        <button type="button" className="button secondary" onClick={check} disabled={Boolean(busy) || !credentialsReady}>{busy === "check" ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}立即检查</button>
        <button type="button" className="icon-button danger" onClick={remove} disabled={Boolean(busy)} title="删除任务" aria-label="删除任务"><Trash2 size={16} /></button>
      </div>
    </div>

    <FormSection icon={Activity} title="运行" description="控制任务是否运行，以及确认后是否真正执行写操作">
      <div className="switch-list">
        <Toggle checked={form.enabled} onChange={(value) => update("enabled", value)} label="启用监控" hint="后台按轮询间隔运行" />
        <Toggle checked={form.dryRun} onChange={(value) => update("dryRun", value)} label="预览模式" hint="确认事件只记录，不执行写操作" />
      </div>
    </FormSection>

    <FormSection icon={ServerCog} title="Sub2API 连接" description="每个任务使用独立的服务地址与管理凭据">
      <div className="form-grid">
        <Field label="任务名称"><input value={form.name} maxLength="80" onChange={(e) => update("name", e.target.value)} /></Field>
        <Field label="认证方式"><select value={form.authType} onChange={(e) => update("authType", e.target.value)}><option value="apiKey">API Key</option><option value="jwt">管理员 JWT</option></select></Field>
        <Field label="服务地址" wide><input type="url" value={form.baseUrl} onChange={(e) => update("baseUrl", e.target.value)} placeholder="https://sub2api.example.com" /></Field>
        <Field label="管理凭据" wide badge={monitor.authSecretConfigured && <SavedBadge configured invalid={monitor.authSecretInvalid} />} hint={monitor.authSecretInvalid ? "当前主密钥无法解密此凭据，请重新输入并保存" : "凭据加密存储，不会回显"}>
          <PasswordInput value={form.authSecret} onChange={(e) => update("authSecret", e.target.value)} placeholder={monitor.authSecretInvalid ? "重新输入 API Key 或 JWT" : monitor.authSecretConfigured ? "留空保持不变" : "输入管理凭据"} autoComplete="new-password" />
        </Field>
      </div>
    </FormSection>

    <FormSection icon={CircleGauge} title="额度监控" description="Codex OAuth 账号的额度窗口与重置判定">
      <div className="form-grid">
        <Field label="源账号 ID"><input type="number" min="1" value={form.sourceAccountId || ""} onChange={(e) => update("sourceAccountId", e.target.value)} /></Field>
        <Field label="目标账号 ID" hint="逗号分隔，重置后同步恢复"><input value={form.targetAccountIdsText} onChange={(e) => update("targetAccountIdsText", e.target.value)} placeholder="34, 35" /></Field>
        <div className="field wide"><span className="field-label">监控窗口</span><ChoiceButtons values={["5h", "7d", "primary", "secondary"]} selected={form.monitorWindows} onChange={(value) => update("monitorWindows", value)} /></div>
        <Field label="轮询间隔（秒）" hint="平时的检查频率"><input type="number" min="15" value={form.pollIntervalSeconds} onChange={(e) => update("pollIntervalSeconds", e.target.value)} /></Field>
        <Field label="连续确认次数" hint="设为 1 可在首次检测到后立即执行"><input type="number" min="1" max="10" value={form.confirmationsRequired} onChange={(e) => update("confirmationsRequired", e.target.value)} /></Field>
        <Field label="待确认轮询（秒）" hint="出现重置候选后加快确认，不改变平时轮询"><input type="number" min="15" max="3600" value={form.pendingConfirmIntervalSeconds ?? 60} onChange={(e) => update("pendingConfirmIntervalSeconds", e.target.value)} /></Field>
        <Field label="触顶预警（%）" hint="使用率达到该值或上游限流时提醒，0 关闭"><input type="number" min="0" max="100" value={form.usageAlertPercent} onChange={(e) => update("usageAlertPercent", e.target.value)} /></Field>
      </div>
      <details className="sub-disclosure">
        <summary>高级参数<ChevronDown size={14} className="chevron" /></summary>
        <div className="form-grid">
          <Field label="请求超时（秒）"><input type="number" min="5" value={form.requestTimeoutSeconds} onChange={(e) => update("requestTimeoutSeconds", e.target.value)} /></Field>
          <Field label="周期容差（秒）" hint="判断重置时间是否前移的容差"><input type="number" min="1" value={form.resetGraceSeconds} onChange={(e) => update("resetGraceSeconds", e.target.value)} /></Field>
        </div>
      </details>
    </FormSection>

    <FormSection icon={UsersRound} title="订阅级联" description="周期重置后同步重置有效用户的订阅用量">
      <div className="form-grid">
        <Field label="分组来源"><select value={form.subscriptionGroupMode} onChange={(e) => update("subscriptionGroupMode", e.target.value)}><option value="none">关闭</option><option value="auto">源账号自动发现</option><option value="explicit">指定分组</option></select></Field>
        {form.subscriptionGroupMode === "explicit" && <Field label="订阅分组 ID" hint="逗号分隔"><input value={form.subscriptionGroupIdsText} onChange={(e) => update("subscriptionGroupIdsText", e.target.value)} placeholder="10, 11" /></Field>}
        <div className="field wide"><span className="field-label">重置周期</span><ChoiceButtons values={["daily", "weekly", "monthly"]} labels={{ daily: "每日", weekly: "每周", monthly: "每月" }} selected={form.subscriptionResetWindows} onChange={(value) => update("subscriptionResetWindows", value)} /></div>
      </div>
      <div className="switch-list">
        <Toggle checked={form.publicSubscriberPreviewEnabled !== false} onChange={(value) => update("publicSubscriberPreviewEnabled", value)} label="首页显示订阅用户" hint="关闭后公开首页不会读取或展示订阅用户" />
      </div>
      <SubscriberPreview monitor={monitor} visible={form.subscriptionGroupMode !== "none"} />
    </FormSection>

    <FormSection icon={Wallet} title="周额度均分" description="可选：为专用订阅分组统一计算每人周上限">
      <div className="switch-list">
        <Toggle checked={form.quotaSharingEnabled} onChange={(value) => update("quotaSharingEnabled", value)} label="启用专用分组额度均分" hint="一账号对应一个专用订阅分组，统一周上限并保留已用额度；关闭后保留最后同步的上限" />
        {form.quotaSharingEnabled && <div className="form-grid nested"><Field label="专用订阅分组 ID"><input type="number" min="1" required value={form.quotaSharingGroupId || ""} onChange={(e) => update("quotaSharingGroupId", e.target.value)} /></Field></div>}
        <Toggle checked={form.quotaSharingReserveEnabled} onChange={(value) => update("quotaSharingReserveEnabled", value)} label="启用额度预留" hint="从用户计费口径的预估总额度中扣除预留份额" />
        {form.quotaSharingReserveEnabled && <div className="form-grid nested"><Field label="预留比例（%）"><input type="number" min="0" max="90" step="0.1" required value={form.quotaSharingReservePercent} onChange={(e) => update("quotaSharingReservePercent", e.target.value)} /></Field></div>}
        <Toggle checked={form.quotaSharingAutoRecalculateEnabled} onChange={(value) => update("quotaSharingAutoRecalculateEnabled", value)} label="定时重算并同步" hint="需要启用额度均分和监控；关闭后只预估，可手动同步。预览模式不执行写操作" />
        {form.quotaSharingAutoRecalculateEnabled && <div className="form-grid nested"><Field label="重算间隔（秒）"><input type="number" min="60" max="86400" required value={form.quotaSharingIntervalSeconds} onChange={(e) => update("quotaSharingIntervalSeconds", e.target.value)} /></Field></div>}
        <Toggle checked={form.quotaSharingDisplayEnabled} onChange={(value) => update("quotaSharingDisplayEnabled", value)} label="首页显示预估总额度" hint="可独立启用；展示预估总额、可分配额度、用户人数和每人周上限" />
      </div>
      <div className="row-actions spread">
        <span className="field-hint">使用率达到 5% 后估算；保存配置后重算。预算不足或数据异常时保留现有限额</span>
        <button type="button" className="button secondary" onClick={recalculateQuota} disabled={Boolean(busy) || (!monitor.quotaSharingEnabled && !monitor.quotaSharingDisplayEnabled) || !credentialsReady}>{busy === "quota-sharing" ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}{monitor.quotaSharingEnabled && !monitor.dryRun ? "立即重算并同步" : "刷新额度预估"}</button>
      </div>
      {(monitor.quotaSharingEnabled || monitor.quotaSharingDisplayEnabled) && <QuotaSharingPanel quota={monitor.quotaSharing} admin />}
    </FormSection>

    <FormSection icon={BellRing} title="重置提醒" description="识别到自然重置后实时推送">
      <div className="switch-list">
        <Toggle checked={form.notifyEnabled} onChange={(value) => update("notifyEnabled", value)} label="启用重置提醒" hint="总开关，关闭后所有渠道都不发送" />
      </div>
      <div className="channels">
        <ChannelBlock label="Telegram" hint="Bot 推送到指定会话" enabled={form.notifyTelegramEnabled} configured={form.telegramBotTokenConfigured} onToggle={(value) => update("notifyTelegramEnabled", value)} onTest={() => testChannel("telegram")} testing={busy === "notify-telegram"}>
          <Field label="Bot Token" badge={<SavedBadge configured={form.telegramBotTokenConfigured} invalid={form.telegramBotTokenInvalid} onClear={() => { update("clearTelegramBotToken", true); update("notifyTelegramEnabled", false); update("telegramBotTokenConfigured", false); }} />}><PasswordInput value={form.telegramBotToken || ""} onChange={(e) => update("telegramBotToken", e.target.value)} placeholder={form.telegramBotTokenConfigured ? "留空保持不变" : "输入 Bot Token"} autoComplete="new-password" /></Field>
          <Field label="Chat ID"><input value={form.telegramChatId || ""} onChange={(e) => update("telegramChatId", e.target.value)} placeholder="123456789" /></Field>
        </ChannelBlock>
        <ChannelBlock label="Bark" hint="iOS 推送，默认服务器 https://api.day.app" enabled={form.notifyBarkEnabled} configured={form.barkKeyConfigured} onToggle={(value) => update("notifyBarkEnabled", value)} onTest={() => testChannel("bark")} testing={busy === "notify-bark"}>
          <Field label="Bark 服务器"><input value={form.barkServer || ""} onChange={(e) => update("barkServer", e.target.value)} placeholder="留空使用 https://api.day.app" /></Field>
          <Field label="设备 Key" badge={<SavedBadge configured={form.barkKeyConfigured} invalid={form.barkKeyInvalid} onClear={() => { update("clearBarkKey", true); update("notifyBarkEnabled", false); update("barkKeyConfigured", false); }} />}><PasswordInput value={form.barkKey || ""} onChange={(e) => update("barkKey", e.target.value)} placeholder={form.barkKeyConfigured ? "留空保持不变" : "输入设备 Key"} autoComplete="new-password" /></Field>
        </ChannelBlock>
        <ChannelBlock label="邮件" hint="通过 SMTP 发送" enabled={form.notifyEmailEnabled} configured={form.emailSmtpPassConfigured} onToggle={(value) => update("notifyEmailEnabled", value)} onTest={() => testChannel("email")} testing={busy === "notify-email"}>
          <Field label="SMTP 服务器"><input value={form.emailSmtpHost || ""} onChange={(e) => update("emailSmtpHost", e.target.value)} placeholder="smtp.example.com" /></Field>
          <Field label="端口"><input type="number" min="1" max="65535" value={form.emailSmtpPort} onChange={(e) => update("emailSmtpPort", e.target.value)} /></Field>
          <Field label="SMTP 用户名"><input value={form.emailSmtpUser || ""} onChange={(e) => update("emailSmtpUser", e.target.value)} autoComplete="off" /></Field>
          <Field label="SMTP 密码" badge={<SavedBadge configured={form.emailSmtpPassConfigured} invalid={form.emailSmtpPassInvalid} onClear={() => { update("clearEmailSmtpPass", true); update("notifyEmailEnabled", false); update("emailSmtpPassConfigured", false); }} />}><PasswordInput value={form.emailSmtpPass || ""} onChange={(e) => update("emailSmtpPass", e.target.value)} placeholder={form.emailSmtpPassConfigured ? "留空保持不变" : "输入 SMTP 密码"} autoComplete="new-password" /></Field>
          <Field label="发件人"><input type="email" value={form.emailFrom || ""} onChange={(e) => update("emailFrom", e.target.value)} placeholder="monitor@example.com" /></Field>
          <Field label="收件人"><input type="email" value={form.emailTo || ""} onChange={(e) => update("emailTo", e.target.value)} placeholder="you@example.com" /></Field>
        </ChannelBlock>
      </div>
    </FormSection>

    <div className="save-bar">
      <span>修改后需保存才会生效</span>
      <button className="button primary" disabled={Boolean(busy)}>{busy === "save" ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}保存配置</button>
    </div>
  </form>;
}

/* ---------- settings ---------- */

function SettingsPage({ adminData, selectedId, onSelect, reload, notify }) {
  const monitor = adminData.monitors.find((item) => item.id === selectedId) || adminData.monitors[0];
  async function create() {
    try { const created = await api.createMonitor({ name: `Codex 账号 ${adminData.monitors.length + 1}` }); await reload(); onSelect(created.id); notify("success", "已创建监控任务"); }
    catch (error) { notify("error", error.message); }
  }
  return <div className="page wide">
    <div className="settings-layout">
      <aside className="settings-nav">
        <div className="settings-nav-head"><span>监控任务</span><button className="icon-button ghost small" onClick={create} title="添加任务" aria-label="添加任务"><Plus size={16} /></button></div>
        <div className="settings-nav-list">
          {adminData.monitors.map((item) => {
            const state = monitorState(item);
            return <button key={item.id} className={monitor?.id === item.id ? "active" : ""} onClick={() => onSelect(item.id)}>
              <span className={`dot dot-${state.tone}`} />
              <span className="settings-nav-text"><strong>{item.name}</strong><small>#{item.sourceAccountId || "未配置"} · {state.label}</small></span>
            </button>;
          })}
        </div>
      </aside>
      <div className="settings-main">
        {monitor
          ? <MonitorForm monitor={monitor} onSaved={async () => reload()} onDeleted={async () => { await reload(); onSelect(null); }} notify={notify} />
          : <div className="card"><EmptyState icon={ServerCog} title="暂无监控任务" hint="添加一个 Codex OAuth 账号开始监控" action={<button className="button primary" onClick={create}><Plus size={15} />添加任务</button>} /></div>}
        <TwoFactorSettings notify={notify} />
      </div>
    </div>
  </div>;
}

/* ---------- event drawer ---------- */

function EventDrawer({ event, onClose, now }) {
  useEffect(() => {
    if (!event) return undefined;
    const onKey = (keyEvent) => { if (keyEvent.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [event, onClose]);
  if (!event) return null;
  const summary = actionCounts(event);
  const status = eventState(event.status);
  return <div className="overlay drawer-overlay" onMouseDown={onClose}>
    <aside className="drawer" role="dialog" aria-modal="true" aria-label="重置事件详情" onMouseDown={(e) => e.stopPropagation()}>
      <div className="drawer-head">
        <div><h2>{event.monitorName || "监控任务"}</h2><p>源账号 #{event.sourceAccountId} · <span className="mono-tag">{event.window}</span></p></div>
        <button className="icon-button ghost" onClick={onClose} aria-label="关闭"><X size={18} /></button>
      </div>
      <div className="drawer-status"><Chip tone={status.tone}>{status.label}</Chip>{event.dryRun && <Chip tone="muted" dot={false}>预览</Chip>}<time title={formatDate(event.confirmedAt, true)}>{formatDate(event.confirmedAt, true)} · {formatRelative(event.confirmedAt, now)}</time></div>
      <div className="delta">
        <div><span>旧周期</span><strong>{percent(event.baseline?.usedPercent)}</strong><small>重置于 {formatDate(event.baseline?.resetAt)}</small></div>
        <ArrowRight size={18} />
        <div><span>新周期</span><strong>{percent(event.resetSnapshot?.usedPercent)}</strong><small>重置于 {formatDate(event.resetSnapshot?.resetAt)}</small></div>
      </div>
      <dl className="kv-grid three">
        <div><dt>动作总数</dt><dd>{summary.total}</dd></div>
        <div><dt>已完成</dt><dd>{summary.completed}</dd></div>
        <div><dt>失败</dt><dd className={summary.failed ? "text-danger" : ""}>{summary.failed}</dd></div>
      </dl>
      {event.completedAt && <p className="footnote">完成于 {formatDate(event.completedAt, true)}</p>}
    </aside>
  </div>;
}

/* ---------- shell ---------- */

function AppShell({ publicData, adminData, authenticated, initialPage, onRequireAdmin, onLogout, reloadAdmin, theme, onThemeChange }) {
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
  useEffect(() => { window.scrollTo({ top: 0 }); }, [page]);
  const notify = useCallback((kind, message) => { setToast({ kind, message }); clearTimeout(timer.current); timer.current = setTimeout(() => setToast(null), 5000); }, []);
  const closeEvent = useCallback(() => setSelectedEvent(null), []);
  function navigate(item) { if (item.admin && !authenticated) onRequireAdmin(item.id); else setPage(item.id); }
  const items = NAVIGATION.filter((item) => authenticated || !item.admin);

  return <div className="app">
    <header className="topbar">
      <div className="topbar-inner">
        <button className="brand" onClick={() => setPage("overview")}><span className="brand-glyph"><Activity size={15} /></span><span>SubMonitor</span></button>
        <nav className="nav-tabs" aria-label="主导航">
          {items.map((item) => <button key={item.id} className={page === item.id ? "active" : ""} onClick={() => navigate(item)}>{item.label}</button>)}
        </nav>
        <div className="topbar-actions">
          <span className={`health ${unhealthyCount ? "bad" : ""}`} title={`更新于 ${formatDate(publicData.generatedAt, true)}`}><i />{unhealthyCount ? `${unhealthyCount} 个异常` : "运行正常"}</span>
          <ThemeSelector value={theme} onChange={onThemeChange} />
          {authenticated
            ? <button className="icon-button ghost" onClick={onLogout} title="退出后台" aria-label="退出后台"><LogOut size={16} /></button>
            : <button className="button secondary small" onClick={() => onRequireAdmin("settings")}><KeyRound size={14} /><span className="hide-mobile">后台登录</span></button>}
        </div>
      </div>
    </header>

    <main className="content">
      {page === "overview" && <Overview data={publicData} selectedId={selectedMonitorId} onSelectMonitor={setSelectedMonitorId} onSelectEvent={setSelectedEvent} onShowEvents={() => setPage("events")} now={now} onAdmin={() => authenticated ? setPage("settings") : onRequireAdmin("settings")} />}
      {page === "events" && <EventsPage events={publicData.events} onSelect={setSelectedEvent} now={now} />}
      {page === "audit" && adminData && <AuditPage entries={adminData.audit} now={now} />}
      {page === "settings" && adminData && <SettingsPage adminData={adminData} selectedId={selectedAdminId} onSelect={setSelectedAdminId} reload={reloadAdmin} notify={notify} />}
    </main>

    <nav className="tabbar" aria-label="底部导航">
      {items.map((item) => { const Icon = item.icon; return <button key={item.id} className={page === item.id ? "active" : ""} onClick={() => navigate(item)}><Icon size={19} /><span>{item.label}</span></button>; })}
    </nav>

    <EventDrawer event={selectedEvent} onClose={closeEvent} now={now} />
    <Toast toast={toast} onClose={() => setToast(null)} />
  </div>;
}

export default function App() {
  const [publicData, setPublicData] = useState(null);
  const [adminData, setAdminData] = useState(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [pendingPage, setPendingPage] = useState("settings");
  const [theme, setTheme] = useState(readThemePreference);
  const refreshTimer = useRef(null);

  useEffect(() => {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return undefined;
    const update = () => { if (theme === "system") applyTheme("system"); };
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, [theme]);

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
    ["runtime", "snapshot", "event", "audit", "config", "quota-sharing"].forEach((type) => stream.addEventListener(type, refresh));
    return () => stream.close();
  }, [authenticated, loadAdmin, loadPublic]);

  function requireAdmin(page) { setPendingPage(page); setLoginOpen(true); }
  async function loggedIn() { setAuthenticated(true); await Promise.all([loadAdmin(), loadPublic()]); setLoginOpen(false); }
  async function logout() { await api.logout().catch(() => {}); setAuthenticated(false); setAdminData(null); }

  if (!publicData) return <div className="app-loading"><span className="brand-glyph large"><Activity size={20} /></span><span>SubMonitor</span></div>;
  return <><AppShell key={`${authenticated}-${pendingPage}`} publicData={publicData} adminData={adminData} authenticated={authenticated} initialPage={authenticated ? pendingPage : "overview"} onRequireAdmin={requireAdmin} onLogout={logout} reloadAdmin={loadAdmin} theme={theme} onThemeChange={setTheme} /><LoginDialog open={loginOpen} onClose={() => setLoginOpen(false)} onAuthenticated={loggedIn} /></>;
}
