async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const envelope = await response.json().catch(() => null);
  if (!response.ok || !envelope?.ok) {
    const error = new Error(envelope?.error?.message || `Request failed with HTTP ${response.status}`);
    error.status = response.status;
    error.code = envelope?.error?.code || "REQUEST_FAILED";
    throw error;
  }
  return envelope.data;
}

export const api = {
  session: () => request("/api/auth/session"),
  twoFactorPublicStatus: () => request("/api/auth/2fa/status"),
  login: (password, totp = "") => request("/api/auth/login", { method: "POST", body: JSON.stringify({ password, totp }) }),
  logout: () => request("/api/auth/logout", { method: "POST" }),
  twoFactorStatus: () => request("/api/auth/2fa"),
  setupTwoFactor: () => request("/api/auth/2fa/setup", { method: "POST" }),
  enableTwoFactor: (code) => request("/api/auth/2fa/enable", { method: "POST", body: JSON.stringify({ code }) }),
  disableTwoFactor: (password, code) => request("/api/auth/2fa/disable", { method: "POST", body: JSON.stringify({ password, code }) }),
  publicDashboard: () => request("/api/public/dashboard"),
  publicSubscribers: (id) => request(`/api/public/monitors/${encodeURIComponent(id)}/subscribers`),
  adminDashboard: () => request("/api/dashboard"),
  createMonitor: (monitor) => request("/api/monitors", { method: "POST", body: JSON.stringify(monitor) }),
  saveMonitor: (id, monitor) => request(`/api/monitors/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(monitor) }),
  deleteMonitor: (id) => request(`/api/monitors/${encodeURIComponent(id)}`, { method: "DELETE" }),
  testConnection: (id) => request(`/api/monitors/${encodeURIComponent(id)}/test`, { method: "POST" }),
  checkNow: (id) => request(`/api/monitors/${encodeURIComponent(id)}/check`, { method: "POST" }),
  notifyTest: (id, channel) => request(`/api/monitors/${encodeURIComponent(id)}/notify-test`, { method: "POST", body: JSON.stringify({ channel }) }),
  subscribers: (id, refresh = false) => request(`/api/monitors/${encodeURIComponent(id)}/subscribers${refresh ? "?refresh=1" : ""}`),
  events: () => request("/api/events?limit=200"),
  audit: () => request("/api/audit?limit=300"),
};
