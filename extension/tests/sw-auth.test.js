import { describe, expect, it } from "vitest";
import { createFakeChrome } from "./helpers/fake-chrome.js";
import { createAuth, TOKEN_HEADER } from "../sw/auth.js";
import { sendNativeCommand } from "../sw/native.js";
import { NATIVE_HOST } from "../shared/constants.js";

describe("sw/auth", () => {
  it("init restricts storage.session to trusted contexts and removes the v3 local token", async () => {
    const chrome = createFakeChrome({ storage: { local: { installToken: "leaked", speed: 2 } } });
    chrome.storage.session.accessLevel = "TRUSTED_AND_UNTRUSTED_CONTEXTS";
    await createAuth({ chrome }).init();
    expect(chrome.storage.session.accessLevel).toBe("TRUSTED_CONTEXTS");
    expect(chrome.fake.storageData.local).toEqual({ speed: 2 });
  });

  it("init is idempotent and never rejects", async () => {
    const chrome = createFakeChrome();
    chrome.fake.failNext("storage.session.setAccessLevel", "nope");
    const auth = createAuth({ chrome });
    await expect(auth.init()).resolves.toBeUndefined();
    await expect(auth.init()).resolves.toBeUndefined();
  });

  it("getToken reads storage.session without calling the native host", async () => {
    const chrome = createFakeChrome({ storage: { session: { installToken: "tok" } } });
    const auth = createAuth({ chrome });
    expect(await auth.getToken()).toBe("tok");
    expect(chrome.runtime.sendNativeMessage.calls).toHaveLength(0);
    expect(await auth.authHeaders()).toEqual({ [TOKEN_HEADER]: "tok" });
    expect(await auth.authHeaders({ json: true })).toEqual({ [TOKEN_HEADER]: "tok", "Content-Type": "application/json" });
  });

  it("getToken on a miss asks the native host status and stores the token in storage.session only", async () => {
    const chrome = createFakeChrome();
    chrome.runtime.sendNativeMessage.impl = () => ({ success: true, install_token: "fresh" });
    const auth = createAuth({ chrome });
    expect(await auth.getToken()).toBe("fresh");
    expect(chrome.runtime.sendNativeMessage.calls[0].slice(0, 2)).toEqual([NATIVE_HOST, { command: "status" }]);
    expect(chrome.fake.storageData.session.installToken).toBe("fresh");
    expect(chrome.fake.storageData.local.installToken).toBeUndefined();
  });

  it("refreshToken is single-flight and resolves empty when the host is missing", async () => {
    const chrome = createFakeChrome();
    const auth = createAuth({ chrome });
    const [a, b] = await Promise.all([auth.refreshToken(), auth.refreshToken()]);
    expect([a, b]).toEqual(["", ""]);
    expect(chrome.runtime.sendNativeMessage.calls).toHaveLength(1);
    expect(await auth.authHeaders()).toEqual({});
  });

  it("refreshToken replaces a stale token", async () => {
    const chrome = createFakeChrome({ storage: { session: { installToken: "stale" } } });
    chrome.runtime.sendNativeMessage.impl = () => ({ install_token: "new" });
    const auth = createAuth({ chrome });
    expect(await auth.refreshToken()).toBe("new");
    expect(await auth.getToken()).toBe("new");
  });
});

describe("sw/native", () => {
  it("rejects with lastError", async () => {
    const chrome = createFakeChrome();
    await expect(sendNativeCommand(chrome, "start")).rejects.toThrow(/native messaging host not found/);
  });

  it("resolves the host response", async () => {
    const chrome = createFakeChrome();
    chrome.runtime.sendNativeMessage.impl = (host, message) => ({ success: true, message: message.command });
    await expect(sendNativeCommand(chrome, "stop")).resolves.toEqual({ success: true, message: "stop" });
  });
});
