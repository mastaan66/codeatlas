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
  // Paper notebook is the brand default; night notebook follows the OS.
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
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
  $('#studyBtn').addEventListener('click', onStudy);
  $('#search').addEventListener('input', onSearch);
  $('#helpBtn').addEventListener('click', () => $('#helpCard').classList.toggle('hidden'));
  $('#zoomIn').addEventListener('click', () => zoomBy(1.35));
  $('#zoomOut').addEventListener('click', () => zoomBy(1 / 1.35));
  $('#zoomFit').addEventListener('click', () => { focusedNode = null; if (window._nodesSel) unspotlight(window._linksSel, window._nodesSel); fitToView(500); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#fileDialog').open) defocus(); });
  $('#search').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !currentGraph) return;
    e.preventDefault();
    const q = e.target.value.toLowerCase().trim();
    if (!q) return;
    const hit = [...currentGraph.nodes]
      .filter((n) => n.label.toLowerCase().includes(q))
      .sort((a, b) => b.degree - a.degree)[0];
    if (hit) { showNode(hit); focusNode(hit); }
  });
  $('#themeBtn').addEventListener('click', toggleTheme);
  $('#fileDialogClose').addEventListener('click', () => $('#fileDialog').close());
  $('#fileDialog').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
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

let fullGraph = null;
let showMeta = false;

async function loadRepo(slug) {
  currentSlug = slug;
  $('#tour').textContent = '';
  $('#answer').textContent = '';
  $('#study').textContent = '';
  setStatus('Loading graph…');
  fullGraph = await fetchJSON('/api/graph/' + encodeURIComponent(slug));
  setStatus(null);
  applyMetaFilter();
}

// Keep the map about code: config/manifest/CI/doc symbols hide behind a toggle.
function applyMetaFilter() {
  const nodes = fullGraph.nodes.filter((n) => showMeta || !n.meta);
  const keep = new Set(nodes.map((n) => n.id));
  const links = fullGraph.links
    .map((l) => ({ source: l.source.id ?? l.source, target: l.target.id ?? l.target, rel: l.rel }))
    .filter((l) => keep.has(l.source) && keep.has(l.target));
  const communities = new Set(nodes.map((n) => n.community));
  const hidden = fullGraph.nodes.length - nodes.length;
  const graph = { slug: fullGraph.slug, nodes, links,
    stats: { nodes: nodes.length, links: links.length, communities: communities.size } };
  $('#graphMeta').innerHTML =
    `${esc(fullGraph.slug)} · ${graph.stats.nodes} symbols · ${graph.stats.links} links · ${graph.stats.communities} modules` +
    (hidden > 0 || showMeta
      ? ` · <label class="metaToggle"><input type="checkbox" id="metaToggle"${showMeta ? ' checked' : ''}> config & deps${hidden ? ` (${hidden})` : ''}</label>`
      : '');
  const t = $('#metaToggle');
  if (t) t.addEventListener('change', (e) => { showMeta = e.target.checked; applyMetaFilter(); });
  drawGraph(graph);
}

function topByDegreeLocal(nodes, n) {
  return [...nodes].sort((a, b) => b.degree - a.degree).slice(0, n);
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
  // Disambiguate modules that share a directory by naming their hub symbol.
  const dirCounts = {};
  for (const [c] of top) dirCounts[topFiles.get(c)] = (dirCounts[topFiles.get(c)] || 0) + 1;
  const nameFor = (c) => {
    const dir = topFiles.get(c);
    if (dirCounts[dir] <= 1) return dir;
    const hub = topByDegreeLocal(currentGraph.nodes.filter((n) => n.community === c), 1)[0];
    return `${dir} — ${hub ? hub.label : 'module ' + c}`;
  };
  const others = [...sizes.keys()].length - top.length;
  $('#legend').innerHTML = '<h4>Modules</h4>' + top.map(([c, n]) =>
    `<div class="row"><i class="sw" style="background:${colorFor(c)}"></i><span>${esc(nameFor(c))} · ${n}</span></div>`
  ).join('') + (others > 0
    ? `<div class="row"><i class="sw" style="background:${OTHER_COLOR[theme()]}"></i><span>${others} smaller modules</span></div>`
    : '');
  $('#legend').classList.remove('hidden');
}

function drawGraph(graph) {
  currentGraph = graph;
  focusedNode = null;
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
    .on('click', (ev, d) => { ev.stopPropagation(); showNode(d); focusNode(d); })
    .on('mouseenter', (ev, d) => { if (!focusedNode) spotlight(d, link, node); })
    .on('mousemove', (ev) => moveTooltip(ev))
    .on('mouseleave', () => { if (!focusedNode) unspotlight(link, node); });

  // Click empty canvas or press Escape to release focus (Meet-style pull-back).
  svg.on('dblclick', () => defocus());

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

/* ---- Meet-style focus: fly the camera to a node and its neighborhood ---- */
let focusedNode = null;

function neighborhoodOf(d) {
  const ids = new Set([d.id]);
  for (const l of currentGraph.links) {
    const s = l.source.id ?? l.source;
    const t = l.target.id ?? l.target;
    if (s === d.id) ids.add(t);
    if (t === d.id) ids.add(s);
  }
  return ids;
}

function focusNode(d) {
  focusedNode = d;
  const ids = neighborhoodOf(d);
  const pts = currentGraph.nodes.filter((n) => ids.has(n.id) && Number.isFinite(n.x));
  if (!pts.length || !zoomBehavior) return;
  const svg = d3.select('#graph');
  const { width, height } = svg.node().getBoundingClientRect();
  const xs = pts.map((n) => n.x);
  const ys = pts.map((n) => n.y);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const pad = 120;
  const k = Math.max(0.3, Math.min(4.5,
    0.9 / Math.max((x1 - x0 + pad) / width, (y1 - y0 + pad) / height, 1e-6)));
  const t = d3.zoomIdentity
    .translate(width / 2 - k * (x0 + x1) / 2, height / 2 - k * (y0 + y1) / 2)
    .scale(k);
  svg.transition().duration(820).ease(d3.easeCubicInOut).call(zoomBehavior.transform, t);
  if (window._nodesSel && window._linksSel) spotlight(d, window._linksSel, window._nodesSel);
  $('#tooltip').style.display = 'none'; // focus is a click, not a hover
}

function defocus() {
  if (!focusedNode) return;
  focusedNode = null;
  if (window._nodesSel && window._linksSel) unspotlight(window._linksSel, window._nodesSel);
  fitToView(820);
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
      <div>File: ${d.file
        ? `<span class="filelink" data-path="${esc(d.file)}" data-loc="${esc(d.loc || '')}">${esc(d.file)}</span>${d.loc ? ' · ' + esc(d.loc) : ''}`
        : '—'}</div>
      <div>Module (community): ${d.community}</div>
      <div>Connections: ${d.degree}</div>
      <div>${d.callable ? 'Callable (function/class)' : 'Symbol'}</div>
    </div>`;
  const link = $('#nodeDetails .filelink');
  if (link) link.addEventListener('click', () => openFile(link.dataset.path, link.dataset.loc));
}

/* ---- file viewer ---- */
async function openFile(relPath, loc) {
  if (!currentSlug || !relPath) return;
  const dlg = $('#fileDialog');
  $('#fileDialogPath').textContent = relPath + (loc ? ` · ${loc}` : '');
  $('#fileContent').textContent = 'Loading…';
  dlg.showModal();
  try {
    const { content, truncated } = await fetchJSON(
      `/api/file/${encodeURIComponent(currentSlug)}?path=${encodeURIComponent(relPath)}`);
    const hitLine = loc && /^L(\d+)/.exec(loc) ? Number(RegExp.$1) : -1;
    const rows = content.split('\n').map((line, i) =>
      `<div class="ln${i + 1 === hitLine ? ' hit' : ''}"><span class="no">${i + 1}</span><code>${esc(line)}</code></div>`);
    if (truncated) rows.push('<div class="ln"><span class="no">…</span><code>(truncated at 200 KB)</code></div>');
    $('#fileContent').innerHTML = rows.join('');
    const hit = $('#fileContent .hit');
    if (hit) hit.scrollIntoView({ block: 'center' });
  } catch (err) {
    $('#fileContent').textContent = err.message;
  }
}

// Make file paths inside rendered ask/tour markdown clickable.
function wireFileLinks(container) {
  if (!currentGraph) return;
  const files = new Set(currentGraph.nodes.map((n) => n.file).filter(Boolean));
  container.querySelectorAll('code').forEach((c) => {
    const t = c.textContent.trim();
    const match = files.has(t) ? t : [...files].find((f) => f.endsWith('/' + t) || f === t);
    if (match) {
      c.classList.add('filelink');
      c.title = 'Open ' + match;
      c.addEventListener('click', () => openFile(match, ''));
    }
  });
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
    renderMarkdown($('#answer'), answer, provider);
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
    renderMarkdown($('#tour'), tour, provider);
  } catch (err) {
    $('#tour').textContent = 'Error: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

/* ---- Study tab: flashcards + pop quiz from the knowledge graph ---- */
async function onStudy() {
  if (!currentSlug) return alert('Index or select a repo first');
  const btn = $('#studyBtn');
  btn.disabled = true;
  $('#study').textContent = 'Writing flashcards from the knowledge graph…';
  try {
    const kit = await fetchJSON('/api/studykit/' + encodeURIComponent(currentSlug));
    renderStudyKit($('#study'), kit);
  } catch (err) {
    $('#study').textContent = 'Error: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

// All model text goes through esc() — never innerHTML raw output.
function renderStudyKit(el, kit) {
  const cards = (kit.flashcards || []).map((c, i) => `
    <div class="flashcard" tabindex="0" role="button" aria-pressed="false" title="Flip the card">
      <div class="flashInner">
        <div class="flashFace flashFront"><span class="cardNo">${i + 1}</span><span>${esc(c.front)}</span></div>
        <div class="flashFace flashBack">${esc(c.back)}</div>
      </div>
    </div>`).join('');
  const quiz = (kit.quiz || []).map((q, qi) => `
    <div class="quizQ" data-answer="${Number(q.answerIndex)}">
      <div class="quizQuestion">${qi + 1}. ${esc(q.question)}</div>
      ${q.options.map((o, oi) => `<button class="quizOpt" data-o="${oi}">${esc(o)}</button>`).join('')}
      <div class="quizExplain hidden">${esc(q.explanation || '')}</div>
    </div>`).join('');
  el.innerHTML = `
    <h4 class="studyHead">Flashcards</h4>
    <div class="flashcards">${cards}</div>
    <h4 class="studyHead">Pop quiz</h4>
    ${quiz}
    <div class="quizScore"></div>
    ${kit.provider ? `<p class="muted">— ${esc(kit.provider)}</p>` : ''}`;

  el.querySelectorAll('.flashcard').forEach((card) => {
    const flip = () => {
      card.classList.toggle('flipped');
      card.setAttribute('aria-pressed', card.classList.contains('flipped'));
    };
    card.addEventListener('click', flip);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); }
    });
  });

  const questions = el.querySelectorAll('.quizQ');
  let answered = 0, right = 0;
  questions.forEach((qEl) => {
    const answer = Number(qEl.dataset.answer);
    qEl.querySelectorAll('.quizOpt').forEach((opt) => opt.addEventListener('click', () => {
      if (qEl.classList.contains('done')) return;
      qEl.classList.add('done');
      const picked = Number(opt.dataset.o);
      qEl.querySelectorAll('.quizOpt').forEach((o) => {
        const oi = Number(o.dataset.o);
        o.disabled = true;
        if (oi === answer) o.classList.add('correct');
        else if (oi === picked) o.classList.add('wrong');
        else o.classList.add('dim');
      });
      qEl.querySelector('.quizExplain').classList.remove('hidden');
      answered += 1;
      if (picked === answer) right += 1;
      if (answered === questions.length) {
        el.querySelector('.quizScore').textContent =
          `Score: ${right} / ${questions.length}` + (right === questions.length ? ' — you know this map!' : '');
      }
    }));
  });
}

// Model output is markdown — render it, sanitized (belt-and-braces).
function renderMarkdown(el, md, provider) {
  if (window.marked && window.DOMPurify) {
    el.classList.add('md');
    el.innerHTML = DOMPurify.sanitize(marked.parse(md || '')) +
      (provider ? `<p class="muted">— ${esc(provider)}</p>` : '');
    wireFileLinks(el);
  } else {
    el.textContent = md + (provider ? `\n\n— ${provider}` : '');
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
