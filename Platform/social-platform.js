/* Ember Mine platform adapter. SDK calls stay in the host page, never in the economy. */
(function (global) {
  'use strict';
  const SAVE = 'EmberMine.Save.v1', SOUND = 'EmberMine.SoundEnabled';
  const MANIFEST = 'ember_mine_manifest_v1', CHUNK = 2800, MAX_CHUNKS = 64;
  function create(env) {
    const values = Object.create(null);
    let bridge, namespace, initialized = false, cloud = false, hiddenByHost = false;
    let pending = null, writing = null, lastManifest = null, retryTimer = null;
    let unity = null;
    const context = { platform: 'standalone', language: 'ru', mobile: false, storageMode: 'local' };
    const params = new URLSearchParams(env.location.search);
    function timeout(promise, ms = 10000) {
      let timer;
      return Promise.race([promise, new Promise((_, reject) => { timer = env.setTimeout(() => reject(new Error('Platform timeout')), ms); })])
        .finally(() => env.clearTimeout(timer));
    }
    const send = (method, data = {}) => timeout(bridge.send(method, data));
    function readLocal() { try { return JSON.parse(env.localStorage.getItem(namespace) || 'null'); } catch (_) { return null; } }
    function writeLocal(snapshot) { try { env.localStorage.setItem(namespace, JSON.stringify(snapshot)); } catch (_) { /* Platform storage remains available. */ } }
    function validSnapshot(snapshot) {
      return snapshot && snapshot.version === 1 && snapshot.values && typeof snapshot.values === 'object'
        && Number.isFinite(snapshot.savedAt) && snapshot.savedAt >= 0
        && Object.keys(snapshot.values).every(key => (key === SAVE || key === SOUND) && typeof snapshot.values[key] === 'string');
    }
    function chunkKeys(manifest) {
      if (!manifest || manifest.version !== 1 || !/^[a-z0-9_]+$/.test(manifest.generation)
          || !Number.isInteger(manifest.count) || manifest.count < 1 || manifest.count > MAX_CHUNKS) throw new Error('Invalid cloud manifest');
      return Array.from({ length: manifest.count }, (_, i) => 'em_' + manifest.generation + '_' + i);
    }
    async function get(keys) {
      const response = await send('VKWebAppStorageGet', { keys });
      if (!response || !Array.isArray(response.keys)) throw new Error('Invalid storage response');
      return Object.fromEntries(response.keys.map(item => [item.key, item.value]));
    }
    async function set(key, value) {
      const response = await send('VKWebAppStorageSet', { key, value });
      if (!response || response.result !== true) throw new Error('Storage write rejected');
    }
    async function loadRemote() {
      const header = (await get([MANIFEST]))[MANIFEST];
      if (!header) return null;
      const manifest = JSON.parse(header), keys = chunkKeys(manifest);
      const chunks = await get(keys);
      if (keys.some(key => !chunks[key])) throw new Error('Incomplete cloud save');
      const serialized = keys.map(key => chunks[key]).join('');
      if (serialized.length !== manifest.length) throw new Error('Incomplete cloud save');
      const snapshot = JSON.parse(serialized);
      if (!validSnapshot(snapshot)) throw new Error('Invalid cloud save');
      lastManifest = manifest;
      return snapshot;
    }
    // Two fixed banks bound key usage and leave the previous complete save readable
    // if a chunk request fails. The manifest is always committed last.
    function splitChunks(text) {
      const chunks = []; let part = '', bytes = 0;
      for (const character of text) {
        const point = character.codePointAt(0);
        const size = point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4;
        if (bytes + size > CHUNK) { chunks.push(part); part = ''; bytes = 0; }
        part += character; bytes += size;
      }
      if (part) chunks.push(part);
      return chunks;
    }
    async function commit(snapshot) {
      const serialized = JSON.stringify(snapshot);
      const chunks = splitChunks(serialized);
      const bank = lastManifest && lastManifest.generation === 'a' ? 'b' : 'a';
      const manifest = { version: 1, generation: bank, count: chunks.length, length: serialized.length };
      const keys = chunkKeys(manifest);
      for (let i = 0; i < keys.length; i++) await set(keys[i], chunks[i]);
      await set(MANIFEST, JSON.stringify(manifest));
      lastManifest = manifest;
    }
    function drain() {
      if (!cloud || writing || !pending) return writing || Promise.resolve();
      writing = (async () => {
        while (pending) {
          const snapshot = pending; pending = null;
          try { await commit(snapshot); context.storageMode = 'cloud'; }
          catch (_) {
            pending = pending || snapshot; context.storageMode = 'local-pending';
            if (!retryTimer) retryTimer = env.setTimeout(() => { retryTimer = null; drain(); }, 15000);
            break;
          }
        }
      })().finally(() => { writing = null; if (pending && !retryTimer) drain(); });
      return writing;
    }
    function snapshot() { return { version: 1, savedAt: Date.now(), values: { ...values } }; }
    function visible() {
      if (unity) unity.SendMessage('Ember Mine', 'BrowserVisibility', env.document.hidden || hiddenByHost ? 'hidden' : 'visible');
    }
    function hostEvent(event) {
      const detail = event && event.detail;
      if (!detail) return;
      if (detail.type === 'VKWebAppViewHide') { hiddenByHost = true; visible(); }
      if (detail.type === 'VKWebAppViewRestore') { hiddenByHost = false; visible(); drain(); }
      if ((detail.type === 'VKWebAppUpdateInsets' || detail.type === 'VKWebAppUpdateConfig') && detail.data && detail.data.insets) {
        for (const side of ['top', 'right', 'bottom', 'left']) {
          const value = Math.min(120, Math.max(0, Number(detail.data.insets[side]) || 0));
          env.document.documentElement.style.setProperty('--host-' + side, value + 'px');
        }
      }
    }
    async function initialize() {
      if (initialized) return context;
      context.mobile = /mobile|android|iphone|ipad/.test(params.get('vk_platform') || '')
        || /Android|iPhone|iPad/i.test(env.navigator.userAgent || '');
      const forced = env.EMBER_PLATFORM;
      const inPlatform = forced === 'vk' || forced === 'ok' || params.has('vk_app_id') || params.has('vk_client') || env.parent !== env;
      if (inPlatform) {
        bridge = env.vkBridge;
        if (!bridge || typeof bridge.send !== 'function') throw new Error('VK Bridge is unavailable');
        await send('VKWebAppInit');
        let launch = Object.fromEntries(params);
        if (!launch.vk_user_id || !launch.vk_app_id) launch = { ...launch, ...await send('VKWebAppGetLaunchParams') };
        context.platform = launch.vk_client === 'ok' || forced === 'ok' ? 'ok' : 'vk';
        if (!/^\d+$/.test(String(launch.vk_user_id || '')) || !/^\d+$/.test(String(launch.vk_app_id || ''))) throw new Error('Launch identity is missing');
        context.language = String(launch.vk_language || 'ru').startsWith('en') ? 'en' : 'ru';
        namespace = 'EmberMine.vkbridge.v1:' + context.platform + ':' + launch.vk_app_id + ':' + launch.vk_user_id;
        bridge.subscribe(hostEvent);
        let remote = null;
        try { remote = await loadRemote(); cloud = true; context.storageMode = 'cloud'; }
        catch (_) { cloud = false; context.storageMode = 'local'; }
        const local = readLocal();
        const chosen = validSnapshot(local) && (!remote || local.savedAt > remote.savedAt) ? local : remote;
        if (chosen) { Object.assign(values, chosen.values); writeLocal(chosen); }
        if (cloud && chosen && chosen !== remote) { pending = chosen; drain(); }
      } else {
        namespace = 'EmberMine.standalone.v1';
        const local = readLocal(); if (validSnapshot(local)) Object.assign(values, local.values);
      }
      initialized = true;
      env.document.addEventListener('visibilitychange', () => { visible(); if (!env.document.hidden) drain(); });
      env.addEventListener('pagehide', () => { if (unity) unity.SendMessage('Ember Mine', 'BrowserVisibility', 'hidden'); });
      env.addEventListener('pageshow', visible);
      return context;
    }
    return {
      initialize, context,
      attach(instance) { unity = instance; visible(); },
      has(key) { return Object.prototype.hasOwnProperty.call(values, key); },
      get(key) { return this.has(key) ? values[key] : ''; },
      set(key, value) { if (key !== SAVE && key !== SOUND) throw new Error('Unknown storage key'); values[key] = String(value); },
      flush() { if (!initialized) return Promise.resolve(); const data = snapshot(); writeLocal(data); if (cloud) { pending = data; return drain(); } return Promise.resolve(); },
      whenIdle() { return writing || Promise.resolve(); }
    };
  }
  global.EmberSocialFactory = create;
  global.emberPlatform = create(global);
})(typeof window !== 'undefined' ? window : globalThis);
