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
  // Reduced motion is read live: the preference can change mid-session and the
  // canvas must react (idle life off, camera snaps) without a reload.
  const MQ_REDUCED = typeof matchMedia === 'function'
    ? matchMedia('(prefers-reduced-motion: reduce)')
    : null;
  let REDUCED = MQ_REDUCED ? MQ_REDUCED.matches : false;
  if (MQ_REDUCED && MQ_REDUCED.addEventListener) {
    MQ_REDUCED.addEventListener('change', (e) => {
      REDUCED = e.matches;
      window.atlas?.requestDraw?.();
    });
  }
  const TOAST = $('#toast');
  let toastTimer = 0;
  function toast(msg) {
    TOAST.textContent = msg;
    TOAST.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => TOAST.classList.add('hidden'), 3600);
  }

  /* ------------------------------------------------------------- physics */
  // A small d3-style force layout: link springs, charge repulsion, gravity
  // toward the centre and collision resolution. The server ships a static
  // layout; this refines it live so bubbles settle, drift and react to input.
  // Neighbour lookups use a uniform grid so a 8k-node graph stays smooth.
  // Every bubble also carries a stable phase (idle breathing) and a visual
  // spring (scale) so the map never looks frozen.
  // Bounds of the dense core of a node set. With many nodes, a handful of far
  // outliers would force a zoomed-out frame where everything looks tiny, so
  // trim the outer 4% on each axis (outliers stay reachable by panning).
  function coreBounds(src) {
    const rx = (n) => n.r || 5;
    if (src.length < 16) {
      return {
        minX: Math.min(...src.map((n) => n.x - rx(n))), maxX: Math.max(...src.map((n) => n.x + rx(n))),
        minY: Math.min(...src.map((n) => n.y - rx(n))), maxY: Math.max(...src.map((n) => n.y + rx(n))),
      };
    }
    const q = (arr, f) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(f * (arr.length - 1))))];
    const xs = src.map((n) => n.x).sort((a, b) => a - b);
    const ys = src.map((n) => n.y).sort((a, b) => a - b);
    const pad = 14;
    return { minX: q(xs, 0.04) - pad, maxX: q(xs, 0.96) + pad, minY: q(ys, 0.04) - pad, maxY: q(ys, 0.96) + pad };
  }

  const hash01 = (s) => {
    let h = 2166136261;
    const str = String(s);
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 100000) / 100000;
  };

  class ForceSim {
    constructor(nodes, links, opts = {}) {
      this.nodes = nodes || [];
      this.alpha = opts.alpha ?? 0.55;
      this.alphaMin = 0.004;
      this.alphaDecay = opts.alphaDecay ?? 0.018;
      this.linkDistance = opts.linkDistance ?? 52;
      this.linkStrength = opts.linkStrength ?? 0.35;
      this.charge = opts.charge ?? -130;
      this.gravity = opts.gravity ?? 0.045;
      this.collidePad = opts.collidePad ?? 3;
      this.cell = opts.cell ?? 170;
      this.byId = new Map(this.nodes.map((n) => [n.id, n]));
      this.pairs = [];
      for (const l of links || []) {
        const s = this.byId.get(l.source);
        const t = this.byId.get(l.target);
        if (!s || !t || s === t) continue;
        this.pairs.push({
          s, t,
          w: l.weight != null ? Math.min(1.2, 0.3 + l.weight / 10) : 1,
          weight: Number(l.weight) || 1,
        });
      }
      for (const n of this.nodes) {
        if (n.vx == null) n.vx = 0;
        if (n.vy == null) n.vy = 0;
        if (n.phase == null) n.phase = hash01(n.id);
        if (n.scale == null) { n.scale = 1; n.scaleV = 0; }
      }
      this.grid = new Map();
    }

    reheat(a = 0.45) {
      this.alpha = Math.max(this.alpha, a);
      return this;
    }

    step(dt = 1 / 60) {
      // Frame-rate independent: forces accumulate into velocity, integration
      // is scaled so a 120Hz display settles exactly like a 60Hz one.
      const ts = clamp(dt * 60, 0.4, 3);
      const nodes = this.nodes;
      const a = this.alpha;
      if (a < this.alphaMin || !nodes.length) { this.alpha = 0; return false; }

      // link springs
      for (const p of this.pairs) {
        let dx = p.t.x - p.s.x;
        let dy = p.t.y - p.s.y;
        let d = Math.hypot(dx, dy);
        if (d < 0.01) { dx = (Math.random() - 0.5) * 0.2; dy = (Math.random() - 0.5) * 0.2; d = 0.2; }
        const f = ((d - this.linkDistance) / d) * this.linkStrength * p.w * a;
        const fx = dx * f, fy = dy * f;
        p.s.vx += fx; p.s.vy += fy;
        p.t.vx -= fx; p.t.vy -= fy;
      }

      // charge repulsion + collision, via a reused uniform grid
      const cell = this.cell;
      const grid = this.grid;
      grid.clear();
      for (const nd of nodes) {
        const key = ((nd.x / cell) | 0) + ',' + ((nd.y / cell) | 0);
        let arr = grid.get(key);
        if (!arr) { arr = []; grid.set(key, arr); }
        arr.push(nd);
      }
      const cutoff = cell * 1.7;
      const cutoff2 = cutoff * cutoff;
      for (const nd of nodes) {
        const gx = (nd.x / cell) | 0, gy = (nd.y / cell) | 0;
        for (let ix = gx - 1; ix <= gx + 1; ix++) {
          for (let iy = gy - 1; iy <= gy + 1; iy++) {
            const arr = grid.get(ix + ',' + iy);
            if (!arr) continue;
            for (const o of arr) {
              if (o === nd || o.id < nd.id) continue; // each pair once
              let dx = o.x - nd.x, dy = o.y - nd.y;
              let d2 = dx * dx + dy * dy;
              if (d2 > cutoff2) continue;
              if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.5; }
              const d = Math.sqrt(d2);
              const f = (this.charge * a) / d2;
              const fx = (dx / d) * f, fy = (dy / d) * f;
              nd.vx += fx; nd.vy += fy;
              o.vx -= fx; o.vy -= fy;
              const min = (nd.r || 6) + (o.r || 6) + this.collidePad;
              if (d < min) {
                const push = ((min - d) / d) * 0.5;
                nd.x -= dx * push; nd.y -= dy * push;
                o.x += dx * push; o.y += dy * push;
              }
            }
          }
        }
      }

      // gravity: toward the graph centroid, then toward the origin
      let cx = 0, cy = 0;
      for (const nd of nodes) { cx += nd.x; cy += nd.y; }
      cx /= nodes.length; cy /= nodes.length;
      for (const nd of nodes) {
        nd.vx += (cx - nd.x) * this.gravity * a;
        nd.vy += (cy - nd.y) * this.gravity * a;
        nd.vx += -nd.x * 0.02 * a;
        nd.vy += -nd.y * 0.02 * a;
      }

      // integrate
      const damping = Math.pow(0.86, ts);
      const maxV = 80;
      for (const nd of nodes) {
        if (nd.fx != null) {
          // Grabbed: spring toward the pointer so the bubble lags a little
          // behind the cursor and snaps back with elastic overshoot.
          if (nd.grabX != null) {
            const g = 1 - Math.exp(-13 * dt);
            nd.fx += (nd.grabX - nd.fx) * g;
            nd.fy += (nd.grabY - nd.fy) * g;
          }
          nd.x = nd.fx; nd.vx = 0;
        } else if (nd.fy != null) { nd.y = nd.fy; nd.vy = 0; }
        else {
          nd.vx = clamp(nd.vx, -maxV, maxV);
          nd.vy = clamp(nd.vy, -maxV, maxV);
          nd.x += nd.vx * ts; nd.y += nd.vy * ts;
        }
        nd.vx *= damping; nd.vy *= damping;
      }

      this.alpha += (0 - this.alpha) * Math.min(1, this.alphaDecay * ts);
      return this.alpha > this.alphaMin;
    }
  }

  /* -------------------------------------------------------------- colors */
  const C = {};
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    // Glow sprites bake colours in: drop the cache when the theme flips.
    const theme = document.documentElement.dataset.theme || 'dark';
    if (window.atlas && theme !== window.atlas.spriteTheme) {
      window.atlas.spriteTheme = theme;
      window.atlas.sprites?.clear();
    }
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
      this.timers = { toast: 0, search: 0, palette: 0 };
      this.searchAbort = null;
      this.paletteAbort = null;
      this.sim = null;
      // --- living-canvas state -------------------------------------------------
      // cam is what we draw; camT is where the camera is gliding to. Every
      // camera change (drag, wheel, button, fit) writes the target and the
      // loop eases toward it, so nothing in the UI ever jumps.
      this.camT = { x: 0, y: 0, k: 1 };
      this.camRate = 13;            // camera spring rate (1/s)
      this.camV = { x: 0, y: 0 };   // flick velocity, world units / second
      this.fitPad = 1.24;
      this.ripples = [];            // click pops: { x, y, r0, t, life, color }
      this.sprites = new Map();     // cached glow sprites, keyed by colour
      this.spriteTheme = null;
      this.egoSpin = 0;
      this.lastT = 0;
      this.raf = 0;
      this.dirty = true;
      this.visible = true;          // tab focused
      this.onScreen = true;         // stage intersecting the viewport
      this.grab = null;
      this.tipPos = null;
      this.tipTarget = null;
      this._ovStamp = '';
      this._ovLabels = [];
      this.overlayId = null;
      this.overlayDone = null;
    }

    /* ------------------------------------------------------------ boot */
    async boot() {
      readColors();
      this.bindUI();
      this.resize();
      this.observeStage();
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
      this.buildSim();
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
      this.buildSim();
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
        const div = document.createElement('button');
        div.type = 'button';
        div.className = 'drawer-file-group';
        div.title = `Open ${f.file}`;
        div.innerHTML = `<div class="fg-name">${esc(f.file)}</div><div class="fg-count">${f.count} symbols</div>`;
        div.addEventListener('click', () => this.openFileDialog(f.file));
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
      const nodes = [{ ...center, x: 0, y: 0, r: 17, rel: 'self', ring: -1, phase: hash01(center.id), scale: 1, scaleV: 0 }];
      const rings = [[], [], []];
      nbrs.forEach((n, i) => rings[i < 10 ? 0 : i < 28 ? 1 : 2].push(n));
      rings.forEach((list, ri) => {
        const radius = ri === 0 ? 150 : ri === 1 ? 270 : 390;
        list.forEach((n, i) => {
          const ang = (i / Math.max(1, list.length)) * Math.PI * 2 - Math.PI / 2 + ri * 0.35;
          nodes.push({
            ...n,
            x: Math.cos(ang) * radius, y: Math.sin(ang) * radius,
            r: 5 + Math.min(8, Math.sqrt(n.degree || 1) * 0.9),
            ring: ri, a0: ang, rad: radius, phase: hash01(n.id), scale: 1, scaleV: 0,
          });
        });
      });
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const links = nbrs.map((n) => ({ source: center.id, target: n.id, rel: n.rel })).filter((l) => byId.has(l.target));
      this.egoSpin = 0;
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
      this.buildSim();
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
                <div class="snippet-tools"><button class="copy-btn" data-act="pop-snippet">⤢ Open in window</button><button class="copy-btn" data-snippet="${esc(snippet.text, false)}">Copy snippet</button></div></div>
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
      $$('[data-act="pop-snippet"]', el)?.forEach((b) => b.addEventListener('click', () => {
        const start = snippet?.startLine || line;
        const n = String(snippet?.text || '').split('\n').length;
        this.openFileDialog(facts.file, line, Math.max(line, start + n - 1), start);
      }));
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
    // Source opens in a centred, resizable window. `line` is the focus line;
    // [from, to] (optional) highlights a whole function body.
    async openFileDialog(file, line = 1, to = 0, from = 0) {
      const dlg = $('#fileDialog');
      $('#fileDialogPath').textContent = file;
      $('#fileDialogMeta').textContent = '';
      this.fileDialogText = '';
      try { if (!dlg.open) dlg.showModal(); } catch {}
      $('#fileContent').innerHTML = '<div class="line"><span class="no"></span>Loading…</div>';
      try {
        const out = await api(`/api/file/${encodeURIComponent(this.slug)}?path=${encodeURIComponent(file)}`);
        this.fileDialogText = String(out.content || '');
        const lines = this.fileDialogText.split('\n');
        const target = clamp(Number(line) || 1, 1, lines.length);
        const a = from ? clamp(from, 1, lines.length) : target;
        const b = to ? clamp(to, a, lines.length) : target;
        $('#fileDialogMeta').textContent = a === b ? `line ${target} · ${lines.length} lines` : `lines ${a}–${b} · ${lines.length} lines`;
        $('#fileContent').innerHTML = lines.map((l, i) => {
          const no = i + 1;
          return `<span class="line${no >= a && no <= b ? ' hl' : ''}"><span class="no">${no}</span>${highlightCode(l)}</span>`;
        }).join('');
        const first = $('#fileContent .hl');
        if (first) first.scrollIntoView({ block: b - a > 12 ? 'start' : 'center' });
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
      m.width = 234; m.height = 160;
      this.dirty = true;
      this.requestDraw();
    }

    // The stage can change size without a window resize (sidebar, rail
    // collapse, devtools); watch the element itself and re-fit after it settles.
    observeStage() {
      const stage = $('#stage');
      if (!stage) return;
      let fitTimer = 0;
      const ro = new ResizeObserver(() => {
        this.resize();
        clearTimeout(fitTimer);
        fitTimer = setTimeout(() => this.fitCurrent(this.fitPad), 140);
      });
      ro.observe(stage);
      if ('IntersectionObserver' in window) {
        new IntersectionObserver((es) => {
          this.onScreen = es[0].isIntersecting;
          if (this.onScreen) { this.lastT = 0; this.requestDraw(); }
        }, { threshold: 0.02 }).observe(stage);
      }
      document.addEventListener('visibilitychange', () => {
        this.visible = !document.hidden;
        if (this.visible) { this.lastT = 0; this.requestDraw(); }
      });
    }

    requestDraw() {
      this.dirty = true;
      this.ensureLoop();
    }
    ensureLoop() {
      if (this.raf || !this.visible || !this.onScreen) return;
      this.lastT = 0;
      this.raf = requestAnimationFrame((n) => this.frame(n));
    }

    // One rAF loop drives physics, camera easing, visual springs and paint.
    // It only sleeps when nothing can move: reduced-motion users get a still
    // map that redraws on demand; everyone else gets a living one.
    frame(now) {
      this.raf = 0;
      if (!this.lastT) this.lastT = now;
      let dt = (now - this.lastT) / 1000;
      this.lastT = now;
      if (!(dt > 0)) dt = 1 / 60;
      dt = Math.min(dt, 0.05);
      const t = now / 1000;
      let moving = false;

      if (this.sim) {
        const alive = this.sim.step(dt);
        if (alive) { moving = true; this.simWasAlive = true; }
        else if (this.simWasAlive) {
          // Layout just settled: glide the camera around the final positions,
          // unless the user has taken the camera (pan/zoom) — never yank it back.
          this.simWasAlive = false;
          if (!this.camUser) {
            const k0 = this.camT.k;
            this.fitCurrent(this.view === 'overview' ? 1.08 : 1.14);
            // Settling may spread the layout a bit; never widen the view by
            // more than a hair for that: the user is already looking at it.
            this.camT.k = Math.max(this.camT.k, k0 * 0.94);
            moving = true;
          }
        }
      }
      if (this.easeCam(dt)) moving = true;
      if (this.stepVisuals(dt, t)) moving = true;
      if (moving && this.lastPointer && !this.down) this.refreshHover();

      if (moving || this.dirty) {
        this.dirty = false;
        this.render();
      }
      if (moving || this.dirty || (!REDUCED && this.visible && this.onScreen)) this.ensureLoop();
    }

    // Camera easing: exponential approach, zoom in log space so the glide
    // feels linear to the eye. Returns true while the camera is still moving.
    easeCam(dt) {
      const c = this.cam, t2 = this.camT;
      if (REDUCED) {
        const moved = c.x !== t2.x || c.y !== t2.y || c.k !== t2.k;
        c.x = t2.x; c.y = t2.y; c.k = t2.k;
        return moved;
      }
      const k = 1 - Math.exp(-this.camRate * dt);
      const dx = t2.x - c.x, dy = t2.y - c.y;
      const dk = Math.log(t2.k / c.k);
      if (Math.abs(dx) < 0.02 && Math.abs(dy) < 0.02 && Math.abs(dk) < 0.0004) {
        c.x = t2.x; c.y = t2.y; c.k = t2.k;
        return false;
      }
      c.x += dx * k;
      c.y += dy * k;
      c.k *= Math.exp(dk * k);
      return true;
    }

    // Per-bubble visual springs (hover / select / grab scale) plus the ego
    // ring rotation and click ripples. Returns true while anything moves.
    stepVisuals(dt, t) {
      let moving = false;
      const nodes = this.liveNodes();
      const hover = this.hover;
      const grabItem = this.grab ? this.grab.item : null;
      const stiff = 190, damp = 19;
      for (const n of nodes) {
        const target = grabItem === n ? 1.3
          : this.selected === n.id ? 1.12
            : (hover && hover.id === n.id ? 1.26 : 1);
        if (n.scale !== target || Math.abs(n.scaleV) > 0.001) {
          n.scaleV += (target - n.scale) * stiff * dt;
          n.scaleV *= Math.exp(-damp * dt);
          n.scale += n.scaleV * dt;
          moving = true;
        } else { n.scale = target; n.scaleV = 0; }
      }
      if (this.view === 'ego' && this.ego && !REDUCED) {
        // Rings drift while you look, and ease to a stop while the mouse is
        // on the map so nothing slides out from under the cursor.
        const want = this.lastPointer ? 0 : 1;
        this.egoSpinRate = (this.egoSpinRate ?? 1) + (want - (this.egoSpinRate ?? 1)) * (1 - Math.exp(-6 * dt));
        this.egoSpin += dt * 0.1 * this.egoSpinRate;
        for (const n of this.ego.nodes) {
          if (n.rel === 'self') continue;
          const spin = this.egoSpin * (n.ring === 0 ? 1 : n.ring === 1 ? 0.62 : 0.36);
          const breathe = 1 + Math.sin(t * 0.8 + n.phase * 6.283) * 0.015;
          n.x = Math.cos(n.a0 + spin) * n.rad * breathe;
          n.y = Math.sin(n.a0 + spin) * n.rad * breathe;
        }
        moving = true;
      }
      if (this.ripples.length) {
        for (const r of this.ripples) r.t += dt;
        this.ripples = this.ripples.filter((r) => r.t < r.life);
        moving = true;
      }
      return moving;
    }

    liveNodes() {
      if (this.view === 'overview' && this.overview) return this.overview.modules.filter((m) => !m.hidden && m.primary !== false);
      if (this.view === 'module' && this.module) return this.module.nodes || [];
      if (this.view === 'ego' && this.ego) return this.ego.nodes || [];
      return [];
    }

    // Live layout for the current view. The server ships a static layout; the
    // simulation refines it so bubbles settle, drift and react to the pointer.
    buildSim() {
      this.sim = null;
      this._ovStamp = '';
      if (this.view === 'overview' && this.overview) {
        const mods = this.overview.modules.filter((m) => !m.hidden && m.primary !== false);
        if (mods.length) {
          this.sim = new ForceSim(mods, this.overview.links, {
            alpha: 0.42, linkDistance: 170, linkStrength: 0.22,
            charge: -900, gravity: 0.03, collidePad: 10, cell: 260,
          });
        }
      } else if (this.view === 'module' && this.module && (this.module.nodes || []).length) {
        this.sim = new ForceSim(this.module.nodes, this.module.links, {
          alpha: 0.62, linkDistance: 52, linkStrength: 0.35,
          charge: -130, gravity: 0.045, collidePad: 3, cell: 170,
        });
      }
      if (this.sim) {
        // Settle the layout before the first frame (bounded to ~80ms) so the
        // map appears at rest instead of drifting under the user's cursor.
        // The sim only wakes again when a bubble is dragged.
        const t0 = performance.now();
        while (this.sim.step(1 / 60) && performance.now() - t0 < 80) { /* settle */ }
        this.sim.alpha = 0;
        this.simWasAlive = false;
        this.fitCurrent(this.view === 'overview' ? 1.08 : 1.14);
      }
      this.requestDraw();
    }

    reheat(a = 0.4) {
      if (!this.sim) return;
      this.sim.reheat(a);
      this.requestDraw();
    }

    sx = (x) => (x - this.cam.x) * this.cam.k + this.W / 2;
    sy = (y) => (y - this.cam.y) * this.cam.k + this.H / 2;
    wx = (p) => (p - this.W / 2) / this.cam.k + this.cam.x;
    wy = (p) => (p - this.H / 2) / this.cam.k + this.cam.y;

    // Cached soft-glow sprite per colour: one radial gradient baked into a
    // small offscreen canvas, then blitted and scaled. Creating a gradient
    // per bubble per frame was the single most expensive thing on the canvas.
    glow(color) {
      let sp = this.sprites.get(color);
      if (sp) return sp;
      const S = 128;
      const c = document.createElement('canvas');
      c.width = S; c.height = S;
      const g = c.getContext('2d');
      const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
      grad.addColorStop(0, alpha(color, 0.30));
      grad.addColorStop(0.55, alpha(color, 0.10));
      grad.addColorStop(1, alpha(color, 0));
      g.fillStyle = grad;
      g.fillRect(0, 0, S, S);
      this.sprites.set(color, c);
      return c;
    }

    render() {
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
      this.drawRipples(ctx);
      ctx.restore();
      this.drawMinimap();
      this.updateTooltip();
    }

    // One bubble: breathing radius, gentle bob, glow bloom, springy scale.
    // Returns the on-screen geometry actually drawn (bob shifts it a hair).
    drawBubble(ctx, n, color, hovered, selected) {
      const t = performance.now() / 1000;
      const breathe = REDUCED ? 1 : 1 + Math.sin(t * 0.9 + n.phase * 6.283) * 0.03;
      const bob = REDUCED ? 0 : Math.sin(t * 0.55 + n.phase * 12.566) * 1.3;
      const r = Math.max(0.5, (n.r || 6) * breathe * (n.scale || 1));
      const x = n.x, y = n.y + bob;
      const sp = this.glow(color);
      if (sp) {
        const pulse = REDUCED ? 1 : 0.85 + 0.15 * Math.sin(t * 1.3 + n.phase * 6.283);
        ctx.globalAlpha = clamp((hovered || selected ? 1.35 : 1) * pulse, 0.2, 1.7);
        ctx.drawImage(sp, x - r * 2.4, y - r * 2.4, r * 4.8, r * 4.8);
        ctx.globalAlpha = 1;
      }
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = alpha(color, hovered ? 0.4 : selected ? 0.34 : 0.24);
      ctx.fill();
      ctx.strokeStyle = alpha(color, selected ? 1 : hovered ? 0.95 : 0.55);
      ctx.lineWidth = (selected ? 2.4 : hovered ? 2 : 1.1) / this.cam.k;
      ctx.stroke();
      return { x, y, r };
    }

    drawRipples(ctx) {
      for (const r of this.ripples) {
        const p = r.t / r.life;
        if (p >= 1) continue;
        const ease = 1 - Math.pow(1 - p, 3);
        ctx.beginPath();
        ctx.arc(r.x, r.y, r.r0 + ease * 52, 0, Math.PI * 2);
        ctx.strokeStyle = alpha(r.color, (1 - p) * 0.6);
        ctx.lineWidth = (1.8 * (1 - p) + 0.4) / this.cam.k;
        ctx.stroke();
      }
    }

    drawIdle(ctx) {
      const t = performance.now() / 1000;
      ctx.save();
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
        const bob = REDUCED ? 0 : Math.sin(t * 0.6 + d.ph) * 4;
        ctx.beginPath();
        ctx.arc(d.x, d.y + bob, d.s * 1.8, 0, Math.PI * 2);
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
      const t = performance.now() / 1000;
      const pairs = this.sim ? this.sim.pairs : [];
      const maxW = Math.max(1, ...this.overview.links.map((l) => l.weight));

      // Edges: bent hairlines with a pulse travelling each one.
      for (const p of pairs) {
        const a = p.s, b = p.t;
        const w = clamp(p.weight / maxW, 0, 1);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const bend = Math.min(80, len * 0.15);
        const cx = mx - (dy / len) * bend, cy = my + (dx / len) * bend;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(cx, cy, b.x, b.y);
        ctx.strokeStyle = alpha(w > 0.4 ? C.accent : C.stone, 0.16 + 0.3 * w);
        ctx.lineWidth = (0.7 + 0.9 * w) / this.cam.k;
        ctx.stroke();
        if (!REDUCED && pairs.length <= 80) {
          const ph = (t * 0.14 + (a.phase + b.phase) * 0.5) % 1;
          const q = 1 - ph;
          const px = q * q * a.x + 2 * q * ph * cx + ph * ph * b.x;
          const py = q * q * a.y + 2 * q * ph * cy + ph * ph * b.y;
          ctx.beginPath();
          ctx.arc(px, py, 1.7, 0, Math.PI * 2);
          ctx.fillStyle = alpha(C.accent, 0.5 + 0.3 * w);
          ctx.fill();
        }
      }

      // Bubbles: preview dots orbit slowly inside each module.
      for (const m of mods) {
        const color = m.kind === 'support' ? C.muted : moduleColor(m.id);
        const hovered = this.hover?.type === 'module' && this.hover.id === m.id;
        const selected = this.selected === m.id;
        const geo = this.drawBubble(ctx, m, color, hovered, selected);
        for (const p of m.preview || []) {
          const pa = Math.atan2(p.y, p.x) + (REDUCED ? 0 : t * 0.22 + m.phase * 6.283);
          const pr = Math.hypot(p.x, p.y) * geo.r * 0.55;
          ctx.beginPath();
          ctx.arc(geo.x + Math.cos(pa) * pr, geo.y + Math.sin(pa) * pr, 1.8, 0, Math.PI * 2);
          ctx.fillStyle = alpha(kindTone(p.kind), 0.92);
          ctx.fill();
        }
      }

      // Labels: placement is O(n²) scoring, so cache it until the layout or
      // zoom actually changes.
      const labels = this.overviewLabels(ctx, mods);
      ctx.font = `600 ${10.5 / this.cam.k}px ${C.mono}`;
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

    overviewLabels(ctx, mods) {
      const stamp = `${Math.round(this.cam.k * 1000)}|${mods.map((m) => `${Math.round(m.x)},${Math.round(m.y)},${Math.round(m.r || 0)}`).join(';')}`;
      if (stamp === this._ovStamp) return this._ovLabels;
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
      this._ovStamp = stamp;
      this._ovLabels = labels;
      return labels;
    }

    drawModule(ctx) {
      const m = this.module;
      if (!m) return this.drawIdle(ctx);
      const nodes = m.nodes || [];
      if (!nodes.length) return this.drawIdle(ctx);
      const t = performance.now() / 1000;
      const pairs = this.sim ? this.sim.pairs : [];

      // The module graph finally shows its edges: faint hairlines weighted by
      // call strength, with a few pulses running along them.
      if (pairs.length && pairs.length <= 600) {
        ctx.lineCap = 'round';
        for (const p of pairs) {
          const w = clamp((p.w - 0.3) / 0.9, 0, 1);
          ctx.beginPath();
          ctx.moveTo(p.s.x, p.s.y);
          ctx.lineTo(p.t.x, p.t.y);
          ctx.strokeStyle = alpha(C.stone, 0.05 + 0.11 * w);
          ctx.lineWidth = (0.6 + 0.8 * w) / this.cam.k;
          ctx.stroke();
        }
        if (!REDUCED) {
          const pulses = Math.min(pairs.length, 24);
          for (let i = 0; i < pulses; i++) {
            const p = pairs[Math.floor((i / pulses) * pairs.length)];
            const ph = (t * 0.16 + i * 0.173) % 1;
            ctx.beginPath();
            ctx.arc(p.s.x + (p.t.x - p.s.x) * ph, p.s.y + (p.t.y - p.s.y) * ph, 1.5, 0, Math.PI * 2);
            ctx.fillStyle = alpha(C.accent, 0.4);
            ctx.fill();
          }
        }
      }

      const labelsOn = nodes.length <= 160;
      const top = labelsOn ? [...nodes].sort((a, b) => b.degree - a.degree).slice(0, 14).map((n) => n.id) : [];
      const topSet = new Set(top);
      for (const n of nodes) {
        const color = degreeColor(n.kind, n.degree);
        const hovered = this.hover?.type === 'node' && this.hover.id === n.id;
        const selected = this.selected === n.id;
        const geo = this.drawBubble(ctx, n, color, hovered, selected);
        if (topSet.has(n.id) || hovered || selected) {
          ctx.font = `${selected || hovered ? 600 : 500} ${10.5 / this.cam.k}px ${C.sans}`;
          ctx.fillStyle = selected || hovered ? C.text : alpha(C.text, 0.7);
          ctx.textAlign = 'center';
          ctx.fillText(short(n.label, 28), geo.x, geo.y - geo.r - 6 / this.cam.k);
        }
      }
    }

    drawEgo(ctx) {
      const ego = this.ego;
      if (!ego) return;
      const t = performance.now() / 1000;
      const byId = ego.byId;
      const center = ego.nodes.find((n) => n.rel === 'self') || ego.node;

      // Spokes curve gently toward the centre; a pulse rides each one.
      for (const l of ego.links) {
        const a = byId.get(l.source), b = byId.get(l.target);
        if (!a || !b) continue;
        const hovered = this.hover?.type === 'node' && (this.hover.id === l.source || this.hover.id === l.target);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const bend = Math.min(26, len * 0.08);
        const cx = mx - (dy / len) * bend, cy = my + (dx / len) * bend;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(cx, cy, b.x, b.y);
        ctx.strokeStyle = alpha(relColor(l.rel), hovered ? 0.5 : 0.24);
        ctx.lineWidth = 1.2 / this.cam.k;
        ctx.stroke();
        if (!REDUCED) {
          const ph = (t * 0.2 + (b.phase || 0)) % 1;
          const q = 1 - ph;
          const px = q * q * a.x + 2 * q * ph * cx + ph * ph * b.x;
          const py = q * q * a.y + 2 * q * ph * cy + ph * ph * b.y;
          ctx.beginPath();
          ctx.arc(px, py, 1.4, 0, Math.PI * 2);
          ctx.fillStyle = alpha(relColor(l.rel), 0.55);
          ctx.fill();
        }
      }

      for (const n of ego.nodes) {
        const isCenter = n.rel === 'self';
        const color = isCenter ? C.cyan : kindColor(n.kind);
        const hovered = this.hover?.type === 'node' && this.hover.id === n.id;
        const selected = this.selected === n.id;
        const geo = this.drawBubble(ctx, n, color, hovered || isCenter, selected);
        if (isCenter && !REDUCED) {
          // A slow dashed halo turns around the selected symbol.
          ctx.save();
          ctx.setLineDash([5 / this.cam.k, 7 / this.cam.k]);
          ctx.lineDashOffset = -t * 26;
          ctx.beginPath();
          ctx.arc(geo.x, geo.y, geo.r * 1.55, 0, Math.PI * 2);
          ctx.strokeStyle = alpha(C.cyan, 0.5);
          ctx.lineWidth = 1.2 / this.cam.k;
          ctx.stroke();
          ctx.restore();
        }
        const show = isCenter || hovered || selected || n.ring === 0 || (n.ring === 1 && (n.degree || 0) > 8);
        if (show) {
          ctx.font = `${isCenter ? 640 : 500} ${(isCenter ? 12 : 10) / this.cam.k}px ${C.sans}`;
          ctx.fillStyle = isCenter ? C.text : alpha(C.text, 0.72);
          ctx.textAlign = 'center';
          ctx.fillText(short(n.label, 28), geo.x, geo.y - geo.r - 6 / this.cam.k);
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
      // Cap the dots: an 8k-node module would otherwise redraw thousands of
      // arcs every frame for a 234px box.
      const stride = Math.max(1, Math.ceil(nodes.length / 600));
      for (let i = 0; i < nodes.length; i += stride) {
        const n = nodes[i];
        const [x, y] = map(n.x, n.y);
        mctx.beginPath();
        mctx.arc(x, y, this.view === 'overview' ? Math.max(1.5, n.r * k * 0.4) : 1.6, 0, Math.PI * 2);
        mctx.fillStyle = this.view === 'overview' ? alpha(moduleColor(n.id), 0.65) : alpha(kindColor(n.kind), 0.72);
        mctx.fill();
      }
      // Coverage bar (DOM writes only when the value actually changes)
      const meta = this.overview?.meta || {};
      const served = this.overview?.stats?.nodes || 0;
      const total = this.view === 'module' && this.module ? this.module.count : (meta.totalNodes || served || 1);
      const frac = clamp(served / total, 0, 1);
      const pct = Math.round(frac * 100);
      if (this._covPct !== pct) {
        this._covPct = pct;
        const bar = $('#coverageBar');
        bar.style.width = `${pct}%`;
        bar.classList.toggle('warn', frac < 0.6);
        $('#coverageText').textContent = `${pct}% served`;
      }
    }

    // Tooltip: canvas-relative, lerped toward the cursor, clamped on-screen.
    updateTooltip() {
      const tip = $('#tooltip');
      if (!this.tipTarget) {
        if (!tip.classList.contains('hidden')) tip.classList.add('hidden');
        this.tipPos = null;
        return;
      }
      if (!this.tipPos) this.tipPos = { x: this.tipTarget.x, y: this.tipTarget.y };
      else {
        this.tipPos.x += (this.tipTarget.x - this.tipPos.x) * 0.4;
        this.tipPos.y += (this.tipTarget.y - this.tipPos.y) * 0.4;
      }
      const w = tip.offsetWidth || 160, h = tip.offsetHeight || 44;
      const x = clamp(this.tipPos.x, 4, Math.max(4, this.W - w - 4));
      const y = clamp(this.tipPos.y, 4, Math.max(4, this.H - h - 4));
      tip.style.transform = `translate(${x}px, ${y}px)`;
      if (tip.classList.contains('hidden')) tip.classList.remove('hidden');
    }

    /* ------------------------------------------------------------ camera */
    // Every camera change writes the TARGET; the loop eases toward it, so
    // fits, zooms and view switches glide instead of jumping.
    fitBounds(b, pad = 1.24) {
      this.bounds = b;
      const bw = Math.max(1, b.maxX - b.minX), bh = Math.max(1, b.maxY - b.minY);
      this.camT.k = clamp(Math.min((this.W - 60) / (bw * pad), (this.H - 60) / (bh * pad)), 0.05, 4);
      this.camT.x = (b.minX + b.maxX) / 2;
      this.camT.y = (b.minY + b.maxY) / 2;
      this.fitPad = pad;
      this.camUser = false;
      this.requestDraw();
    }
    fitCurrent(pad = 1.24) {
      let src = [];
      if (this.view === 'overview' && this.overview) {
        src = this.overview.modules.filter((m) => !m.hidden && m.primary !== false);
      } else if (this.view === 'module' && this.module) src = this.module.nodes || [];
      else if (this.view === 'ego' && this.ego) src = this.ego.nodes || [];
      if (!src.length) return;
      this.fitBounds(coreBounds(src), pad);
      if (this.view === 'overview') this.camT.k = Math.min(this.camT.k, 1.3);
    }

    // Glide the camera so a world point sits at the centre, optionally zooming
    // in a little. Used when you click: the map follows your attention.
    focusOn(x, y, minK) {
      this.camUser = true;
      this.camT.x = x;
      this.camT.y = y;
      if (minK) this.camT.k = clamp(Math.max(this.camT.k, minK), 0.05, 4);
      this.requestDraw();
    }

    // Zoom that keeps the world point under the cursor pinned. The anchor is
    // computed from the TARGET camera so fast wheel events compose correctly.
    zoomAt(px, py, factor) {
      const kNew = clamp(this.camT.k * factor, 0.05, 4);
      if (kNew === this.camT.k) return;
      const wx = (px - this.W / 2) / this.camT.k + this.camT.x;
      const wy = (py - this.H / 2) / this.camT.k + this.camT.y;
      this.camUser = true;
      this.camT.k = kNew;
      this.camT.x = wx - (px - this.W / 2) / kNew;
      this.camT.y = wy - (py - this.H / 2) / kNew;
      this.requestDraw();
    }

    // Re-run the hit test at the resting cursor: bubbles and the camera move
    // on their own, so hover/tooltip must follow them, not just mouse events.
    refreshHover() {
      const { px, py } = this.lastPointer;
      const h = this.hitTest(px, py);
      const id = h ? h.id : null;
      if (id === this.hoverId) { if (h) this.setTip(h, px, py); return; }
      this.hoverId = id;
      this.hover = h;
      $('#map').style.cursor = h ? 'pointer' : 'grab';
      if (h) this.setTip(h, px, py); else this.clearTip();
      this.dirty = true;
    }

    // Pan by a screen-space delta (keyboard arrows, buttons).
    panBy(dxPx, dyPx) {
      this.camUser = true;
      this.camT.x -= dxPx / this.camT.k;
      this.camT.y -= dyPx / this.camT.k;
      this.requestDraw();
    }

    // Drag the divider to grow or shrink the inspector; arrows nudge it,
    // double-click resets. The width is remembered per browser.
    bindRailResize() {
      const split = $('#railSplit'), shell = $('.shell');
      if (!split || !shell) return;
      const KEY = 'codeatlas.railW';
      const limits = () => [280, Math.max(320, Math.round(window.innerWidth * 0.7))];
      const apply = (w, save) => {
        const [lo, hi] = limits();
        const v = Math.round(clamp(w, lo, hi));
        shell.style.setProperty('--rail-w', v + 'px');
        split.setAttribute('aria-valuenow', String(v));
        if (save) { try { localStorage.setItem(KEY, String(v)); } catch { /* storage off */ } }
      };
      try { const w = Number(localStorage.getItem(KEY)); if (w) apply(w, false); } catch { /* storage off */ }
      split.setAttribute('aria-valuemin', '280');
      const syncAria = () => {
        split.setAttribute('aria-valuemax', String(limits()[1]));
        split.setAttribute('aria-valuenow', String(Math.round($('#rail').getBoundingClientRect().width)));
      };
      syncAria();
      window.addEventListener('resize', syncAria);
      const railW = () => $('#rail').getBoundingClientRect().width;
      split.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const x0 = e.clientX, w0 = railW();
        split.classList.add('dragging');
        document.body.classList.add('resizing');
        split.setPointerCapture(e.pointerId);
        const move = (ev) => apply(w0 - (ev.clientX - x0), false);
        const up = (ev) => {
          split.removeEventListener('pointermove', move);
          split.removeEventListener('pointerup', up);
          split.removeEventListener('pointercancel', up);
          split.classList.remove('dragging');
          document.body.classList.remove('resizing');
          apply(railW(), true);
        };
        split.addEventListener('pointermove', move);
        split.addEventListener('pointerup', up);
        split.addEventListener('pointercancel', up);
      });
      split.addEventListener('dblclick', () => {
        shell.style.removeProperty('--rail-w');
        requestAnimationFrame(syncAria);
        try { localStorage.removeItem(KEY); } catch { /* storage off */ }
      });
      split.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 64 : 16;
        if (e.key === 'ArrowLeft') { e.preventDefault(); apply(railW() + step, true); }
        if (e.key === 'ArrowRight') { e.preventDefault(); apply(railW() - step, true); }
      });
    }

    // Every titled section in the inspector folds/unfolds from its title.
    // Folded state is remembered by title for the session, across re-renders.
    bindCollapsibles() {
      const body = $('#railBody');
      if (!body) return;
      this.folded = this.folded || new Set();
      const SEL = '.card2 > h4, .kv-block > h4';
      const keyOf = (h) => h.textContent.replace(/\(\d[\d,]*\)/g, '').trim().toLowerCase();
      const decorate = () => {
        for (const h of $$(SEL, body)) {
          if (!h.hasAttribute('tabindex')) { h.tabIndex = 0; h.setAttribute('role', 'button'); }
          const folded = this.folded.has(keyOf(h));
          h.parentElement.classList.toggle('collapsed', folded);
          h.setAttribute('aria-expanded', String(!folded));
        }
      };
      const toggle = (h) => {
        const k = keyOf(h);
        if (this.folded.has(k)) this.folded.delete(k); else this.folded.add(k);
        decorate();
      };
      body.addEventListener('click', (e) => { const h = e.target.closest(SEL); if (h && body.contains(h)) toggle(h); });
      body.addEventListener('keydown', (e) => {
        const h = e.target.closest?.(SEL);
        if (h && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(h); }
      });
      new MutationObserver(decorate).observe(body, { childList: true, subtree: true });
      decorate();
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
      repo = String(repo || '').trim();
      if (!repo) { $('#repoInput')?.focus(); return; }
      // Already mapped? Open it instead of re-queuing (matches slug or owner/repo).
      const key = repo.toLowerCase()
        .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//, '')
        .replace(/\/+$/, '').replace(/\.git$/, '');
      const known = this.repoList.find((r) => r.slug === repo
        || ((r.meta && r.meta.repo) || '').toLowerCase().replace(/^https?:\/\/(www\.)?github\.com\//, '') === key);
      if (known) { await this.loadOverview(known.slug); return; }

      const fail = (msg) => {
        $('#overlay').classList.add('hidden');
        toast(msg || 'Indexing failed');
      };
      $('#jobMsg').textContent = 'Starting…';
      $('#jobPct').textContent = '0%';
      $('#jobBar').style.width = '0%';
      $('#overlay').classList.remove('hidden');
      let out;
      try {
        out = await api('/api/index', { method: 'POST', body: JSON.stringify({ repoUrl: repo }) });
      } catch (err) {
        fail(err.message);
        return;
      }
      const es2 = new EventSource(`/api/job/${out.jobId}/events`);
      let settled = false;
      const onJob = (job) => {
        $('#jobMsg').textContent = job.message || '';
        $('#jobPct').textContent = `${job.progress || 0}%`;
        $('#jobBar').style.width = `${job.progress || 0}%`;
        $$('#jobStages li').forEach((li) => li.classList.toggle('done', job.state === 'ready'));
        if (job.state === 'ready') {
          settled = true;
          es2.close();
          $('#overlay').classList.add('hidden');
          this.loadRepos().then(() => this.loadOverview(job.slug || out.slug));
          toast(job.cached ? 'Loaded the existing map' : `Mapped ${fmt(job.stats?.nodes || 0)} symbols`);
        } else if (job.state === 'failed') {
          settled = true;
          es2.close();
          fail(job.error || 'Indexing failed');
        }
      };
      es2.onmessage = (ev) => onJob(JSON.parse(ev.data));
      es2.onerror = async () => {
        if (settled) return;
        // The stream dropped (proxy timeout, server restart). Check the job
        // directly so a finished job still opens and a lost one says so.
        try {
          const job = await api(`/api/job/${out.jobId}`);
          if (job.state === 'ready' || job.state === 'failed') onJob(job);
        } catch (err) {
          settled = true;
          es2.close();
          fail(err.message);
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
      // Click outside the window (on the backdrop) closes it.
      $('#fileDialog').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
      $('#fileDialog').addEventListener('close', () => { $('#fileDialog').classList.remove('max'); $('#fileDialogMax').setAttribute('aria-pressed', 'false'); });
      $('#fileDialogMax').addEventListener('click', (e) => {
        const on = $('#fileDialog').classList.toggle('max');
        e.currentTarget.setAttribute('aria-pressed', String(on));
        e.currentTarget.title = on ? 'Restore' : 'Maximize';
      });
      $('#fileDialogCopy').addEventListener('click', async (e) => {
        try { await navigator.clipboard.writeText(this.fileDialogText || ''); toast('File copied'); }
        catch { toast('Copy failed'); }
      });
      this.bindRailResize();
      this.bindCollapsibles();
      $('#sidebarClose').addEventListener('click', () => this.toggleSidebar());
      $('#overlayClose').addEventListener('click', () => { $('#overlay').classList.add('hidden'); toast('Indexing continues in the background'); });
      $('#zoomIn').addEventListener('click', () => this.zoomAt(this.W / 2, this.H / 2, 1.3));
      $('#zoomOut').addEventListener('click', () => this.zoomAt(this.W / 2, this.H / 2, 1 / 1.3));
      $('#fitBtn').addEventListener('click', () => this.fitCurrent(1.24));
      $('#backBtn').addEventListener('click', () => this.back());
      document.addEventListener('keydown', (e) => {
        // A modal owns the keyboard: the source window closes itself on Esc
        // (natively), the module drawer closes here. Neither moves the map.
        if ($('#fileDialog').open) return;
        if (!$('#moduleDrawer').classList.contains('hidden')) {
          if (e.key === 'Escape') $('#moduleDrawer').classList.add('hidden');
          return;
        }
        const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
        // Keys pressed while working in the inspector (divider, section
        // titles, buttons) belong to the inspector, not the map.
        const inRail = !!document.activeElement?.closest?.('#rail');
        if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); this.openPalette(); }
        if (e.key === '/' && !typing) { e.preventDefault(); $('#search').focus(); }
        // Map keyboard: arrows pan, +/- zoom, 0 fits — the canvas is the only
        // way to reach some symbols, so it must work without a pointer.
        if (!typing && !inRail && $('#palette').classList.contains('hidden')) {
          const pan = 90;
          if (e.key === 'ArrowLeft') { e.preventDefault(); this.panBy(pan, 0); }
          else if (e.key === 'ArrowRight') { e.preventDefault(); this.panBy(-pan, 0); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); this.panBy(0, pan); }
          else if (e.key === 'ArrowDown') { e.preventDefault(); this.panBy(0, -pan); }
          else if (e.key === '+' || e.key === '=') { e.preventDefault(); this.zoomAt(this.W / 2, this.H / 2, 1.25); }
          else if (e.key === '-' || e.key === '_') { e.preventDefault(); this.zoomAt(this.W / 2, this.H / 2, 0.8); }
          else if (e.key === '0') { e.preventDefault(); this.fitCurrent(this.fitPad); }
        }
        if (e.key === 'Escape') {
          if (!$('#palette').classList.contains('hidden')) { this.closePalette(); return; }
          if (typing) { document.activeElement.blur(); return; }
          this.back();
        }
      });
      // Canvas interactions — one pointermove handler covers hover, tooltip,
      // bubble drag and panning (the old code ran
      // hitTest twice per move and panned with self-cancelling maths).
      const c = $('#map');
      const local = (e) => {
        const r = c.getBoundingClientRect();
        return { px: e.clientX - r.left, py: e.clientY - r.top };
      };

      c.addEventListener('pointerdown', (e) => {
        const { px, py } = local(e);
        const h = this.hitTest(px, py);
        this.down = {
          x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY,
          t: performance.now(), hit: h, moved: false, vx: 0, vy: 0,
        };
        if (h && this.sim) {
          // Pin the bubble while the pointer is on it; the sim keeps it alive
          // and the grab spring gives the drag an elastic lag.
          this.grab = h;
          h.item.fx = h.item.x;
          h.item.fy = h.item.y;
          h.item.grabX = h.item.x;
          h.item.grabY = h.item.y;
          this.sim.reheat(0.5);
        }
        c.style.cursor = 'grabbing';
        try { c.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
      });

      window.addEventListener('keydown', (e) => {
        if (e.key === ' ' && this.studyTab === 'flash') {
          const cards = $$('#studyPanel .card-side');
          if (cards.length) cards.forEach((s) => s.classList.toggle('flipped'));
        }
      });

      const endPointer = (e) => {
        if (!this.down) return;
        const d = this.down;
        this.down = null;
        if (this.grab) {
          const n = this.grab.item;
          n.fx = null; n.fy = null; n.grabX = null; n.grabY = null;
          this.grab = null;
          if (this.sim) this.sim.reheat(0.3);
        }
        if (d.hit && !d.moved) {
          // Click: pop a ripple, bounce the bubble, then open it.
          const n = d.hit.item;
          this.ripples.push({
            x: n.x, y: n.y, r0: n.r || 6, t: 0, life: 0.55,
            color: d.hit.type === 'module' ? moduleColor(n.id) : degreeColor(n.kind, n.degree),
          });
          n.scaleV = (n.scaleV || 0) + 4.5;
          this.focusOn(n.x, n.y);
          if (d.hit.type === 'module') this.openModule(d.hit.id);
          else this.selectNode(d.hit.id);
        } else if (!d.moved) {
          // Click on empty map: glide there.
          const { px, py } = local(e);
          this.focusOn(this.wx(px), this.wy(py));
        } else if (d.moved) {
          // Flick: carry the release velocity into the eased camera, capped
          // so a wild swipe can't fling the map into the void.
          const speed = Math.hypot(d.vx, d.vy);
          if (speed > 40) {
            const glide = Math.min(speed * 0.16, 650);
            this.camT.x = this.cam.x + (d.vx / speed) * glide;
            this.camT.y = this.cam.y + (d.vy / speed) * glide;
          }
        }
        c.style.cursor = this.hover ? 'pointer' : 'grab';
        try { c.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
      };
      c.addEventListener('pointerup', endPointer);
      c.addEventListener('dblclick', (e) => {
        e.preventDefault();
        const { px, py } = local(e);
        if (this.hitTest(px, py)) return; // bubbles handle their own click
        // The two clicks already glided this spot toward the centre; zoom in on it.
        this.focusOn(this.wx(px), this.wy(py), this.camT.k * 1.7);
      });
      c.addEventListener('pointercancel', endPointer);

      c.addEventListener('pointermove', (e) => {
        const { px, py } = local(e);
        const h = this.hitTest(px, py);
        const id = h ? h.id : null;
        if (id !== this.hoverId) {
          this.hoverId = id;
          this.hover = h;
          c.style.cursor = h ? 'pointer' : (this.down ? 'grabbing' : 'grab');
          this.dirty = true;
        }
        if (h) this.setTip(h, px, py);
        else this.clearTip();
        this.lastPointer = { px, py };
        this.lastPointer = { px, py };

        const d = this.down;
        if (!d) return;
        const now = performance.now();
        const dt = Math.max(8, now - d.t) / 1000;
        if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) d.moved = true;
        if (d.hit && this.grab) {
          const n = d.hit.item;
          n.grabX = this.wx(px);
          n.grabY = this.wy(py);
          this.reheat(0.35);
        } else if (d.moved) {
          // 1:1 pan: the content tracks the pointer exactly.
          const wdx = (e.clientX - d.lastX) / this.cam.k;
          const wdy = (e.clientY - d.lastY) / this.cam.k;
          this.camUser = true;
          this.cam.x -= wdx;
          this.cam.y -= wdy;
          this.camT.x = this.cam.x;
          this.camT.y = this.cam.y;
          d.vx = -wdx / dt;
          d.vy = -wdy / dt;
        }
        d.lastX = e.clientX;
        d.lastY = e.clientY;
        d.t = now;
        this.dirty = true;
      });

      c.addEventListener('pointerleave', (e) => {
        if (this.down) endPointer(e);
        this.hover = null;
        this.hoverId = null;
        this.clearTip();
        this.lastPointer = null;
        c.style.cursor = 'grab';
        this.dirty = true;
      });

      c.addEventListener('wheel', (e) => {
        e.preventDefault();
        const { px, py } = local(e);
        const step = e.deltaMode === 1 ? 0.03 : 0.0016;
        this.zoomAt(px, py, Math.exp(-e.deltaY * step));
      }, { passive: false });
    }

    setTip(h, px, py) {
      const tip = $('#tooltip');
      const html = this.view === 'overview'
        ? `<div class="tt">${esc(h.item.name)}</div><div class="td">${fmt(h.item.count)} symbols · ${h.item.files} files</div>`
        : `<div class="tt">${esc(h.item.label)}</div><div class="td">${esc(h.item.kind || 'symbol')} · ${fmt(h.item.degree || 0)} connections</div>`;
      if (tip.dataset.for !== h.id) {
        tip.innerHTML = html;
        tip.dataset.for = h.id;
      }
      this.tipTarget = { x: px + 14, y: py + 14 };
    }
    clearTip() {
      this.tipTarget = null;
      $('#tooltip').dataset.for = '';
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
