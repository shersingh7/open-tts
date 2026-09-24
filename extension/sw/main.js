// @ts-check
// Open TTS v4 — service-worker composition root. Every chrome.* listener is registered synchronously while this
// module evaluates (MV3 requirement); state is loaded lazily from the session store before events are handled.

import { MSG } from "../shared/messages.js";
import { createAuth } from "./auth.js";
import { createHistory } from "./history.js";
import { createHostManager, createHostRegistry } from "./host-manager.js";
import { createMenus } from "./menus.js";
import { createRouter } from "./router.js";
import { createServerManager } from "./server-manager.js";
import { createSessionStore } from "./session-store.js";
import { createSettingsResolver } from "./settings.js";

/**
 * Wire the service worker against `chromeApi` and register all listeners synchronously.
 * @param {typeof chrome} chromeApi
 * @param {{fetchImpl?: typeof fetch}} [options]
 */
export function startServiceWorker(chromeApi, options = {}) {
  /** @type {import("./router.js").Router|null} */
  let router = null;
  /** @param {object} message */
  const publish = (message) => router?.publish(message);

  const auth = createAuth({ chrome: chromeApi });
  const server = createServerManager({ chrome: chromeApi, auth, publish, fetchImpl: options.fetchImpl });
  const store = createSessionStore({ storage: chromeApi.storage.session });
  const registry = createHostRegistry();
  const hosts = createHostManager({ chrome: chromeApi, registry });
  const history = createHistory({
    onError: (runId, message) => publish({ type: MSG.HISTORY_ERROR, runId, message }),
  });
  router = createRouter({
    store,
    registry,
    hosts,
    server,
    auth,
    settings: createSettingsResolver(),
    history,
    extensionUrl: (path) => chromeApi.runtime.getURL(path),
  });
  const menus = createMenus({ chrome: chromeApi, router });

  chromeApi.runtime.onConnect.addListener(router.handleConnect);
  chromeApi.runtime.onInstalled.addListener(() => menus.install());
  chromeApi.contextMenus.onClicked.addListener((info, tab) => {
    void menus.onMenuClick(info, tab);
  });
  chromeApi.commands.onCommand.addListener((command, tab) => {
    void menus.onCommand(command, tab);
  });
  chromeApi.tabs.onRemoved.addListener((tabId) => menus.onTabRemoved(tabId));

  // Token hardening + v3 migration (plan 1.2); does not block listener registration.
  void auth.init();

  return { router, server, store, registry, hosts, history, menus, auth };
}

if (globalThis.chrome?.runtime?.onConnect) startServiceWorker(globalThis.chrome);
