import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withSmokeCleanup } from "../smoke-cleanup.mjs";

test("cleans a real nested fixture before returning the smoke result", () => {
  const root = mkdtempSync(join(tmpdir(), "smoke-cleanup-test-"));
  const result = withSmokeCleanup(root, () => {
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested", "file"), "fixture");
    return "passed";
  });
  assert.equal(result, "passed");
  assert.equal(existsSync(root), false);
  // An already-removed fixture is harmless, not a reason to skip other errors.
  withSmokeCleanup(root, () => {});
});

test("requests bounded native retries and does not hide persistent cleanup failures", () => {
  const failure = Object.assign(new Error("still busy"), { code: "ENOTEMPTY" });
  assert.throws(() => withSmokeCleanup("test-owned-directory", () => {}, (path, options) => {
    assert.equal(path, "test-owned-directory");
    assert.deepEqual(options, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    throw failure;
  }), (error) => error === failure);
});

test("cleans after smoke failure and preserves the original failure", () => {
  const root = mkdtempSync(join(tmpdir(), "smoke-cleanup-test-"));
  const failure = new Error("consumer failed");
  assert.throws(() => withSmokeCleanup(root, () => { throw failure; }), (error) => error === failure);
  assert.equal(existsSync(root), false);
});

test("reports both failures when the smoke and cleanup fail", () => {
  const smokeFailure = new Error("consumer failed");
  const cleanupFailure = new Error("cleanup failed");
  assert.throws(() => withSmokeCleanup("test-owned-directory", () => { throw smokeFailure; },
    () => { throw cleanupFailure; }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [smokeFailure, cleanupFailure]);
    return true;
  });
});

test("Windows retries deletion until a real non-delete-sharing handle closes", {
  skip: process.platform !== "win32", timeout: 15_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "smoke-cleanup-lock-"));
  const locked = join(root, "runtime.exe");
  writeFileSync(locked, "fixture, not an executable");
  const holder = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", [
    "$ErrorActionPreference = 'Stop'",
    "$handle = [System.IO.File]::Open($env:CODEX_SMOKE_LOCK_FILE, 'Open', 'Read', 'Read')",
    "try { [Console]::WriteLine('locked'); [Console]::Out.Flush(); [void][Console]::In.ReadLine(); Start-Sleep -Milliseconds 500 } finally { $handle.Dispose() }",
  ].join("; ")], { env: { ...process.env, CODEX_SMOKE_LOCK_FILE: locked }, stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(holder, "exit");
  // Attach the rejection handler immediately even if spawn fails before the ready handshake.
  void exited.catch(() => {});
  let stderr = "";
  holder.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  try {
    await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("File-lock fixture did not become ready")), 5_000);
      holder.once("error", (error) => { clearTimeout(timer); reject(error); });
      holder.once("exit", () => { clearTimeout(timer); reject(new Error("File-lock fixture exited: " + stderr)); });
      holder.stdout.setEncoding("utf8").on("data", (chunk) => {
        output += chunk;
        if (output.includes("locked")) { clearTimeout(timer); resolve(); }
      });
    });
    // This proves the lock is effective before testing the retry-enabled removal.
    assert.throws(() => rmSync(locked), (error) => error.code === "EPERM" || error.code === "EBUSY");
    // Start the release delay only after the assertion, independent of runner scheduling.
    holder.stdin.end("release\n");
    withSmokeCleanup(root, () => {});
    assert.equal(existsSync(root), false);
    const [code] = await exited;
    assert.equal(code, 0, stderr);
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill();
    await exited.catch(() => {});
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
