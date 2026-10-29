'use strict';
// Host identity and native layout readiness are separate from viewport size.
// These hints choose UI behavior only; native bridges still verify token/origin/frame.
const BridgeHost = (() => {
  function kind(userAgent = globalThis.navigator?.userAgent || '') {
    const match = /BridgeMobile\/[\w.-]+-(iOS|Android)(?:\s|$)/.exec(userAgent);
    return match ? (match[1] === 'iOS' ? 'ios' : 'android') : 'browser';
  }
  function isNativeApp(userAgent) { return kind(userAgent) !== 'browser'; }
  function hasNativeLayout() {
    // Native injection can finish after deferred page scripts have executed.
    return !!globalThis.document?.documentElement?.classList.contains('bridge-mobile');
  }
  function isSendShortcut(event) {
    if (event.key !== 'Enter' || event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat || event.altKey || event.shiftKey) return false;
    const platform = globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || globalThis.navigator?.userAgent || '';
    return /Mac|iPhone|iPad|iPod/i.test(platform) ? !!event.metaKey && !event.ctrlKey : !!event.ctrlKey && !event.metaKey;
  }
  return Object.freeze({kind, isNativeApp, hasNativeLayout, isSendShortcut});
})();
if (typeof module === 'object' && module.exports) module.exports = BridgeHost;
