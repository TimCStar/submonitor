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

export function buildUsageAlertTitle(monitorName) {
  return `Codex 额度触顶预警 · ${monitorName}`;
}

export function buildUsageAlertText({ monitorName, selector, usedPercent, threshold, resetAt }) {
  return [
    `监控：${monitorName}`,
    `窗口：${selector}`,
    `使用率：${usedPercent ?? "?"}%（达到阈值 ${threshold}%）`,
    `重置：${formatTime(resetAt)}`,
  ].join("\n");
}

export function buildExhaustedTitle(monitorName) {
  return `Codex 额度已耗尽 · ${monitorName}`;
}

export function buildExhaustedText({ monitorName, selector, usedPercent, resetAt }) {
  return [
    `监控：${monitorName}`,
    `窗口：${selector}`,
    `使用率：${usedPercent ?? "?"}%（额度已耗尽）`,
    `重置：${formatTime(resetAt)}`,
  ].join("\n");
}

export function buildActionFailureTitle(monitorName) {
  return `Codex 重置动作失败 · ${monitorName}`;
}

export function buildActionFailureText({ monitorName, eventId, action, error }) {
  return [
    `监控：${monitorName}`,
    `事件：${eventId}`,
    `动作：${action}`,
    `错误：${error}`,
  ].join("\n");
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
  if (Number(result.code) !== 200) throw new Error(`Bark API rejected the push: ${result.message || "unknown error"}`);
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

  async function dispatch(config, title, text) {
    const results = [];
    if (config.notifyTelegramEnabled && isChannelConfigured(config, "telegram")) {
      results.push(await attempt("telegram", () => sendTelegram(
        { botToken: config.telegramBotToken, chatId: config.telegramChatId },
        text,
        { fetchImpl },
      )));
    }
    if (config.notifyBarkEnabled && isChannelConfigured(config, "bark")) {
      results.push(await attempt("bark", () => sendBark(
        { server: config.barkServer, key: config.barkKey },
        title,
        text,
        { fetchImpl },
      )));
    }
    if (config.notifyEmailEnabled && isChannelConfigured(config, "email")) {
      results.push(await attempt("email", () => sendEmail(config, title, text)));
    }
    return results;
  }

  return {
    async notifyReset(config, event) {
      if (!config.notifyEnabled) return [];
      return dispatch(config, buildResetTitle(event), buildResetText(event));
    },

    async notifyUsageAlert(config, data) {
      if (!config.notifyEnabled) return [];
      const exhausted = data.kind === "exhausted";
      const title = exhausted ? buildExhaustedTitle(data.monitorName) : buildUsageAlertTitle(data.monitorName);
      const text = exhausted ? buildExhaustedText(data) : buildUsageAlertText(data);
      return dispatch(config, title, text);
    },

    async notifyActionFailure(config, data) {
      if (!config.notifyEnabled) return [];
      return dispatch(config, buildActionFailureTitle(data.monitorName), buildActionFailureText(data));
    },

    async testChannel(config, channel) {
      if (!config.notifyEnabled) throw new Error("请先启用重置提醒");
      const message = "SubMonitor 测试消息：通知配置正常";
      if (channel === "telegram") {
        if (!config.notifyTelegramEnabled || !isChannelConfigured(config, "telegram")) {
          throw new Error("请先启用并配置 Telegram 通知");
        }
        await sendTelegram({ botToken: config.telegramBotToken, chatId: config.telegramChatId }, message, { fetchImpl });
      } else if (channel === "bark") {
        if (!config.notifyBarkEnabled || !isChannelConfigured(config, "bark")) {
          throw new Error("请先启用并配置 Bark 通知");
        }
        await sendBark({ server: config.barkServer, key: config.barkKey }, "SubMonitor 测试", message, { fetchImpl });
      } else if (channel === "email") {
        if (!config.notifyEmailEnabled || !isChannelConfigured(config, "email")) {
          throw new Error("请先启用并配置邮件通知");
        }
        await sendEmail(config, "SubMonitor 测试", message);
      } else {
        throw new Error(`未知通知渠道：${channel}`);
      }
    },
  };
}
