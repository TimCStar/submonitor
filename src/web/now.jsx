import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { api } from "./api.js";
import { countdownParts, dayLabel, shortDay, friendlyTime, money, percent, relative, windowLabel, clock, toDate } from "./format.js";
import { accountInitial, accountSlot, accountState, describeEvent, overallSentence, primarySnapshot, resetsWithin } from "./status.js";
import { Dot, Empty, Sheet, Skeleton, Spinner } from "./ui.jsx";

export function useTicker(interval = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), interval); return () => clearInterval(id); }, [interval]);
  return now;
}

const pad = (value) => String(value).padStart(2, "0");

function Countdown({ resetAt, muted }) {
  const now = useTicker(1000);
  const parts = countdownParts(resetAt, now);
  if (!parts) return <span className="countdown is-empty" aria-label="尚未读取到重置时间">—</span>;
  if (parts.total === 0) return <span className="countdown">即将重置</span>;
  const label = `${parts.days ? `${parts.days} 天 ` : ""}${parts.hours} 小时 ${parts.minutes} 分后重置`;
  return <span className={`countdown${muted ? " is-muted" : ""}`} role="timer" aria-label={label}>
    {parts.days > 0 && <><b>{parts.days}</b><i>天</i></>}
    <b>{parts.days ? pad(parts.hours) : parts.hours}</b><i>时</i>
    <b>{pad(parts.minutes)}</b><i>分</i>
    {!parts.days && <><b className="sec">{pad(parts.seconds)}</b><i>秒</i></>}
  </span>;
}

function UsageTick({ value }) {
  const width = Math.max(0, Math.min(100, Number(value) || 0));
  const tone = width >= 90 ? "bad" : width >= 75 ? "warn" : "ok";
  return <span className={`tick tick-${tone}`} aria-hidden="true"><span style={{ width: `${width}%` }} /></span>;
}

export function AccountMark({ monitor, size = "md" }) {
  return <span className={`mark mark-${size} slot-${accountSlot(monitor?.id ?? monitor?.name)}`} aria-hidden="true">{accountInitial(monitor?.name)}</span>;
}

function Stat({ label, children, sub, tone }) {
  return <div className={`stat${tone ? ` stat-${tone}` : ""}`}><dt>{label}</dt><dd>{children}{sub && <small>{sub}</small>}</dd></div>;
}

function Account({ monitor, events, adminMonitor, now, onOpen, index }) {
  const state = accountState(monitor, events, now, adminMonitor);
  const { primary, windows } = primarySnapshot(monitor);
  const recent = resetsWithin(events, monitor.id, now);
  const runtime = monitor.runtime || {};
  const used = primary ? Number(primary.usedPercent) : null;
  const usedTone = used >= 90 ? "bad" : used >= 75 ? "warn" : null;
  const conc = monitor.concurrency;
  const concFull = conc && Number(conc.max) > 0 && Number(conc.current) >= Number(conc.max);
  const nextAt = runtime.nextPollAt ? toDate(runtime.nextPollAt)?.getTime() : null;
  const checked = runtime.running ? "正在检查" : `${relative(runtime.lastPollAt, now)}检查`;
  const next = nextAt ? (nextAt <= now ? "马上再查" : `下次 ${clock(runtime.nextPollAt)}`) : null;
  const windowName = primary ? windowLabel(primary.selector) : windows[0] ? windowLabel(windows[0]) : null;
  return <article className={`account state-${state.kind}`} style={{ "--i": index }}>
    <button type="button" className="account-head" onClick={onOpen} aria-label={`${monitor.name} 详情`}>
      <AccountMark monitor={monitor} />
      <span className="account-id">
        <span className="account-name">{monitor.name}</span>
        <span className="account-sub">源账号 #{monitor.sourceAccountId || "--"}{windowName ? ` · ${windowName}窗口` : ""}{monitor.dryRun ? " · 预览模式" : ""}</span>
      </span>
      <ChevronRight className="account-chevron" size={18} aria-hidden="true" />
    </button>

    <div className="reset-line">
      <span className="reset-label">距重置</span>
      <Countdown resetAt={primary?.resetAt} muted={["pending", "resetting", "error", "paused"].includes(state.kind)} />
      <span className="when">{primary ? `${friendlyTime(primary.resetAt, now)}` : "尚未读取到额度"}</span>
    </div>

    <dl className="stats">
      <Stat label="已用" tone={usedTone}>{primary ? percent(primary.usedPercent) : "--"}{primary && <UsageTick value={primary.usedPercent} />}</Stat>
      <Stat label="并发" tone={concFull ? "warn" : null}>{conc ? <>{conc.current}<span className="of"> / {conc.max}</span></> : "--"}</Stat>
      <Stat label="近 7 天">{recent}<span className="of"> 次重置</span></Stat>
    </dl>

    <div className={`status status-${state.tone}`} role="status">
      <p className="status-title"><Dot tone={state.tone} pulse={["pending", "resetting"].includes(state.kind)} /><span>{state.title}</span>{state.kind === "normal" && <span className="status-check">{checked}{next ? ` · ${next}` : ""}</span>}</p>
      {state.hint && <p className="status-hint">{state.hint}</p>}
      {state.kind !== "normal" && <p className="status-hint check-line">{checked}{next ? ` · ${next}` : ""}</p>}
      {state.detail && <p className="status-detail">{state.detail}</p>}
    </div>
  </article>;
}

export function EventLine({ event, onOpen, now, showDay = false }) {
  const description = describeEvent(event);
  return <li>
    <button type="button" className="event-line" onClick={() => onOpen(event)}>
      <time dateTime={event.confirmedAt} className={showDay ? "with-day" : undefined}>{showDay ? `${shortDay(event.confirmedAt, now)} ` : ""}{clock(event.confirmedAt)}</time>
      <span className="event-name"><i className={`acct-dot slot-${accountSlot(event.monitorId ?? event.monitorName)}`} aria-hidden="true" />{event.monitorName || "监控任务"}</span>
      <span className={`event-what tone-${description.tone}`}>
        {description.tone !== "ok" && <Dot tone={description.tone} />}{description.text}
      </span>
      <ChevronRight className="event-chevron" size={15} aria-hidden="true" />
    </button>
  </li>;
}

export function NowView({ data, adminData, now, onOpenEvent, onShowRecords, onAdmin }) {
  const [openId, setOpenId] = useState(null);
  const adminById = useMemo(() => Object.fromEntries((adminData?.monitors || []).map((monitor) => [monitor.id, monitor])), [adminData]);
  const states = data.monitors.map((monitor) => accountState(monitor, data.events, now, adminById[monitor.id]));
  const overall = overallSentence(states);
  const recent = data.events.filter((event) => !describeEvent(event).noise).slice(0, 4);
  const opened = data.monitors.find((monitor) => monitor.id === openId);

  return <div className="view view-now">
    <header className="view-head">
      <p className="eyebrow">{new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "long", day: "numeric", weekday: "long" }).format(now)} · 北京时间 {clock(now)}</p>
      <h1 className={`headline tone-${overall.tone}`}>{overall.text}<span className="period">。</span></h1>
    </header>

    {!data.monitors.length
      ? <Empty title="还没有正在监控的账号" hint="登录后台，在设置里添加一个 Codex 账号。"><button type="button" className="btn btn-primary" onClick={onAdmin}>前往设置</button></Empty>
      : <div className="accounts">{data.monitors.map((monitor, index) => <Account key={monitor.id} index={index} monitor={monitor} events={data.events} adminMonitor={adminById[monitor.id]} now={now} onOpen={() => setOpenId(monitor.id)} />)}</div>}

    {recent.length > 0 && <section className="recent">
      <h2 className="section-title">最近</h2>
      <ul className="event-list">{recent.map((event) => <EventLine key={event.id} event={event} onOpen={onOpenEvent} now={now} showDay />)}</ul>
      <button type="button" className="link more" onClick={onShowRecords}>全部记录<ChevronRight size={14} /></button>
    </section>}

    <AccountSheet monitor={opened} adminMonitor={opened && adminById[opened.id]} events={data.events} now={now} onClose={() => setOpenId(null)} />
  </div>;
}

function Fact({ label, children }) {
  return <div className="fact"><dt>{label}</dt><dd>{children}</dd></div>;
}

function AccountSheet({ monitor, events, now, onClose }) {
  const close = useCallback(() => onClose(), [onClose]);
  if (!monitor) return <Sheet open={false} onClose={close} />;
  const { latest, windows } = primarySnapshot(monitor);
  const runtime = monitor.runtime || {};
  const pending = Object.entries(monitor.candidates || {}).filter(([, value]) => value);
  return <Sheet open onClose={close} title={monitor.name} subtitle={`源账号 #${monitor.sourceAccountId || "--"}${monitor.dryRun ? " · 预览模式，不会执行写操作" : ""}`}>
    <section className="sheet-section">
      <h3 className="section-title">额度</h3>
      <dl className="facts">
        {windows.map((selector) => {
          const snapshot = latest[selector];
          return <Fact key={selector} label={`${windowLabel(selector)}窗口`}>
            {snapshot ? <>已用 {percent(snapshot.usedPercent)} · {friendlyTime(snapshot.resetAt, now)} 重置{snapshot.allowed === false ? " · 已受限" : ""}</> : "尚未读取"}
          </Fact>;
        })}
        {pending.map(([selector, candidate]) => <Fact key={`p-${selector}`} label="正在确认">{windowLabel(selector)}窗口 · 已确认 {candidate.confirmations} 次 · {relative(candidate.firstConfirmedAt, now)}发现</Fact>)}
        {monitor.concurrency && <Fact label="当前并发">{monitor.concurrency.current} / {monitor.concurrency.max}</Fact>}
      </dl>
    </section>
    <section className="sheet-section">
      <h3 className="section-title">检查</h3>
      <dl className="facts">
        <Fact label="上次检查">{runtime.running ? "正在检查…" : `${friendlyTime(runtime.lastPollAt, now)} · ${relative(runtime.lastPollAt, now)}`}</Fact>
        <Fact label="下次检查">{runtime.nextPollAt ? (toDate(runtime.nextPollAt).getTime() <= now ? "马上" : `${clock(runtime.nextPollAt)} · ${relative(runtime.nextPollAt, now)}`) : "--"}</Fact>
        <Fact label="近 7 天">重置 {resetsWithin(events, monitor.id, now)} 次</Fact>
      </dl>
    </section>
    {monitor.quotaSharing && <QuotaEstimate quota={monitor.quotaSharing} now={now} />}
    {monitor.publicSubscriberPreviewEnabled !== false && monitor.subscriptionGroupMode !== "none" && <PublicSubscribers monitorId={monitor.id} />}
  </Sheet>;
}

const QUOTA_STATUS = { waiting: "等待采样", ready: "已估算", preview: "预览", applied: "已同步", unchanged: "无需调整", blocked: "未调整", error: "重算失败" };

export function QuotaEstimate({ quota, now, showError = false }) {
  const data = quota || { status: "waiting" };
  const proportional = data.mode === "proportional";
  const shares = Array.isArray(data.proportionalShares) ? data.proportionalShares : [];
  const minimum = data.proportionalMinLimitUsd ?? (shares.length ? Math.min(...shares.map((share) => share.recommendedLimitUsd)) : null);
  const maximum = data.proportionalMaxLimitUsd ?? (shares.length ? Math.max(...shares.map((share) => share.recommendedLimitUsd)) : null);
  return <section className="sheet-section">
    <h3 className="section-title">周额度估算 <span className="title-note">{proportional ? "按比例 · " : ""}{QUOTA_STATUS[data.status] || "等待采样"}{data.checkedAt ? ` · ${relative(data.checkedAt, now)}更新` : ""}</span></h3>
    {proportional
      ? <p className="big-figure">{minimum === null ? money(null) : minimum === maximum ? money(minimum) : `${money(minimum)}～${money(maximum)}`}<span>按比例建议每人每周</span></p>
      : <p className="big-figure">{money(data.recommendedWeeklyLimitUsd)}<span>建议每人每周</span></p>}
    <dl className="facts">
      <Fact label="当前每人上限">{money(data.currentWeeklyLimitUsd)}</Fact>
      <Fact label="订阅用户">{data.subscriberCount ?? "--"} 人</Fact>
      <Fact label="账号预估总额度">{money(data.estimatedTotalUsd)}</Fact>
      <Fact label="可分配">{money(data.distributableTotalUsd)}{typeof data.reservePercent === "number" ? ` · 预留 ${data.reservePercent}%` : ""}</Fact>
    </dl>
    <p className="note">{data.note || "按本周期使用率和费用估算，额度可能变化。"}</p>
    {showError && data.lastError && <p className="note text-bad">{data.lastError}</p>}
    {showError && proportional && shares.length > 0 && <ul className="subscribers">
      {shares.map((share) => <li key={share.userId}>
        <span className="sub-name">用户 #{share.userId}</span>
        <span className="sub-meta">权重 {share.weight} · 已用 {money(share.usedUsd)}</span>
        <span className="sub-usage">{money(share.recommendedLimitUsd)}</span>
      </li>)}
    </ul>}
  </section>;
}

export function SubscriberList({ data }) {
  if (!data?.subscribers?.length) return <p className="note">暂无有效订阅用户。</p>;
  return <ul className="subscribers">
    {data.subscribers.map((subscriber, index) => {
      const usage = Object.entries(subscriber.usage || {});
      const identity = subscriber.identity;
      return <li key={`${subscriber.groupId || "g"}-${index}`}>
        <span className="sub-name" title="已脱敏">{identity ? <>{identity.prefix}{identity.leading}{identity.obscured && <span className="masked">••••</span>}{identity.trailing}{identity.suffix}</> : "--"}</span>
        <span className="sub-meta">{subscriber.groupName || (subscriber.groupId ? `分组 #${subscriber.groupId}` : "订阅分组")} · {subscriber.expiresAt ? `${friendlyTime(subscriber.expiresAt)} 到期` : "长期"}</span>
        <span className="sub-usage">{usage.length ? usage.map(([window, metric]) => `${{ daily: "日", weekly: "周", monthly: "月" }[window] || window} ${Number.isFinite(metric.percentage) ? `${metric.percentage.toFixed(0)}%` : "--"}`).join(" · ") : "--"}</span>
      </li>;
    })}
    {data.truncated && <li className="note">仅显示前 {data.subscribers.length} 位</li>}
  </ul>;
}

function PublicSubscribers({ monitorId }) {
  const [state, setState] = useState({ loading: true, data: null, error: "" });
  useEffect(() => {
    let active = true;
    api.publicSubscribers(monitorId).then((data) => active && setState({ loading: false, data, error: "" }))
      .catch((error) => active && setState({ loading: false, data: null, error: error.message }));
    return () => { active = false; };
  }, [monitorId]);
  return <section className="sheet-section">
    <h3 className="section-title">订阅用户 {state.data && <span className="title-note">{state.data.total} 位 · {state.data.groupCount} 个分组</span>}</h3>
    {state.loading && <Skeleton lines={3} />}
    {state.error && <p className="note text-bad">{state.error}</p>}
    {state.data && <SubscriberList data={state.data} />}
  </section>;
}

export { Spinner };
