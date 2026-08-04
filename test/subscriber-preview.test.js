import assert from "node:assert/strict";
import test from "node:test";
import { buildSubscriberPreview, maskSubscriberIdentity } from "../src/server/subscriber-preview.js";

test("subscriber identities retain only edge characters and the email suffix", () => {
  assert.deepEqual(maskSubscriberIdentity({ user: { email: "alice@example.com" } }), {
    kind: "email",
    prefix: "",
    leading: "a",
    trailing: "e",
    obscured: true,
    suffix: "@example.com",
  });
  assert.deepEqual(maskSubscriberIdentity({ user: { username: "member-seven" } }), {
    kind: "username",
    prefix: "",
    leading: "m",
    trailing: "n",
    obscured: true,
    suffix: "",
  });
});

test("subscriber preview paginates active subscriptions and never returns raw identities", async () => {
  const client = {
    async listSubscriptions(groupId, page) {
      assert.equal(groupId, 10);
      if (page === 1) return {
        pages: 2,
        items: [
          { id: 1, user_id: 7, status: "active", expires_at: null, user: { email: "alice@example.com" }, group: { name: "Codex Pro" } },
          { id: 2, user_id: 8, status: "revoked", expires_at: null, user: { email: "revoked@example.com" } },
        ],
      };
      return {
        pages: 2,
        items: [{ id: 3, user_id: 9, status: "active", expires_at: null, user: { username: "member-nine" }, group: { name: "Codex Pro" } }],
      };
    },
  };
  const preview = await buildSubscriberPreview(client, {
    subscriptionGroupMode: "explicit",
    subscriptionGroupIds: [10],
  });

  assert.equal(preview.total, 2);
  assert.equal(preview.subscribers[0].groupName, "Codex Pro");
  const serialized = JSON.stringify(preview);
  for (const rawIdentity of ["alice", "member-nine", "revoked", "user_id", "userId"]) {
    assert.equal(serialized.includes(rawIdentity), false, `${rawIdentity} leaked into subscriber preview`);
  }
});

test("automatic mode only discovers active subscription groups attached to the source account", async () => {
  const client = {
    async getAccount() { return { group_ids: [10, 11, 12] }; },
    async listGroups() {
      return [
        { id: 10, subscription_type: "subscription", status: "active" },
        { id: 11, subscription_type: "standard", status: "active" },
        { id: 12, subscription_type: "subscription", status: "disabled" },
      ];
    },
    async listSubscriptions() { return { pages: 1, items: [] }; },
  };
  const preview = await buildSubscriberPreview(client, {
    sourceAccountId: 28,
    subscriptionGroupMode: "auto",
    subscriptionGroupIds: [],
  });
  assert.deepEqual(preview.groups, [10]);
});
