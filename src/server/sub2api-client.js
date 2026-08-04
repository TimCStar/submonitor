function buildApiUrl(baseUrl, apiPath) {
  const suffix = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  if (baseUrl.endsWith("/api/v1") && suffix.startsWith("/api/v1/")) {
    return `${baseUrl}${suffix.slice("/api/v1".length)}`;
  }
  return `${baseUrl}${suffix}`;
}

export class Sub2ApiClient {
  constructor(config) {
    this.config = config;
  }

  async request(method, apiPath, body) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.requestTimeoutSeconds * 1000,
    );
    const headers = { Accept: "application/json" };
    if (this.config.authType === "jwt") headers.Authorization = `Bearer ${this.config.authSecret}`;
    else headers["x-api-key"] = this.config.authSecret;
    const options = { method, headers, signal: controller.signal };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }

    try {
      const response = await fetch(buildApiUrl(this.config.baseUrl, apiPath), options);
      const responseText = await response.text();
      let envelope;
      try {
        envelope = responseText ? JSON.parse(responseText) : {};
      } catch {
        throw new Error(`${method} ${apiPath} returned non-JSON HTTP ${response.status}`);
      }
      if (!response.ok) {
        throw new Error(
          `${method} ${apiPath} failed with HTTP ${response.status}: ${envelope.message || responseText}`,
        );
      }
      if (Object.hasOwn(envelope, "code") && Number(envelope.code) !== 0) {
        throw new Error(`${method} ${apiPath} failed: ${envelope.message || envelope.code}`);
      }
      return Object.hasOwn(envelope, "data") ? envelope.data : envelope;
    } catch (error) {
      if (error?.name === "AbortError") throw new Error(`${method} ${apiPath} timed out`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  queryCodexQuota(accountId) {
    return this.request("GET", `/api/v1/admin/openai/accounts/${accountId}/quota`);
  }

  getAccount(accountId) {
    return this.request("GET", `/api/v1/admin/accounts/${accountId}`);
  }

  listGroups() {
    return this.request("GET", "/api/v1/admin/groups/all");
  }

  listSubscriptions(groupId, page) {
    const query = new URLSearchParams({
      page: String(page),
      page_size: "1000",
      group_id: String(groupId),
      status: "active",
    });
    return this.request("GET", `/api/v1/admin/subscriptions?${query}`);
  }

  recoverSourceAccount(accountId) {
    return this.request("POST", `/api/v1/admin/accounts/${accountId}/recover-state`);
  }

  resetTargetAccount(accountId) {
    return this.request("POST", `/api/v1/admin/accounts/${accountId}/reset-quota`);
  }

  resetSubscription(subscriptionId, body) {
    return this.request(
      "POST",
      `/api/v1/admin/subscriptions/${subscriptionId}/reset-quota`,
      body,
    );
  }
}
