/* sticker-seal-gateway GUI.
 * No framework, no build step. Talks to /_seal/api/* on its own origin.
 * The sub2api panel hands us its session JWT as ?token= when it opens the
 * iframe, so no separate login exists.
 */

(() => {
  'use strict';

  const TOKEN_KEY = 'sticker-seal.token';
  const API = new URL('./api/', location.href);

  const el = (id) => document.getElementById(id);
  const esc = (value) =>
    String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const fmtInt = (n) => (Number(n) || 0).toLocaleString('en-US');
  const fmtBytes = (n) => {
    const v = Number(n) || 0;
    if (v < 1024) return `${v} B`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
    return `${(v / 1024 / 1024).toFixed(1)} MB`;
  };
  const fmtMs = (n) => (Number(n) >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Number(n) || 0} ms`);
  // Same split the server uses: CJK ~1.6 chars/token, Latin ~4 chars/token.
  const estimateTokens = (text) => {
    let cjk = 0;
    let total = 0;
    for (const ch of String(text)) {
      total += 1;
      const cp = ch.codePointAt(0);
      if (
        (cp >= 0x3040 && cp <= 0x30ff) ||
        (cp >= 0x3400 && cp <= 0x4dbf) ||
        (cp >= 0x4e00 && cp <= 0x9fff) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xff00 && cp <= 0xffef)
      ) {
        cjk += 1;
      }
    }
    return Math.ceil(cjk / 1.6) + Math.ceil((total - cjk) / 4);
  };

  const fmtClock = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('zh-CN', { hour12: false });
  };

  const store = {
    token: '',
    state: null,
    accounts: [],
    preview: null,
    lastPreviewInput: '',
  };

  /* ─────────────── transport ─────────────── */

  async function api(path, { method = 'GET', body } = {}) {
    const url = new URL(path, API);
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${store.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
    const text = await res.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text };
    }
    if (!res.ok) {
      const message = payload?.error?.message || payload?.message || `HTTP ${res.status}`;
      const error = new Error(message);
      error.status = res.status;
      throw error;
    }
    return payload;
  }

  /* ─────────────── toast ─────────────── */

  let toastTimer = 0;
  function toast(message, kind = 'ok') {
    const node = el('toast');
    node.textContent = message;
    node.className = `toast ${kind}`;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      node.hidden = true;
    }, kind === 'bad' ? 6000 : 2600);
  }

  /* ─────────────── boot ─────────────── */

  function boot() {
    const params = new URLSearchParams(location.search);
    const theme = params.get('theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;

    const token = params.get('token');
    if (token) {
      store.token = token;
      try {
        sessionStorage.setItem(TOKEN_KEY, token);
      } catch {
        /* private mode: keep it in memory only */
      }
    } else {
      try {
        store.token = sessionStorage.getItem(TOKEN_KEY) || '';
      } catch {
        store.token = '';
      }
    }

    el('btn-demo').addEventListener('click', () => {
      try {
        store.token = sessionStorage.getItem(TOKEN_KEY) || '';
      } catch {
        store.token = '';
      }
      start();
    });

    if (!store.token) {
      showGate('需要以管理员身份打开。请从 sub2api 侧栏的「贴纸封印」进入。');
      return;
    }
    start();
  }

  function showGate(reason) {
    el('app').hidden = true;
    el('auth-gate').hidden = false;
    el('auth-reason').textContent = reason;
  }

  async function start() {
    try {
      store.state = await api('state');
    } catch (error) {
      showGate(error.status === 401 ? `身份校验未通过：${error.message}` : `连不上网关：${error.message}`);
      return;
    }
    el('auth-gate').hidden = true;
    el('app').hidden = false;

    wireTabs();
    wireActions();
    renderAll();
    loadAccounts();
    ticker();
  }

  function activateTab(name, { updateHash = true } = {}) {
    const button = document.querySelector(`.tab[data-tab="${name}"]`);
    if (!button) return;
    for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('is-active', tab === button);
    for (const panel of document.querySelectorAll('.panel')) {
      panel.classList.toggle('is-active', panel.dataset.panel === name);
    }
    if (updateHash) {
      history.replaceState(null, '', `#${name}`);
    }
    if (name === 'events') refreshEvents();
    if (name === 'attach') loadAccounts();
  }

  function wireTabs() {
    el('tabs').addEventListener('click', (event) => {
      const button = event.target.closest('.tab');
      if (!button) return;
      activateTab(button.dataset.tab);
    });
    const fromHash = location.hash.replace('#', '');
    if (fromHash) activateTab(fromHash, { updateHash: false });
  }

  function wireActions() {
    el('btn-refresh').addEventListener('click', async () => {
      await refreshState();
      if (document.querySelector('.panel[data-panel="attach"]').classList.contains('is-active')) loadAccounts();
      if (document.querySelector('.panel[data-panel="events"]').classList.contains('is-active')) refreshEvents();
      toast('已刷新');
    });

    el('btn-save-stickers').addEventListener('click', saveStickers);
    el('sticker-prefix').addEventListener('input', updateTokenHint);
    el('sticker-suffix').addEventListener('input', updateTokenHint);

    el('btn-load-accounts').addEventListener('click', loadAccounts);
    el('btn-preview').addEventListener('click', runPreview);
    el('btn-live').addEventListener('click', runLive);
    el('btn-sample').addEventListener('click', fillSample);
  }

  /* ─────────────── render ─────────────── */

  function renderAll() {
    const state = store.state;
    if (!state) return;

    el('pill-version').textContent = `v${state.gateway.version} · node ${state.gateway.node}`;
    el('brand-sub').textContent = `${state.gateway.public_host} · 上报 ${state.gateway.sub2api_base}`;

    const totalRequests = state.upstreams.reduce((sum, u) => sum + (u.counters?.requests || 0), 0);
    const totalInjected = state.upstreams.reduce((sum, u) => sum + (u.counters?.injected || 0), 0);
    const totalSkipped = state.upstreams.reduce((sum, u) => sum + (u.counters?.skipped || 0), 0);
    const totalChars = state.upstreams.reduce((sum, u) => sum + (u.counters?.injected_chars || 0), 0);
    const stickerChars = state.stickers.prefix_chars + state.stickers.suffix_chars;
    const tokenRatio = stickerChars ? state.stickers.extra_tokens / stickerChars : 0;
    const totalTokens = Math.round(totalChars * tokenRatio);

    el('overview-stats').innerHTML = [
      ['今日请求', fmtInt(totalRequests), state.today],
      ['已注入', fmtInt(totalInjected), totalRequests ? `${((totalInjected / totalRequests) * 100).toFixed(1)}% 命中` : '—'],
      ['跳过', fmtInt(totalSkipped), '未命中注入条件'],
      ['额外 input token', fmtInt(totalTokens), `每次约 ${fmtInt(state.stickers.extra_tokens)}，贴纸 ${fmtInt(stickerChars)} 字符`],
    ]
      .map(
        ([label, value, sub]) => `
        <div class="stat">
          <div class="stat-label">${esc(label)}</div>
          <div class="stat-value">${esc(value)}</div>
          <div class="stat-sub">${esc(sub)}</div>
        </div>`,
      )
      .join('');

    renderCards();
    renderStickers();
    renderAttachTable();
    renderPreviewUpstreams();

    const broken = state.upstreams.filter((u) => u.listen_error);
    const notice = el('overview-notice');
    if (broken.length) {
      notice.hidden = false;
      notice.textContent = `端口未能监听：${broken.map((u) => `${u.id}:${u.listen} — ${u.listen_error}`).join('；')}`;
    } else {
      notice.hidden = true;
    }
  }

  function renderCards() {
    const state = store.state;
    if (!state.upstreams.length) {
      el('upstream-cards').innerHTML = `<div class="card"><p class="hint">还没有上游。去「接入」页或者用 PUT /_seal/api/upstreams 加一条。</p></div>`;
      return;
    }
    el('upstream-cards').innerHTML = state.upstreams
      .map((u) => {
        const counters = u.counters || {};
        const armed = u.enabled && u.listening;
        return `
        <div class="card">
          <div class="card-head">
            <div class="card-title">
              <span class="dot ${armed ? 'on' : 'off'}"></span>${esc(u.name)}
            </div>
            <span class="pill ${armed ? 'pill-ok' : 'pill-bad'}">${armed ? '在线' : u.enabled ? '未监听' : '已停用'}</span>
          </div>
          <dl class="kv">
            <dt>上游</dt><dd>${esc(u.target)}</dd>
            <dt>网关地址</dt><dd>${esc(u.url_for_sub2api)}</dd>
            <dt>账号</dt><dd>${u.account_id ? `#${u.account_id}` : '未绑定'}</dd>
            <dt>模型过滤</dt><dd>${u.model_allow.length ? esc(u.model_allow.join(', ')) : '全部'}</dd>
          </dl>
          <div class="card-metrics">
            <div class="metric"><b>${fmtInt(counters.requests)}</b><span>请求</span></div>
            <div class="metric"><b>${fmtInt(counters.injected)}</b><span>注入</span></div>
            <div class="metric"><b>${fmtInt(counters.skipped)}</b><span>跳过</span></div>
            <div class="metric"><b>${fmtBytes(counters.bytes_out)}</b><span>下行</span></div>
          </div>
          <div class="card-actions">
            <button class="btn btn-sm" data-copy="${esc(u.url_for_sub2api)}" type="button">复制网关地址</button>
            <button class="btn btn-sm" data-select-upstream="${esc(u.id)}" type="button">去预览</button>
          </div>
        </div>`;
      })
      .join('');

    el('upstream-cards').querySelectorAll('[data-copy]').forEach((button) => {
      button.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(button.dataset.copy);
          toast('已复制');
        } catch {
          toast('复制失败，手动选中吧', 'bad');
        }
      });
    });
    el('upstream-cards').querySelectorAll('[data-select-upstream]').forEach((button) => {
      button.addEventListener('click', () => {
        document.querySelector('.tab[data-tab="preview"]').click();
        el('preview-upstream').value = button.dataset.selectUpstream;
      });
    });
  }

  function renderStickers() {
    const stickers = store.state.stickers;
    if (document.activeElement !== el('sticker-prefix')) el('sticker-prefix').value = stickers.prefix;
    if (document.activeElement !== el('sticker-suffix')) el('sticker-suffix').value = stickers.suffix;
    el('dedupe').checked = stickers.dedupe;
    el('max-body').value = stickers.max_body_bytes;
    updateTokenHint();
  }

  function updateTokenHint() {
    const prefix = el('sticker-prefix').value;
    const suffix = el('sticker-suffix').value;
    const chars = prefix.length + suffix.length;
    const tokens = estimateTokens(prefix) + estimateTokens(suffix);
    el('count-prefix').textContent = `${fmtInt(prefix.length)} 字符 / ${fmtBytes(new Blob([prefix]).size)}`;
    el('count-suffix').textContent = `${fmtInt(suffix.length)} 字符 / ${fmtBytes(new Blob([suffix]).size)}`;
    el('token-hint').textContent =
      `合计 ${fmtInt(chars)} 字符 ≈ ${fmtInt(tokens)} input token/次请求（CJK 1.6 字符/token、西文 4 字符/token 估算）。` +
      `实测 deepseek-v4.1-flash 这套贴纸约 7,376 token；上游按实际用量计费，这笔增量会进账。`;
  }

  async function saveStickers() {
    const button = el('btn-save-stickers');
    button.disabled = true;
    try {
      const payload = {
        prefix: el('sticker-prefix').value,
        suffix: el('sticker-suffix').value,
        dedupe: el('dedupe').checked,
        max_body_bytes: Number(el('max-body').value),
      };
      const result = await api('stickers', { method: 'PUT', body: payload });
      store.state.stickers = result.stickers;
      renderStickers();
      toast('贴纸已保存，下一次请求立即生效');
    } catch (error) {
      toast(`保存失败：${error.message}`, 'bad');
    } finally {
      button.disabled = false;
    }
  }

  /* ─────────────── attach ─────────────── */

  function upstreamForAccount(accountId) {
    return store.state?.upstreams.find((u) => Number(u.account_id) === Number(accountId)) || null;
  }

  function renderAttachTable() {
    const tbody = el('attach-table').querySelector('tbody');
    if (!store.accounts.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty">没有账号数据</td></tr>`;
      return;
    }
    tbody.innerHTML = store.accounts
      .map((account) => {
        const upstream = upstreamForAccount(account.id);
        const wanted = upstream ? upstream.url_for_sub2api : null;
        const attached = wanted && account.base_url === wanted;
        const mismatch = wanted && !attached && Number(upstream.account_id) === Number(account.id);
        return `
        <tr>
          <td class="mono">${account.id}</td>
          <td>${esc(account.name)}</td>
          <td class="nowrap"><span class="pill pill-muted">${esc(account.platform)} / ${esc(account.type)}</span></td>
          <td class="mono ${mismatch ? 'mismatch' : ''}">${esc(account.base_url ?? '—')}</td>
          <td class="mono">${esc(wanted ?? '—')}</td>
          <td>${
            attached
              ? '<span class="pill pill-ok">已接入</span>'
              : upstream
                ? '<span class="pill pill-warn">待接入</span>'
                : '<span class="pill pill-muted">未映射</span>'
          }</td>
          <td class="ta-right nowrap">
            ${
              upstream
                ? `${
                    attached
                      ? ''
                      : `<button class="btn btn-sm btn-primary" data-attach="${esc(upstream.id)}" type="button">接入</button>`
                  }
                   <button class="btn btn-sm" data-detach="${esc(upstream.id)}" type="button">断开</button>`
                : ''
            }
          </td>
        </tr>`;
      })
      .join('');

    tbody.querySelectorAll('[data-attach]').forEach((button) => {
      button.addEventListener('click', () => attach(button.dataset.attach));
    });
    tbody.querySelectorAll('[data-detach]').forEach((button) => {
      button.addEventListener('click', () => detach(button.dataset.detach));
    });
  }

  async function loadAccounts() {
    try {
      const result = await api('accounts');
      store.accounts = result.items || [];
      renderAttachTable();
    } catch (error) {
      el('attach-table').querySelector('tbody').innerHTML =
        `<tr><td colspan="7" class="empty">拉取账号失败：${esc(error.message)}</td></tr>`;
    }
  }

  async function attach(upstreamId) {
    const upstream = store.state.upstreams.find((u) => u.id === upstreamId);
    if (!upstream) return;
    if (!confirm(`把账号 #${upstream.account_id} 的 base_url 改到 ${upstream.url_for_sub2api}？`)) return;
    try {
      const result = await api('attach', { method: 'POST', body: { upstream_id: upstreamId } });
      toast(`已接入 #${result.account_id}：${result.before ?? '(空)'} → ${result.after}`);
      await refreshState();
      await loadAccounts();
    } catch (error) {
      toast(`接入失败：${error.message}`, 'bad');
    }
  }

  async function detach(upstreamId) {
    const upstream = store.state.upstreams.find((u) => u.id === upstreamId);
    if (!upstream) return;
    if (!confirm(`把账号 #${upstream.account_id} 还原到 ${upstream.previous_base_url ?? '(未记录)'}？`)) return;
    try {
      const result = await api('detach', { method: 'POST', body: { upstream_id: upstreamId } });
      toast(`已断开 #${result.account_id}：${result.before ?? '(空)'} → ${result.after}`);
      await refreshState();
      await loadAccounts();
    } catch (error) {
      toast(`断开失败：${error.message}`, 'bad');
    }
  }

  /* ─────────────── preview / live ─────────────── */

  function renderPreviewUpstreams() {
    const select = el('preview-upstream');
    const previous = select.value;
    select.innerHTML = store.state.upstreams
      .map((u) => `<option value="${esc(u.id)}">${esc(u.name)} · :${u.listen} → ${esc(u.target)}</option>`)
      .join('');
    if (previous && store.state.upstreams.some((u) => u.id === previous)) select.value = previous;
  }

  function sampleBody() {
    return JSON.stringify(
      {
        model: 'deepseek-v4.1-flash',
        stream: false,
        messages: [
          { role: 'system', content: '你是一个乐于助人的助手。' },
          { role: 'user', content: '用一句话描述这张图：一只橘猫趴在键盘上。' },
        ],
      },
      null,
      2,
    );
  }

  function fillSample() {
    el('preview-input').value = sampleBody();
    el('preview-path').value = '/v1/chat/completions';
  }

  function highlight(text, needle) {
    const safe = esc(text);
    if (!needle) return safe;
    const probe = esc(needle);
    const index = safe.indexOf(probe);
    if (index === -1) return safe;
    return `${safe.slice(0, index)}<mark>${probe}</mark>${safe.slice(index + probe.length)}`;
  }

  async function runPreview() {
    const upstreamId = el('preview-upstream').value;
    if (!upstreamId) {
      toast('先加一条上游', 'bad');
      return;
    }
    const input = el('preview-input').value.trim();
    if (!input) {
      fillSample();
      return runPreview();
    }
    try {
      const result = await api('preview', {
        method: 'POST',
        body: { upstream_id: upstreamId, path: el('preview-path').value, body: input },
      });
      store.preview = result;
      store.lastPreviewInput = input;

      el('preview-badge').textContent = result.injected ? '(将被注入)' : '(原样透传)';
      el('preview-badge').className = `badge ${result.injected ? 'hit' : 'miss'}`;

      const head = store.state.stickers.prefix.slice(0, 80);
      el('preview-output').innerHTML = result.injected
        ? highlight(result.transformed, head)
        : esc(result.transformed);

      const delta = result.transformed.length - input.length;
      el('preview-out-badge').textContent = `${result.reason}${result.injected ? ` · +${fmtInt(delta)} 字符` : ''}`;
      el('preview-out-badge').className = `badge ${result.injected ? 'hit' : 'miss'}`;
    } catch (error) {
      toast(`预览失败：${error.message}`, 'bad');
    }
  }

  async function runLive() {
    const upstreamId = el('preview-upstream').value;
    if (!upstreamId) {
      toast('先加一条上游', 'bad');
      return;
    }
    const input = el('preview-input').value.trim();
    if (!input) {
      toast('先把请求体填上', 'bad');
      return;
    }
    let outgoing = input;
    if (store.preview && store.lastPreviewInput === input && store.preview.injected) {
      outgoing = store.preview.transformed;
    } else {
      const sure = confirm('还没生成注入预览，这一发会以原文直接打上游。继续？');
      if (!sure) return;
    }

    const wrap = el('live-wrap');
    wrap.hidden = false;
    el('live-output').textContent = '请求中…';
    el('live-badge').textContent = '';

    try {
      const result = await api('test', {
        method: 'POST',
        body: { upstream_id: upstreamId, path: el('preview-path').value, body: outgoing },
      });
      el('live-badge').textContent = `HTTP ${result.status} · ${fmtMs(result.ms)}${result.truncated ? ' · 已截断' : ''}`;
      el('live-badge').className = `badge ${result.status >= 200 && result.status < 300 ? 'hit' : 'miss'}`;
      el('live-output').textContent = result.body || '(空响应体)';
    } catch (error) {
      el('live-badge').textContent = '失败';
      el('live-badge').className = 'badge miss';
      el('live-output').textContent = error.message;
    }
  }

  /* ─────────────── events ─────────────── */

  async function refreshEvents() {
    try {
      const result = await api('events?limit=150');
      const rows = result.items || [];
      const tbody = el('events-table').querySelector('tbody');
      if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="9" class="empty">还没有请求经过网关</td></tr>`;
        return;
      }
      tbody.innerHTML = rows
        .map(
          (row) => `
        <tr>
          <td class="mono nowrap">${esc(fmtClock(row.ts))}</td>
          <td class="mono">${esc(row.upstream)}</td>
          <td class="mono">${esc(row.method)} ${esc(row.path)}</td>
          <td class="mono">${esc(row.model ?? '—')}</td>
          <td>${row.injected ? '<span class="pill pill-ok">注入</span>' : '<span class="pill pill-muted">跳过</span>'}</td>
          <td class="mono">${esc(row.reason ?? '')}</td>
          <td class="mono ta-right">${fmtBytes(row.inBytes)}</td>
          <td class="mono ta-right">${row.upStatus || '—'}</td>
          <td class="mono ta-right">${fmtMs(row.ms)}</td>
        </tr>`,
        )
        .join('');
    } catch (error) {
      el('events-table').querySelector('tbody').innerHTML =
        `<tr><td colspan="9" class="empty">拉取事件失败：${esc(error.message)}</td></tr>`;
    }
  }

  /* ─────────────── loop ─────────────── */

  async function refreshState() {
    try {
      store.state = await api('state');
      renderAll();
    } catch (error) {
      toast(`刷新失败：${error.message}`, 'bad');
    }
  }

  let tick = 0;
  function ticker() {
    setInterval(async () => {
      tick += 1;
      if (store.state === null) return;
      const onEvents = document.querySelector('.panel[data-panel="events"]').classList.contains('is-active');
      const onOverview = document.querySelector('.panel[data-panel="overview"]').classList.contains('is-active');
      if (onEvents && el('events-live').checked) {
        await refreshEvents();
        await refreshState();
      } else if (onOverview && tick % 3 === 0) {
        await refreshState();
      }
    }, 5000);
  }

  boot();
})();
