'use strict';
(() => {
  const markdown = window.markdownit({html:false, linkify:true, breaks:true});
  // Math delimiters must be consumed before Markdown removes backslash escapes.
  markdown.use(texmath, {engine:window.katex, delimiters:['brackets','dollars']});
  const tags = new Set(['p','h1','h2','h3','h4','h5','h6','ul','ol','li','strong','em','s','blockquote','hr','br','table','thead','tbody','tr','th','td']);

  // Writing containers are chat presentation, not Markdown source rewriting.
  // Parse at the block boundary so code examples and quoted markers stay literal.
  markdown.block.ruler.before('fence', 'writing', (state, start, end, silent) => {
    if (!state.env.writingBlocks || state.level !== 0 || state.sCount[start] - state.blkIndent >= 4) return false;
    const line = n => state.src.slice(state.bMarks[n] + state.tShift[n], state.eMarks[n]);
    const match = /^:::writing\{(.*)\}[ \t]*$/.exec(line(start));
    if (!match) return false;
    const attributes = Object.create(null), attribute = /([a-zA-Z][\w-]*)=("(?:[^"\\\r\n]|\\.)*")(?:[ \t]+|$)/y;
    let offset = 0;
    try {
      while (offset < match[1].length) {
        attribute.lastIndex = offset;
        const part = attribute.exec(match[1]);
        if (!part || Object.hasOwn(attributes, part[1])) return false;
        attributes[part[1]] = JSON.parse(part[2]); offset = attribute.lastIndex;
      }
    } catch { return false; }
    if (!['standard', 'email'].includes(attributes.variant)) return false;
    if (silent) return true;
    let next = start + 1, fence = null, closed = false;
    for (; next < end; next++) {
      const source = line(next), indent = state.sCount[next] - state.blkIndent;
      if (indent >= 4) continue;
      if (fence) {
        if (new RegExp('^' + fence[0] + '{' + fence.length + ',}[ \\t]*$').test(source)) fence = null;
      } else {
        if (/^:::[ \t]*$/.test(source)) { closed = true; break; }
        const marker = /^(`{3,}|~{3,})(.*)$/.exec(source);
        if (marker && (marker[1][0] !== '`' || !marker[2].includes('`'))) fence = marker[1];
      }
    }
    const token = state.push('writing_block', '', 0);
    token.block = true; token.map = [start, next + (closed ? 1 : 0)];
    token.content = state.getLines(start + 1, next, state.blkIndent, false).replace(/\n$/, '');
    token.meta = {closed, subject:attributes.subject || ''};
    token.children = state.md.parse(token.content, {...state.env, writingBlocks:false});
    state.line = token.map[1];
    return true;
  }, {alt:['paragraph']});

  function followup(source) {
    const match = /^:codex-followup\[([^\]\r\n]+)\]\{prompt=("(?:[^"\\\r\n]|\\.)*")\}$/u.exec(source.trim());
    if (!match) return null;
    try {
      const label = markdown.utils.unescapeAll(match[1]), prompt = JSON.parse(match[2]);
      return label.trim() && prompt.trim() ? {label, prompt} : null;
    } catch { return null; }
  }

  // Insert through the existing input events; never submit or replace a draft.
  window.ChatFollowups = {
    fill(input, prompt, {quotes, reveal = () => {}} = {}) {
      if (input.disabled || input.readOnly) return false;
      const value = input.value + (input.value ? '\n\n' : '') + prompt;
      if (quotes) quotes.validate(quotes.text(value));
      else if (input.maxLength > 0 && value.length > input.maxLength) {
        throw Error(typeof BridgeI18n === 'undefined' ? '文字和文件引用合计过长，请缩小选区或删除部分引用' : BridgeI18n.t('文字和文件引用合计过长，请缩小选区或删除部分引用'));
      }
      input.value = value;
      reveal();
      input.dispatchEvent(new Event('input', {bubbles:true}));
      input.focus();
      input.setSelectionRange(value.length, value.length);
      return true;
    }
  };

  // Build nodes from parsed tokens; model output never becomes executable HTML.
  window.renderMarkdown = function(node, text, files = [], fileUrl = () => '', options = {}) {
    const source = String(text || '');
    const lastContentLine = options.complete === false ? source.trimEnd().split(/\r\n|\r|\n/).length : 0;
    const body = document.createElement('div');
    body.className = 'markdown-body';
    const headingAnchors = new Set();
    const artifacts = new Map(files.flatMap(file =>
      [file.reference, ...(file.references || [])].flatMap(reference =>
        [reference, markdown.utils.unescapeAll(reference)].map(value => [markdown.normalizeLink(value), file]))));
    function parse(source) {
      const validate = markdown.validateLink;
      // Only server-authorized file URLs may pass the parser's local-URL filter.
      // Rendering still replaces them with authenticated gateway routes below.
      markdown.validateLink = reference => validate(reference) || /^file:\/\//i.test(reference) && artifacts.has(reference);
      try { return markdown.parse(source, {writingBlocks:options.writingBlocks === true}); }
      finally { markdown.validateLink = validate; }
    }
    function target(reference, local = false) {
      const file = artifacts.get(reference);
      if (file) return {url:fileUrl(file), file};
      if (/^https?:\/\//i.test(reference)) return {url:reference};
      return local ? options.resolveLink?.(reference) || null : null;
    }
    function link(url, title) {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      if (title) anchor.title = title;
      return anchor;
    }
    let codeIndex=0, writingIndex=0;
    function appendTokens(tokens, root, inWriting = false) {
      const parents = [root];
      for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.hidden) continue;
        const parent = parents[parents.length - 1];
        // Match a whole list item before inline parsing unescapes its attributes.
        const action = !inWriting && typeof options.onFollowup === 'function' && token.type === 'list_item_open' &&
          !parents.some(node => node.tagName === 'BLOCKQUOTE') &&
          // A preview or streaming tail can still acquire a continuation later.
          (options.complete !== false || token.map?.[1] < lastContentLine) &&
          tokens[index+1]?.type === 'paragraph_open' && tokens[index+2]?.type === 'inline' &&
          tokens[index+3]?.type === 'paragraph_close' && tokens[index+4]?.type === 'list_item_close' &&
          followup(tokens[index+2].content);
        if (action) {
          const item = document.createElement('li'), button = document.createElement('button');
          item.className = 'chat-followup-item';
          button.className = 'chat-followup'; button.type = 'button'; button.textContent = action.label;
          button.onclick = event => {
            event.preventDefault(); event.stopPropagation();
            if (button.isConnected) options.onFollowup(action.prompt);
          };
          item.append(button); parent.append(item); index += 4;
        } else if (token.type === 'writing_block') {
          const card = document.createElement('section'); card.className = 'writing-block';
          const header = document.createElement('div'); header.className = 'writing-header';
          const title = document.createElement('strong'); title.textContent = token.meta.subject || (typeof BridgeI18n === 'undefined' ? '文稿' : BridgeI18n.t('文稿'));
          const button = document.createElement('button'); button.className = 'plain writing-copy'; button.type = 'button';
          button.textContent = typeof BridgeI18n === 'undefined' ? '复制' : BridgeI18n.t('复制');
          button.disabled = !token.meta.closed;
          const index = writingIndex++;
          button.onclick = () => window.BridgeClipboard?.copy(async () => {
            if (!options.fullText) return token.content;
            const blocks = parse(await options.fullText()).filter(t => t.type === 'writing_block');
            if (!blocks[index]?.meta.closed) throw Error('读取完整正文失败，请重试');
            return blocks[index].content;
          }, button);
          const content = document.createElement('div'); content.className = 'writing-content';
          appendTokens(token.children || [], content, true);
          header.append(title, button); card.append(header, content); parent.append(card);
        } else if (token.type === 'inline') {
          appendTokens(token.children || [], parent, inWriting);
        } else if (token.type.startsWith('math_')) {
          const display = token.block || token.type === 'math_inline_double';
          const formula = document.createElement(token.block ? 'div' : 'span');
          formula.className = display ? 'math-display' : 'math-inline';
          try {
            window.katex.render(token.content, formula, {
              displayMode:display, throwOnError:true, trust:false,
              maxExpand:1000, maxSize:20, strict:'ignore'
            });
          } catch {
            // Incomplete or unsupported TeX stays readable during streaming.
            const source = document.createElement('code');
            source.textContent = token.content;
            formula.append(source);
          }
          if (token.type.endsWith('_eqno')) {
            const number = document.createElement('span');
            number.className = 'math-number';
            number.textContent = '(' + token.info + ')';
            formula.append(number);
          }
          parent.append(formula);
        } else if (token.type === 'text') {
          parent.append(document.createTextNode(token.content));
        } else if (token.type === 'softbreak' || token.type === 'hardbreak') {
          parent.append(document.createElement('br'));
        } else if (token.type === 'code_inline' || token.type === 'code_block' || token.type === 'fence') {
          const code = document.createElement('code');
          code.textContent = token.content;
          if (token.type === 'code_inline') parent.append(code);
          else {
            const pre = document.createElement('pre');
            pre.append(code);
            const wrapper=document.createElement('div');wrapper.className='code-block';
            const button=document.createElement('button');button.className='plain code-copy';button.type='button';button.textContent=typeof BridgeI18n==='undefined'?'复制代码':BridgeI18n.t('复制代码');
            const index=codeIndex++;
            button.onclick=()=>window.BridgeClipboard?.copy(async()=>{
              if(!options.fullText)return token.content;
              const complete=await options.fullText();
              const blocks=parse(complete).flatMap(t=>t.type==='writing_block'?t.children:[t]).filter(t=>t.type==='fence'||t.type==='code_block');
              if(!blocks[index])throw Error('读取完整正文失败，请重试');
              return blocks[index].content;
            },button);
            wrapper.append(button,pre);parent.append(wrapper);
          }
        } else if (token.type === 'image') {
          const destination = target(token.attrGet('src') || '');
          const label = token.content || destination?.file?.name || '图片';
          if (destination?.file?.image) {
            const image = document.createElement('img');
            image.className = 'artifact-image';
            image.src = destination.url;
            image.alt = label;
            image.loading = 'lazy';
            image.dataset.imagePreview = destination.url; image.dataset.imageName = label;
            image.tabIndex = 0; image.setAttribute('role', 'button');
            parent.append(image);
          } else if (destination) {
            // Remote images remain links instead of making background requests.
            const anchor = link(destination.url, token.attrGet('title'));
            anchor.textContent = label;
            parent.append(anchor);
          } else parent.append(document.createTextNode(label));
        } else if (token.nesting === -1) {
          if (options.headingAnchors && token.type === 'heading_close') {
            const base = parent.textContent.toLowerCase().replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, '').replace(/\s/g, '-');
            let slug = base, suffix = 0;
            while (headingAnchors.has(slug)) slug = base + '-' + ++suffix;
            headingAnchors.add(slug); parent.dataset.markdownAnchor = slug;
          }
          parents.pop();
        } else {
          let element;
          if (token.type === 'link_open') {
            const destination = target(token.attrGet('href') || '', true);
            element = destination ? link(destination.url, token.attrGet('title')) : document.createElement('span');
            if (destination?.activate) element.onclick = event => {
              if (event.defaultPrevented || event.button !== 0) return;
              event.preventDefault(); destination.activate();
            };
            if (destination?.file?.image) { element.dataset.imagePreview = destination.url; element.dataset.imageName = destination.file.name; }
          } else if (tags.has(token.tag)) {
            element = document.createElement(token.tag);
            if (token.tag === 'ol' && token.attrGet('start')) element.start = Number(token.attrGet('start'));
            const alignment = /^text-align:(left|center|right)$/.exec(token.attrGet('style') || '');
            if (alignment) element.className = 'align-' + alignment[1];
          } else continue;
          if (token.tag === 'table') {
            const scroll = document.createElement('div');
            scroll.className = 'markdown-table';
            scroll.tabIndex = 0;
            scroll.setAttribute('role', 'region');
            scroll.setAttribute('aria-label', '表格，可横向滚动');
            scroll.append(element);
            parent.append(scroll);
          } else parent.append(element);
          if (token.nesting === 1) parents.push(element);
        }
      }
    }
    appendTokens(parse(source), body);
    node.append(body);
  };
})();
