import { useMemo, useState } from "react";
import { ArrowRight } from "lucide-react";
import { dateTime, dayKey, dayLabel, friendlyTime, percent, relative, windowLabel, clock } from "./format.js";
import { describeEvent, eventSummary } from "./status.js";
import { EventLine } from "./now.jsx";
import { Dot, Empty, Segmented, Sheet, Toggle } from "./ui.jsx";

function groupByDay(items, getTime, now) {
  const groups = [];
  for (const item of items) {
    const key = dayKey(getTime(item));
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item);
    else groups.push({ key, label: dayLabel(getTime(item), now), items: [item] });
  }
  return groups;
}

export function RecordsView({ events, monitors, now, onOpenEvent }) {
  const [showNoise, setShowNoise] = useState(false);
  const [account, setAccount] = useState("all");
  const [limit, setLimit] = useState(20);
  const noiseCount = events.filter((event) => describeEvent(event).noise).length;
  const filtered = useMemo(() => events.filter((event) => (showNoise || !describeEvent(event).noise) && (account === "all" || event.monitorId === account)), [events, showNoise, account]);
  const groups = useMemo(() => groupByDay(filtered.slice(0, limit), (event) => event.confirmedAt, now), [filtered, limit, now]);
  const accountOptions = [{ value: "all", label: "全部" }, ...monitors.map((monitor) => ({ value: monitor.id, label: monitor.name }))];

  return <div className="view">
    <header className="view-head">
      <p className="eyebrow">记录</p>
      <h1 className="headline">{filtered.length ? `${filtered.length} 次重置` : "暂无记录"}</h1>
    </header>
    <div className="filters">
      {monitors.length > 1 && <Segmented label="按账号筛选" options={accountOptions} value={account} onChange={(value) => { setAccount(value); setLimit(40); }} size="sm" />}
      {noiseCount > 0 && <Toggle checked={showNoise} onChange={setShowNoise} label="显示预览与已取消" hint={`${noiseCount} 条`} />}
    </div>
    {!groups.length
      ? <Empty title="这里还没有内容" hint="检测到周期重置后，会在这里按时间排列。" />
      : groups.map((group) => <section key={group.key || group.label} className="day">
        <h2 className="section-title">{group.label}</h2>
        <ul className="event-list">{group.items.map((event) => <EventLine key={event.id} event={event} onOpen={onOpenEvent} now={now} />)}</ul>
      </section>)}
    {filtered.length > limit && <button type="button" className="btn btn-quiet more-btn" onClick={() => setLimit((current) => current + 30)}>再显示 {Math.min(30, filtered.length - limit)} 条</button>}
  </div>;
}

const ACTION_TEXT = { success: "完成", preview: "预览", skipped: "已跳过", failed: "失败", pending: "等待", in_progress: "进行中" };
const ACTION_TONE = { success: "ok", preview: "muted", skipped: "muted", failed: "bad", pending: "warn", in_progress: "warn" };

function ActionList({ event }) {
  const rows = [];
  if (event.actions?.sourceRecovery) rows.push(["恢复源账号", event.actions.sourceRecovery]);
  for (const [id, action] of Object.entries(event.actions?.targetAccounts || {})) rows.push([`恢复账号 #${id}`, action]);
  for (const [key, action] of Object.entries(event.actions?.subscriptions || {})) rows.push([`重置订阅 #${key}${action.groupId ? ` · 分组 ${action.groupId}` : ""}`, action]);
  if (!rows.length) return null;
  return <section className="sheet-section">
    <h3 className="section-title">动作</h3>
    <ul className="actions">{rows.map(([label, action]) => <li key={label}>
      <span>{label}</span>
      <span className={`tone-${ACTION_TONE[action.status] || "muted"}`}>{ACTION_TEXT[action.status] || action.status}</span>
      {(action.error || action.skipReason) && <p className="note">{action.error || action.skipReason}</p>}
    </li>)}</ul>
  </section>;
}

export function EventSheet({ event, onClose, now }) {
  if (!event) return null;
  const description = describeEvent(event);
  const summary = eventSummary(event);
  return <Sheet open onClose={onClose} title={event.monitorName || "监控任务"} subtitle={`${friendlyTime(event.confirmedAt, now)} · ${relative(event.confirmedAt, now)}`}>
    <p className={`status-title tone-${description.tone}`}><Dot tone={description.tone} />{description.text}</p>
    <div className="delta">
      <div><span>重置前</span><strong>{percent(event.baseline?.usedPercent)}</strong></div>
      <ArrowRight size={18} aria-hidden="true" />
      <div><span>重置后</span><strong>{percent(event.resetSnapshot?.usedPercent)}</strong></div>
    </div>
    <dl className="facts">
      <div className="fact"><dt>窗口</dt><dd>{windowLabel(event.window)}</dd></div>
      <div className="fact"><dt>原定重置</dt><dd>{dateTime(event.baseline?.resetAt)}</dd></div>
      <div className="fact"><dt>新周期重置</dt><dd>{dateTime(event.resetSnapshot?.resetAt)}</dd></div>
      <div className="fact"><dt>动作</dt><dd>{summary.completed} / {summary.total} 完成{summary.failed ? ` · ${summary.failed} 失败` : ""}</dd></div>
      <div className="fact"><dt>确认于</dt><dd>{dateTime(event.confirmedAt, true)}</dd></div>
      {event.completedAt && <div className="fact"><dt>完成于</dt><dd>{clock(event.completedAt, true)}</dd></div>}
      <div className="fact"><dt>源账号</dt><dd>#{event.sourceAccountId}</dd></div>
    </dl>
    <ActionList event={event} />
  </Sheet>;
}

const LEVEL = { error: "bad", warn: "warn" };

export function AuditView({ entries, now }) {
  const [onlyIssues, setOnlyIssues] = useState(false);
  const list = (entries || []).filter((entry) => !onlyIssues || entry.level === "error" || entry.level === "warn");
  const groups = groupByDay(list, (entry) => entry.createdAt, now);
  return <div className="view">
    <header className="view-head">
      <p className="eyebrow">审计</p>
      <h1 className="headline">操作日志</h1>
    </header>
    <div className="filters"><Toggle checked={onlyIssues} onChange={setOnlyIssues} label="只看警告和错误" /></div>
    {!groups.length ? <Empty title="没有记录" /> : groups.map((group) => <section key={group.key} className="day">
      <h2 className="section-title">{group.label}</h2>
      <ul className="audit">{group.items.map((entry) => <li key={entry.id} className={LEVEL[entry.level] ? `tone-${LEVEL[entry.level]}` : ""}>
        <time title={dateTime(entry.createdAt, true)}>{clock(entry.createdAt)}</time>
        <span className="audit-msg">{LEVEL[entry.level] && <Dot tone={LEVEL[entry.level]} />}{entry.message}</span>
        <span className="audit-code">{entry.action}</span>
      </li>)}</ul>
    </section>)}
  </div>;
}
