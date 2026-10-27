import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ClipboardList, LogIn, LogOut, Menu, Settings } from "lucide-react";
import { api } from "./api.js";
import { NowView } from "./now.jsx";
import { AuditView, EventSheet, RecordsView } from "./records.jsx";
import { SettingsView } from "./settings.jsx";
import { Segmented, Sheet, Skeleton, Toast } from "./ui.jsx";

const THEME_STORAGE_KEY = "submonitor-theme";
const THEME_COLORS = { light: "#f6f4ef", dark: "#121110" };
const THEME_OPTIONS = [{ value: "system", label: "跟随系统" }, { value: "light", label: "浅色" }, { value: "dark", label: "深色" }];
const PAGES = { now: "现在", records: "记录", settings: "设置", audit: "审计" };
const ADMIN_PAGES = new Set(["settings", "audit"]);

function readTheme() {
  const value = window.localStorage.getItem(THEME_STORAGE_KEY);
  return THEME_OPTIONS.some((option) => option.value === value) ? value : "system";
}
function applyTheme(preference) {
  const resolved = preference === "system" ? (window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light") : preference;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[resolved]);
}
function readPage() {
  const hash = window.location.hash.replace("#", "");
  return PAGES[hash] ? hash : "now";
}

function Login({ onClose, onAuthenticated }) {
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => { api.twoFactorPublicStatus().then((result) => setNeedsCode(Boolean(result.enabled))).catch(() => setNeedsCode(false)); }, []);
  async function submit(event) {
    event.preventDefault();
    setSubmitting(true); setError("");
    try { await api.login(password, totp); await onAuthenticated(); }
    catch (requestError) { if (requestError.code === "TWO_FACTOR_INVALID") setTotp(""); setError(requestError.message); }
    finally { setSubmitting(false); }
  }
  return <Sheet open onClose={onClose} title="管理员登录" subtitle="登录后可以修改设置、查看审计。" size="sm">
    <form className="login" onSubmit={submit}>
      <label className="field"><span>密码</span>
        <input className="input" id="password" type="password" autoFocus required autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
      </label>
      {needsCode && <label className="field"><span>验证码</span>
        <input className="input input-code" id="totp" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required autoComplete="one-time-code" placeholder="6 位数字" value={totp} onChange={(event) => setTotp(event.target.value.replace(/\D/g, "").slice(0, 6))} />
      </label>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <button type="submit" className="btn btn-primary btn-block" disabled={submitting || !password}>{submitting ? "正在登录…" : "登录"}</button>
    </form>
  </Sheet>;
}

function Wordmark() {
  return <a className="wordmark" href="#now" aria-label="SubMonitor 首页"><span className="wordmark-mark" aria-hidden="true" />SubMonitor</a>;
}

export default function App() {
  const [publicData, setPublicData] = useState(null);
  const [adminData, setAdminData] = useState(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [page, setPage] = useState(readPage);
  const [afterLogin, setAfterLogin] = useState(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useState(readTheme);
  const [eventId, setEventId] = useState(null);
  const [toast, setToast] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const refreshTimer = useRef(null);
  const toastTimer = useRef(null);

  useEffect(() => { window.localStorage.setItem(THEME_STORAGE_KEY, theme); applyTheme(theme); }, [theme]);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return undefined;
    const update = () => { if (theme === "system") applyTheme("system"); };
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, [theme]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(timer); }, []);

  const notify = useCallback((kind, message) => {
    clearTimeout(toastTimer.current);
    setToast({ kind, message });
    toastTimer.current = setTimeout(() => setToast(null), kind === "error" ? 6000 : 3200);
  }, []);
  const loadPublic = useCallback(async () => { const data = await api.publicDashboard(); setPublicData(data); setNow(Date.now()); return data; }, []);
  const loadAdmin = useCallback(async () => { const data = await api.adminDashboard(); setAdminData(data); return data; }, []);
  const reloadAll = useCallback(async () => { await Promise.all([loadAdmin(), loadPublic()]); }, [loadAdmin, loadPublic]);

  useEffect(() => {
    loadPublic().catch((error) => notify("error", error.message));
    api.session().then(async (session) => { setAuthenticated(session.authenticated); if (session.authenticated) await loadAdmin(); }).catch(() => {});
  }, [loadAdmin, loadPublic, notify]);
  useEffect(() => {
    const stream = new EventSource("/api/public/stream");
    const refresh = () => { clearTimeout(refreshTimer.current); refreshTimer.current = setTimeout(() => void loadPublic().catch(() => {}), 200); };
    stream.addEventListener("refresh", refresh);
    return () => { clearTimeout(refreshTimer.current); stream.close(); };
  }, [loadPublic]);
  useEffect(() => {
    if (!authenticated) return undefined;
    const stream = new EventSource("/api/stream");
    let timer = null;
    const refresh = () => { clearTimeout(timer); timer = setTimeout(() => { void loadPublic().catch(() => {}); void loadAdmin().catch(() => {}); }, 200); };
    ["runtime", "snapshot", "event", "audit", "config", "quota-sharing"].forEach((type) => stream.addEventListener(type, refresh));
    return () => { clearTimeout(timer); stream.close(); };
  }, [authenticated, loadAdmin, loadPublic]);

  const go = useCallback((next) => {
    setMenuOpen(false);
    if (ADMIN_PAGES.has(next) && !authenticated) { setAfterLogin(next); setLoginOpen(true); return; }
    setPage(next);
    if (window.location.hash !== `#${next}`) window.history.replaceState(null, "", `#${next}`);
    window.scrollTo({ top: 0 });
  }, [authenticated]);
  useEffect(() => {
    const onHash = () => go(readPage());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [go]);
  useEffect(() => { document.title = page === "now" ? "SubMonitor" : `${PAGES[page]} · SubMonitor`; }, [page]);

  async function loggedIn() {
    setAuthenticated(true);
    await reloadAll();
    setLoginOpen(false);
    const target = afterLogin || "settings";
    setAfterLogin(null);
    setPage(target); window.history.replaceState(null, "", `#${target}`);
  }
  async function logout() {
    setMenuOpen(false);
    await api.logout().catch(() => {});
    setAuthenticated(false); setAdminData(null);
    if (ADMIN_PAGES.has(page)) { setPage("now"); window.history.replaceState(null, "", "#now"); }
    notify("success", "已退出");
  }

  const events = publicData?.events || [];
  const selectedEvent = useMemo(() => {
    if (!eventId) return null;
    const pub = events.find((event) => event.id === eventId);
    const full = adminData?.events?.find((event) => event.id === eventId);
    return full ? { ...pub, ...full, monitorName: pub?.monitorName || full.monitorName } : pub || null;
  }, [eventId, events, adminData]);
  const closeEvent = useCallback(() => setEventId(null), []);
  const openEvent = useCallback((event) => setEventId(event.id), []);
  const effectivePage = ADMIN_PAGES.has(page) && !authenticated ? "now" : page;

  const nav = (variant) => <>
    {["now", "records"].map((id) => <a key={id} href={`#${id}`} className={`nav-link${effectivePage === id ? " active" : ""}`} aria-current={effectivePage === id ? "page" : undefined} onClick={(event) => { event.preventDefault(); go(id); }}>{PAGES[id]}</a>)}
    {variant === "rail" && <div className="rail-quiet">
      <a href="#settings" className={`nav-link quiet${effectivePage === "settings" ? " active" : ""}`} onClick={(event) => { event.preventDefault(); go("settings"); }}><Settings size={15} />设置</a>
      <a href="#audit" className={`nav-link quiet${effectivePage === "audit" ? " active" : ""}`} onClick={(event) => { event.preventDefault(); go("audit"); }}><ClipboardList size={15} />审计</a>
    </div>}
  </>;

  return <div className="shell">
    <aside className="rail" aria-label="导航">
      <Wordmark />
      <nav className="rail-nav">{nav("rail")}</nav>
      <div className="rail-foot">
        <Segmented size="sm" label="外观" value={theme} onChange={setTheme} options={THEME_OPTIONS} />
        {authenticated
          ? <button type="button" className="link quiet" onClick={logout}><LogOut size={14} />退出管理</button>
          : <button type="button" className="link quiet" onClick={() => { setAfterLogin(null); setLoginOpen(true); }}><LogIn size={14} />管理员登录</button>}
      </div>
    </aside>

    <header className="topbar">
      <Wordmark />
      <button type="button" className="icon-btn" onClick={() => setMenuOpen(true)} aria-label="菜单"><Menu size={20} /></button>
    </header>

    <main className="main" id="main">
      {!publicData ? <div className="view"><div className="view-head"><Skeleton lines={2} /></div><Skeleton lines={5} /></div> : <>
        {effectivePage === "now" && <NowView data={publicData} adminData={adminData} now={now} onOpenEvent={openEvent} onShowRecords={() => go("records")} onAdmin={() => go("settings")} />}
        {effectivePage === "records" && <RecordsView events={events} monitors={publicData.monitors} now={now} onOpenEvent={openEvent} />}
        {effectivePage === "settings" && <SettingsView adminData={adminData} publicMonitors={publicData.monitors} events={events} now={now} reload={reloadAll} notify={notify} />}
        {effectivePage === "audit" && (adminData ? <AuditView entries={adminData.audit} now={now} /> : <div className="view"><Skeleton lines={6} /></div>)}
      </>}
    </main>

    <nav className={`pill${effectivePage === "settings" ? " is-raised" : ""}`} aria-label="主导航">{nav("pill")}</nav>

    <Sheet open={menuOpen} onClose={() => setMenuOpen(false)} title="菜单" size="sm">
      <div className="menu">
        <button type="button" className="menu-item" onClick={() => go("settings")}><Settings size={17} /><span>设置</span>{!authenticated && <em>需要登录</em>}</button>
        <button type="button" className="menu-item" onClick={() => go("audit")}><ClipboardList size={17} /><span>审计日志</span>{!authenticated && <em>需要登录</em>}</button>
        <div className="menu-theme"><span>外观</span><Segmented label="外观" value={theme} onChange={setTheme} options={THEME_OPTIONS} /></div>
        {authenticated
          ? <button type="button" className="menu-item" onClick={logout}><LogOut size={17} /><span>退出管理</span></button>
          : <button type="button" className="menu-item" onClick={() => { setMenuOpen(false); setAfterLogin(null); setLoginOpen(true); }}><LogIn size={17} /><span>管理员登录</span></button>}
      </div>
    </Sheet>

    {loginOpen && <Login onClose={() => setLoginOpen(false)} onAuthenticated={loggedIn} />}
    <EventSheet event={selectedEvent} onClose={closeEvent} now={now} />
    <Toast toast={toast} onClose={() => setToast(null)} />
  </div>;
}
