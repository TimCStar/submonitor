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
    throw error;
  }
  return envelope.data;
}

export const api = {
  session: () => request("/api/auth/session"),
  login: (password) => request("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => request("/api/auth/logout", { method: "POST" }),
  dashboard: () => request("/api/dashboard"),
  saveConfig: (config) => request("/api/config", { method: "PUT", body: JSON.stringify(config) }),
  testConnection: () => request("/api/config/test", { method: "POST" }),
  checkNow: () => request("/api/monitor/check", { method: "POST" }),
  events: () => request("/api/events?limit=200"),
  audit: () => request("/api/audit?limit=300"),
};
