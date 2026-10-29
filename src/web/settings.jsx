import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { api } from "./api.js";
import { friendlyTime, relative, seconds as formatSeconds } from "./format.js";
import { accountState } from "./status.js";
import { AccountMark, QuotaEstimate, SubscriberList } from "./now.jsx";
import { Button, Dot, Empty, Row, SecretInput, Segmented, Skeleton, Spinner, Stepper, TextInput, Toggle } from "./ui.jsx";

function numberList(value) {
  if (!String(value || "").trim()) return [];
  const parsed = String(value).split(/[,，\s]+/).filter(Boolean).map((item) => Number(item.trim()));
  if (parsed.some((item) => !Number.isSafeInteger(item) || item <= 0)) throw new Error("账号和分组 ID 必须是用逗号分隔的正整数");
  return [...new Set(parsed)];
}

const TRANSIENT = ["runtime", "snapshots", "quotaSharing", "updatedAt", "createdAt", "concurrency", "candidates"];
function editable(form) {
  const copy = { ...form };
  for (const key of TRANSIENT) delete copy[key];
  return JSON.stringify(copy);
}

function initialForm(monitor) {
  return {
    ...monitor,
    authSecret: "", telegramBotToken: "", barkKey: "", emailSmtpPass: "",
    targetAccountIdsText: (monitor.targetAccountIds || []).join(", "),
    subscriptionGroupIdsText: (monitor.subscriptionGroupIds || []).join(", "),
    quotaSharingMode: monitor.quotaSharingMode || "equal",
    quotaSharingWeightsText: Object.entries(monitor.quotaSharingWeights || {}).map(([userId, weight]) => `${userId}:${weight}`).join(", "),
    pendingConfirmIntervalSeconds: monitor.pendingConfirmIntervalSeconds ?? 60,
  };
}

/** presets as segmented control, plus a custom numeric entry */
function PresetPicker({ value, onChange, presets, min, max, unit = "秒", format = formatSeconds, label, id }) {
  const number = Number(value);
  const isPreset = presets.some((preset) => preset === number);
  const [custom, setCustom] = useState(!isPreset);
  const options = [...presets.map((preset) => ({ value: preset, label: format(preset) })), { value: "custom", label: "自定义" }];
  return <div className="preset">
    <Segmented label={label} options={options} value={custom ? "custom" : number} onChange={(next) => {
      if (next === "custom") setCustom(true);
      else { setCustom(false); onChange(next); }
    }} />
    {custom && <div className="inline-input">
      <TextInput id={id} type="number" inputMode="numeric" min={min} max={max} value={value ?? ""} onChange={(event) => onChange(event.target.value)} />
      <span>{unit}</span>
    </div>}
  </div>;
}

function Group({ title, hint, children, id }) {
  return <section className="group" id={id} aria-labelledby={`${id}-title`}>
    <header className="group-head">
      <h2 id={`${id}-title`}>{title}</h2>
      {hint && <p>{hint}</p>}
    </header>
    <div className="group-body">{children}</div>
  </section>;
}

function Channel({ name, hint, enabled, onToggle, onTest, testing, children, open }) {
  return <div className={`channel${open ? " is-open" : ""}`}>
    <Toggle checked={enabled} onChange={onToggle} label={name} hint={hint} />
    {open && <div className="channel-body">
      {children}
      <div className="channel-actions"><Button variant="link" onClick={onTest} busy={testing}>发送一条测试消息</Button></div>
    </div>}
  </div>;
}

function AdminSubscribers({ monitor }) {
  const [state, setState] = useState({ loading: false, data: null, error: "" });
  const ready = Boolean(monitor.baseUrl && monitor.sourceAccountId && monitor.authSecretConfigured && !monitor.authSecretInvalid);
  const enabled = monitor.subscriptionGroupMode !== "none";
  const load = useCallback(async (refresh = false) => {
    if (!enabled || !ready) return;
    setState((current) => ({ ...current, loading: true, error: "" }));
    try { setState({ loading: false, data: await api.subscribers(monitor.id, refresh), error: "" }); }
    catch (error) { setState((current) => ({ ...current, loading: false, error: error.message })); }
  }, [enabled, ready, monitor.id]);
  useEffect(() => { void load(false); }, [load, monitor.updatedAt]);
  if (!enabled) return null;
  return <div className="subpanel">
    <div className="subpanel-head">
      <span>当前有效订阅{state.data ? ` · ${state.data.total} 位 · ${state.data.groups?.length ?? state.data.groupCount ?? 0} 个分组` : ""}</span>
      <button type="button" className="icon-btn" onClick={() => load(true)} disabled={!ready || state.loading} aria-label="刷新订阅用户"><RefreshCw size={15} className={state.loading ? "spin" : ""} /></button>
    </div>
    {!ready && <p className="note">连接配置完整并保存后显示。</p>}
    {state.loading && !state.data && <Skeleton lines={2} />}
    {state.error && <p className="note text-bad">{state.error}</p>}
    {state.data && <SubscriberList data={state.data} />}
  </div>;
}

function MonitorForm({ monitor, publicMonitor, events, now, reload, notify, onDelete, deleting }) {
  const [form, setForm] = useState(() => initialForm(monitor));
  const [baseline, setBaseline] = useState(() => editable(initialForm(monitor)));
  const [busy, setBusy] = useState("");
  useEffect(() => { const next = initialForm(monitor); setForm(next); setBaseline(editable(next)); }, [monitor.id, monitor.updatedAt]);
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const patch = (values) => setForm((current) => ({ ...current, ...values }));
  const dirty = editable(form) !== baseline;
  const formId = `monitor-form-${useId().replace(/:/g, "")}`;
  const credentialsReady = monitor.authSecretConfigured && !monitor.authSecretInvalid;
  const state = accountState({ ...(publicMonitor || {}), ...monitor, candidates: publicMonitor?.candidates }, events, now, monitor);

  async function run(name, task, success) {
    setBusy(name);
    try { const result = await task(); if (success) notify("success", typeof success === "function" ? success(result) : success); return result; }
    catch (error) { notify("error", error.message); return null; }
    finally { setBusy(""); }
  }
  async function save(event) {
    event?.preventDefault();
    let payload;
    try { payload = { ...form, targetAccountIds: numberList(form.targetAccountIdsText), subscriptionGroupIds: numberList(form.subscriptionGroupIdsText), quotaSharingWeights: form.quotaSharingWeightsText }; }
    catch (error) { notify("error", error.message); return; }
    const result = await run("save", () => api.saveMonitor(monitor.id, payload), "已保存");
    if (result) await reload();
  }
  const clearSecret = (flag, configured, enabledKey) => patch({ [flag]: true, [configured]: false, [enabledKey]: false });

  return <form id={formId} className="settings-form" onSubmit={save} noValidate>
    <Group id="run" title="运行" hint="监控是否在跑，以及确认重置后是否真的执行。">
      <div className={`status status-${state.tone} status-inline`}>
        <p className="status-title"><Dot tone={state.tone} pulse={state.kind === "pending"} />{state.title}</p>
        <p className="status-hint">上次检查 {monitor.runtime?.lastPollAt ? `${friendlyTime(monitor.runtime.lastPollAt, now)}（${relative(monitor.runtime.lastPollAt, now)}）` : "尚未检查"}</p>
        {monitor.runtime?.lastError && <p className="status-detail">{monitor.runtime.lastError}</p>}
      </div>
      <Toggle checked={form.enabled} onChange={(value) => update("enabled", value)} label="启用监控" hint="关闭后停止检查，首页也不再显示这个账号。" />
      <Toggle checked={form.dryRun} onChange={(value) => update("dryRun", value)} label="预览模式" hint="只记录检测到的重置，不执行任何写操作。" />
      <div className="button-line">
        <Button onClick={() => run("check", () => api.checkNow(monitor.id), "检查完成")} busy={busy === "check"} disabled={!credentialsReady || Boolean(busy)}>立即检查</Button>
        <Button onClick={() => run("test", () => api.testConnection(monitor.id), (result) => `连接正常，读到 ${result.snapshots?.length ?? 0} 个额度窗口`)} busy={busy === "test"} disabled={!credentialsReady || Boolean(busy)}>测试连接</Button>
      </div>
    </Group>

    <Group id="speed" title="检测速度" hint="越快越早发现重置，但会多请求一次 Sub2API。">
      <Row label="平时" hint="没有异常时多久查一次额度。" stack>
        <PresetPicker label="平时检查间隔" id="poll" value={form.pollIntervalSeconds} onChange={(value) => update("pollIntervalSeconds", value)} presets={[60, 300, 600, 1800]} min={15} max={86400} />
      </Row>
      <Row label="发现疑似重置后" hint="临时加快复查，确认完就恢复平时的频率。" stack>
        <PresetPicker label="待确认轮询间隔" id="pending" value={form.pendingConfirmIntervalSeconds} onChange={(value) => update("pendingConfirmIntervalSeconds", value)} presets={[30, 60, 120, 300]} min={15} max={3600} />
      </Row>
      <Row label="监控窗口" hint="判断重置用哪几个额度窗口。" stack>
        <Segmented multiple label="监控窗口" value={form.monitorWindows || []} onChange={(value) => update("monitorWindows", value)} options={[{ value: "5h", label: "5 小时" }, { value: "7d", label: "7 天" }, { value: "primary", label: "主窗口" }, { value: "secondary", label: "次窗口" }]} />
      </Row>
    </Group>

    <Group id="confirm" title="重置确认" hint="避免把偶发的数据抖动当成重置。">
      <Row label="连续确认次数" hint="看到几次重置信号才执行。1 次最快。">
        <Stepper label="连续确认次数" value={form.confirmationsRequired} onChange={(value) => update("confirmationsRequired", value)} min={1} max={10} suffix="次" />
      </Row>
      <Row label="用量提醒" hint="使用率达到这个值，或被上游限流时提醒。" stack>
        <PresetPicker label="用量提醒阈值" id="alert" value={form.usageAlertPercent} onChange={(value) => update("usageAlertPercent", value)} presets={[0, 80, 90, 95]} min={0} max={100} unit="%" format={(value) => (value === 0 ? "关闭" : `${value}%`)} />
      </Row>
    </Group>

    <Group id="notify" title="通知" hint="重置完成、动作失败或用量过高时推送。">
      <Toggle checked={form.notifyEnabled} onChange={(value) => update("notifyEnabled", value)} label="发送通知" hint="总开关。关闭后所有渠道都不发送。" />
      <div className={`channels${form.notifyEnabled ? "" : " is-dim"}`}>
        <Channel name="Telegram" hint="Bot 推送到指定会话" enabled={form.notifyTelegramEnabled} open={form.notifyTelegramEnabled || form.telegramBotTokenConfigured}
          onToggle={(value) => update("notifyTelegramEnabled", value)} onTest={() => run("t-telegram", () => api.notifyTest(monitor.id, "telegram"), "测试消息已发送")} testing={busy === "t-telegram"}>
          <Row label="Bot Token" htmlFor="tg-token" stack><SecretInput id="tg-token" configured={monitor.telegramBotTokenConfigured} invalid={monitor.telegramBotTokenInvalid} cleared={form.clearTelegramBotToken} value={form.telegramBotToken} onChange={(event) => update("telegramBotToken", event.target.value)} onClear={() => clearSecret("clearTelegramBotToken", "telegramBotTokenConfigured", "notifyTelegramEnabled")} /></Row>
          <Row label="Chat ID" htmlFor="tg-chat" stack><TextInput id="tg-chat" value={form.telegramChatId || ""} onChange={(event) => update("telegramChatId", event.target.value)} placeholder="123456789" /></Row>
        </Channel>
        <Channel name="Bark" hint="iPhone 推送" enabled={form.notifyBarkEnabled} open={form.notifyBarkEnabled || form.barkKeyConfigured}
          onToggle={(value) => update("notifyBarkEnabled", value)} onTest={() => run("t-bark", () => api.notifyTest(monitor.id, "bark"), "测试消息已发送")} testing={busy === "t-bark"}>
          <Row label="设备 Key" htmlFor="bark-key" stack><SecretInput id="bark-key" configured={monitor.barkKeyConfigured} invalid={monitor.barkKeyInvalid} cleared={form.clearBarkKey} value={form.barkKey} onChange={(event) => update("barkKey", event.target.value)} onClear={() => clearSecret("clearBarkKey", "barkKeyConfigured", "notifyBarkEnabled")} /></Row>
          <Row label="服务器" hint="留空使用 api.day.app" htmlFor="bark-server" stack><TextInput id="bark-server" value={form.barkServer || ""} onChange={(event) => update("barkServer", event.target.value)} placeholder="https://api.day.app" /></Row>
        </Channel>
        <Channel name="邮件" hint="通过 SMTP 发送" enabled={form.notifyEmailEnabled} open={form.notifyEmailEnabled || form.emailSmtpPassConfigured}
          onToggle={(value) => update("notifyEmailEnabled", value)} onTest={() => run("t-email", () => api.notifyTest(monitor.id, "email"), "测试邮件已发送")} testing={busy === "t-email"}>
          <div className="field-pair">
            <Row label="SMTP 服务器" htmlFor="smtp-host" stack><TextInput id="smtp-host" value={form.emailSmtpHost || ""} onChange={(event) => update("emailSmtpHost", event.target.value)} placeholder="smtp.example.com" /></Row>
            <Row label="端口" htmlFor="smtp-port" stack><TextInput id="smtp-port" type="number" inputMode="numeric" min="1" max="65535" value={form.emailSmtpPort ?? ""} onChange={(event) => update("emailSmtpPort", event.target.value)} /></Row>
          </div>
          <Row label="用户名" htmlFor="smtp-user" stack><TextInput id="smtp-user" value={form.emailSmtpUser || ""} onChange={(event) => update("emailSmtpUser", event.target.value)} autoComplete="off" /></Row>
          <Row label="密码" htmlFor="smtp-pass" stack><SecretInput id="smtp-pass" configured={monitor.emailSmtpPassConfigured} invalid={monitor.emailSmtpPassInvalid} cleared={form.clearEmailSmtpPass} value={form.emailSmtpPass} onChange={(event) => update("emailSmtpPass", event.target.value)} onClear={() => clearSecret("clearEmailSmtpPass", "emailSmtpPassConfigured", "notifyEmailEnabled")} /></Row>
          <div className="field-pair">
            <Row label="发件人" htmlFor="mail-from" stack><TextInput id="mail-from" type="email" value={form.emailFrom || ""} onChange={(event) => update("emailFrom", event.target.value)} placeholder="monitor@example.com" /></Row>
            <Row label="收件人" htmlFor="mail-to" stack><TextInput id="mail-to" type="email" value={form.emailTo || ""} onChange={(event) => update("emailTo", event.target.value)} placeholder="you@example.com" /></Row>
          </div>
        </Channel>
      </div>
    </Group>

    <Group id="conn" title="Sub2API 连接" hint="这个账号从哪里读额度，重置后恢复哪些账号。">
      <Row label="名称" htmlFor="name" stack><TextInput id="name" value={form.name || ""} maxLength={80} onChange={(event) => update("name", event.target.value)} /></Row>
      <Row label="服务地址" htmlFor="base" stack><TextInput id="base" type="url" inputMode="url" value={form.baseUrl || ""} onChange={(event) => update("baseUrl", event.target.value)} placeholder="https://sub2api.example.com" /></Row>
      <Row label="认证方式" stack><Segmented label="认证方式" value={form.authType} onChange={(value) => update("authType", value)} options={[{ value: "apiKey", label: "API Key" }, { value: "jwt", label: "管理员 JWT" }]} /></Row>
      <Row label="管理凭据" hint="加密保存，不会显示。" htmlFor="secret" stack><SecretInput id="secret" configured={monitor.authSecretConfigured} invalid={monitor.authSecretInvalid} value={form.authSecret} onChange={(event) => update("authSecret", event.target.value)} placeholder={monitor.authSecretConfigured ? undefined : "输入 API Key 或 JWT"} /></Row>
      <div className="field-pair">
        <Row label="源账号 ID" hint="被监控的 Codex 账号。" htmlFor="src" stack><TextInput id="src" type="number" inputMode="numeric" min="1" value={form.sourceAccountId || ""} onChange={(event) => update("sourceAccountId", event.target.value)} /></Row>
        <Row label="一起恢复的账号" hint="逗号分隔，可留空。" htmlFor="targets" stack><TextInput id="targets" inputMode="numeric" value={form.targetAccountIdsText} onChange={(event) => update("targetAccountIdsText", event.target.value)} placeholder="34, 35" /></Row>
      </div>
    </Group>

    <Group id="subs" title="订阅与额度" hint="重置后顺带重置订阅用户的用量，可选按人均分周额度。">
      <Row label="订阅分组" stack><Segmented label="订阅分组来源" value={form.subscriptionGroupMode} onChange={(value) => update("subscriptionGroupMode", value)} options={[{ value: "none", label: "不联动" }, { value: "auto", label: "自动发现" }, { value: "explicit", label: "指定分组" }]} /></Row>
      {form.subscriptionGroupMode === "explicit" && <Row label="分组 ID" hint="逗号分隔。" htmlFor="groups" stack><TextInput id="groups" value={form.subscriptionGroupIdsText} onChange={(event) => update("subscriptionGroupIdsText", event.target.value)} placeholder="10, 11" /></Row>}
      {form.subscriptionGroupMode !== "none" && <>
        <Row label="重置哪些用量" stack><Segmented multiple label="订阅重置周期" value={form.subscriptionResetWindows || []} onChange={(value) => update("subscriptionResetWindows", value)} options={[{ value: "daily", label: "日" }, { value: "weekly", label: "周" }, { value: "monthly", label: "月" }]} /></Row>
        <Toggle checked={form.publicSubscriberPreviewEnabled !== false} onChange={(value) => update("publicSubscriberPreviewEnabled", value)} label="公开页显示订阅用户" hint="脱敏后显示在账号详情里。" />
        <AdminSubscribers monitor={monitor} />
      </>}
      <Toggle checked={form.quotaSharingEnabled} onChange={(value) => update("quotaSharingEnabled", value)} label="按人均分周额度" hint="给专用订阅分组统一设置每人周上限。" />
      {form.quotaSharingEnabled && <div className="nested">
        <Row label="专用分组 ID" htmlFor="qs-group"><TextInput id="qs-group" className="input input-short" type="number" inputMode="numeric" min="1" value={form.quotaSharingGroupId || ""} onChange={(event) => update("quotaSharingGroupId", event.target.value)} /></Row>
        <Row label="分配方式" stack><Segmented label="分配方式" value={form.quotaSharingMode || "equal"} onChange={(value) => update("quotaSharingMode", value)} options={[{ value: "equal", label: "平均分配" }, { value: "proportional", label: "按比例分配" }]} /></Row>
        {form.quotaSharingMode === "proportional" && <Row label="用户权重" hint="格式 用户ID:权重，逗号分隔；未列出的用户权重为 1。Sub2API 只有分组级周上限，按比例分配仅计算预览，不会写入。" htmlFor="qs-weights" stack><TextInput id="qs-weights" value={form.quotaSharingWeightsText || ""} onChange={(event) => update("quotaSharingWeightsText", event.target.value)} placeholder="12:2, 15:0.5" /></Row>}
        <Toggle checked={form.quotaSharingReserveEnabled} onChange={(value) => update("quotaSharingReserveEnabled", value)} label="预留一部分额度" />
        {form.quotaSharingReserveEnabled && <Row label="预留比例" htmlFor="qs-reserve"><span className="inline-input"><TextInput id="qs-reserve" type="number" inputMode="decimal" min="0" max="90" step="0.1" value={form.quotaSharingReservePercent ?? ""} onChange={(event) => update("quotaSharingReservePercent", event.target.value)} /><span>%</span></span></Row>}
        <Toggle checked={form.quotaSharingAutoRecalculateEnabled} onChange={(value) => update("quotaSharingAutoRecalculateEnabled", value)} label="定时重算并同步" hint="关闭时只估算，可手动同步。" />
        {form.quotaSharingAutoRecalculateEnabled && <Row label="重算间隔" stack><PresetPicker label="重算间隔" id="qs-interval" value={form.quotaSharingIntervalSeconds} onChange={(value) => update("quotaSharingIntervalSeconds", value)} presets={[300, 900, 3600]} min={60} max={86400} /></Row>}
      </div>}
      <Toggle checked={form.quotaSharingDisplayEnabled} onChange={(value) => update("quotaSharingDisplayEnabled", value)} label="公开页显示额度估算" />
      {(monitor.quotaSharingEnabled || monitor.quotaSharingDisplayEnabled) && <div className="subpanel">
        <QuotaEstimate quota={monitor.quotaSharing} now={now} showError />
        <Button onClick={async () => { const result = await run("quota", () => api.recalculateQuota(monitor.id)); if (result) { await reload(); notify(result.quotaSharing?.status === "blocked" ? "error" : "success", result.quotaSharing?.note || "额度重算完成"); } }} busy={busy === "quota"} disabled={Boolean(busy) || !credentialsReady}>
          {monitor.quotaSharingEnabled && !monitor.dryRun && monitor.quotaSharingMode !== "proportional" ? "立即重算并同步" : "刷新估算"}
        </Button>
      </div>}
    </Group>

    <Group id="danger" title="删除账号" hint="删除后无法恢复本地历史记录。">
      <div className="danger-zone">
        <div><strong>删除“{monitor.name}”</strong><p>只删除 SubMonitor 里的这个监控任务和本地历史，不会改动 Sub2API 里的账号。</p></div>
        <Button variant="danger" onClick={onDelete} busy={deleting} disabled={Boolean(busy) || deleting}>删除</Button>
      </div>
    </Group>

    <details className="group advanced">
      <summary><h2>高级</h2><p>一般不需要改。</p></summary>
      <div className="group-body">
        <Row label="请求超时" hint="单次请求 Sub2API 的最长等待。" htmlFor="timeout"><span className="inline-input"><TextInput id="timeout" type="number" inputMode="numeric" min="5" max="300" value={form.requestTimeoutSeconds ?? ""} onChange={(event) => update("requestTimeoutSeconds", event.target.value)} /><span>秒</span></span></Row>
        <Row label="重置时间容差" hint="重置时间前移超过这个值才算新周期。" htmlFor="grace"><span className="inline-input"><TextInput id="grace" type="number" inputMode="numeric" min="1" max="3600" value={form.resetGraceSeconds ?? ""} onChange={(event) => update("resetGraceSeconds", event.target.value)} /><span>秒</span></span></Row>
        <Row label="新周期用量上限" hint="重置后用量高于此值时不认为是重置。" htmlFor="maxused"><span className="inline-input"><TextInput id="maxused" type="number" inputMode="decimal" min="0" max="100" value={form.resetMaxUsedPercent ?? ""} onChange={(event) => update("resetMaxUsedPercent", event.target.value)} /><span>%</span></span></Row>
      </div>
    </details>

    {createPortal(<div className={`savebar${dirty ? " is-visible" : ""}`} aria-hidden={!dirty}>
      <span>有未保存的更改</span>
      <div>
        <Button onClick={() => { const next = initialForm(monitor); setForm(next); }} disabled={!dirty || busy === "save"} tabIndex={dirty ? 0 : -1}>还原</Button>
        <button type="submit" form={formId} className="btn btn-primary" disabled={!dirty || busy === "save"} tabIndex={dirty ? 0 : -1}>{busy === "save" ? "保存中…" : "保存"}</button>
      </div>
    </div>, document.body)}
  </form>;
}

function TwoFactor({ notify }) {
  const [security, setSecurity] = useState({ loading: true, enabled: false });
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState("");
  useEffect(() => {
    let active = true;
    api.twoFactorStatus().then((result) => active && setSecurity({ loading: false, ...result }))
      .catch((error) => { if (active) { setSecurity({ loading: false, enabled: false }); notify("error", error.message); } });
    return () => { active = false; };
  }, [notify]);
  async function act(name, task, message) {
    setBusy(name);
    try { await task(); notify("success", message); } catch (error) { notify("error", error.message); } finally { setBusy(""); }
  }
  const codeInput = <TextInput id="tfa-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="6 位验证码" />;
  return <Group id="security" title="安全" hint="管理员登录的双因素认证。">
    {security.loading ? <Skeleton lines={1} /> : <>
      <div className="row"><span className="row-text"><span className="row-label">双因素认证</span><span className="row-hint">{security.enabled ? "已开启，登录需要密码和动态验证码。" : "未开启。"}</span></span>
        {!security.enabled && !setup && <Button onClick={() => act("setup", async () => { setSetup(await api.setupTwoFactor()); setCode(""); }, "请在身份验证器中添加密钥")} busy={busy === "setup"}>开启</Button>}
      </div>
      {!security.enabled && setup && <div className="nested">
        <Row label="密钥" hint="在身份验证器里手动输入，或复制下方链接。" stack><code className="code">{setup.secret}</code></Row>
        <Row label="导入链接" htmlFor="otp-uri" stack><TextInput id="otp-uri" readOnly value={setup.otpauthUri} onFocus={(event) => event.target.select()} /></Row>
        <Row label="验证码" htmlFor="tfa-code" stack>{codeInput}</Row>
        <div className="button-line"><Button variant="primary" disabled={code.length !== 6} busy={busy === "enable"} onClick={() => act("enable", async () => { setSecurity({ loading: false, ...(await api.enableTwoFactor(code)) }); setSetup(null); setCode(""); }, "已开启双因素认证")}>确认开启</Button></div>
      </div>}
      {security.enabled && <div className="nested">
        <p className="note">停用需要输入管理员密码和当前验证码。</p>
        <div className="field-pair">
          <Row label="管理员密码" htmlFor="tfa-pass" stack><TextInput id="tfa-pass" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></Row>
          <Row label="验证码" htmlFor="tfa-code" stack>{codeInput}</Row>
        </div>
        <div className="button-line"><Button variant="danger" disabled={!password || code.length !== 6} busy={busy === "disable"} onClick={() => act("disable", async () => { setSecurity({ loading: false, ...(await api.disableTwoFactor(password, code)) }); setPassword(""); setCode(""); }, "已停用双因素认证")}>停用</Button></div>
      </div>}
    </>}
  </Group>;
}

export function SettingsView({ adminData, publicMonitors = [], events, now, reload, notify }) {
  const serverMonitors = adminData?.monitors || [];
  const [overrideMonitors, setOverrideMonitors] = useState(null);
  const [selectedId, setSelectedId] = useState(serverMonitors[0]?.id || null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => { setOverrideMonitors(null); }, [adminData]);
  const monitors = overrideMonitors ?? serverMonitors;
  const monitor = useMemo(() => monitors.find((item) => item.id === selectedId) || monitors[0] || null, [monitors, selectedId]);
  useEffect(() => {
    if (selectedId && monitors.length && !monitors.some((item) => item.id === selectedId)) {
      setSelectedId(monitors[0]?.id || null);
    }
  }, [monitors, selectedId]);

  async function create() {
    if (creating || deleting) return;
    setCreating(true);
    try {
      const created = await api.createMonitor({ name: `Codex 账号 ${monitors.length + 1}` });
      setOverrideMonitors([...(overrideMonitors ?? serverMonitors), created]);
      setSelectedId(created.id);
      notify("success", "已添加，填写连接信息后启用");
      void reload().catch(() => {});
    } catch (error) {
      notify("error", error.message);
    } finally {
      setCreating(false);
    }
  }

  async function removeMonitor(target = monitor) {
    if (!target || creating || deleting) return;
    if (!window.confirm(`删除“${target.name}”以及它的本地历史记录？此操作无法撤销。`)) return;
    setDeleting(true);
    try {
      await api.deleteMonitor(target.id);
      const remaining = (overrideMonitors ?? serverMonitors).filter((item) => item.id !== target.id);
      setOverrideMonitors(remaining);
      setSelectedId(remaining[0]?.id || null);
      notify("success", "已删除");
      void reload().catch(() => {});
    } catch (error) {
      notify("error", error.message);
    } finally {
      setDeleting(false);
    }
  }

  if (!adminData) return <div className="view"><Skeleton lines={6} /></div>;
  return <div className="view view-settings">
    <header className="view-head">
      <p className="eyebrow">设置</p>
      <h1 className="headline headline-account">{monitor && <AccountMark monitor={monitor} />}{monitor ? monitor.name : "添加一个账号"}</h1>
      <div className="account-picker">
        {monitors.length > 1 && <Segmented label="选择账号" value={monitor?.id} onChange={setSelectedId} options={monitors.map((item) => ({ value: item.id, label: `${item.name}${item.enabled ? "" : "（已暂停）"}` }))} size="sm" />}
        <button type="button" className="link" onClick={create} disabled={creating || deleting}>{creating ? <Spinner size={14} /> : <Plus size={14} />}{creating ? "添加中…" : "添加账号"}</button>
        {monitor && <Button variant="danger" onClick={() => removeMonitor(monitor)} busy={deleting} disabled={creating || deleting}><Trash2 size={14} />删除</Button>}
      </div>
    </header>
    {monitor
      ? <MonitorForm key={monitor.id} monitor={monitor} publicMonitor={publicMonitors.find((item) => item.id === monitor.id)} events={events} now={now} reload={reload} notify={notify} onDelete={() => removeMonitor(monitor)} deleting={deleting} />
      : <Empty title="还没有账号" hint="添加一个 Codex OAuth 账号开始监控。"><Button variant="primary" onClick={create} busy={creating} disabled={creating}>添加账号</Button></Empty>}
    <TwoFactor notify={notify} />
  </div>;
}
