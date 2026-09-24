import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeChrome, flush } from "./helpers/fake-chrome.js";
import { BADGE_HINT_TITLE, createMenus, MENU_ID } from "../sw/menus.js";
import { MSG } from "../shared/messages.js";

function setup() {
  const chrome = createFakeChrome();
  const router = {
    speak: vi.fn(async () => ({ runId: "m1", hostKind: "offscreen" })),
    togglePause: vi.fn(async () => null),
  };
  const menus = createMenus({ chrome, router });
  return { chrome, router, menus };
}

describe("sw/menus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("installs the selection context menu", async () => {
    const { chrome, menus } = setup();
    menus.install();
    await flush();
    menus.install();
    await flush();
    expect(chrome.fake.menus.get(MENU_ID)).toEqual({ id: MENU_ID, title: "Read with Open TTS", contexts: ["selection"] });
    expect(chrome.contextMenus.create.calls).toHaveLength(2);
  });

  it("a menu click starts a SPEAK bound to the tab and frame", async () => {
    const { router, menus } = setup();
    await menus.onMenuClick({ menuItemId: MENU_ID, selectionText: "Menu words", frameId: 3 }, { id: 12 });
    expect(router.speak).toHaveBeenCalledWith({ text: "Menu words", source: "menu", sourceTabId: 12, sourceFrameId: 3 });
  });

  it("menu clicks for other items are ignored; missing tab/frame default sanely", async () => {
    const { router, menus } = setup();
    await menus.onMenuClick({ menuItemId: "other", selectionText: "x" }, { id: 1 });
    expect(router.speak).not.toHaveBeenCalled();
    await menus.onMenuClick({ menuItemId: MENU_ID, selectionText: "pdf text" }, { id: -1 });
    expect(router.speak).toHaveBeenCalledWith({ text: "pdf text", source: "menu", sourceTabId: null, sourceFrameId: 0 });
  });

  it("read-selection asks the content script and starts a command run on frame 0", async () => {
    const { chrome, router, menus } = setup();
    chrome.tabs.sendMessage.impl = () => ({ text: "Selected text" });
    await menus.onCommand("read-selection", { id: 4 });
    expect(chrome.tabs.sendMessage.calls[0]).toEqual([4, { type: MSG.CONTENT_GET_SELECTION }]);
    expect(router.speak).toHaveBeenCalledWith({ text: "Selected text", source: "command", sourceTabId: 4, sourceFrameId: 0 });
  });

  it("read-selection with no content script shows the badge hint, cleared after 4 s", async () => {
    const { chrome, router, menus } = setup();
    await menus.onCommand("read-selection", { id: 4 });
    expect(router.speak).not.toHaveBeenCalled();
    expect(chrome.action.setBadgeText.calls[0]).toEqual([{ tabId: 4, text: "?" }]);
    expect(chrome.action.setTitle.calls[0]).toEqual([{ tabId: 4, title: BADGE_HINT_TITLE }]);
    await vi.advanceTimersByTimeAsync(3900);
    expect(chrome.action.setBadgeText.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(chrome.action.setBadgeText.calls[1]).toEqual([{ tabId: 4, text: "" }]);
    expect(chrome.action.setTitle.calls[1]).toEqual([{ tabId: 4, title: "Open TTS" }]);
  });

  it("read-selection with an empty selection shows the hint", async () => {
    const { chrome, router, menus } = setup();
    chrome.tabs.sendMessage.impl = () => ({ text: "  " });
    await menus.onCommand("read-selection", { id: 4 });
    expect(router.speak).not.toHaveBeenCalled();
    expect(chrome.action.setBadgeText.calls[0]).toEqual([{ tabId: 4, text: "?" }]);
  });

  it("read-selection falls back to the active tab", async () => {
    const { chrome, router, menus } = setup();
    chrome.fake.addTab({ id: 8, active: true });
    chrome.tabs.sendMessage.impl = () => ({ text: "Hi" });
    await menus.onCommand("read-selection", undefined);
    expect(router.speak).toHaveBeenCalledWith(expect.objectContaining({ sourceTabId: 8 }));
  });

  it("toggle-pause toggles the current run", async () => {
    const { router, menus } = setup();
    await menus.onCommand("toggle-pause", { id: 1 });
    expect(router.togglePause).toHaveBeenCalledTimes(1);
    router.togglePause.mockRejectedValueOnce(new Error("Still preparing playback"));
    await expect(menus.onCommand("toggle-pause", { id: 1 })).resolves.toBeNull();
  });

  it("a tab closing cancels its pending hint reset", async () => {
    const { chrome, menus } = setup();
    await menus.showHint(4);
    menus.onTabRemoved(4);
    await vi.advanceTimersByTimeAsync(5000);
    expect(chrome.action.setBadgeText.calls).toHaveLength(1);
  });
});
