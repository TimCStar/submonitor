import { latestBySelector, percent, relative, toDate } from "./format.js";

export const JUST_RESET_MS = 6 * 3600 * 1000;

export function eventSummary(event) {
  if (event.actionSummary) return event.actionSummary;
  const actions = [event.actions?.sourceRecovery, ...Object.values(event.actions?.targetAccounts || {}), ...Object.values(event.actions?.subscriptions || {})].filter(Boolean);
  return {
    total: actions.length,
    completed: actions.filter((action) => ["success", "preview", "skipped"].includes(action.status)).length,
    failed: actions.filter((action) => action.status === "failed").length,
    running: actions.filter((action) => ["pending", "in_progress"].includes(action.status)).length,
  };
}

/** One plain-language description of an event. tone: ok | warn | bad | muted | busy */
export function describeEvent(event) {
  const summary = eventSummary(event);
  if (event.status === "cancelled") return { tone: "muted", text: "已取消", noise: true };
  if (event.status === "preview" || (event.dryRun && event.status === "complete")) return { tone: "muted", text: "检测到重置 · 预览模式未执行", noise: true };
  if (event.status === "pending" || event.status === "in_progress" || summary.running) return { tone: "busy", text: "正在执行重置动作" };
  if (summary.failed) return { tone: "bad", text: `已重置 · ${summary.failed} 项动作失败` };
  if (event.status === "complete") return { tone: "ok", text: "已重置" };
  if (event.status === "failed") return { tone: "bad", text: "重置失败" };
  return { tone: "muted", text: event.status || "未知" };
}

export function primarySnapshot(monitor) {
  const latest = latestBySelector(monitor.snapshots);
  const windows = monitor.monitorWindows || [];
  const primary = latest[windows[0]] || Object.values(latest)[0] || null;
  return { latest, primary, windows };
}

/**
 * The single answer for an account. kind: normal | pending | resetting | reset | warn | error | paused | waiting
 */
export function accountState(monitor, events, now, adminMonitor) {
  const runtime = monitor.runtime || {};
  const { primary } = primarySnapshot(monitor);
  const mine = events.filter((event) => event.monitorId === monitor.id && event.status !== "cancelled");
  const latestEvent = mine[0];
  const pendingEntry = Object.entries(monitor.candidates || {}).find(([, value]) => value);

  if (!monitor.enabled) return { kind: "paused", tone: "muted", title: "已暂停", hint: "在设置里重新启用后恢复检查。" };
  if (runtime.hasError || runtime.status === "error" || runtime.lastError) {
    return {
      kind: "error", tone: "bad", title: "最近一次检查失败",
      hint: "服务会自动重试。如果持续出现，请在设置里点“测试连接”检查 Sub2API 地址和凭据。",
      detail: adminMonitor?.runtime?.lastError || runtime.lastError || null,
    };
  }
  if (pendingEntry) {
    const [, candidate] = pendingEntry;
    const required = Number(monitor.confirmationsRequired) || 1;
    const done = Math.min(required, Number(candidate.confirmations) || 0);
    const nextAt = runtime.nextPollAt ? new Date(runtime.nextPollAt).getTime() : null;
    const next = runtime.running ? "正在复查" : nextAt && nextAt > now ? `${relative(runtime.nextPollAt, now)}复查` : "马上复查";
    return { kind: "pending", tone: "warn", title: "检测到疑似重置，正在确认…", hint: `已确认 ${done}/${required} 次 · ${next}。确认后自动执行。` };
  }
  if (latestEvent && (latestEvent.status === "pending" || latestEvent.status === "in_progress" || eventSummary(latestEvent).running)) {
    return { kind: "resetting", tone: "warn", title: "正在执行重置动作…", hint: "通常几秒内完成。" };
  }
  if (latestEvent) {
    const at = toDate(latestEvent.confirmedAt)?.getTime() || 0;
    const summary = eventSummary(latestEvent);
    if (now - at < 24 * 3600 * 1000 && summary.failed) {
      return { kind: "warn", tone: "bad", title: `上次重置有 ${summary.failed} 项动作失败`, hint: "打开“记录”查看是哪一项；服务不会自动重试已失败的动作。", event: latestEvent };
    }
    if (now - at < JUST_RESET_MS && !latestEvent.dryRun && latestEvent.status === "complete") {
      return { kind: "reset", tone: "accent", title: "刚刚完成重置", hint: `${relative(latestEvent.confirmedAt, now)} · ${summary.total ? `${summary.total} 项动作全部完成` : "额度已回到新周期"}`, event: latestEvent };
    }
  }
  if (!primary) return { kind: "waiting", tone: "muted", title: "等待首次检查", hint: "第一次读取额度后显示重置时间。" };
  if (primary.limitReached || primary.allowed === false) return { kind: "warn", tone: "warn", title: "额度已用完，等待重置", hint: "上游暂时限制了这个账号。" };
  if (Number(primary.usedPercent) >= 90) return { kind: "warn", tone: "warn", title: `额度已用 ${percent(primary.usedPercent)}`, hint: "接近上限，留意用量。" };
  return { kind: "normal", tone: "ok", title: "一切正常", hint: null };
}

export function overallSentence(states) {
  if (!states.length) return { tone: "muted", text: "还没有监控任何账号" };
  const bad = states.filter((state) => ["error", "warn"].includes(state.kind)).length;
  const pending = states.filter((state) => ["pending", "resetting"].includes(state.kind)).length;
  const reset = states.filter((state) => state.kind === "reset").length;
  if (bad) return { tone: "bad", text: `${bad} 个账号需要留意` };
  if (pending) return { tone: "warn", text: "正在确认一次重置" };
  if (reset) return { tone: "accent", text: "刚刚完成了一次重置" };
  return { tone: "ok", text: "一切正常" };
}

export function resetsWithin(events, monitorId, now, days = 7) {
  const since = now - days * 86400000;
  return events.filter((event) => event.monitorId === monitorId && event.status === "complete" && !event.dryRun && (toDate(event.confirmedAt)?.getTime() || 0) >= since).length;
}
