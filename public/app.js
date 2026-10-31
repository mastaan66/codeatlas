/* CodeAtlas frontend: d3 force graph (hover spotlight, auto-fit, themed) + ask/tour. */
const $ = (s) => document.querySelector(s);

// Validated categorical palette (dataviz reference instance), stepped per surface.
// Top 8 communities by size get slots in fixed order; the rest fold to "Other" gray.
const PALETTES = {
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
};
const OTHER_COLOR = { dark: '#6e7781', light: '#8b949e' };

let currentSlug = null;
let simulation = null;
let zoomBehavior = null;
let currentGraph = null;
let communityRank = new Map(); // community id -> palette slot (0-7) or -1 (Other)

init();

function theme() {
  const t = document.documentElement.dataset.theme;
  if (t === 'light' || t === 'dark') return t;
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
const colorFor = (community) => {
  const slot = communityRank.get(community);
  return slot >= 0 ? PALETTES[theme()][slot] : OTHER_COLOR[theme()];
};

async function init() {
  const health = await fetchJSON('/api/health').catch(() => null);
  if (health) $('#providerBadge').textContent =
    health.provider === 'gemini-api' ? 'Gemma 4 · Gemini API' : 'Gemma 4 · local open weights';
  await refreshRepoList();
  $('#indexForm').addEventListener('submit', onIndex);
  $('#repoSelect').addEventListener('change', (e) => e.target.value && loadRepo(e.target.value));
  $('#askBtn').addEventListener('click', onAsk);
  $('#tourBtn').addEventListener('click', onTour);
  $('#search').addEventListener('input', onSearch);
  $('#helpBtn').addEventListener('click', () => $('#helpCard').classList.toggle('hidden'));
  $('#zoomIn').addEventListener('click', () => zoomBy(1.35));
  $('#zoomOut').addEventListener('click', () => zoomBy(1 / 1.35));
  $('#zoomFit').addEventListener('click', () => fitToView(500));
  $('#themeBtn').addEventListener('click', toggleTheme);
  syncThemeButton();
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab, .tabPanel').forEach((el) => el.classList.remove('active'));
    t.classList.add('active');
    $('#tab-' + t.dataset.tab).classList.add('active');
  }));
}

function toggleTheme() {
  const next = theme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('codeatlas-theme', next); } catch {}
  syncThemeButton();
  repaint();
}
function syncThemeButton() { $('#themeBtn').textContent = theme() === 'dark' ? '🌙' : '🌞'; }
function repaint() {
  if (!window._nodesSel) return;
  window._nodesSel.select('circle').attr('fill', (d) => colorFor(d.community));
  renderLegend();
}

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function refreshRepoList() {
  const { repos } = await fetchJSON('/api/repos');
  const sel = $('#repoSelect');
  sel.innerHTML = '<option value="">— indexed repos —</option>' +
    repos.map((r) => `<option value="${r}">${r}</option>`).join('');
  if (!currentSlug && repos.length) {
    sel.value = repos[0];
    loadRepo(repos[0]);
  }
}

function setStatus(msg) {
  const el = $('#status');
  if (!msg) return el.classList.add('hidden');
  el.textContent = msg;
  el.classList.remove('hidden');
}

async function onIndex(e) {
  e.preventDefault();
  const btn = $('#indexBtn');
  btn.disabled = true;
  setStatus('Cloning and mapping the codebase with Graphify… (local AST parsing, ~5–60s)');
  try {
    const { slug } = await fetchJSON('/api/index', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoUrl: $('#repoUrl').value }),
    });
    await refreshRepoList();
    $('#repoSelect').value = slug;
    await loadRepo(slug);
  } catch (err) {
    setStatus('Failed: ' + err.message);
    setTimeout(() => setStatus(null), 5000);
  } finally {
    btn.disabled = false;
  }
}

async function loadRepo(slug) {
  currentSlug = slug;
  $('#tour').textContent = '';
  $('#answer').textContent = '';
  setStatus('Loading graph…');
  const graph = await fetchJSON('/api/graph/' + encodeURIComponent(slug));
  setStatus(null);
  $('#graphMeta').textContent =
    `${slug} · ${graph.stats.nodes} symbols · ${graph.stats.links} links · ${graph.stats.communities} modules`;
  drawGraph(graph);
}

function rankCommunities(graph) {
  const sizes = new Map();
  for (const n of graph.nodes) sizes.set(n.community, (sizes.get(n.community) || 0) + 1);
  const ordered = [...sizes.entries()].sort((a, b) => b[1] - a[1]);
  communityRank = new Map(ordered.map(([c], i) => [c, i < 8 ? i : -1]));
  return sizes;
}

function renderLegend() {
  if (!currentGraph) return;
  const sizes = new Map();
  for (const n of currentGraph.nodes) sizes.set(n.community, (sizes.get(n.community) || 0) + 1);
  const top = [...sizes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const topFiles = new Map(); // community -> most common dir, as a human name
  for (const [c] of top) {
    const dirs = {};
    for (const n of currentGraph.nodes) {
      if (n.community !== c || !n.file) continue;
      const d = n.file.split('/').slice(0, -1).join('/') || n.file;
      dirs[d] = (dirs[d] || 0) + 1;
    }
    topFiles.set(c, Object.entries(dirs).sort((a, b) => b[1] - a[1])[0]?.[0] || `module ${c}`);
  }
  const others = [...sizes.keys()].length - top.length;
  $('#legend').innerHTML = '<h4>Modules</h4>' + top.map(([c, n]) =>
    `<div class="row"><i class="sw" style="background:${colorFor(c)}"></i><span>${esc(topFiles.get(c))} · ${n}</span></div>`
  ).join('') + (others > 0
    ? `<div class="row"><i class="sw" style="background:${OTHER_COLOR[theme()]}"></i><span>${others} smaller modules</span></div>`
    : '');
  $('#legend').classList.remove('hidden');
}

function drawGraph(graph) {
  currentGraph = graph;
  rankCommunities(graph);
  const svg = d3.select('#graph');
  svg.selectAll('*').remove();
  const { width, height } = svg.node().getBoundingClientRect();
  const g = svg.append('g');
  zoomBehavior = d3.zoom().scaleExtent([0.08, 8]).on('zoom', (ev) => g.attr('transform', ev.transform));
  svg.call(zoomBehavior).on('dblclick.zoom', null);

  if (simulation) simulation.stop();
  const r = (d) => 4.5 + Math.min(20, 2.2 * Math.sqrt(d.degree));

  const link = g.append('g').selectAll('line').data(graph.links).join('line')
    .attr('class', 'link').attr('stroke-width', 1.1);
  const node = g.append('g').selectAll('g').data(graph.nodes).join('g').attr('class', 'node');

  node.append('circle')
    .attr('r', r)
    .attr('fill', (d) => colorFor(d.community))
    .attr('stroke', 'var(--bg)')
    .style('cursor', 'pointer')
    .on('click', (ev, d) => showNode(d))
    .on('mouseenter', (ev, d) => spotlight(d, link, node))
    .on('mousemove', (ev) => moveTooltip(ev))
    .on('mouseleave', () => unspotlight(link, node));

  // Label the hubs: top 22 by degree, with a surface-colored halo for legibility.
  const labelCut = [...graph.nodes].sort((a, b) => b.degree - a.degree)[Math.min(21, graph.nodes.length - 1)]?.degree ?? 0;
  node.filter((d) => d.degree >= Math.max(labelCut, 3)).append('text')
    .attr('dy', (d) => -r(d) - 5).attr('text-anchor', 'middle').text((d) => d.label);

  node.call(d3.drag()
    .on('start', (ev, d) => { if (!ev.active) simulation.alphaTarget(0.2).restart(); d.fx = d.x; d.fy = d.y; })
    .on('drag', (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
    .on('end', (ev, d) => { if (!ev.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; }));

  simulation = d3.forceSimulation(graph.nodes)
    .force('link', d3.forceLink(graph.links).id((d) => d.id).distance(52).strength(0.35))
    .force('charge', d3.forceManyBody().strength(-130))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('x', d3.forceX(width / 2).strength(0.045))
    .force('y', d3.forceY(height / 2).strength(0.055))
    .force('collide', d3.forceCollide().radius((d) => r(d) + 3))
    .on('tick', () => {
      link.attr('x1', (d) => d.source.x).attr('y1', (d) => d.source.y)
          .attr('x2', (d) => d.target.x).attr('y2', (d) => d.target.y);
      node.attr('transform', (d) => `translate(${d.x},${d.y})`);
    })
    .on('end', () => fitToView(650));

  // Early fit so big graphs are on screen even before full settle.
  setTimeout(() => fitToView(650), 1300);

  window._nodesSel = node;
  window._linksSel = link;
  renderLegend();
}

function fitToView(ms) {
  if (!currentGraph || !zoomBehavior) return;
  const svg = d3.select('#graph');
  const { width, height } = svg.node().getBoundingClientRect();
  const xs = currentGraph.nodes.map((n) => n.x).filter(Number.isFinite);
  const ys = currentGraph.nodes.map((n) => n.y).filter(Number.isFinite);
  if (!xs.length) return;
  const pad = 56;
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const k = Math.min(3, 0.95 / Math.max((x1 - x0 + pad) / width, (y1 - y0 + pad) / height, 1e-6));
  const t = d3.zoomIdentity
    .translate(width / 2 - k * (x0 + x1) / 2, height / 2 - k * (y0 + y1) / 2)
    .scale(k);
  svg.transition().duration(ms || 0).call(zoomBehavior.transform, t);
}

function zoomBy(factor) {
  d3.select('#graph').transition().duration(220).call(zoomBehavior.scaleBy, factor);
}

function spotlight(d, link, node) {
  const near = new Set([d.id]);
  for (const l of currentGraph.links) {
    const s = l.source.id ?? l.source;
    const t = l.target.id ?? l.target;
    if (s === d.id) near.add(t);
    if (t === d.id) near.add(s);
  }
  node.attr('opacity', (n) => near.has(n.id) ? 1 : 0.12);
  link.attr('stroke-opacity', (l) =>
    (l.source.id ?? l.source) === d.id || (l.target.id ?? l.target) === d.id ? 0.9 : 0.06);
  const tip = $('#tooltip');
  tip.innerHTML = `<b>${esc(d.label)}</b><div class="path">${esc(d.file || '')}${d.loc ? ':' + esc(d.loc) : ''}</div>` +
    `<div>${d.degree} connection${d.degree === 1 ? '' : 's'} · ${d.callable ? 'callable' : 'symbol'}</div>`;
  tip.style.display = 'block';
}
function moveTooltip(ev) {
  const tip = $('#tooltip');
  const pane = $('#graphPane').getBoundingClientRect();
  tip.style.left = Math.min(ev.clientX - pane.left + 16, pane.width - 330) + 'px';
  tip.style.top = (ev.clientY - pane.top + 14) + 'px';
}
function unspotlight(link, node) {
  node.attr('opacity', 1);
  link.attr('stroke-opacity', 0.6);
  $('#tooltip').style.display = 'none';
}

function showNode(d) {
  document.querySelectorAll('.tab, .tabPanel').forEach((el) => el.classList.remove('active'));
  document.querySelector('[data-tab=node]').classList.add('active');
  $('#tab-node').classList.add('active');
  $('#nodeDetails').innerHTML = `
    <div class="kv">
      <div><b>${esc(d.label)}</b></div>
      <div>File: ${esc(d.file || '—')}${d.loc ? ' · ' + esc(d.loc) : ''}</div>
      <div>Module (community): ${d.community}</div>
      <div>Connections: ${d.degree}</div>
      <div>${d.callable ? 'Callable (function/class)' : 'Symbol'}</div>
    </div>`;
}

function onSearch(e) {
  const q = e.target.value.toLowerCase();
  if (!window._nodesSel) return;
  window._nodesSel.attr('opacity', (d) => !q || d.label.toLowerCase().includes(q) ? 1 : 0.1);
}

async function onAsk() {
  if (!currentSlug) return alert('Index or select a repo first');
  const q = $('#question').value.trim();
  if (!q) return;
  const btn = $('#askBtn');
  btn.disabled = true;
  $('#answer').textContent = 'Gemma 4 is reading the knowledge graph…';
  try {
    const { answer, provider } = await fetchJSON('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: currentSlug, question: q }),
    });
    $('#answer').textContent = answer + `\n\n— ${provider}`;
  } catch (err) {
    $('#answer').textContent = 'Error: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

async function onTour() {
  if (!currentSlug) return alert('Index or select a repo first');
  const btn = $('#tourBtn');
  btn.disabled = true;
  $('#tour').textContent = 'Building a guided tour from the knowledge graph…';
  try {
    const { tour, provider } = await fetchJSON('/api/tour/' + encodeURIComponent(currentSlug));
    $('#tour').textContent = tour + `\n\n— ${provider}`;
  } catch (err) {
    $('#tour').textContent = 'Error: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
