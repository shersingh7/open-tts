// @ts-check
// Open TTS v4 — context menu "Read with Open TTS" and keyboard commands (plan 4.1 / 4.2). Runs started here are bound
// to the tab (menu: the clicked frame; command: frame 0) so that tab's widget can control them.

import { MSG } from "../shared/messages.js";

export const MENU_ID = "open-tts-read";
export const MENU_TITLE = "Read with Open TTS";
export const COMMAND_READ = "read-selection";
export const COMMAND_TOGGLE = "toggle-pause";
export const BADGE_HINT_MS = 4000;
export const BADGE_HINT_TITLE = "Use right-click → Read with Open TTS";
export const DEFAULT_TITLE = "Open TTS";

/**
 * @param {object} deps
 * @param {typeof chrome} deps.chrome
 * @param {Pick<import("./router.js").Router, "speak"|"togglePause">} deps.router
 */
export function createMenus({ chrome: chromeApi, router }) {
  /** @type {Map<number, ReturnType<typeof setTimeout>>} */
  const hintTimers = new Map();

  /** Create the context menu (call from runtime.onInstalled). Never throws. */
  function install() {
    chromeApi.contextMenus.removeAll(() => {
      void chromeApi.runtime.lastError;
      chromeApi.contextMenus.create({ id: MENU_ID, title: MENU_TITLE, contexts: ["selection"] }, () => {
        void chromeApi.runtime.lastError;
      });
    });
  }

  /**
   * Badge "?" plus a title hint on the tab, cleared after BADGE_HINT_MS.
   * @param {number} tabId
   */
  async function showHint(tabId) {
    const previous = hintTimers.get(tabId);
    if (previous) clearTimeout(previous);
    await Promise.allSettled([
      chromeApi.action.setBadgeText({ tabId, text: "?" }),
      chromeApi.action.setTitle({ tabId, title: BADGE_HINT_TITLE }),
    ]);
    hintTimers.set(tabId, setTimeout(() => {
      hintTimers.delete(tabId);
      void Promise.allSettled([
        chromeApi.action.setBadgeText({ tabId, text: "" }),
        chromeApi.action.setTitle({ tabId, title: DEFAULT_TITLE }),
      ]);
    }, BADGE_HINT_MS));
  }

  /**
   * contextMenus.onClicked
   * @param {chrome.contextMenus.OnClickData} info
   * @param {chrome.tabs.Tab} [tab]
   */
  async function onMenuClick(info, tab) {
    if (info.menuItemId !== MENU_ID) return null;
    try {
      return await router.speak({
        text: info.selectionText || "",
        source: "menu",
        sourceTabId: typeof tab?.id === "number" && tab.id >= 0 ? tab.id : null,
        sourceFrameId: info.frameId ?? 0,
      });
    } catch {
      return null;
    }
  }

  /** @param {chrome.tabs.Tab} [tab] */
  async function resolveTabId(tab) {
    if (typeof tab?.id === "number" && tab.id >= 0) return tab.id;
    const [active] = await chromeApi.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    return typeof active?.id === "number" ? active.id : null;
  }

  /** @param {chrome.tabs.Tab} [tab] */
  async function readSelection(tab) {
    const tabId = await resolveTabId(tab);
    if (tabId === null) return null;
    const response = await chromeApi.tabs.sendMessage(tabId, { type: MSG.CONTENT_GET_SELECTION }).catch(() => null);
    const text = typeof response?.text === "string" ? response.text : "";
    if (!text.trim()) {
      await showHint(tabId);
      return null;
    }
    try {
      return await router.speak({ text, source: "command", sourceTabId: tabId, sourceFrameId: 0 });
    } catch {
      await showHint(tabId);
      return null;
    }
  }

  /**
   * commands.onCommand
   * @param {string} command
   * @param {chrome.tabs.Tab} [tab]
   */
  async function onCommand(command, tab) {
    if (command === COMMAND_READ) return readSelection(tab);
    if (command === COMMAND_TOGGLE) return router.togglePause().catch(() => null);
    return null;
  }

  /** @param {number} tabId */
  function onTabRemoved(tabId) {
    const timer = hintTimers.get(tabId);
    if (timer) clearTimeout(timer);
    hintTimers.delete(tabId);
  }

  return { install, onMenuClick, onCommand, onTabRemoved, showHint };
}
