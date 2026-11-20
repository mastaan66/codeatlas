/* CodeAtlas v2 — canvas instrument with module cards, symbol inspector,
   ask thread, tour timeline, study flashcards, minimap coverage. */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => {
    n = Number(n) || 0;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}m`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
    return String(n);
  };
  const exact = (n) => Number(n || 0).toLocaleString('en-US');
  const md = (text) => {
    if (!text) return '';
    try {
      const html = window.marked ? window.marked.parse(String(text)) : esc(text);
      const clean = window.DOMPurify ? window.DOMPurify.sanitize(html, { ADD_ATTR: ['target'] }) : html;
      const t = document.createElement('div');
      t.innerHTML = clean;
      $$('a', t).forEach((a) => { a.target = '_blank'; a.rel = 'noreferrer'; });
      return t.innerHTML;
    } catch { return esc(text); }
  };
  const short = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));
  const REDUCED = typeof matchMedia === 'function'
    ? matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
  const TOAST = $('#toast');
  let toastTimer = 0;
  function toast(msg) {
    TOAST.textContent = msg;
    TOAST.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => TOAST.classList.add('hidden'), 3600);
  }

  /* -------------------------------------------------------------- colors */
  const C = {};
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    Object.assign(C, {
      bg: v('--bg'), panel: v('--panel-solid'), text: v('--text'), text2: v('--text-2'),
      muted: v('--muted'), faint: v('--faint'), line: v('--line'), lineStrong: v('--line-strong'),
      accent: v('--accent'), accentText: v('--accent-text'),
      sans: v('--sans'), mono: v('--mono'),
      cyan: v('--cyan'), violet: v('--violet'), amber: v('--amber'), rose: v('--rose'), green: v('--green'), red: v('--red'),
      kClass: v('--k-class'), kFunction: v('--k-function'), kMethod: v('--k-method'),
      kInterface: v('--k-interface'), kFile: v('--k-file'), kImport: v('--k-import'),
      kVariable: v('--k-variable'), kSymbol: v('--k-symbol'),
      m1: v('--m1'), m2: v('--m2'), m3: v('--m3'), m4: v('--m4'), m5: v('--m5'), m6: v('--m6'),
    });
  }
  function alpha(hex, a) {
    const h = String(hex || '').replace('#', '');
    const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const num = parseInt(n, 16);
    if (!Number.isFinite(num)) return `rgba(110,178,224,${a})`;
    return `rgba(${(num >> 16) & 255},${(num >> 8) & 255},${(num & 255)},${a})`;
  }
  const DEG_TIERS = () => [[10, C.muted], [20, C.accentText], [40, C.amber], [80, C.rose], [90, C.accent]];
  function degreeColor(kind, degree) {
    const d = Math.max(0, Math.floor(Number(degree) || 0));
    if (d <= 3) return kindColor(kind);
    const tiers = DEG_TIERS();
    for (const [max, col] of tiers) if (d <= max) return col;
    return tiers[tiers.length - 1][1];
  }
  function kindColor(kind) {
    const k = String(kind || '').toLowerCase();
    if (k.includes('class')) return C.kClass;
    if (k.includes('func') || k.includes('method')) return C.kFunction;
    if (k.includes('interface') || k.includes('struct') || k.includes('enum') || k.includes('type') || k.includes('trait')) return C.kInterface;
    if (k.includes('file') || k.includes('module') || k.includes('package')) return C.kFile;
    if (k.includes('import') || k.includes('include')) return C.kImport;
    if (k.includes('var') || k.includes('const') || k.includes('prop') || k.includes('field')) return C.kVariable;
    return C.kSymbol;
  }
  function kindTone(kind) {
    const k = String(kind || '').toLowerCase();
    if (k.includes('class')) return C.cyan;
    if (k.includes('func') || k.includes('method')) return C.green;
    if (k.includes('interface') || k.includes('struct') || k.includes('enum') || k.includes('type') || k.includes('trait')) return C.violet;
    if (k.includes('file') || k.includes('module') || k.includes('package')) return C.amber;
    if (k.includes('import') || k.includes('include')) return C.rose;
    if (k.includes('var') || k.includes('const') || k.includes('prop') || k.includes('field')) return C.cyan;
    return C.cyan;
  }
  const MOD_COLORS = () => [C.m1, C.m2, C.m3, C.m4, C.m5, C.m6];
  function moduleColor(id) {
    let h = 0;
    for (let i = 0; i < String(id).length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return MOD_COLORS()[h % MOD_COLORS().length];
  }
  function relColor(rel) {
    const r = String(rel || '').toLowerCase();
    if (r.includes('import') || r.includes('include')) return C.violet;
    if (r.includes('call')) return C.cyan;
    if (r.includes('use')) return C.green;
    if (r.includes('contain') || r.includes('define') || r.includes('own')) return C.amber;
    return C.muted;
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
    });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error((data && data.error) || `request failed (${res.status})`);
    return data;
  }

  /* ------------------------------------------------------------ top-level */
  class Atlas {
    constructor() {
      this.slug = null;
      this.overview = null;
      this.view = 'overview'; // overview | module | ego
      this.module = null;
      this.moduleId = null;
      this.ego = null;
      this.selected = null;
      this.hover = null;
      this.cam = { x: 0, y: 0, k: 1 };
      this.bounds = null;
      this.repoList = [];
      this.qa = [];
      this.askBusy = false;
      this.tour = null;
      this.tourIdx = 0;
      this.tourDone = new Set();
      this.study = null;
      this.studyTab = 'flash';
      this.flashIdx = 0;
      this.studyRight = 0;
      this.studyWrong = 0;
      this.quizIdx = 0;
      this.quizAnswered = null;
      this.drawRaf = 0;
      this.timers = { toast: 0, search: 0, palette: 0 };
      this.searchAbort = null;
      this.paletteAbort = null;
      this.overlayId = null;
      this.overlayDone = null;
    }

    /* ------------------------------------------------------------ boot */
    async boot() {
      readColors();
      this.bindUI();
      this.resize();
      this.loadHealth();
      await this.loadRepos();
      const params = new URLSearchParams(location.search);
      const repo = params.get('repo');
      let last = null;
      try { last = localStorage.getItem('codeatlas:last'); } catch {}
      if (repo) {
        const known = this.repoList.find((r) => r.slug === repo);
        if (known) await this.loadOverview(repo);
        else await this.startIndex(repo);
      } else if (last && this.repoList.some((r) => r.slug === last)) {
        await this.loadOverview(last);
      } else if (this.repoList.length) {
        await this.loadOverview(this.repoList[0].slug);
      } else {
        this.view = 'overview';
        this.requestDraw();
      }
      $('#repoInput')?.addEventListener('change', (e) => { const v = e.target.value; if (v) { this.loadOverview(v); } });
      $('#sidebarToggle').addEventListener('click', () => this.toggleSidebar());
      $('#drawerBackdrop').addEventListener('click', () => $('#moduleDrawer').classList.add('hidden'));
      $('#drawerClose').addEventListener('click', () => $('#moduleDrawer').classList.add('hidden'));
    }

    async loadRepos() {
      try {
        const out = await api('/api/repos');
        this.repoList = out.details || [];
        const sel = $('#repoSelect');
        const cur = this.slug || (sel && sel.value);
        sel.innerHTML = '<option value="">Indexed repos…</option>' + this.repoList.map((r) => {
          const label = (r.meta && r.meta.repo || r.slug).replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '') || r.slug;
          return `<option value="${esc(r.slug)}">${esc(label)}</option>`;
        }).join('');
        if (cur) sel.value = cur;
        this.drawSidebar();
      } catch {}
    }

    async loadHealth() {
      try {
        const h = await api('/api/health');
        const b = $('#providerBadge');
        b.textContent = h.provider === 'gemini-api' ? 'Gemini · grounded' : 'Ollama · grounded';
        b.title = 'Answers are grounded in real symbols and files';
      } catch {
        $('#providerBadge').textContent = 'Offline';
      }
    }

    themeToggle() {
      const cur = document.documentElement.dataset.theme || 'dark';
      this.setTheme(cur === 'light' ? 'dark' : 'light');
    }
    setTheme(next) {
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('codeatlas-theme', next); } catch {}
      readColors();
      this.renderStats();
      this.renderLegend();
      this.requestDraw();
    }

    /* ------------------------------------------------------------ views */
    async loadOverview(slug) {
      if (!slug) return;
      this.slug = slug;
      this.view = 'overview';
      this.module = null;
      this.moduleId = null;
      this.ego = null;
      this.selected = null;
      this.hover = null;
      const [ov, brief] = await Promise.all([
        api(`/api/atlas/${encodeURIComponent(slug)}?meta=1`),
        api(`/api/brief/${encodeURIComponent(slug)}?narrate=0`).catch(() => null),
      ]).catch((err) => { toast(`Map unavailable: ${err.message}`); return [null, null]; });
      if (!ov) return;
      this.overview = ov;
      history.replaceState(null, '', `${location.pathname}?repo=${encodeURIComponent(slug)}`);
      try { localStorage.setItem('codeatlas:last', slug); } catch {}
      this.renderRailHead();
      this.renderCrumbs();
      this.renderStats();
      this.renderLegend();
      this.activateTab('symbol');
      this.renderModuleGrid();
      this.renderBriefPanel(brief, { compact: true });
      const ri = $('#repoInput'); if (ri) ri.value = slug;
      $('#stageHint').classList.add('hidden');
      const only = this.overview.modules.filter((m) => !m.hidden && m.primary !== false);
      if (only.length === 1) { this.openModule(only[0].id); return; }
      this.fitCurrent(1.08);
      this.requestDraw();
    }

    async openModule(id) {
      if (!this.slug) return;
      const payload = await api(`/api/atlas/${encodeURIComponent(this.slug)}/module?id=${encodeURIComponent(id)}`);
      this.module = payload;
      this.moduleId = payload.id;
      this.ego = null;
      this.selected = null;
      this.view = 'module';
      this.renderCrumbs();
      this.renderRailHead();
      this.renderStats();
      this.renderLegend(payload.nodes);
      this.activateTab('symbol');
      this.renderModuleView(payload);
      this.fitCurrent(1.14);
      this.requestDraw();
    }

    async openModuleDrawer(id) {
      if (!this.slug) return;
      const payload = await api(`/api/atlas/${encodeURIComponent(this.slug)}/module?id=${encodeURIComponent(id)}`);
      const el = $('#drawer');
      el.classList.remove('hidden');
      $('#drawerTitle').textContent = payload.name;
      $('#drawerMeta').textContent = `${fmt(payload.count)} symbols · ${payload.files} files`;
      const stats = $('#drawerStats');
      stats.innerHTML = '';
      const make = (k, v) => { const d = document.createElement('div'); d.className = 'stat-cell'; d.innerHTML = `<div class="k">${k}</div><div class="v">${v}</div>`; return d; };
      stats.append(make('Symbols', fmt(payload.count)), make('Files', fmt(payload.files)));
      const groups = $('#drawerGroups');
      groups.innerHTML = '';
      for (const f of (payload.fileGroups || []).slice(0, 40)) {
        const div = document.createElement('div');
        div.className = 'drawer-file-group';
        div.innerHTML = `<div class="fg-name">${esc(f.file)}</div><div class="fg-count">${f.count} symbols</div>`;
        groups.appendChild(div);
      }
      $('#drawerTop').innerHTML = (payload.top || []).slice(0, 8).map((n) => `<div class="dt">${esc(n.label)}<span class="dg">${esc(n.loc || '')}</span></div>`).join('');
      $('#moduleDrawer').classList.remove('hidden');
    }

    async selectNode(id) {
      if (!this.slug || !id) return;
      const [facts, np] = await Promise.all([
        api(`/api/symbol/${encodeURIComponent(this.slug)}?id=${encodeURIComponent(id)}`),
        api(`/api/atlas/${encodeURIComponent(this.slug)}/node?id=${encodeURIComponent(id)}`),
      ]);
      this.selected = id;
      this.ego = this.buildEgo(np);
      this.view = 'ego';
      this.renderLegend([]);
      this.activateTab('symbol');
      this.renderCrumbs();
      this.renderSymbolPanel(facts, np);
      this.fitCurrent(1.18);
      this.requestDraw();
    }

    async focusById(id) {
      if (!this.slug || !id) return;
      if (this.module && this.module.nodes.some((n) => n.id === id)) { await this.selectNode(id); return; }
      if (this.ego && this.ego.byId?.has(id)) { await this.selectNode(id); return; }
      const np = await api(`/api/atlas/${encodeURIComponent(this.slug)}/node?id=${encodeURIComponent(id)}`);
      if (np.node.module && np.node.module !== this.moduleId) { await this.openModule(np.node.module); }
      await this.selectNode(id);
    }

    back() {
      if (this.view === 'ego') {
        if (this.module) this.showModuleView(this.module);
        else this.loadOverview(this.slug);
      } else if (this.view === 'module') {
        this.loadOverview(this.slug);
      }
    }

    buildEgo(np) {
      const center = np.node;
      const nbrs = np.neighbors || [];
      const nodes = [{ ...center, x: 0, y: 0, r: 17, rel: 'self', ring: -1 }];
      const rings = [[], [], []];
      nbrs.forEach((n, i) => rings[i < 10 ? 0 : i < 28 ? 1 : 2].push(n));
      rings.forEach((list, ri) => {
        const radius = ri === 0 ? 150 : ri === 1 ? 270 : 390;
        list.forEach((n, i) => {
          const ang = (i / Math.max(1, list.length)) * Math.PI * 2 - Math.PI / 2 + ri * 0.35;
          nodes.push({ ...n, x: Math.cos(ang) * radius, y: Math.sin(ang) * radius, r: 5 + Math.min(8, Math.sqrt(n.degree || 1) * 0.9), ring: ri });
        });
      });
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const links = nbrs.map((n) => ({ source: center.id, target: n.id, rel: n.rel })).filter((l) => byId.has(l.target));
      return { nodes, byId, links, node: center };
    }

    showModuleView(payload) {
      this.module = payload;
      this.moduleId = payload.id;
      this.ego = null;
      this.selected = null;
      this.view = 'module';
      this.renderCrumbs();
      this.activateTab('symbol');
      this.renderSymbolPanel(payload);
      this.fitCurrent(1.24);
      this.requestDraw();
    }

    /* ------------------------------------------------------------ brief */
    renderBriefPanel(brief, opts = {}) {
      const el = $('#briefPanel');
      if (!brief) { el.innerHTML = ''; return; }
      const f = brief.facts || brief;
      const meta = this.overview.meta || {};
      el.innerHTML = `
        <div class="card2">
          <div class="card2-head"><div><div class="card2-title">${esc(this.slug)}</div><div class="card2-sub">${fmt(f.stats?.nodes || 0)} symbols · ${fmt(meta.selectedFiles || 0)} files</div></div></div>
          <div class="stat-grid">
            <div class="stat-cell"><div class="k">Links</div><div class="v">${fmt(f.stats?.links || 0)}</div></div>
            <div class="stat-cell"><div class="k">Entry points</div><div class="v">${fmt((f.entryPoints || []).length)}</div></div>
            <div class="stat-cell"><div class="k">Languages</div><div class="v">${f.languages?.length || 0}</div></div>
          </div>
          ${opts.compact ? '' : (f.modules || []).map((m) => `
            <button class="module-card" data-module="${esc(m.id)}" style="margin-top:8px">
              <div class="module-card-row"><span class="dot"></span><div><div class="mk">${esc(m.name)}</div><div class="mx">${fmt(m.count)} symbols · ${m.files} files</div></div></div>
            </button>`).join('')}
        </div>`;
      $$('[data-module]', el).forEach((b) => b.addEventListener('click', () => this.openModule(b.dataset.module)));
    }

    /* ------------------------------------------------------------ module view */
    renderModuleGrid() {
      const el = $('#symbolPanel');
      $('#briefPanel').innerHTML = '';
      const mods = this.overview.modules.filter((m) => !m.hidden && m.primary !== false);
      const countByModule = new Map(mods.map((m) => [m.id, m.count]));
      const maxCount = Math.max(1, ...mods.map((m) => m.count));
      el.innerHTML = mods.map((m) => {
        const bar = Math.max(1, Math.round((m.count / maxCount) * 100));
        const preview = (m.preview || []).slice(0, 4).map((p) => `<span style="background:${kindTone(p.kind)};opacity:.85"></span>`).join('');
        return `<button class="module-card" data-module="${esc(m.id)}">
          <div class="module-card-row"><span class="dot" style="background:${moduleColor(m.id)}"></span><div><div class="mk">${esc(m.name)}</div><div class="mx">${fmt(m.count)} symbols · ${m.files} files</div></div><span class="dots">${preview}</span></div>
          <div class="bar"><div class="fill" style="width:${bar}%"></div></div>
        </button>`;
      }).join('') || '<p class="muted" style="font-size:12.5px">No modules loaded.</p>';
      $$('[data-module]', el).forEach((b) => b.addEventListener('click', () => this.openModule(b.dataset.module)));
    }

    renderModuleView(payload) {
      const el = $('#symbolPanel');
      const files = (payload.fileGroups || []).slice(0, 6);
      const rest = (payload.fileGroups || []).slice(6);
      el.innerHTML = `
        <div class="card2">
          <div class="card2-head"><div><div class="card2-title">${esc(payload.name)}</div><div class="card2-sub">${esc(payload.dir)}</div></div><span class="chip" style="border-color:${moduleColor(payload.id)};color:${moduleColor(payload.id)}"><span class="k" style="background:${moduleColor(payload.id)}"></span>${esc(payload.kind)}</span></div>
          <div class="stat-grid">
            <div class="stat-cell"><div class="k">Symbols</div><div class="v">${fmt(payload.count)}</div></div>
            <div class="stat-cell"><div class="k">Files</div><div class="v">${fmt(payload.files)}</div></div>
          </div>
          <div class="drawer-file-groups" style="margin-top:10px">
            ${files.map((f) => `<button class="drawer-file-group" style="cursor:pointer" data-file="${esc(f.file)}"><div class="fg-name">${esc(f.file)}</div><div class="fg-count">${f.count} symbols</div></button>`).join('')}
            ${rest.length ? `<details style="margin-top:6px"><summary class="muted" style="cursor:pointer;font-size:10.5px;color:var(--muted)">+${rest.length} more files</summary><div class="drawer-file-groups">${rest.map((f) => `<button class="drawer-file-group" data-file="${esc(f.file)}"><div class="fg-name">${esc(f.file)}</div><div class="fg-count">${f.count}</div></button>`).join('')}</div></details>` : ''}
          </div>
          <div class="chips" style="margin-top:10px">${(payload.top || []).slice(0, 10).map((n) => `<button class="chip" data-node="${esc(n.id)}"><span class="k" style="background:${kindColor(n.kind)}"></span>${esc(n.label)}</button>`).join('')}</div>
          ${payload.satellites?.length ? `<div class="chips" style="margin-top:10px">${payload.satellites.map((s) => `<button class="chip" data-module="${esc(s.id)}">${esc(s.name)} <span style="color:var(--faint)">${s.weight}</span></button>`).join('')}</div>` : ''}
        </div>`;
      $$('[data-module]', el).forEach((b) => b.addEventListener('click', () => this.openModule(b.dataset.module)));
      $$('[data-file]', el).forEach((b) => b.addEventListener('click', () => this.openFileDialog(b.dataset.file)));
      $$('[data-node]', el).forEach((b) => b.addEventListener('click', () => this.focusById(b.dataset.node)));
    }

    renderSymbolPanel(facts, np) {
      if (!facts) {
        const el = $('#symbolPanel');
        if (this.view === 'overview') return;
        el.innerHTML = `
          <div class="card2">
            <div class="card2-head"><div><div class="card2-title">${esc(facts2(this.module)?.name || this.view)}</div><div class="card2-sub">Open a module to read its symbols</div></div></div>
          </div>`;
        return;
      }
      const el = $('#symbolPanel');
      const nbrs = np ? np.neighbors || [] : facts.neighbors || [];
      const snippet = facts.snippet;
      const line = facts.loc ? Number((/L?(\d+)/.exec(String(facts.loc)) || [0, 1])[1]) || 1 : 1;
      el.innerHTML = `
        <div class="card2" style="margin-bottom:10px">
          <div class="sym-card-head">
            <div class="card2-head">
              <div><div class="card2-title">${esc(facts.label)}</div><div class="card2-sub">${esc(facts.file)}${facts.loc ? `:${esc(facts.loc)}` : ''}</div></div>
              <span class="chip" style="border-color:${degreeColor(facts.kind, facts.degree)};color:${degreeColor(facts.kind, facts.degree)}"><span class="k" style="background:${degreeColor(facts.kind, facts.degree)}"></span>${esc(facts.kind || 'symbol')} · ${fmt(facts.degree || 0)} conns</span>
            </div>
            <div class="kv-inline">
              <div class="kv-row"><div class="a">Module</div><div class="b">${esc(facts.module || 'external')}</div></div>
              <div class="kv-row"><div class="a">Callers</div><div class="b">${fmt((facts.callers || []).length)}</div></div>
              <div class="kv-row"><div class="a">Callees</div><div class="b">${fmt((facts.callees || []).length)}</div></div>
            </div>
            ${facts.contract ? `
              <div class="kv-block">
                <div class="kv-row"><div class="a">Params</div><div class="b">${esc(facts.contract.params || '—')}</div></div>
                <div class="kv-row"><div class="a">Returns</div><div class="b">${esc(facts.contract.returns || '—')}</div></div>
                <div class="kv-row"><div class="a">Signature</div><div class="b">${esc(facts.contract.note || '—')}</div></div>
              </div>` : ''}
            ${facts.route?.path?.length > 1 ? `
              <div class="kv-block"><h4>Route to entry</h4>
                <div class="route">${facts.route.path.map((p, i) => `${i ? '<span class="arrow">→</span>' : ''}<button class="hop" data-node="${esc(p.id)}">${esc(p.label)}</button>`).join('')}</div>
              </div>` : ''}
            ${snippet ? `
              <div class="kv-block"><h4>Source</h4>
                <div class="snippet"><div class="snippet-box"><pre>${renderSnippet(snippet, line)}</pre></div>
                <div style="margin-top:6px"><button class="copy-btn" data-snippet="${esc(snippet.text, false)}">Copy snippet</button></div></div>
              </div>` : ''}
            <div style="margin-top:12px;display:flex;gap:8px">
              <button class="chip-btn" data-act="open-file">Open source</button>
              <button class="chip-btn" data-act="explain-symbol">Explain</button>
            </div>
          </div>
        </div>
        <div class="card2">
          <h4 style="color:var(--text);margin-bottom:8px">Connections (${fmt(nbrs.length)})</h4>
          <div class="chips">${nbrs.slice(0, 18).map((n) => `<button class="chip" data-node="${esc(n.id)}"><span class="k" style="background:${kindColor(n.kind)}"></span>${esc(n.label)} <span class="rel" style="color:${n.rel ? relColor(n.rel) : 'var(--faint)'}">${esc(n.rel || '')}</span></button>`).join('') || '<span class="muted">No linked symbols.</span>'}</div>
        </div>`;
      $$('[data-node]', el).forEach((b) => b.addEventListener('click', () => this.focusById(b.dataset.node)));
      $$('[data-act="open-file"]', el)?.forEach((b) => b.addEventListener('click', () => this.openFileDialog(facts.file, line)));
      $$('[data-act="explain-symbol"]', el)?.forEach((b) => b.addEventListener('click', async () => {
        const btn = b; setBusy(btn, true, 'Reading symbol…');
        try {
          const out = await api('/api/explain', { method: 'POST', body: JSON.stringify({ slug: this.slug, kind: 'symbol', id: facts.id }) });
          toast(out.narrative || out.warning || 'No explanation available');
        } catch (err) { toast(err.message); }
        finally { setBusy(btn, false); }
      }));
      $$('.copy-btn', el).forEach((b) => b.addEventListener('click', () => this.copySnippet(b)));
    }

    copySnippet(btn) {
      const text = String(btn.dataset.snippet || '');
      navigator.clipboard?.writeText(text).catch(() => toast('Clipboard blocked'));
      toast('Snippet copied');
    }

    /* ------------------------------------------------------------ ask */
    async ask() {
      const input = $('#askPanel input[type=text], #askPanel textarea');
      const q = (input && input.value.trim());
      if (!q || this.askBusy || !this.slug) return;
      this.askBusy = true;
      if (input) input.value = '';
      const item = { q, pending: true };
      this.qa.push(item);
      this.renderAsk();
      const out = await api('/api/ask', { method: 'POST', body: JSON.stringify({ slug: this.slug, question: q }) }).catch((e) => ({ error: e.message }));
      item.pending = false;
      item.a = out.answer || '';
      item.warning = out.warning || '';
      item.sources = out.sources || [];
      item.followups = out.followups || [];
      this.askBusy = false;
      this.renderAsk();
    }

    renderAsk() {
      const el = $('#askPanel');
      el.innerHTML = `
        <div class="ask-thread">
          ${this.qa.map((q, i) => `
            <div class="ask-block question" data-idx="${i}">
              <div class="ask-meta"><span style="color:var(--text)">${esc(q.q)}${q.pending ? ' <span style="color:var(--faint)">…</span>' : ''}</span></div>
              ${q.pending ? '<div class="ask-body"><span class="spinner"></span>Reading the graph…</div>' : ''}
              ${q.a ? `<div class="ask-block answer"><div class="ask-body">${md(q.a)}</div></div>` : ''}
              ${q.warning ? `<div class="ask-block answer"><div class="ask-body" style="color:var(--faint)">${esc(q.warning)}</div></div>` : ''}
              ${q.error ? `<div class="ask-block answer"><div class="ask-body" style="color:var(--red)">${esc(q.error)}</div></div>` : ''}
              ${(q.sources || []).length ? `<div class="ask-source">${q.sources.map((s) => `<button class="ask-source-row" data-file="${esc(s.file)}" data-loc="${esc(s.loc || '')}"><span class="loc">${esc(s.loc || '')}</span><span>${esc(short(s.file, 46))}</span></button>`).join('')}</div>` : ''}
              ${(q.followups || []).length ? `<div class="chips" style="margin-top:8px">${q.followups.map((f) => `<button class="chip" data-follow="${esc(f)}">${esc(f)}</button>`).join('')}</div>` : ''}
            </div>`).join('')}
        </div>
        <div class="ask-composer">
          <textarea id="askInput" placeholder="How does auth reach the database?" rows="2"></textarea>
          <button id="askBtn" class="chip-btn" style="float:right"${this.askBusy ? ' disabled' : ''}>Ask</button>
        </div>`;
      $$('.ask-source-row', el).forEach((b) => b.addEventListener('click', () => this.openFileDialog(b.dataset.file, Number(b.dataset.loc) || 1)));
      $$('[data-follow]', el).forEach((b) => b.addEventListener('click', () => { const q = b.dataset.follow; if (q) { const ta = $('#askInput'); if (ta) ta.value = q; this.ask(); } }));
      const ta = $('#askInput');
      ta?.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); this.ask(); } });
      $('#askBtn')?.addEventListener('click', () => this.ask());
      if (this.tab === 'ask') ta?.focus();
    }

    /* ------------------------------------------------------------ tour */
    async loadTour(btn) {
      const b = btn || $('#tourBtn');
      if (!b) return;
      setBusy(b, true, 'Writing tour…');
      try {
        const out = await api(`/api/tour/${encodeURIComponent(this.slug)}?refresh=1`);
        this.tour = out.tour;
        this.tourWarning = out.warning || null;
        b.dataset.loaded = '1';
      } catch (err) { toast(err.message); return; }
      finally { setBusy(b, false); }
      this.renderTour();
    }

    parseTour(text) {
      const steps = [];
      const lines = String(text || '').split('\n');
      let cur = null;
      for (const line of lines) {
        const t = line.trim();
        if (/^#{1,4}\s+/.test(t) || /^\d+[).:]\s/.test(t)) {
          if (cur) steps.push(cur);
          cur = { title: t.replace(/^[#*>\d().:-\s]+/, '').slice(0, 90), desc: '', done: false };
        } else if (cur) {
          if (t) cur.desc = cur.desc ? `${cur.desc} ${t}` : t;
        }
      }
      if (cur) steps.push(cur);
      return steps;
    }

    renderTour() {
      const el = $('#tourPanel');
      if (!this.tour) {
        el.innerHTML = `<p class="muted" style="margin-bottom:10px">A guided reading order for this repository, built from its real symbols.</p><button class="chip-btn" id="tourBtn">Generate tour</button>`;
        $('#tourBtn')?.addEventListener('click', (e) => this.loadTour(e.currentTarget));
        return;
      }
      const steps = this.parseTour(this.tour);
      const doneCount = steps.filter((s) => s.done).length;
      el.innerHTML = `
        <div class="tour-progress"><div class="tour-bar"><div class="fill" style="width:${(doneCount / Math.max(1, steps.length)) * 100}%"></div></div><span style="color:var(--text);font-size:11px">${doneCount}/${steps.length} read</span></div>
        <div class="tour-steps">
          ${steps.map((s, i) => `
            <div class="tour-step${s.done ? ' done' : ''}">
              <span class="idx">${String(i + 1).padStart(2, ' ')}</span>
              <span></span>
              <div class="tw">
                <div class="tt">${esc(s.title)} ${s.done ? '<span style="color:var(--green)">· done</span>' : ''}</div>
                <div class="tc">${esc(s.desc)}</div>
                <div class="tn"><button class="go" data-idx="${i}">Read <span style="color:var(--cyan)">${esc(s.title)}</span> →</button></div>
              </div>
              <button class="go" data-idx="${i}" aria-label="Mark read">✔</button>
            </div>`).join('')}
        </div>
        ${this.tourWarning ? `<p class="muted" style="margin-top:10px;font-size:11px">${esc(this.tourWarning)}</p>` : ''}
        <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line);display:flex;gap:8px"><button class="chip-btn" id="tourReset" style="font-size:11px">Reset progress</button><button class="chip-btn" id="tourRefresh" style="font-size:11px">Regenerate</button></div>`;
      $$('.tour-step .go', el).forEach((b) => b.addEventListener('click', async () => {
        const idx = Number(b.dataset.idx);
        const step = steps[idx];
        const mods = this.overview ? this.overview.modules.filter((m) => !m.hidden && m.primary !== false) : [];
        const words = String(step.title + ' ' + step.desc).split(/[^\w]+/).filter((w) => w.length >= 4).slice(0, 4);
        for (const w of words) {
          const m = mods.find((m) => m.name.toLowerCase().includes(w.toLowerCase()));
          if (m) { this.openModule(m.id); return; }
          const r = await api(`/api/atlas/${encodeURIComponent(this.slug)}/search?q=${encodeURIComponent(w)}`).catch(() => null);
          const hit = (r && r.results && r.results[0]);
          if (hit) { await this.focusById(hit.id); return; }
        }
        toast('No matching module for this step');
      }));
      $$('.tour-step button[aria-label]', el).forEach((b) => b.addEventListener('click', () => {
        const idx = Number(b.closest('.tour-step').querySelector('.idx').textContent.trim());
        steps[idx].done = true;
        this.renderTour();
      }));
      $('#tourReset')?.addEventListener('click', () => { this.tourDone = new Set(); this.tourIdx = 0; toast('Tour progress reset'); });
      $('#tourRefresh')?.addEventListener('click', (e) => this.loadTour(e.currentTarget));
    }

    /* ------------------------------------------------------------ study */
    async loadStudy(btn) {
      const b = btn || $('#studyBtn');
      if (!b) return;
      setBusy(b, true, 'Making cards…');
      try {
        const out = await api(`/api/studykit/${encodeURIComponent(this.slug)}`);
        this.study = out;
        this.studyWarning = out.warning || null;
        this.flashIdx = 0;
        this.studyTab = 'flash';
        this.renderStudy();
      } catch (err) { toast(err.message); }
      finally { setBusy(b, false); }
    }

    renderStudy() {
      const el = $('#studyPanel');
      const kit = this.study || {};
      if (!this.study) {
        el.innerHTML = `<p class="muted" style="margin-bottom:10px">Flashcards and a quiz built from this repository's real symbols and files.</p><button class="chip-btn" id="studyBtn">Make cards</button>`;
        $('#studyBtn')?.addEventListener('click', (e) => this.loadStudy(e.currentTarget));
        return;
      }
      if (this.studyTab === 'quiz') { this.renderQuiz(el, kit); return; }
      const cards = kit.flashcards || [];
      const view = cards.slice(this.flashIdx, this.flashIdx + 3);
      el.innerHTML = `<div class="flashcard">${view.map((c) => `<div class="card-wrap"><div class="card-side front"><div class="q">${esc(c.front)}</div><div class="a">${esc(c.back)}</div><div class="flip-hint">click to flip · space</div></div><div class="card-side back"><div class="q">${esc(c.front)}</div><div class="a">${esc(c.back)}</div></div></div>`).join('')}</div>`;
      $$('.card-wrap', el).forEach((w) => { if (REDUCED) w.classList.add('flipped'); w.addEventListener('click', () => w.classList.toggle('flipped')); });
      this.renderStudyFooter(kit);
    }

    renderStudyFooter(kit) {
      const el = $('#studyPanel');
      if (this.studyTab !== 'flash' || !kit.flashcards?.length) return;
      el.insertAdjacentHTML('beforeend', `
        ${this.studyWarning ? `<p class="muted" style="margin-top:10px;font-size:11px">${esc(this.studyWarning)}</p>` : ''}
        <div style="margin-top:12px;display:flex;gap:8px">
          ${(kit.quiz || []).length ? '<button class="chip-btn" id="quizBtn" style="font-size:11px">Jump to quiz</button>' : ''}
          ${this.flashIdx + 1 < kit.flashcards.length ? `<button class="chip-btn" id="nextCard" style="font-size:11px">Next card →</button>` : ''}
        </div>`);
      $('#nextCard')?.addEventListener('click', () => {
        this.flashIdx = Math.min(kit.flashcards.length - 1, this.flashIdx + 1);
        this.renderStudy();
      });
      $('#quizBtn')?.addEventListener('click', () => {
        this.studyTab = 'quiz';
        this.quizIdx = 0;
        this.quizAnswered = null;
        this.renderStudy();
      });
    }

    renderQuiz(el, kit) {
      const q = (kit.quiz || [])[this.quizIdx];
      const total = (kit.quiz || []).length;
      if (!q) { this.studyTab = 'flash'; this.renderStudy(); return; }
      el.innerHTML = `
        <div class="card2">
          <div class="quiz-q">${esc(q.question)}</div>
          <div class="quiz-progress">
            <div class="fill"><div style="width:${((this.quizIdx + 1) / total) * 100}%"></div></div>
            <span style="color:var(--green)">✓ ${this.studyRight}</span>
            <span style="color:var(--red)">✗ ${this.studyWrong}</span>
            <span style="color:var(--faint)">${this.quizIdx + 1}/${total}</span>
          </div>
        </div>
        <div class="quiz-quiz">
          ${q.options.map((o, i) => `
            <button class="quiz-opt" data-opt="${i}"${this.quizAnswered != null ? ' disabled' : ''}
              style="border-color:${this.quizAnswered === i ? (i === q.answerIndex ? 'var(--green)' : 'var(--red)') : 'var(--line)'};background:${this.quizAnswered === i ? (i === q.answerIndex ? 'rgba(124,224,168,0.12)' : 'rgba(255,111,136,0.08)') : 'transparent'}">${esc(o)}</button>`).join('')}
          ${q.explanation && this.quizAnswered !== null ? `<div style="margin-top:8px;font-size:11.5px;color:var(--muted)">${esc(q.explanation)}</div>` : ''}
        </div>
        ${this.quizIdx + 1 < total ? `<div style="margin-top:12px;display:flex;gap:8px"><button class="chip-btn" id="quizNext">Next question →</button></div>` : `<div style="margin-top:12px;display:flex;gap:8px"><button class="chip-btn" id="quizReset" style="font-size:11px">Start over</button></div>`}`;
      $$('[data-opt]', el).forEach((b) => b.addEventListener('click', () => {
        if (this.quizAnswered != null) return;
        const i = Number(b.dataset.opt);
        this.quizAnswered = i;
        if (i === q.answerIndex) this.studyRight += 1;
        else this.studyWrong += 1;
        this.renderQuiz(el, kit);
      }));
      $('#quizNext')?.addEventListener('click', () => {
        this.quizIdx = Math.min((kit.quiz || []).length - 1, this.quizIdx + 1);
        this.quizAnswered = null;
        this.renderQuiz(el, kit);
      });
      $('#quizReset')?.addEventListener('click', () => {
        this.quizIdx = 0;
        this.quizAnswered = null;
        this.studyRight = 0;
        this.studyWrong = 0;
        this.renderQuiz(el, kit);
      });
    }

    /* ------------------------------------------------------------ file dialog */
    async openFileDialog(file, line = 1) {
      const dlg = $('#fileDialog');
      $('#fileDialogPath').textContent = file;
      try { dlg.showModal(); } catch {}
      $('#fileContent').innerHTML = '<div class="line"><span class="no"></span>Loading…</div>';
      try {
        const out = await api(`/api/file/${encodeURIComponent(this.slug)}?path=${encodeURIComponent(file)}`);
        const lines = String(out.content || '').split('\n');
        const target = clamp(Number(line) || 1, 1, lines.length);
        $('#fileContent').innerHTML = lines.map((l, i) => {
          const no = i + 1;
          return `<span class="line${no === target ? ' hl' : ''}"><span class="no">${no}</span>${highlightCode(l)}</span>`;
        }).join('');
        const hl = $('#fileContent .hl');
        if (hl) hl.scrollIntoView({ block: 'center' });
      } catch (err) {
        $('#fileContent').innerHTML = `<div class="line"><span class="no"></span>${esc(err.message)}</div>`;
      }
    }

    /* ------------------------------------------------------------ search */
    search() {
      const q = $('#search').value.trim();
      const box = $('#searchResults');
      box.classList.add('hidden');
      if (!q || !this.slug) return;
      clearTimeout(this.timers.search);
      this.timers.search = setTimeout(async () => {
        if (this.searchAbort) this.searchAbort.abort();
        this.searchAbort = new AbortController();
        try {
          const out = await api(`/api/atlas/${encodeURIComponent(this.slug)}/search?q=${encodeURIComponent(q)}`, { signal: this.searchAbort.signal });
          const list = out.results || [];
          if (!list.length) { box.innerHTML = `<div class="results-empty">No matches for "${esc(q)}".</div>`; }
          else {
            box.innerHTML = list.map((r) => `
              <button class="search-result" data-id="${esc(r.id)}">
                <span class="k" style="background:${kindColor(r.kind)}"></span>
                <span><span class="lbl">${esc(r.label)}</span><span class="path">${esc(r.file)}${r.loc ? `:${esc(r.loc)}` : ''}</span></span>
                <span class="deg">${fmt(r.degree)}</span>
              </button>`).join('');
          }
          box.classList.remove('hidden');
          $$('.search-result', box).forEach((b) => b.addEventListener('click', () => { box.classList.add('hidden'); this.focusById(b.dataset.id); }));
        } catch (err) { if (err.name !== 'AbortError') console.warn(err); }
      }, 150);
    }

    /* ------------------------------------------------------------ palette */
    openPalette() {
      $('#palette').classList.remove('hidden');
      setTimeout(() => $('#paletteInput').focus(), 30);
    }
    closePalette() { $('#palette').classList.add('hidden'); }
    async paletteSearch(q) {
      const box = $('#paletteResults');
      if (this.paletteAbort) this.paletteAbort.abort();
      this.paletteAbort = new AbortController();
      const out = await api(`/api/atlas/${encodeURIComponent(this.slug)}/search?q=${encodeURIComponent(q)}`, { signal: this.paletteAbort.signal }).catch(() => null);
      const list = out ? (out.results || []) : [];
      box.innerHTML = list.map((r) => `
        <button class="search-result" data-id="${esc(r.id)}">
          <span class="k" style="background:${kindColor(r.kind)}"></span>
          <span><span class="lbl">${esc(r.label)}</span><span class="path">${esc(r.file)}</span></span>
          <span class="deg">${fmt(r.degree)}</span></button>`).join('') || `<div class="results-empty">No matches.</div>`;
      $$('.search-result', box).forEach((b) => b.addEventListener('click', () => { box.classList.add('hidden'); $('#palette').classList.add('hidden'); this.focusById(b.dataset.id); }));
    }

    /* ------------------------------------------------------------ sidebar */
    toggleSidebar() {
      $('#sidebar').classList.toggle('open');
    }
    async drawSidebar() {
      const el = $('#sidebarBody');
      el.innerHTML = `
        <div class="group">
          <div class="gtitle">Repository</div>
          ${(this.repoList.map((r) => `<button class="item" data-slug="${esc(r.slug)}"><span class="b6"></span><span class="label">${esc((r.meta && r.meta.repo || r.slug).replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '') || r.slug)}</span><span class="cnt"></span></button>`)).join('')}
        </div>
        <div class="group">
          <div class="gtitle">Module map</div>
          ${(this.overview ? this.overview.modules.filter((m) => m.primary !== false).map((m) => `<button class="item${m.hidden ? '' : ''}" data-module="${esc(m.id)}"><span class="b6"></span><span class="label">${esc(m.name)}</span><span class="cnt">${fmt(m.count)}</span></button>`).join('') : '')}
        </div>
        <div class="group">
          <div class="gtitle">Quick actions</div>
          ${this.slug ? [
            ['Map', '#', () => this.loadOverview(this.slug)],
            ['Ask', '#', () => this.activateTab('ask')],
            ['Tour', '#', () => this.activateTab('tour')],
            ['Study', '#', () => this.activateTab('study')],
          ].map(([n, _, fn]) => `<button class="item" data-action="${n.toLowerCase()}"><span class="b6"></span><span class="label">${n}</span></button>`).join('') : '<span style="padding:7px 8px;font-size:11.5px;color:var(--faint)">Map a repo to unlock</span>'}
        </div>
        <div class="group">
          <div class="gtitle">Theme</div>
          <button class="item" id="sidebarTheme"><span class="b6"></span><span class="label">${document.documentElement.dataset.theme || 'dark'}</span><span class="cnt"></span></button>
        </div>`;
      $$('#sidebarBody [data-slug]', el).forEach((b) => b.addEventListener('click', () => this.loadOverview(b.dataset.slug)));
      $$('#sidebarBody [data-module]', el).forEach((b) => b.addEventListener('click', () => this.openModule(b.dataset.module)));
      $$('#sidebarBody [data-action="map"]', el).forEach((b) => b.addEventListener('click', () => { this.toggleSidebar(); if (this.slug) this.loadOverview(this.slug); }));
      $$('#sidebarBody [data-action="ask"]', el).forEach((b) => b.addEventListener('click', () => this.activateTab('ask')));
      $$('#sidebarBody [data-action="tour"]', el).forEach((b) => b.addEventListener('click', () => this.activateTab('tour')));
      $$('#sidebarBody [data-action="study"]', el).forEach((b) => b.addEventListener('click', () => this.activateTab('study')));
      $('#sidebarTheme')?.addEventListener('click', () => { this.themeToggle(); this.drawSidebar(); });
    }

    /* ------------------------------------------------------------ canvas */
    resize() {
      const r = $('#stage').getBoundingClientRect();
      this.W = Math.max(1, r.width);
      this.H = Math.max(1, r.height);
      this.DPR = Math.min(window.devicePixelRatio || 1, 2);
      const c = $('#map');
      const m = $('#mini');
      c.width = Math.round(this.W * this.DPR); c.height = Math.round(this.H * this.DPR);
      c.style.width = `${this.W}px`; c.style.height = `${this.H}px`;
      m.width = 234; m.height = 160;
      this.requestDraw();
    }
    requestDraw() { if (this.drawRaf) return; this.drawRaf = requestAnimationFrame(() => { this.drawRaf = 0; this.setTransform(); }); }

    sx = (x) => (x - this.cam.x) * this.cam.k + this.W / 2;
    sy = (y) => (y - this.cam.y) * this.cam.k + this.H / 2;
    wx = (p) => (p - this.W / 2) / this.cam.k + this.cam.x;
    wy = (p) => (p - this.H / 2) / this.cam.k + this.cam.y;

    setTransform() {
      const ctx = $('#map').getContext('2d');
      ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
      ctx.clearRect(0, 0, this.W, this.H);
      ctx.save();
      ctx.translate(this.W / 2, this.H / 2);
      ctx.scale(this.cam.k, this.cam.k);
      ctx.translate(-this.cam.x, -this.cam.y);
      if (this.view === 'overview') this.drawOverview(ctx);
      else if (this.view === 'module') this.drawModule(ctx);
      else this.drawEgo(ctx);
      ctx.restore();
      this.drawMinimap();
    }

    drawIdle(ctx) {
      const t = performance.now() / 1000;
      ctx.save();
      ctx.translate(0, 0);
      ctx.beginPath();
      ctx.arc(0, 0, 120, 0, Math.PI * 2);
      ctx.strokeStyle = alpha(C.cyan, 0.08);
      ctx.lineWidth = 1 / this.cam.k;
      ctx.stroke();
      let seed = 7;
      const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
      const dots = [];
      for (let i = 0; i < 24; i++) {
        const a = rnd() * Math.PI * 2;
        const r = 60 + rnd() * 140;
        dots.push({ x: Math.cos(a) * r, y: Math.sin(a) * r * 0.72, s: 1 + rnd() * 1.5, ph: rnd() * 6 });
      }
      for (const d of dots) {
        const a = 0.15 + 0.1 * Math.sin(t + d.ph);
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.s * 1.8, 0, Math.PI * 2);
        ctx.fillStyle = alpha(C.cyan, a);
        ctx.fill();
      }
      ctx.fillStyle = C.text;
      ctx.font = `600 15px ${C.sans}`;
      ctx.textAlign = 'center';
      ctx.fillText('Map a repository', 0, 8);
      ctx.font = `11px ${C.mono}`;
      ctx.fillStyle = C.faint;
      ctx.fillText('github.com/owner/repo', 0, 30);
      ctx.restore();
    }

    drawOverview(ctx) {
      if (!this.overview) return this.drawIdle(ctx);
      const mods = this.overview.modules.filter((m) => !m.hidden && m.primary !== false);
      if (!mods.length) return this.drawIdle(ctx);
      const maxW = Math.max(1, ...this.overview.links.map((l) => l.weight));
      const byId = new Map(mods.map((m) => [m.id, m]));
      // Edges
      for (const l of this.overview.links) {
        const a = byId.get(l.source), b = byId.get(l.target);
        if (!a || !b) continue;
        const w = l.weight / maxW;
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const bend = Math.min(80, len * 0.15);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(mx - (dy / len) * bend, my + (dx / len) * bend, b.x, b.y);
        ctx.strokeStyle = alpha(w > 0.4 ? C.accent : C.stone, 0.16 + 0.3 * w);
        ctx.lineWidth = (0.7 + 0.9 * w) / this.cam.k;
        ctx.stroke();
      }
      const labelFont = `600 ${10.5 / this.cam.k}px ${C.mono}`;
      ctx.font = labelFont;
      const placed = [];
      const labels = [...mods]
        .sort((a, b) => (b.r || 0) - (a.r || 0))
        .map((m) => {
          const text = short(m.name, 26).toUpperCase();
          const w = ctx.measureText(text).width;
          const h = 11 / this.cam.k;
          const cands = [
            m.y + m.r + 15 / this.cam.k,
            m.y + m.r + 28 / this.cam.k,
            m.y - m.r - 9 / this.cam.k,
            m.y - m.r - 22 / this.cam.k,
          ];
          const score = (ly) => {
            let s = 0;
            for (const o of mods) {
              if (o === m) continue;
              const dx = Math.max(0, Math.abs(m.x - o.x) - w / 2);
              const dy = Math.max(0, Math.abs(ly - o.y) - h / 2);
              const d = Math.hypot(dx, dy);
              if (d < o.r) s += 2 * (o.r - d) / Math.max(1, o.r);
            }
            for (const p of placed) {
              const ox = Math.min(m.x + w / 2, p.x + p.w / 2) - Math.max(m.x - w / 2, p.x - p.w / 2);
              const oy = Math.min(ly + h / 2, p.y + p.h / 2) - Math.max(ly - h / 2, p.y - p.h / 2);
              if (ox > 0 && oy > 0) s += 4 * (ox * oy) / Math.max(1, w * h);
            }
            return s;
          };
          let best = cands[0], bestS = Infinity;
          for (const c of cands) { const sc = score(c); if (sc < bestS) { bestS = sc; best = c; } }
          placed.push({ x: m.x, y: best, w, h });
          return { m, text, y: best };
        });
      for (const m of mods) {
        const color = m.kind === 'support' ? C.muted : moduleColor(m.id);
        const hovered = this.hover?.type === 'module' && this.hover.id === m.id;
        const g = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, m.r * 2.1);
        g.addColorStop(0, alpha(color, hovered ? 0.4 : 0.3));
        g.addColorStop(0.55, alpha(color, 0.12));
        g.addColorStop(1, alpha(color, 0));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(m.x, m.y, m.r * 2.1, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
        ctx.fillStyle = alpha(color, hovered ? 0.34 : 0.22);
        ctx.fill();
        ctx.strokeStyle = alpha(color, hovered ? 1 : 0.78);
        ctx.lineWidth = (hovered ? 2.2 : 1.3) / this.cam.k;
        ctx.stroke();
        for (const p of m.preview || []) {
          ctx.beginPath(); ctx.arc(m.x + p.x * m.r * 0.55, m.y + p.y * m.r * 0.55, 1.8, 0, Math.PI * 2);
          ctx.fillStyle = alpha(kindTone(p.kind), 0.92);
          ctx.fill();
        }
      }
      ctx.font = labelFont;
      ctx.textAlign = 'center';
      ctx.lineJoin = 'round';
      for (const l of labels) {
        const hovered = this.hover?.type === 'module' && this.hover.id === l.m.id;
        ctx.lineWidth = 3.4 / this.cam.k;
        ctx.strokeStyle = alpha(C.bg, 0.88);
        ctx.strokeText(l.text, l.m.x, l.y);
        ctx.fillStyle = hovered ? C.accentText : alpha(C.text, 0.9);
        ctx.fillText(l.text, l.m.x, l.y);
      }
    }

    drawModule(ctx) {
      const m = this.module;
      if (!m) return this.drawIdle(ctx);
      const nodes = m.nodes || [];
      if (!nodes.length) return this.drawIdle(ctx);
      const labelsOn = nodes.length <= 160;
      const top = labelsOn ? [...nodes].sort((a, b) => b.degree - a.degree).slice(0, 14).map((n) => n.id) : [];
      const topSet = new Set(top);
      for (const n of nodes) {
        const color = degreeColor(n.kind, n.degree);
        const hovered = this.hover?.type === 'node' && this.hover.id === n.id;
        const selected = this.selected === n.id;
        const g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.r * 2.4);
        g.addColorStop(0, alpha(color, hovered || selected ? 0.3 : 0.14));
        g.addColorStop(0.6, alpha(color, 0.05));
        g.addColorStop(1, alpha(color, 0));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r * 2.4, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fillStyle = alpha(color, hovered ? 0.36 : 0.24);
        ctx.fill();
        ctx.strokeStyle = alpha(color, selected ? 1 : hovered ? 0.95 : 0.55);
        ctx.lineWidth = (selected ? 2.4 : 1.1) / this.cam.k;
        ctx.stroke();
        if (topSet.has(n.id) || hovered || selected) {
          ctx.font = `${selected || hovered ? 600 : 500} ${10.5 / this.cam.k}px ${C.sans}`;
          ctx.fillStyle = selected || hovered ? C.text : alpha(C.text, 0.7);
          ctx.textAlign = 'center';
          ctx.fillText(short(n.label, 28), n.x, n.y - n.r - 6 / this.cam.k);
        }
      }
    }

    drawEgo(ctx) {
      const ego = this.ego;
      if (!ego) return;
      const byId = ego.byId;
      for (const l of ego.links) {
        const a = byId.get(l.source), b = byId.get(l.target);
        if (!a || !b) continue;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = alpha(relColor(l.rel), 0.26);
        ctx.lineWidth = 1.2 / this.cam.k;
        ctx.stroke();
      }
      for (const n of ego.nodes) {
        const isCenter = n.rel === 'self';
        const color = isCenter ? C.cyan : kindColor(n.kind);
        const hovered = this.hover?.type === 'node' && this.hover.id === n.id;
        const r = n.r;
        if (isCenter || hovered) {
          const g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, r * 3.2);
          g.addColorStop(0, alpha(color, isCenter ? 0.28 : 0.24));
          g.addColorStop(1, alpha(color, 0));
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(n.x, n.y, r * 3.2, 0, Math.PI * 2); ctx.fill();
        }
        ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = alpha(color, isCenter ? 0.42 : 0.26);
        ctx.fill();
        ctx.strokeStyle = alpha(color, isCenter ? 1 : 0.65);
        ctx.lineWidth = isCenter ? 2 / this.cam.k : 0.8 / this.cam.k;
        ctx.stroke();
        const show = isCenter || hovered || n.ring === 0 || (n.ring === 1 && (n.degree || 0) > 8);
        if (show) {
          ctx.font = `${isCenter ? 640 : 500} ${(isCenter ? 12 : 10) / this.cam.k}px ${C.sans}`;
          ctx.fillStyle = isCenter ? C.text : alpha(C.text, 0.72);
          ctx.textAlign = 'center';
          ctx.fillText(short(n.label, 28), n.x, n.y - r - 6 / this.cam.k);
        }
      }
    }

    drawMinimap() {
      const mctx = $('#mini').getContext('2d');
      mctx.setTransform(1, 0, 0, 1, 0, 0);
      mctx.clearRect(0, 0, 234, 160);
      const b = this.bounds;
      if (!b) return;
      const mw = 234, mh = 160;
      const pad = 10;
      const bw = Math.max(1, b.maxX - b.minX), bh = Math.max(1, b.maxY - b.minY);
      const k = Math.min((mw - pad * 2) / bw, (mh - pad * 2) / bh);
      const ox = pad + (mw - pad * 2 - bw * k) / 2;
      const oy = pad + (mh - pad * 2 - bh * k) / 2;
      const map = (x, y) => [ox + (x - b.minX) * k, oy + (y - b.minY) * k];
      mctx.strokeStyle = alpha(C.lineStrong, 0.55);
      mctx.lineWidth = 1;
      mctx.strokeRect(ox, oy, bw * k, bh * k);
      const nodes = this.view === 'overview'
        ? (this.overview?.modules || []).filter((m) => !m.hidden && m.primary !== false)
        : (this.view === 'module' ? (this.module?.nodes || []) : (this.ego?.nodes || []));
      for (const n of nodes) {
        const [x, y] = map(n.x, n.y);
        mctx.beginPath();
        mctx.arc(x, y, this.view === 'overview' ? Math.max(1.5, n.r * k * 0.4) : 1.6, 0, Math.PI * 2);
        mctx.fillStyle = this.view === 'overview' ? alpha(moduleColor(n.id), 0.65) : alpha(kindColor(n.kind), 0.72);
        mctx.fill();
      }
      // Coverage bar
      const meta = this.overview?.meta || {};
      const served = this.overview?.stats?.nodes || 0;
      const total = this.view === 'module' && this.module ? this.module.count : (meta.totalNodes || served || 1);
      const frac = clamp(served / total, 0, 1);
      const bar = $('#coverageBar'), barTotal = Math.max(1, $('#coverageBar').closest('.bar').clientWidth || 100);
      bar.style.width = `${Math.round(frac * 100)}%`;
      bar.classList.toggle('warn', frac < 0.6);
      $('#coverageText').textContent = `${Math.round(frac * 100)}% served`;
    }

    /* ------------------------------------------------------------ camera */
    fitBounds(b, pad = 1.24) {
      this.bounds = b;
      const bw = Math.max(1, b.maxX - b.minX), bh = Math.max(1, b.maxY - b.minY);
      this.cam.k = clamp(Math.min((this.W - 60) / (bw * pad), (this.H - 60) / (bh * pad)), 0.05, 4);
      this.cam.x = (b.minX + b.maxX) / 2;
      this.cam.y = (b.minY + b.maxY) / 2;
      this.requestDraw();
    }
    fitCurrent(pad = 1.24) {
      let src = [];
      if (this.view === 'overview' && this.overview) {
        src = this.overview.modules.filter((m) => !m.hidden && m.primary !== false);
      } else if (this.view === 'module' && this.module) src = this.module.nodes || [];
      else if (this.view === 'ego' && this.ego) src = this.ego.nodes || [];
      if (!src.length) return;
      this.fitBounds({ minX: Math.min(...src.map((n) => n.x - (n.r || 5))), maxX: Math.max(...src.map((n) => n.x + (n.r || 5))), minY: Math.min(...src.map((n) => n.y - (n.r || 5))), maxY: Math.max(...src.map((n) => n.y + (n.r || 5))) }, pad);
      if (this.view === 'overview') this.cam.k = Math.min(this.cam.k, 1.3);
    }

    hitTest(px, py) {
      const p = { x: this.wx(px), y: this.wy(py) };
      if (this.view === 'overview' && this.overview) {
        let best = null, bestD = Infinity;
        for (const m of this.overview.modules) {
          if (m.hidden) continue;
          const d = Math.hypot(p.x - m.x, p.y - m.y);
          if (d <= m.r + 8 / this.cam.k && d < bestD) { best = m; bestD = d; }
        }
        return best ? { type: 'module', id: best.id, item: best } : null;
      }
      const pool = this.view === 'module' ? (this.module?.nodes || []) : (this.view === 'ego' ? (this.ego?.nodes || []) : []);
      let best = null, bestD = Infinity;
      for (const n of pool) {
        const d = Math.hypot(p.x - n.x, p.y - n.y);
        if (d <= (n.r || 5) + 8 / this.cam.k && d < bestD) { best = n; bestD = d; }
      }
      return best ? { type: 'node', id: best.id, item: best } : null;
    }

    /* ------------------------------------------------------------ ui */
    activateTab(name) {
      this.tab = name;
      $$('.tab').forEach((t) => {
        const on = t.dataset.tab === name;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      $$('.panel').forEach((p) => {
        const on = p.id === `${name}Tab`;
        p.classList.toggle('active', on);
        // Panels ship with `hidden`; it must be removed or .panel.active never shows.
        p.classList.toggle('hidden', !on);
      });
      if (name === 'ask') this.renderAsk();
      if (name === 'tour') this.renderTour();
      if (name === 'study') this.renderStudy();
      if (name === 'symbol' && this.view === 'ego') this.renderSymbolPanel();
    }
    renderRailHead() {
      const st = this.overview?.stats || null;
      $('#railRepo').textContent = this.slug || 'No repository';
      $('#railStats').textContent = st ? `${exact(st.nodes)} symbols · ${exact(st.links)} links` : 'Choose a repo';
    }
    renderStats() {
      const el = $('#repoStats');
      if (!this.overview) { el.innerHTML = ''; return; }
      const st = this.overview.stats || {};
      const files = this.overview.meta?.selectedFiles || 0;
      el.innerHTML = [
        `<span class="stat"><b>${exact(st.nodes)}</b> symbols</span>`,
        `<span class="stat"><b>${exact(st.links)}</b> links</span>`,
        `<span class="stat"><b>${exact(files)}</b> files</span>`,
      ].join('');
    }
    renderLegend(nodes) {
      const el = $('#legend');
      if (nodes) {
        const kinds = new Map();
        for (const n of nodes) { const k = String(n.kind || 'symbol').toLowerCase(); kinds.set(k, (kinds.get(k) || 0) + 1); }
        const top = [...kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
        el.innerHTML = top.map(([k, c]) => `<span class="legend-item"><span class="dot" style="background:${kindColor(k)}"></span>${esc(k)} <span style="color:var(--faint)">${fmt(c)}</span></span>`).join('');
      } else {
        el.innerHTML = '<span class="legend-item"><span class="legend-item i" style="background:var(--cyan)"></span>modules</span>';
      }
    }
    renderCrumbs() {
      const el = $('#crumbs');
      if (!this.slug) { el.innerHTML = ''; return; }
      const parts = [`<button class="crumb${this.view === 'overview' ? ' current' : ''}" data-kind="overview">${esc(this.slug)}</button>`];
      if (this.view === 'module' && this.module) {
        parts.push(`<span class="crumb-sep">·</span><button class="crumb current">${esc(this.module.name)}</button>`);
      }
      el.innerHTML = parts.join('');
      $$('.crumb', el).forEach((b) => b.addEventListener('click', () => { if (b.dataset.kind === 'overview') this.loadOverview(this.slug); else if (this.module) this.showModuleView(this.module); }));
    }

    /* ------------------------------------------------------------ life */
    async startIndex(repo) {
      $('#overlay').classList.remove('hidden');
      const out = await api('/api/index', { method: 'POST', body: JSON.stringify({ repoUrl: repo }) });
      const es2 = new EventSource(`/api/job/${out.jobId}/events`);
      es2.onmessage = (ev) => {
        const job = JSON.parse(ev.data);
        $('#jobMsg').textContent = job.message || '';
        $('#jobPct').textContent = `${job.progress || 0}%`;
        $('#jobBar').style.width = `${job.progress || 0}%`;
        $$('#jobStages li').forEach((li) => li.classList.toggle('done', job.state === 'ready'));
        if (job.state === 'ready') {
          es2.close();
          $('#overlay').classList.add('hidden');
          this.loadOverview(job.slug || out.slug);
          toast(job.cached ? 'Loaded the existing map' : `Mapped ${fmt(job.stats?.nodes || 0)} symbols`);
        } else if (job.state === 'failed') {
          es2.close();
          toast(job.error || 'Indexing failed');
          $('#overlay').classList.add('hidden');
        }
      };
    }

    /* ------------------------------------------------------------ canvas ui */
    bindUI() {
      $('#repoForm').addEventListener('submit', (e) => { e.preventDefault(); this.startIndex($('#repoInput').value.trim() || $('#repoSelect').value); });
      $('#repoSelect').addEventListener('change', (e) => { if (e.target.value) this.loadOverview(e.target.value); });
      $('#search').addEventListener('input', () => this.search());
      $('#search').addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#searchResults').classList.add('hidden'); });
      $('#searchResults').addEventListener('click', () => $('#searchResults').classList.add('hidden'));
      $('#themeBtn').addEventListener('click', () => this.themeToggle());
      $$('.tab').forEach((t) => t.addEventListener('click', () => this.activateTab(t.dataset.tab)));
      $('#paletteBtn').addEventListener('click', () => this.openPalette());
      $('#palette').addEventListener('click', (e) => { if (e.target.id === 'palette') this.closePalette(); });
      $('#paletteInput').addEventListener('input', () => { const q = $('#paletteInput').value; if (q) setTimeout(() => this.paletteSearch(q), 120); });
      $('#paletteInput').addEventListener('keydown', (e) => {
        if (e.key === 'Escape') this.closePalette();
        if (e.key === 'Enter') { const active = $('#paletteResults .search-result'); if (active) active.click(); else this.closePalette(); }
      });
      $('#fileDialogClose').addEventListener('click', () => $('#fileDialog').close());
      $('#sidebarClose').addEventListener('click', () => this.toggleSidebar());
      $('#overlayClose').addEventListener('click', () => { $('#overlay').classList.add('hidden'); toast('Indexing continues in the background'); });
      $('#zoomIn').addEventListener('click', () => { const k = clamp(this.cam.k * 1.3, 0.05, 4); this.cam.k = k; this.requestDraw(); });
      $('#zoomOut').addEventListener('click', () => { const k = clamp(this.cam.k / 1.3, 0.05, 4); this.cam.k = k; this.requestDraw(); });
      $('#fitBtn').addEventListener('click', () => this.fitCurrent(1.24));
      $('#backBtn').addEventListener('click', () => this.back());
      document.addEventListener('keydown', (e) => {
        const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
        if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); this.openPalette(); }
        if (e.key === '/' && !typing) { e.preventDefault(); $('#search').focus(); }
        if (e.key === 'Escape') {
          if (!$('#palette').classList.contains('hidden')) { this.closePalette(); return; }
          if (typing) { document.activeElement.blur(); return; }
          this.back();
        }
      });
      // Canvas interactions
      const c = $('#map');
      c.addEventListener('pointerdown', (e) => {
        const r = c.getBoundingClientRect();
        this.down = { x: e.clientX, y: e.clientY, cx: this.cam.x, cy: this.cam.y, k: this.cam.k };
        const h = this.hitTest(e.clientX - r.left, e.clientY - r.top);
        if (h && e.buttons & 1) return; // drag
        if (h) {
          if (h.type === 'module') this.openModule(h.id);
          else this.selectNode(h.id);
        }
      });
      window.addEventListener('keydown', (e) => {
        if (e.key === ' ' && this.studyTab === 'flash') {
          const cards = $$('#studyPanel .card-side');
          if (cards.length) cards.forEach((s) => s.classList.toggle('flipped'));
        }
      });
      window.addEventListener('pointermove', () => {});
      c.addEventListener('pointerup', () => { this.down = null; });
      c.addEventListener('pointermove', (e) => {
        if (!this.down || !(e.buttons & 1)) return;
        const r = c.getBoundingClientRect();
        this.cam.x = this.down.cx - (e.clientX - r.left - this.W / 2) / this.cam.k + (e.clientX - this.down.x) / this.cam.k;
        this.cam.y = this.down.cy - (e.clientY - r.top - this.H / 2) / this.cam.k + (e.clientY - this.down.y) / this.cam.k;
        this.requestDraw();
      });
      c.addEventListener('wheel', (e) => {
        e.preventDefault();
        const k = clamp(this.cam.k * Math.exp(-e.deltaY * 0.0012), 0.05, 4);
        this.cam.k = k;
        const px = e.clientX, py = e.clientY;
        this.cam.x += (this.wx(px) - this.cam.x);
        this.cam.y += (this.wy(py) - this.cam.y);
        this.requestDraw();
      }, { passive: false });
      // Tooltips
      const tip = $('#tooltip');
      c.addEventListener('pointermove', (e) => {
        if (this.view === 'overview' && this.overview) {
          const r = c.getBoundingClientRect();
          const h = this.hitTest(e.clientX - r.left, e.clientY - r.top);
          if (h) {
            tip.innerHTML = `<b>${esc(h.item.name)}</b><span>${fmt(h.item.count)} symbols · ${h.item.files} files</span>`;
            tip.style.left = `${e.clientX + 12}px`;
            tip.style.top = `${e.clientY + 12}px`;
            tip.classList.remove('hidden');
          } else tip.classList.add('hidden');
        }
      });
      c.addEventListener('pointerleave', () => tip.classList.add('hidden'));
    }
  }

  function setBusy(btn, busy, label) {
    if (btn) {
      btn.dataset.label = btn.textContent;
      btn.disabled = !!busy;
      btn.textContent = busy ? label : (btn.dataset.label || btn.textContent);
    }
  }
  function hideOverlaySoon() { $('#overlay').classList.add('hidden'); }
  function highlightCode(line) {
    return esc(line).replace(/(def|class|function|const|return|import|export|async|await)/g, '<span class="c">$1</span>')
      .replace(/(?<=[:=]\s)(["'`][^"'`]*["'`])/g, '<span class="s">$1</span>')
      .replace(/(?<=def\s)[\w.]+/g, '<span class="n">$1</span>')
      .replace(/(?<=class\s)[A-Za-z0-9_]+/g, '<span class="n">$1</span>');
  }
  function renderSnippet(sn, focusLine) {
    const start = sn.startLine || 1;
    const lines = String(sn.text || '').split('\n');
    return lines.map((l, i) => {
      const no = start + i;
      const code = l.replace(/^\s*\d{1,6}\s+/, '');
      return `<span class="ln">${String(no).padStart(5, ' ')}</span><span class="${no === focusLine ? 'hl' : ''}">${highlightCode(code)}</span>`;
    }).join('\n');
  }
  function facts2(mod) { return mod; }

  const atlas = new Atlas();
  window.atlas = atlas;
  new MutationObserver(() => {
    readColors();
    atlas.renderStats();
    atlas.renderLegend();
    atlas.requestDraw();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  atlas.boot().catch((err) => toast(err.message));
})();
