const DEFAULT_BARK_SERVER = "https://api.day.app";
const TELEGRAM_API = "https://api.telegram.org";

function formatTime(epochSeconds) {
  if (!epochSeconds) return "未知";
  return new Date(epochSeconds * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export function buildResetTitle(event) {
  return `Codex 额度已重置 · ${event.monitorName}`;
}

export function buildResetText(event) {
  const lines = [
    `监控：${event.monitorName}`,
    `窗口：${event.window}`,
    `使用率：${event.baseline?.usedPercent ?? "?"}% → ${event.resetSnapshot?.usedPercent ?? "?"}%`,
    `周期：${formatTime(event.baseline?.resetAt)} → ${formatTime(event.resetSnapshot?.resetAt)}`,
    `模式：${event.dryRun ? "预览（未执行写操作）" : "自动执行"}`,
    `确认时间：${event.confirmedAt || "刚刚"}`,
  ];
  return lines.join("\n");
}

export async function sendTelegram({ botToken, chatId }, text, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!response.ok) throw new Error(`Telegram API returned HTTP ${response.status}`);
  const body = await response.json().catch(() => ({}));
  if (body.ok !== true) throw new Error(`Telegram API rejected the message: ${body.description || "unknown error"}`);
}

export async function sendBark({ server, key }, title, body, { fetchImpl = fetch } = {}) {
  const baseUrl = (server || DEFAULT_BARK_SERVER).replace(/\/+$/, "");
  const response = await fetchImpl(`${baseUrl}/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, body, device_key: key, group: "SubMonitor" }),
  });
  if (!response.ok) throw new Error(`Bark API returned HTTP ${response.status}`);
  const result = await response.json().catch(() => ({}));
  if (result.code !== 200) throw new Error(`Bark API rejected the push: ${result.message || "unknown error"}`);
}

export async function sendEmail(config, subject, text, { transport } = {}) {
  const mailer = transport || (await import("nodemailer")).createTransport({
    host: config.emailSmtpHost,
    port: config.emailSmtpPort,
    secure: config.emailSmtpPort === 465,
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 20000,
    auth: config.emailSmtpUser ? { user: config.emailSmtpUser, pass: config.emailSmtpPass } : undefined,
  });
  try {
    await mailer.sendMail({
      from: config.emailFrom,
      to: config.emailTo,
      subject,
      text,
    });
  } finally {
    if (!transport && mailer.close) mailer.close();
  }
}

function isChannelConfigured(config, channel) {
  if (channel === "telegram") return Boolean(config.telegramBotToken && config.telegramChatId);
  if (channel === "bark") return Boolean(config.barkKey);
  if (channel === "email") return Boolean(config.emailSmtpHost && config.emailTo);
  return false;
}

export function createNotifier({ fetchImpl = fetch } = {}) {
  async function attempt(channel, request) {
    try {
      await request();
      return { channel, ok: true, error: null };
    } catch (error) {
      return { channel, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    async notifyReset(config, event) {
      if (!config.notifyEnabled) return [];
      const title = buildResetTitle(event);
      const text = buildResetText(event);
      const results = [];
      if (config.notifyTelegramEnabled && isChannelConfigured(config, "telegram")) {
        results.push(await attempt("telegram", () => sendTelegram(config, text, { fetchImpl })));
      }
      if (config.notifyBarkEnabled && isChannelConfigured(config, "bark")) {
        results.push(await attempt("bark", () => sendBark(config, title, text, { fetchImpl })));
      }
      if (config.notifyEmailEnabled && isChannelConfigured(config, "email")) {
        results.push(await attempt("email", () => sendEmail(config, title, text)));
      }
      return results;
    },
  };
}
