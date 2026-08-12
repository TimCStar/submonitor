import assert from "node:assert/strict";
import test from "node:test";
import {
  buildResetText,
  buildResetTitle,
  createNotifier,
  sendBark,
  sendEmail,
  sendTelegram,
} from "../src/server/notifier.js";

const event = {
  id: "m:12:7d:100",
  monitorId: "m",
  monitorName: "TEAM",
  window: "7d",
  baseline: { usedPercent: 72, resetAt: 1786422364 },
  resetSnapshot: { usedPercent: 0, resetAt: 1787027164 },
  dryRun: true,
  confirmedAt: "2026-08-09T10:19:14.303Z",
};

test("reset message includes the cycle transition", () => {
  assert.equal(buildResetTitle(event), "Codex 额度已重置 · TEAM");
  const text = buildResetText(event);
  assert.match(text, /TEAM/);
  assert.match(text, /窗口：7d/);
  assert.match(text, /72% → 0%/);
  assert.match(text, /预览/);
});

test("telegram sends the message to the configured chat", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  await sendTelegram({ botToken: "tok", chatId: "42" }, "hello", { fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.telegram.org/bottok/sendMessage");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.chat_id, "42");
  assert.equal(body.text, "hello");
});

test("telegram rejects an API error response", async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ ok: false, description: "chat not found" }) });
  await assert.rejects(() => sendTelegram({ botToken: "tok", chatId: "42" }, "x", { fetchImpl }), /chat not found/);
  await assert.rejects(
    () => sendTelegram({ botToken: "tok", chatId: "42" }, "x", { fetchImpl: async () => ({ ok: false, status: 500 }) }),
    /HTTP 500/,
  );
});

test("bark posts to the configured server with the device key", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ code: 200 }) };
  };
  await sendBark({ server: "https://bark.example/", key: "k" }, "T", "B", { fetchImpl });
  assert.equal(calls[0].url, "https://bark.example/push");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.device_key, "k");
  assert.equal(body.title, "T");
  assert.equal(body.body, "B");
});

test("bark falls back to the default server", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, json: async () => ({ code: 200 }) };
  };
  await sendBark({ server: "", key: "k" }, "T", "B", { fetchImpl });
  assert.equal(calls[0], "https://api.day.app/push");
});

test("email sends through the injected transport", async () => {
  const sent = [];
  const transport = { sendMail: async (mail) => sent.push(mail) };
  await sendEmail(
    { emailSmtpHost: "h", emailSmtpPort: 587, emailSmtpUser: "u", emailSmtpPass: "p", emailFrom: "f", emailTo: "t" },
    "S",
    "B",
    { transport },
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "t");
  assert.equal(sent[0].subject, "S");
  assert.equal(sent[0].text, "B");
});

test("notifier dispatches to each configured channel and isolates failures", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("telegram.org")) return { ok: true, json: async () => ({ ok: false, description: "nope" }) };
    return { ok: true, json: async () => ({ code: 200 }) };
  };
  const notifier = createNotifier({ fetchImpl });
  const config = {
    notifyEnabled: true,
    notifyTelegramEnabled: true,
    telegramBotToken: "t",
    telegramChatId: "1",
    notifyBarkEnabled: true,
    barkKey: "k",
    notifyEmailEnabled: false,
  };
  const results = await notifier.notifyReset(config, event);
  assert.deepEqual(
    results.map((result) => [result.channel, result.ok]),
    [["telegram", false], ["bark", true]],
  );
  assert.match(results[0].error, /nope/);
});

test("notifications are skipped when the master switch is off", async () => {
  const notifier = createNotifier({
    fetchImpl: async () => {
      throw new Error("should not be called");
    },
  });
  const results = await notifier.notifyReset(
    { notifyEnabled: false, notifyTelegramEnabled: true, telegramBotToken: "t", telegramChatId: "1" },
    event,
  );
  assert.deepEqual(results, []);
});
