function subscriptionIsActive(subscription) {
  if (!subscription || subscription.status !== "active") return false;
  if (!subscription.expires_at) return true;
  const expiresAt = Date.parse(subscription.expires_at);
  return !Number.isFinite(expiresAt) || expiresAt > Date.now();
}

export async function discoverSubscriptionGroupIds(client, config) {
  if (config.subscriptionGroupMode === "none") return [];
  if (config.subscriptionGroupMode === "explicit") return config.subscriptionGroupIds;
  const [account, groups] = await Promise.all([
    client.getAccount(config.sourceAccountId),
    client.listGroups(),
  ]);
  const sourceGroupIds = new Set((account.group_ids || []).map(Number));
  return (groups || [])
    .filter((group) =>
      sourceGroupIds.has(Number(group.id)) &&
      group.subscription_type === "subscription" &&
      group.status === "active")
    .map((group) => Number(group.id));
}

export async function listActiveSubscriptions(client, groupId) {
  const subscriptions = [];
  let page = 1;
  for (;;) {
    const result = await client.listSubscriptions(groupId, page);
    const items = Array.isArray(result?.items) ? result.items : [];
    subscriptions.push(...items.filter(subscriptionIsActive));
    const pages = Number(result?.pages) || 1;
    if (page >= pages) break;
    page += 1;
  }
  return subscriptions;
}

function maskCore(value, prefix = "", suffix = "") {
  const characters = Array.from(String(value || ""));
  if (!characters.length) return null;
  return {
    prefix,
    leading: characters[0],
    trailing: characters.length > 1 ? characters.at(-1) : "",
    obscured: characters.length > 2,
    suffix,
  };
}

export function maskSubscriberIdentity(subscription) {
  const email = String(subscription?.user?.email || subscription?.email || "").trim();
  const at = email.lastIndexOf("@");
  if (at > 0 && at < email.length - 1) {
    return { kind: "email", ...maskCore(email.slice(0, at), "", email.slice(at)) };
  }
  const username = String(subscription?.user?.username || subscription?.username || "").trim();
  if (username) return { kind: "username", ...maskCore(username) };
  return { kind: "id", ...maskCore(subscription?.user_id, "#") };
}

function usageMetric(subscription, window) {
  const used = Number(subscription?.[`${window}_usage_usd`]);
  const limit = Number(subscription?.group?.[`${window}_limit_usd`]);
  if (!Number.isFinite(used)) return null;
  return {
    used,
    limit: Number.isFinite(limit) && limit > 0 ? limit : null,
    percentage: Number.isFinite(limit) && limit > 0
      ? Math.round((used / limit) * 1000) / 10
      : null,
  };
}

export async function buildSubscriberPreview(client, config, maximumItems = 1000) {
  const resetWindows = config.subscriptionResetWindows || ["weekly"];
  const groupIds = await discoverSubscriptionGroupIds(client, config);
  const batches = await Promise.all(groupIds.map(async (groupId) => ({
    groupId,
    subscriptions: await listActiveSubscriptions(client, groupId),
  })));
  const seen = new Set();
  const subscribers = [];
  for (const { groupId, subscriptions } of batches) {
    for (const subscription of subscriptions) {
      const identityKey = `${groupId}:${subscription.user_id ?? subscription.id}`;
      if (seen.has(identityKey)) continue;
      seen.add(identityKey);
      subscribers.push({
        identity: maskSubscriberIdentity(subscription),
        groupId,
        groupName: subscription.group?.name || null,
        status: subscription.status,
        expiresAt: subscription.expires_at || null,
        usage: Object.fromEntries(
          resetWindows
            .map((window) => [window, usageMetric(subscription, window)])
            .filter(([, metric]) => metric),
        ),
      });
    }
  }
  return {
    groups: groupIds,
    resetWindows,
    total: subscribers.length,
    truncated: subscribers.length > maximumItems,
    subscribers: subscribers.slice(0, maximumItems),
  };
}

export function toPublicSubscriberPreview(preview) {
  return {
    enabled: true,
    resetWindows: preview.resetWindows,
    groupCount: preview.groups?.length || 0,
    total: preview.total,
    truncated: preview.truncated,
    generatedAt: preview.generatedAt,
    subscribers: preview.subscribers.map((subscriber) => ({
      identity: subscriber.identity,
      groupName: subscriber.groupName,
      status: subscriber.status,
      expiresAt: subscriber.expiresAt,
      usage: subscriber.usage,
    })),
  };
}
