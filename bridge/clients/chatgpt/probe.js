(async function(request, loader) {
  'use strict';
  const load = loader ?? (specifier => import(specifier));
  if (location.protocol !== 'app:' || location.host !== '-' || window.codexWindowType !== 'primary') {
    throw Error('unverified_window');
  }
  const urls = ['primary', 'initial'].map(key => {
    const path = request.modules[key];
    if (typeof path !== 'string' || !/^assets\/[A-Za-z0-9-]+\.js$/.test(path)) throw Error('invalid_module');
    return new URL('/' + path, document.baseURI).href;
  });
  const [primary, initial] = await Promise.all(urls.map(url => load(url)));
  const scope = primary.Jp?.scope;
  if (!scope || typeof scope.get !== 'function' || !scope.queryClient) throw Error('scope_unbound');
  const identity = () => [scope.get(initial.ler), scope.get(initial.uer)];
  const before = identity();
  if (before.some(value => typeof value !== 'string' || !value) ||
      scope.get(initial.c0n, {name:'chatgpt'})?.isCapable !== true) throw Error('identity_unknown');
  const guard = initial.rrt(scope);
  const route = scope.get(initial.Xkn);
  const routeKey = JSON.stringify([route?.pathname, route?.key]);
  let thread = null;
  if (request.threadId !== null) {
    const serverId = scope.get(initial.tdn, request.threadId);
    if (serverId !== request.threadId) throw Error('thread_identity_unknown');
    if (request.refresh) {
      // This is the original passive GET query. It does not call completion,
      // navigation, activation, recovery or attachment materialization functions.
      await scope.query.snapshot(initial.dXt, serverId).refetch();
      guard();
    }
    const state = scope.queryClient.getQueryState(['chatgpt-conversation', serverId]);
    const data = state?.data;
    if (data != null && data.conversation_id !== serverId) throw Error('cache_id_mismatch');
    thread = {id:serverId, cachePresent:state != null, hasData:data != null,
      accountVerified:request.refresh === true && data != null && state?.status === 'success',
      queryStatus:state?.status ?? null, fetchStatus:state?.fetchStatus ?? null,
      dataUpdatedAt:state?.dataUpdatedAt ?? null,
      updatedAt:typeof data?.update_time === 'number' ? data.update_time : null};
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(before)));
  guard();
  const after = identity();
  const currentRoute = scope.get(initial.Xkn);
  if (primary.Jp?.scope !== scope || before.some((value, index) => value !== after[index]) ||
      routeKey !== JSON.stringify([currentRoute?.pathname, currentRoute?.key])) throw Error('context_changed');
  return {protocolVersion:1, windowType:'primary', scopeReady:true, mutationVerified:false,
    accountKey:Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2,'0')).join(''),
    route:route?.pathname ?? null, thread};
})
