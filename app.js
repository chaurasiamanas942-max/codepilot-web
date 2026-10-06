// app.js — CodePilot web frontend (hybrid Groq + BYOK OpenAI)
(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const STORAGE_KEY = 'codepilot.settings';
  let settings = loadSettings();
  let history = [];
  let abortController = null;
  let busy = false;

  // ---------------------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------------------
  const messagesEl = document.getElementById('messages');
  const composerEl = document.getElementById('composer');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('send-btn');
  const stopBtn = document.getElementById('stop-btn');
  const newChatBtn = document.getElementById('new-chat-btn');
  const settingsBtn = document.getElementById('settings-btn');
  const settingsModal = document.getElementById('settings-modal');
  const apiKeyInput = document.getElementById('api-key-input');
  const settingsSave = document.getElementById('settings-save');
  const settingsCancel = document.getElementById('settings-cancel');
  const toastEl = document.getElementById('toast');

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------
  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch {}
    return { apiKey: '' };
  }

  function saveSettings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }

  function openSettings() {
    apiKeyInput.value = settings.apiKey || '';
    settingsModal.hidden = false;
    setTimeout(() => apiKeyInput.focus(), 50);
  }

  function closeSettings() {
    settingsModal.hidden = true;
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  let toastTimer;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1800);
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function setBusy(v) {
    busy = v;
    sendBtn.disabled = v;
    stopBtn.hidden = !v;
  }

  // ---------------------------------------------------------------------------
  // Markdown renderer
  // ---------------------------------------------------------------------------
  function inlineFmt(text) {
    const codes = [];
    let out = text.replace(/`([^`\n]+)`/g, (_, c) => {
      codes.push(c);
      return `\u0000${codes.length - 1}\u0000`;
    });
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    out = out.replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>');
    out = out.replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer">$1</a>'
    );
    out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
    return out;
  }

  function renderBlocks(escaped) {
    const lines = escaped.split('\n');
    let html = '';
    let inList = false;
    let para = [];

    const flushPara = () => {
      if (para.length) {
        html += `<p>${inlineFmt(para.join(' '))}</p>`;
        para = [];
      }
    };
    const closeList = () => {
      if (inList) {
        html += '</ul>';
        inList = false;
      }
    };

    for (const line of lines) {
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      const b = /^\s*[-*+]\s+(.*)$/.exec(line);
      const o = /^\s*\d+[.)]\s+(.*)$/.exec(line);

      if (h) {
        flushPara();
        closeList();
        const lvl = h[1].length;
        html += `<h${lvl}>${inlineFmt(h[2])}</h${lvl}>`;
      } else if (b || o) {
        flushPara();
        if (!inList) {
          html += '<ul>';
          inList = true;
        }
        html += `<li>${inlineFmt((b || o)[1])}</li>`;
      } else if (/^\s*$/.test(line)) {
        flushPara();
        closeList();
      } else {
        closeList();
        para.push(line);
      }
    }
    flushPara();
    closeList();
    return html;
  }

  function codeBlockHtml(code, lang) {
    return (
      '<div class="code-block">' +
      '<div class="code-head">' +
      `<span class="code-lang">${escapeHtml(lang || 'code')}</span>` +
      '<span class="code-actions">' +
      '<button data-act="copy">Copy</button>' +
      '</span>' +
      '</div>' +
      `<pre><code>${escapeHtml(code)}</code></pre>` +
      '</div>'
    );
  }

  function renderMarkdown(md) {
    const parts = String(md).split('```');
    let html = '';
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        let chunk = parts[i];
        let lang = '';
        const nl = chunk.indexOf('\n');
        if (nl !== -1) {
          const first = chunk.slice(0, nl).trim();
          if (/^[\w+#.-]*$/.test(first)) {
            lang = first;
            chunk = chunk.slice(nl + 1);
          }
        }
        html += codeBlockHtml(chunk.replace(/\n$/, ''), lang);
      } else {
        html += renderBlocks(escapeHtml(parts[i]));
      }
    }
    return html;
  }

  // ---------------------------------------------------------------------------
  // Message rendering
  // ---------------------------------------------------------------------------
  function addUserBubble(text) {
    const el = document.createElement('div');
    el.className = 'msg user';
    el.innerHTML = `<div class="bubble">${escapeHtml(text).replace(/\n/g, '<br>')}</div>`;
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  function addAssistantBubble() {
    const el = document.createElement('div');
    el.className = 'msg assistant';
    el.innerHTML =
      '<div class="bubble">' +
      '<div class="typing"><span></span><span></span><span></span></div>' +
      '</div>';
    messagesEl.appendChild(el);
    scrollToBottom();
    return el.querySelector('.bubble');
  }

  // ---------------------------------------------------------------------------
  // Streaming via the Vercel proxy (/api/chat)
  // ---------------------------------------------------------------------------
  async function streamChat({ messages, signal, onDelta, openaiKey }) {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, openaiKey: openaiKey || null }),
      signal
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `API error ${res.status} ${res.statusText}${detail ? `\n${detail.slice(0, 400)}` : ''}`
      );
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t || t.startsWith(':') || !t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          const delta = json?.choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            onDelta(delta);
          }
        } catch {}
      }
    }
    return full;
  }

  // ---------------------------------------------------------------------------
  // Send
  // ---------------------------------------------------------------------------
  async function send(text) {
    if (busy) return;

    const emptyState = document.getElementById('empty-state');
    if (emptyState) emptyState.remove();

    addUserBubble(text);
    history.push({ role: 'user', content: text });

    const bubble = addAssistantBubble();
    setBusy(true);
    abortController = new AbortController();

    const systemPrompt =
      'You are CodePilot, an expert AI coding assistant. Be concise and concrete. ' +
      'Always put code in fenced blocks with the correct language tag. ' +
      'When asked to change code, return the complete replacement block.';

    const messages = [{ role: 'system', content: systemPrompt }, ...history];
    let full = '';
    let error = null;

    try {
      full = await streamChat({
        messages,
        signal: abortController.signal,
        openaiKey: settings.apiKey || null,
        onDelta: (delta) => {
          bubble.dataset.raw = (bubble.dataset.raw || '') + delta;
          bubble.innerHTML = renderMarkdown(bubble.dataset.raw);
          scrollToBottom();
        }
      });
      bubble.innerHTML = renderMarkdown(full);
      history.push({ role: 'assistant', content: full });
    } catch (err) {
      if (err.name === 'AbortError') {
        error = 'Stopped.';
      } else {
        error = err.message || String(err);
      }
      if (full) history.push({ role: 'assistant', content: full });
    } finally {
      if (error) {
        bubble.innerHTML =
          `<div class="error">${escapeHtml(error)}</div>` + bubble.innerHTML;
      }
      if (!bubble.innerHTML.trim()) {
        bubble.innerHTML = '<em>No response.</em>';
      }
      setBusy(false);
      abortController = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------
  composerEl.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    autoGrow();
    send(text);
  });

  inputEl.addEventListener('input', autoGrow);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      composerEl.requestSubmit();
    }
  });

  function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
  }

  stopBtn.addEventListener('click', () => abortController?.abort());

  newChatBtn.addEventListener('click', () => {
    abortController?.abort();
    location.reload();
  });

  settingsBtn.addEventListener('click', openSettings);
  settingsCancel.addEventListener('click', closeSettings);
  settingsSave.addEventListener('click', () => {
    settings.apiKey = apiKeyInput.value.trim();
    saveSettings();
    closeSettings();
    toast(settings.apiKey ? 'OpenAI key saved' : 'Using free Groq model');
  });

  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) closeSettings();
  });

  document.addEventListener('click', (e) => {
    const s = e.target.closest('.suggestion');
    if (!s) return;
    inputEl.value = s.dataset.prompt || '';
    composerEl.requestSubmit();
  });

  messagesEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act="copy"]');
    if (!btn) return;
    const code = btn.closest('.code-block')?.querySelector('code')?.textContent || '';
    if (!code) return;
    navigator.clipboard.writeText(code);
    const old = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => (btn.textContent = old), 1200);
    toast('Copied to clipboard');
  });

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  autoGrow();
})();
