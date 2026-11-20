/* CodeAtlas landing — hero constellation and live repo gallery. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cv = $('#heroCanvas');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  let W = 0;
  let H = 0;
  let DPR = 1;
  let raf = 0;
  let t0 = performance.now();
  const C = {};

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    Object.assign(C, {
      text: v('--text'), muted: v('--muted'), cyan: v('--cyan'), violet: v('--violet'), mono: v('--mono'),
      green: v('--green'), amber: v('--amber'), rose: v('--rose'),
      bg: v('--bg'), accent: v('--accent'), stone: v('--stone'),
    });
  }
  function alpha(hex, a) {
    const h = String(hex || '').replace('#', '');
    const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const num = parseInt(n, 16);
    if (!Number.isFinite(num)) return `rgba(150,170,200,${a})`;
    return `rgba(${(num >> 16) & 255},${(num >> 8) & 255},${num & 255},${a})`;
  }

  function resize() {
    const r = cv.getBoundingClientRect();
    W = Math.max(1, r.width);
    H = Math.max(1, r.height);
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(W * DPR);
    cv.height = Math.round(H * DPR);
    draw(performance.now());
  }

  const MODULES = [
    { name: 'api', n: 46, k: 'core', c: 'cyan' },
    { name: 'engine', n: 92, k: 'core', c: 'violet' },
    { name: 'scheduler', n: 64, k: 'core', c: 'cyan' },
    { name: 'cache', n: 38, k: 'core', c: 'cyan' },
    { name: 'workers', n: 58, k: 'core', c: 'violet' },
    { name: 'models', n: 120, k: 'core', c: 'cyan' },
    { name: 'transport', n: 30, k: 'core', c: 'violet' },
    { name: 'tests', n: 72, k: 'support', c: 'muted' },
    { name: 'docs', n: 24, k: 'support', c: 'muted' },
  ];

  function layout() {
    const cx = W * 0.5;
    const cy = H * 0.48;
    const R = Math.min(W, H) * 0.37;
    const list = [];
    MODULES.forEach((m, i) => {
      const inner = i < 5;
      const count = inner ? 5 : 4;
      const idx = inner ? i : i - 5;
      const ang = (idx / count) * Math.PI * 2 - Math.PI / 2 + (inner ? 0.2 : 0.55);
      const r = inner ? R * 0.58 : R * 1.02;
      list.push({
        ...m,
        x: cx + Math.cos(ang) * r,
        y: cy + Math.sin(ang) * r * 0.84,
        r: 13 + Math.sqrt(m.n) * 2.1,
        ang,
      });
    });
    return list;
  }

  function draw(now) {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const t = REDUCED ? 0 : (now - t0) / 1000;
    const mods = layout();
    const byName = new Map(mods.map((m) => [m.name, m]));

    const edges = [
      ['api', 'engine'], ['api', 'scheduler'], ['engine', 'cache'], ['engine', 'models'],
      ['scheduler', 'workers'], ['scheduler', 'cache'], ['workers', 'models'],
      ['api', 'transport'], ['models', 'transport'], ['tests', 'engine'], ['tests', 'api'],
      ['docs', 'api'], ['cache', 'models'],
    ];
    for (const [a, b] of edges) {
      const A = byName.get(a);
      const B = byName.get(b);
      if (!A || !B) continue;
      const mx = (A.x + B.x) / 2 + Math.cos(t * 0.12 + A.ang) * 10;
      const my = (A.y + B.y) / 2 + Math.sin(t * 0.12 + B.ang) * 10;
      ctx.beginPath();
      ctx.moveTo(A.x, A.y);
      ctx.quadraticCurveTo(mx, my, B.x, B.y);
      ctx.strokeStyle = alpha(C.stone, 0.22);
      ctx.lineWidth = 1;
      ctx.stroke();
      // A packet travelling the edge.
      if (!REDUCED) {
        const p = (t * 0.18 + A.ang * 0.3) % 1;
        const q = 1 - p;
        const px = q * q * A.x + 2 * q * p * mx + p * p * B.x;
        const py = q * q * A.y + 2 * q * p * my + p * p * B.y;
        ctx.beginPath();
        ctx.arc(px, py, 1.9, 0, Math.PI * 2);
        ctx.fillStyle = alpha(C.accent, 0.85);
        ctx.fill();
      }
    }

    for (const m of mods) {
      const col = C[m.c] || C.muted;
      const pulse = 1 + Math.sin(t * 0.8 + m.ang) * 0.035;
      const r = m.r * pulse;
      const g = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, r * 2.1);
      g.addColorStop(0, alpha(col, 0.28));
      g.addColorStop(0.6, alpha(col, 0.08));
      g.addColorStop(1, alpha(col, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(m.x, m.y, r * 2.1, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.arc(m.x, m.y, r, 0, Math.PI * 2);
      ctx.fillStyle = alpha(col, 0.13);
      ctx.fill();
      ctx.strokeStyle = alpha(col, m.k === 'support' ? 0.28 : 0.62);
      ctx.lineWidth = m.k === 'support' ? 1 : 1.4;
      ctx.stroke();

      if (m.k !== 'support') {
        let seed = m.n;
        const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
        for (let i = 0; i < 10; i++) {
          const a = rnd() * Math.PI * 2;
          const rr = Math.sqrt(rnd()) * r * 0.66;
          ctx.beginPath();
          ctx.arc(m.x + Math.cos(a) * rr, m.y + Math.sin(a) * rr, 1.4, 0, Math.PI * 2);
          ctx.fillStyle = alpha(col, 0.65);
          ctx.fill();
        }
      }

      ctx.font = `500 ${m.k === 'support' ? 8.5 : 9.5}px ${C.mono}`;
      ctx.textAlign = 'center';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 3;
      ctx.strokeStyle = alpha(C.bg, 0.85);
      ctx.strokeText(m.name.toUpperCase(), m.x, m.y + r + 14);
      ctx.fillStyle = m.k === 'support' ? alpha(C.muted, 0.8) : C.text;
      ctx.fillText(m.name.toUpperCase(), m.x, m.y + r + 14);
    }
  }

  function loop(now) {
    draw(now);
    raf = requestAnimationFrame(loop);
  }

  function start() {
    cancelAnimationFrame(raf);
    if (REDUCED) { draw(performance.now()); return; }
    raf = requestAnimationFrame(loop);
  }

  readColors();
  resize();
  start();
  new ResizeObserver(resize).observe(cv);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelAnimationFrame(raf);
    else start();
  });

  $('#themeBtn')?.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('codeatlas-theme', next); } catch {}
    readColors();
    resize();
  });

  /* ------------------------------------------------------------- gallery */
  let repos = [];
  fetch('/api/repos').then((r) => (r.ok ? r.json() : null)).then((out) => {
    if (!out || !Array.isArray(out.details) || !out.details.length) return;
    repos = out.details;
    const gallery = $('#gallery');
    if (!gallery) return;
    gallery.innerHTML = '';
    for (const r of repos.slice(0, 12)) {
      const stats = r.stats || {};
      const meta = r.meta || {};
      const langs = (meta.languages || []).slice(0, 3);
      const a = document.createElement('a');
      a.className = 'repo-card';
      a.href = `/app?repo=${encodeURIComponent(r.slug)}`;
      const name = document.createElement('div');
      name.className = 'rc-name';
      name.textContent = (meta.repo || r.slug).replace(/^.*github\.com\//, '');
      const info = document.createElement('div');
      info.className = 'rc-meta';
      info.textContent = stats.nodes
        ? `${stats.nodes.toLocaleString()} symbols · ${stats.links.toLocaleString()} links`
        : 'mapped';
      const tags = document.createElement('div');
      tags.className = 'rc-langs';
      for (const l of langs) {
        const s = document.createElement('span');
        s.className = 'rc-lang';
        s.textContent = l[0] || l;
        tags.appendChild(s);
      }
      a.append(name, info, tags);
      gallery.appendChild(a);
    }
  }).catch(() => {});

  const form = $('#heroForm');
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    let v = $('#heroRepo').value.trim();
    if (!v) { $('#heroRepo').focus(); return; }
    const known = repos.find((r) => r.slug === v);
    if (known) v = known.slug;
    else if (/^[\w.-]+\/[\w.-]+$/.test(v)) v = `https://github.com/${v}`;
    location.href = `/app?repo=${encodeURIComponent(v)}`;
  });
})();
