import assert from "node:assert/strict";
import { withLoginExample } from "./lib/login-environment.mjs";

await withLoginExample(async ({ client, live, fixture }) => {
  const login = await client.loginChatGPT();
  // Do not print the authorization URL or open it: this demonstrates cancellation, not sign-in.
  assert.ok(login.loginId && login.authUrl);
  const canceled = await login.cancel();
  assert.equal(canceled.status, "canceled");
  const completion = await login.wait({ timeoutMs: 15_000 });
  assert.equal(completion.loginId, login.loginId);
  assert.equal(completion.success, false);
  const account = await client.account(false);
  assert.equal(account.account, null);
  assert.equal(account.requiresOpenaiAuth, true);
  console.log("login.cancel:", canceled.status, "login.success:", completion.success);
  console.log("account: none; requiresOpenaiAuth:", account.requiresOpenaiAuth);
  if (!live) assert.deepEqual(fixture.messages.filter((message) => message.id !== undefined)
    .map((message) => message.method), ["initialize", "account/login/start", "account/login/cancel", "account/read"]);
});
