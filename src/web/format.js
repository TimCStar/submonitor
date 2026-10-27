export const TIME_ZONE = "Asia/Shanghai";

export function toDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = typeof value === "number" ? new Date(value > 1e11 ? value : value * 1000) : value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const fmtCache = new Map();
function fmt(options) {
  const key = JSON.stringify(options);
  if (!fmtCache.has(key)) fmtCache.set(key, new Intl.DateTimeFormat("zh-CN", { timeZone: TIME_ZONE, hour12: false, ...options }));
  return fmtCache.get(key);
}

export function clock(value, seconds = false) {
  const date = toDate(value);
  return date ? fmt({ hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) }).format(date) : "--";
}

export function dateTime(value, seconds = false) {
  const date = toDate(value);
  if (!date) return "--";
  return `${fmt({ month: "numeric", day: "numeric" }).format(date)} ${clock(date, seconds)}`;
}

export function dayKey(value) {
  const date = toDate(value);
  return date ? new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(date) : "";
}

export function dayLabel(value, now = Date.now()) {
  const key = dayKey(value);
  if (!key) return "未知日期";
  if (key === dayKey(new Date(now))) return "今天";
  if (key === dayKey(new Date(now - 86400000))) return "昨天";
  if (key === dayKey(new Date(now + 86400000))) return "明天";
  return fmt({ month: "long", day: "numeric", weekday: "short" }).format(toDate(value));
}

/** "今天 14:20" / "明天 09:00" / "11月2日 周一 14:20" */
export function friendlyTime(value, now = Date.now()) {
  const date = toDate(value);
  if (!date) return "--";
  return `${dayLabel(date, now)} ${clock(date)}`;
}

export function relative(value, now = Date.now()) {
  const date = toDate(value);
  if (!date) return "--";
  const diff = Math.round((now - date.getTime()) / 1000);
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? "前" : "后";
  if (abs < 45) return diff >= 0 ? "刚刚" : "马上";
  if (abs < 3600) return `${Math.max(1, Math.round(abs / 60))} 分钟${suffix}`;
  if (abs < 86400) return `${Math.round(abs / 3600)} 小时${suffix}`;
  if (abs < 86400 * 30) return `${Math.round(abs / 86400)} 天${suffix}`;
  return dateTime(value);
}

export function countdownParts(value, now = Date.now()) {
  const date = toDate(value);
  if (!date) return null;
  const total = Math.max(0, Math.floor((date.getTime() - now) / 1000));
  return {
    total,
    days: Math.floor(total / 86400),
    hours: Math.floor((total % 86400) / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
  };
}

export function shortDuration(value, now = Date.now()) {
  const parts = countdownParts(value, now);
  if (!parts) return "--";
  if (parts.days) return `${parts.days} 天 ${parts.hours} 小时`;
  if (parts.hours) return `${parts.hours} 小时 ${parts.minutes} 分`;
  return `${Math.max(1, parts.minutes)} 分钟`;
}

export function seconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "--";
  if (n >= 3600 && n % 3600 === 0) return `${n / 3600} 小时`;
  if (n >= 60 && n % 60 === 0) return `${n / 60} 分钟`;
  if (n >= 60) return `${Math.round((n / 60) * 10) / 10} 分钟`;
  return `${n} 秒`;
}

export function percent(value) {
  const n = Number(value);
  if (value === null || value === undefined || !Number.isFinite(n)) return "--";
  return `${Number.isInteger(n) ? n : n.toFixed(1)}%`;
}

export function money(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value) : "--";
}

const WINDOW_TEXT = { "5h": "5 小时", "7d": "7 天", primary: "主窗口", secondary: "次窗口" };
export function windowLabel(selector) { return WINDOW_TEXT[selector] || selector || "--"; }

export function latestBySelector(snapshots) {
  const result = {};
  for (const snapshot of snapshots || []) result[snapshot.selector] ||= snapshot;
  return result;
}

/** "今天" / "昨天" / "10月26日" — compact, for list rows */
export function shortDay(value, now = Date.now()) {
  const label = dayLabel(value, now);
  if (["今天", "昨天", "明天", "未知日期"].includes(label)) return label;
  const date = toDate(value);
  return fmt({ month: "numeric", day: "numeric" }).format(date);
}
