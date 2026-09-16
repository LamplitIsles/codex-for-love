import assert from "node:assert/strict";
import test from "node:test";
import { companionTranslate } from "../src/lib/companion/client/locale.ts";
import { keetRecoveryNotice } from "../src/lib/companion/client/keet-recovery.ts";

test("Keet recovery status exposes every persisted missing range in the client UI contract", () => {
  const losses = [{ first: 4, last: 6 }, { first: 9, last: 9 }];

  assert.equal(
    keetRecoveryNotice(losses, companionTranslate("en")),
    "Keet could not recover messages 4–6, 9; affected group context was cleared.",
  );
  assert.equal(
    keetRecoveryNotice(losses, companionTranslate("zh")),
    "Keet 未能恢复消息 4–6, 9；受影响的群组上下文已清除。",
  );
  assert.equal(keetRecoveryNotice([], companionTranslate("en")), undefined);
});
