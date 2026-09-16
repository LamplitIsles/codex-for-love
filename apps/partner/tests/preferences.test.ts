import assert from "node:assert/strict";
import test from "node:test";
import { appearancePreference, languagePreference, preferredLanguage, readPreference, resolveScheme, writePreference } from "../src/lib/companion/client/preferences.ts";

test("Companion preferences accept only supported explicit values", () => {
  assert.equal(languagePreference("zh"), "zh");
  assert.equal(languagePreference("zh-CN"), undefined);
  assert.equal(appearancePreference("system"), "system");
  assert.equal(appearancePreference("midnight"), undefined);
});

test("Companion browser language and appearance resolve safely", () => {
  assert.equal(preferredLanguage(["zh-CN", "en"]), "zh");
  assert.equal(preferredLanguage(["en-US", "zh-CN"]), "en");
  assert.equal(preferredLanguage(["fr-FR"]), "en");
  assert.equal(resolveScheme("system", true), "dark");
  assert.equal(resolveScheme("system", false), "light");
  assert.equal(resolveScheme("light", true), "light");
});

test("blocked browser storage does not prevent preference operations", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } } });
  assert.equal(readPreference("appearance"), undefined);
  assert.doesNotThrow(() => writePreference("appearance", "dark"));
  if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
  else Reflect.deleteProperty(globalThis, "localStorage");
});
