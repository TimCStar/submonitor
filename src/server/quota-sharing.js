import { listActiveSubscriptions } from "./subscriber-preview.js";

const MINIMUM_USAGE_PERCENT = 5;
const MINIMUM_LIMIT_USD = 0.01;
const activePools = new Set();

function finiteNumber(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

export function estimateWeeklyQuota(usage, now = Date.now()) {
  const window = usage?.seven_day;
  const stats = window?.window_stats;
  const percent = Number(window?.utilization);
  const cost = Number(stats?.cost);
  const userCost = Number(stats?.user_cost);
  const resetAt = Date.parse(window?.resets_at);
  if (!finiteNumber(window?.utilization) || percent < MINIMUM_USAGE_PERCENT || percent > 100 ||
      !finiteNumber(stats?.cost) || cost <= 0 || !finiteNumber(stats?.user_cost) || userCost <= 0 ||
      !Number.isFinite(resetAt) || resetAt <= now || resetAt > now + 8 * 86400000) return null;
  if (!Number.isFinite(cost * 100 / percent) || !Number.isFinite(userCost * 100 / percent)) return null;
  return {
    estimatedTotalUsd: cost * 100 / percent,
    // Subscription limits consume user-billed dollars, not account-billed dollars.
    estimatedUserTotalUsd: userCost * 100 / percent,
    accountUsedUsd: cost,
    userUsedUsd: userCost,
    usedPercent: percent,
    cycleResetAt: new Date(resetAt).toISOString(),
  };
}

export function calculateSharedWeeklyLimit(totalBudgetUsd, poolUsedUsd, usages) {
  if (!Number.isFinite(totalBudgetUsd) || totalBudgetUsd <= 0 ||
      !Number.isFinite(poolUsedUsd) || poolUsedUsd < 0 || !usages.length ||
      usages.some((value) => !Number.isFinite(value) || value < 0)) return null;
  const remaining = Math.max(0, totalBudgetUsd - poolUsedUsd);
  if (remaining <= 0) return null;
  // Equal total ceilings. Already spent quota (including departed users) cannot
  // be reclaimed: the sum of all remaining allowances must fit the pool.
  let low = 0;
  let high = Math.max(...usages) + remaining;
  for (let iteration = 0; iteration < 64; iteration++) {
    const middle = (low + high) / 2;
    const allowances = usages.reduce((sum, used) => sum + Math.max(0, middle - used), 0);
    if (allowances <= remaining) low = middle;
    else high = middle;
  }
  const limit = Math.floor((low + 1e-9) * 100) / 100;
  return limit >= MINIMUM_LIMIT_USD ? limit : null;
}

// 按比例分配：每人周上限 = 权重 × k，已用额度不清零，剩余份额总和不超过剩余预算。
// 权重全为 1 时与平均分配结果一致。
export function calculateProportionalLimits(totalBudgetUsd, poolUsedUsd, entries) {
  if (!Number.isFinite(totalBudgetUsd) || totalBudgetUsd <= 0 ||
      !Number.isFinite(poolUsedUsd) || poolUsedUsd < 0 || !entries.length ||
      entries.some(({ used, weight }) => !Number.isFinite(used) || used < 0 || !Number.isFinite(weight) || weight <= 0)) return null;
  const remaining = totalBudgetUsd - poolUsedUsd;
  if (remaining <= 0) return null;
  let low = 0;
  let high = Math.max(...entries.map(({ used, weight }) => used / weight)) + remaining / Math.min(...entries.map(({ weight }) => weight));
  for (let iteration = 0; iteration < 64; iteration++) {
    const middle = (low + high) / 2;
    const allowances = entries.reduce((sum, { used, weight }) => sum + Math.max(0, weight * middle - used), 0);
    if (allowances <= remaining) low = middle;
    else high = middle;
  }
  const shares = entries.map(({ userId, used, weight }) => ({ userId, weight, usedUsd: used,
    recommendedLimitUsd: Math.floor((weight * low + 1e-9) * 100) / 100 }));
  return shares.some((share) => share.recommendedLimitUsd >= MINIMUM_LIMIT_USD) ? shares : null;
}

export const PROPORTIONAL_PREVIEW_NOTE = "按比例分配需要订阅级限额接口，当前仅计算预览";

export function publicQuotaSharing(config, state) {
  if (!config.quotaSharingDisplayEnabled) return null;
  if (!state) return { status: "waiting", note: "等待首次额度采样" };
  const { status, note, checkedAt, estimatedAt, estimatedTotalUsd, estimatedUserTotalUsd, distributableTotalUsd,
    userUsedUsd, usedPercent, cycleResetAt, reservePercent, subscriberCount, recommendedWeeklyLimitUsd,
    currentWeeklyLimitUsd, lastAppliedAt, proportionalShares } = state;
  // 公开页只给出按比例分配的上下限，不暴露用户 ID 和权重。
  const limits = Array.isArray(proportionalShares) ? proportionalShares.map((share) => share.recommendedLimitUsd) : [];
  return { status, note, checkedAt, estimatedAt, estimatedTotalUsd, estimatedUserTotalUsd, distributableTotalUsd,
    userUsedUsd, usedPercent, cycleResetAt, reservePercent, subscriberCount, recommendedWeeklyLimitUsd,
    currentWeeklyLimitUsd, lastAppliedAt, mode: state.mode || config.quotaSharingMode || "equal",
    proportionalMinLimitUsd: limits.length ? Math.min(...limits) : null,
    proportionalMaxLimitUsd: limits.length ? Math.max(...limits) : null };
}

export class QuotaSharingService {
  constructor({ database, configStore, audit = () => {}, emit = () => {} }) {
    this.database = database;
    this.configStore = configStore;
    this.audit = audit;
    this.emit = emit;
  }

  save(config, state) {
    // Do not republish data after configuration changes during upstream reads.
    const current = this.database.getMonitor(config.id);
    if (!current || this.signature(current) !== this.signature(config)) return null;
    this.database.setSetting(`quota_sharing:${config.id}`, state);
    this.emit("quota-sharing", publicQuotaSharing(config, state));
    return state;
  }

  signature(config) {
    return JSON.stringify([config.baseUrl, config.sourceAccountId, config.authSecretCipher, config.quotaSharingGroupId,
      config.quotaSharingEnabled, config.quotaSharingReserveEnabled, config.quotaSharingReservePercent,
      config.quotaSharingAutoRecalculateEnabled, config.quotaSharingIntervalSeconds, config.quotaSharingDisplayEnabled,
      config.quotaSharingMode || "equal", config.quotaSharingWeights || {}, config.dryRun, config.enabled]);
  }

  async groupAccounts(client, groupId) {
    const accounts = [];
    for (let page = 1; page <= 1000; page++) {
      const result = await client.listGroupAccounts(groupId, page);
      if (!Array.isArray(result?.items) || !Number.isInteger(Number(result?.pages)) || Number(result.pages) < 1) {
        throw new Error("无法验证专用分组中的账号列表");
      }
      accounts.push(...result.items);
      if (page >= Number(result.pages)) return accounts;
    }
    throw new Error("专用分组账号分页数量异常");
  }

  async refresh(config, client, { manual = false, force = false } = {}) {
    if (!config.quotaSharingEnabled && !config.quotaSharingDisplayEnabled) return null;
    const previous = this.database.getSetting(`quota_sharing:${config.id}`);
    const now = Date.now();
    if (!manual && !force && previous && now - Date.parse(previous.checkedAt) < config.quotaSharingIntervalSeconds * 1000) return previous;
    const poolKey = `${config.baseUrl}:${config.quotaSharingGroupId || config.sourceAccountId}`;
    if (activePools.has(poolKey)) {
      // 自动路径与其它路径一致：不抛错，保留上次结果。
      if (!manual) return previous || null;
      throw new Error("该额度池正在重算，请稍后重试");
    }
    activePools.add(poolKey);
    const mode = config.quotaSharingMode === "proportional" ? "proportional" : "equal";
    const state = { checkedAt: new Date(now).toISOString(), lastAppliedAt: previous?.lastAppliedAt || null, mode,
      status: "waiting", note: "等待完整周窗口数据，使用率达到 5% 后开始估算" };
    try {
      const usage = await client.getAccountUsage(config.sourceAccountId);
      const estimate = estimateWeeklyQuota(usage, now);
      if (!estimate) {
        // Never reuse last cycle's costs after a reset or a zero-use window.
        return this.save(config, state);
      }
      Object.assign(state, estimate, { estimatedAt: state.checkedAt, status: "ready", note: "周总额度为费用与使用率的估算值" });
      state.reservePercent = config.quotaSharingReserveEnabled ? config.quotaSharingReservePercent : 0;
      state.distributableTotalUsd = estimate.estimatedUserTotalUsd * (1 - state.reservePercent / 100);
      if (!config.quotaSharingEnabled) return this.save(config, state);

      const groupId = config.quotaSharingGroupId;
      const [account, group, accounts] = await Promise.all([
        client.getAccount(config.sourceAccountId), client.getGroup(groupId), this.groupAccounts(client, groupId),
      ]);
      if (group?.status !== "active" || group?.subscription_type !== "subscription" || group?.platform !== "openai" ||
          account?.status !== "active" || account?.platform !== "openai" || account?.type !== "oauth" ||
          accounts.length !== 1 || Number(accounts[0].id) !== config.sourceAccountId ||
          !Array.isArray(account.group_ids) || account.group_ids.length !== 1 || Number(account.group_ids[0]) !== groupId) {
        throw new Error("额度均分要求专用 OpenAI 订阅分组：分组仅绑定当前 OAuth 源账号，源账号也只能绑定此分组");
      }
      if (this.database.listMonitors().some((m) => m.id !== config.id && m.quotaSharingEnabled &&
          m.baseUrl === config.baseUrl && m.quotaSharingGroupId === groupId)) {
        throw new Error("该分组被多个监控任务管理，请保留一个额度均分任务");
      }
      const subscriptions = (await listActiveSubscriptions(client, groupId, { strict: true })).filter((sub) =>
        (!sub.starts_at || Date.parse(sub.starts_at) <= now) && (!sub.user?.status || sub.user.status === "active"));
      const uniqueUsers = new Set(subscriptions.map((sub) => Number(sub.user_id)));
      if (subscriptions.some((sub) => Number(sub.group_id) !== groupId || !Number.isSafeInteger(Number(sub.user_id)) ||
          Number(sub.user_id) <= 0 || !finiteNumber(sub.weekly_usage_usd) || Number(sub.weekly_usage_usd) < 0) || uniqueUsers.size !== subscriptions.length) {
        throw new Error("订阅人数或周用量数据异常，保留现有额度");
      }
      state.subscriberCount = uniqueUsers.size;
      state.currentWeeklyLimitUsd = finiteNumber(group.weekly_limit_usd) ? Number(group.weekly_limit_usd) : null;
      if (mode === "proportional") {
        // Sub2API 只提供分组级 weekly_limit_usd，无法给每个订阅写不同上限：只计算预览，绝不写入。
        const weights = config.quotaSharingWeights || {};
        state.recommendedWeeklyLimitUsd = null;
        state.proportionalShares = calculateProportionalLimits(state.distributableTotalUsd, estimate.userUsedUsd,
          subscriptions.map((sub) => ({ userId: Number(sub.user_id), used: Number(sub.weekly_usage_usd),
            weight: Number(weights[String(sub.user_id)] ?? 1) })));
        if (!state.proportionalShares) {
          state.status = "blocked";
          state.note = subscriptions.length ? "可分配预算不足，保留现有限额；不会将 0 写成不限额" : "暂无有效订阅，保留现有限额";
        } else {
          state.status = "preview";
          state.note = PROPORTIONAL_PREVIEW_NOTE;
        }
        return this.save(config, state);
      }
      state.recommendedWeeklyLimitUsd = calculateSharedWeeklyLimit(state.distributableTotalUsd, estimate.userUsedUsd,
        subscriptions.map((sub) => Number(sub.weekly_usage_usd)));
      if (!state.recommendedWeeklyLimitUsd) {
        state.status = "blocked";
        state.note = subscriptions.length ? "可分配预算不足，保留现有限额；不会将 0 写成不限额" : "暂无有效订阅，保留现有限额";
        return this.save(config, state);
      }
      if (!(manual || config.quotaSharingAutoRecalculateEnabled) || config.dryRun) {
        state.status = "preview";
        state.note = config.dryRun ? "预览模式，未修改订阅额度" : "定时同步已关闭，可手动重算并同步";
        return this.save(config, state);
      }
      const current = this.configStore.getPrivate();
      if (this.signature(current) !== this.signature(config)) return null;
      const change = state.currentWeeklyLimitUsd === null || state.currentWeeklyLimitUsd <= 0 ? Infinity
        : Math.abs(state.recommendedWeeklyLimitUsd - state.currentWeeklyLimitUsd) / state.currentWeeklyLimitUsd;
      // Filter small increases, but immediately apply budget reductions.
      if (state.currentWeeklyLimitUsd === state.recommendedWeeklyLimitUsd ||
          (!manual && state.recommendedWeeklyLimitUsd > state.currentWeeklyLimitUsd && change < 0.02)) {
        state.status = "unchanged";
        state.note = "当前统一周上限已接近均分结果";
      } else {
        await client.updateGroupWeeklyLimit(groupId, state.recommendedWeeklyLimitUsd);
        state.currentWeeklyLimitUsd = state.recommendedWeeklyLimitUsd;
        state.lastAppliedAt = new Date().toISOString();
        state.status = "applied";
        state.note = "统一周上限已同步，用户已用额度保留";
        this.audit("info", "quota_sharing.applied", "Shared weekly quota updated", {
          groupId, subscriberCount: state.subscriberCount, estimatedTotalUsd: state.estimatedTotalUsd,
          reservePercent: state.reservePercent, weeklyLimitUsd: state.recommendedWeeklyLimitUsd,
        });
      }
      return this.save(config, state);
    } catch (error) {
      state.status = "error";
      state.note = "重算失败，保留现有订阅额度";
      state.lastError = error instanceof Error ? error.message : String(error);
      this.audit("warn", "quota_sharing.failed", "Shared quota recalculation failed", { error: state.lastError });
      this.save(config, state);
      if (manual) throw error;
      return state;
    } finally {
      activePools.delete(poolKey);
    }
  }
}
