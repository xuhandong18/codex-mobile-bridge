'use strict';
(() => {
  const t = text => typeof BridgeI18n === 'undefined' ? text : BridgeI18n.t(text);
  const label = (node, text) => { node.textContent = t(text); node.dataset.i18n = text; };
  const limit = 30000, cache = new Map(), cards = new Set(), states = new WeakMap();
  let library, frame, instance, waiting, pending, librarySent = false, sequence = 0, tail = Promise.resolve();

  // This function contains only application code. It runs in the existing
  // opaque-origin HTML sandbox, whose CSP blocks every external resource.
  // Diagram source is delivered later as data, never interpolated into HTML.
  function sandboxRenderer() {
    const origin = new URL(location.href).origin;
    const instance = Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
    let loaded = false, busy = false;
    window.addEventListener('message', async event => {
      const data = event.data;
      if (event.source !== parent || event.origin !== origin || data?.type !== 'bridge-diagram-render' ||
          data.instance !== instance || !Number.isSafeInteger(data.id) || busy) return;
      busy = true;
      try {
        if (typeof data.source !== 'string' || data.source.length > 30000 ||
            /^\s*---/.test(data.source) || /%%\s*\{/.test(data.source)) throw Error('source');
        if (!loaded) {
          if (typeof data.library !== 'string' || data.library.length > 8000000) throw Error('library');
          const script = document.createElement('script'); script.textContent = data.library;
          document.head.append(script); script.remove(); loaded = true;
        }
        // Never bind Mermaid's click callbacks. No source-controlled config,
        // HTML labels, remote icons, images, fonts or CSS can escape this frame.
        mermaid.initialize({startOnLoad:false, securityLevel:'strict', theme:data.dark ? 'dark' : 'default',
          htmlLabels:false, flowchart:{htmlLabels:false}, fontFamily:'sans-serif',
          maxTextSize:30000, maxEdges:300, suppressErrorRendering:true});
        const {svg} = await mermaid.render('diagram-' + data.id, data.source);
        const doc = new DOMParser().parseFromString(svg, 'image/svg+xml'), root = doc.documentElement;
        if (root.localName !== 'svg' || doc.querySelector('parsererror')) throw Error('svg');
        // Strip active elements even though the parent only displays an inert
        // SVG image. Keep marker/gradient fragment references for diagram edges.
        for (const node of root.querySelectorAll('script,foreignObject,image,iframe,object,embed,a')) node.remove();
        for (const node of [root, ...root.querySelectorAll('*')]) {
          for (const attr of [...node.attributes]) {
            if (/^on/i.test(attr.name) || /(?:href|src)$/i.test(attr.localName) && !/^#[\w-]+$/.test(attr.value)) node.removeAttributeNode(attr);
          }
        }
        const box = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
        if (!box || box.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0 || Math.max(box[2],box[3]) > 50000) throw Error('size');
        root.setAttribute('width', String(Math.ceil(box[2]))); root.setAttribute('height', String(Math.ceil(box[3])));
        root.style.maxWidth = 'none'; root.style.backgroundColor = data.dark ? '#1f2020' : '#ffffff';
        const output = new XMLSerializer().serializeToString(root);
        if (output.length > 2000000) throw Error('size');
        parent.postMessage({type:'bridge-diagram-result',instance,id:data.id,svg:output}, origin);
      } catch {
        parent.postMessage({type:'bridge-diagram-result',instance,id:data.id,error:true}, origin);
      } finally { document.body.replaceChildren(); busy = false; }
    });
    parent.postMessage({type:'bridge-diagram-ready',instance}, origin);
  }

  function reset() {
    frame?.remove(); frame = null; instance = null; librarySent = false;
    waiting?.reject(Error('renderer')); waiting = null;
    pending?.reject(Error('renderer')); pending = null;
  }
  window.addEventListener('message', event => {
    if (!frame || event.source !== frame.contentWindow || event.origin !== 'null') return;
    const data = event.data;
    if (data?.type === 'bridge-html-preview-ready' && waiting && typeof data.instance === 'string') {
      const text = '<!doctype html><html><head><meta charset="utf-8"></head><body><script>(' + sandboxRenderer.toString() + ')();</script></body></html>';
      frame.contentWindow.postMessage({type:'bridge-html-preview-content',instance:data.instance,text}, '*');
    } else if (data?.type === 'bridge-diagram-ready' && waiting && /^[a-f0-9]{32}$/.test(data.instance)) {
      instance = data.instance; waiting.resolve(); waiting = null;
    } else if (data?.type === 'bridge-diagram-result' && pending && data.instance === instance && data.id === pending.id) {
      const request = pending; pending = null;
      if (data.error || typeof data.svg !== 'string' || data.svg.length > 2000000) request.reject(Error('render'));
      else request.resolve(data.svg);
    }
  });
  function timed(start, duration) {
    let timer;
    return Promise.race([start(), new Promise((resolve, reject) => {
      timer = setTimeout(() => { reset(); reject(Error('timeout')); }, duration);
    })]).finally(() => clearTimeout(timer));
  }
  async function engine() {
    if (frame && instance) return;
    await timed(() => new Promise((resolve, reject) => {
      waiting = {resolve,reject};
      frame = document.createElement('iframe'); frame.className = 'diagram-renderer-frame';
      frame.setAttribute('aria-hidden','true'); frame.tabIndex = -1;
      frame.setAttribute('sandbox', 'allow-scripts'); frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.title = t('图表渲染'); frame.src = (window.BridgeRelayBase || '') + '/html-preview-shell';
      document.body.append(frame);
    }), 10000);
  }
  async function loadLibrary() {
    if (!library) library = (async () => {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
      try {
        const response = await fetch((window.BridgeRelayBase || '') + '/vendor/mermaid/mermaid.min.js', {signal:controller.signal, credentials:'same-origin',redirect:'error'});
        if (!response.ok) throw Error('library');
        const text = await response.text(); if (text.length > 8000000) throw Error('library'); return text;
      } finally { clearTimeout(timer); }
    })().catch(error => { library = null; throw error; });
    return library;
  }
  function render(source, dark, connected) {
    if (source.length > limit) return Promise.reject(Error('limit'));
    if (/^\s*---/.test(source) || /%%\s*\{/.test(source)) return Promise.reject(Error('config'));
    const key = (dark ? 'dark:' : 'light:') + source;
    if (cache.has(key)) { const value = cache.get(key); cache.delete(key); cache.set(key,value); return Promise.resolve(value); }
    const result = tail.catch(() => {}).then(async () => {
      if (!connected()) throw Error('detached');
      if (cache.has(key)) return cache.get(key);
      const code = await loadLibrary();
      if (!connected()) throw Error('detached');
      await engine();
      return timed(() => new Promise((resolve, reject) => {
        const id = ++sequence; pending = {id,resolve,reject};
        frame.contentWindow.postMessage({type:'bridge-diagram-render',instance,id,source,dark,library:librarySent ? null : code}, '*'); librarySent = true;
      }), 10000);
    });
    tail = result.catch(() => {});
    result.then(svg => {
      if (!connected()) return;
      cache.set(key,svg);
      // Bounded per-page cache. No Blob URL lifetime or persistent message data.
      while (cache.size > 12) cache.delete(cache.keys().next().value);
    }, () => {});
    return result;
  }
  const resize = new ResizeObserver(entries => {
    for (const {target} of entries) target.diagramMeasure?.();
  });
  function activate(card) {
    const state = states.get(card);
    if (state && card.isConnected && !cards.has(state)) { cards.add(state); state.draw(); }
  }
  // Detached timelines and tabs must not retain observers or message sources.
  new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes || []) {
      if (node.nodeType !== 1) continue;
      if (node.matches('.diagram-card')) activate(node);
      for (const card of node.querySelectorAll('.diagram-card')) activate(card);
    }
    const themeChanged = records.some(record => record.type === 'attributes');
    for (const state of cards) {
      if (!state.card.isConnected) { resize.unobserve(state.viewport); cards.delete(state); }
      else if (themeChanged) state.draw();
    }
    if (!cards.size) { cache.clear(); if (frame) reset(); }
  }).observe(document.documentElement, {childList:true,subtree:true,attributes:true,attributeFilter:['data-theme']});

  window.BridgeDiagrams = {
    create({source,closed,truncated,streaming,getSource,canLoad}) {
      const card = document.createElement('section'); card.className = 'diagram-card';
      const toolbar = document.createElement('div'); toolbar.className = 'diagram-toolbar';
      const title = document.createElement('strong'); label(title,/^\s*(flowchart|graph)\b/.test(source) ? '流程图' : 'Mermaid 图表'); toolbar.append(title);
      const button = (text, action, className) => {
        const node = document.createElement('button'); node.type = 'button'; node.className = 'plain ' + className;
        label(node,text); node.onclick = action; toolbar.append(node); return node;
      };
      const viewport = document.createElement('div'); viewport.className = 'diagram-viewport';
      const status = document.createElement('p'); status.className = 'diagram-status'; status.setAttribute('role','status');
      const pre = document.createElement('pre'), code = document.createElement('code'); code.textContent = source; pre.append(code); pre.hidden = true;
      let image, dark, drawing = false;
      const state = {card,viewport,draw:() => draw()};
      const select = showSource => {
        pre.hidden = !showSource; viewport.hidden = showSource; expand.hidden = showSource || !image;
        graph.setAttribute('aria-pressed',String(!showSource)); raw.setAttribute('aria-pressed',String(showSource));
        if (!showSource) measure();
      };
      const graph = button('图表', () => select(false), 'diagram-graph'); graph.setAttribute('aria-pressed','true');
      const raw = button('源码', () => select(true), 'diagram-source'); raw.setAttribute('aria-pressed','false');
      const enlarge = button('放大', () => image && window.BridgeImageViewer?.openDiagram(image,enlarge), 'diagram-enlarge'); enlarge.disabled = true;
      const copy = button('复制源码', () => window.BridgeClipboard?.copy(async () => {
        const value = await getSource(); if (!value.closed && (streaming || truncated)) throw Error(t('图表尚未完整，请稍后重试')); return value.source;
      }, copy), 'diagram-copy'); copy.disabled = !closed && streaming && (!truncated || !canLoad);
      const expand = document.createElement('button'); expand.type = 'button'; expand.className = 'plain diagram-expand';
      label(expand,'展开查看'); expand.hidden = true; expand.onclick = () => image && window.BridgeImageViewer?.openDiagram(image,expand);
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'plain diagram-retry'; retry.hidden = true;
      label(retry,truncated && canLoad ? '加载完整图表' : '重试');
      retry.onclick = async () => {
        retry.disabled = true;
        try {
          if (truncated && canLoad) {
            const value = await getSource(); source = value.source; closed = value.closed;
            if (!closed) throw Error('incomplete'); truncated = false; code.textContent = source; copy.disabled = false; label(retry,'重试');
          }
          await draw();
          if (image && retry.hidden) select(false);
        } catch { label(status,'图表加载失败，可查看源码或重试'); }
        finally { retry.disabled = false; }
      };
      card.append(toolbar,status,viewport,pre,expand,retry);
      function measure() {
        if (!image || viewport.hidden) return;
        const width = Math.max(260, viewport.clientWidth), scale = Math.min(1,width / image.naturalWidth);
        // Floor the preview scale so wide diagrams remain readable by scrolling.
        const ratio = Math.max(.75,scale);
        image.style.width = Math.ceil(image.naturalWidth * ratio) + 'px';
        image.style.height = Math.ceil(image.naturalHeight * ratio) + 'px';
        expand.hidden = viewport.hidden || image.naturalHeight * ratio <= 360 && image.naturalWidth * ratio <= width;
      }
      viewport.diagramMeasure = measure;
      async function draw() {
        if (drawing || !card.isConnected) return;
        if (truncated || !closed) {
          label(status,truncated ? '加载完整消息后显示图表' : streaming ? '图表生成中，等待代码完整…' : '图表代码尚未闭合，请查看源码');
          if (!truncated && !streaming) select(true);
          retry.hidden = !(truncated && canLoad); return;
        }
        drawing = true; retry.hidden = true; label(status,'正在绘制图表…');
        dark = document.documentElement.dataset.theme === 'dark';
        try {
          const svg = await render(source,dark,() => card.isConnected);
          if (!card.isConnected) return;
          const next = document.createElement('img'); next.alt = t('Mermaid 图表，点击放大'); next.draggable = false;
          next.onload = () => {
            if (!card.isConnected || image !== next) return;
            status.textContent = ''; delete status.dataset.i18n; enlarge.disabled = false; measure();
          };
          next.onerror = () => { if (card.isConnected) { label(status,'图表加载失败，可查看源码或重试'); retry.hidden = false; } };
          const data = btoa(Array.from(new TextEncoder().encode(svg), byte => String.fromCharCode(byte)).join(''));
          next.src = 'data:image/svg+xml;base64,' + data;
          window.BridgeImageViewer?.registerDiagram(next, {data,name:t('Mermaid 图表')});
          image = next; viewport.replaceChildren(next); resize.observe(viewport);
        } catch (error) {
          if (!card.isConnected) return;
          label(status,error.message === 'config' ? '图表包含不支持的配置，请查看源码' : error.message === 'limit' ? '图表过大，请查看源码' : '图表加载失败，可查看源码或重试');
          retry.hidden = ['config','limit'].includes(error.message); select(true);
        } finally {
          drawing = false;
          if (card.isConnected && dark !== (document.documentElement.dataset.theme === 'dark')) draw();
        }
      }
      states.set(card,state); queueMicrotask(() => activate(card));
      return card;
    }
  };
})();
