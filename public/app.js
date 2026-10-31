/* CodeAtlas frontend: d3 force graph + ask/tour panels. */
const $ = (s) => document.querySelector(s);
const palette = d3.schemeTableau10.concat(d3.schemeSet3 || []);

let currentSlug = null;
let simulation = null;

init();

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
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab, .tabPanel').forEach((el) => el.classList.remove('active'));
    t.classList.add('active');
    $('#tab-' + t.dataset.tab).classList.add('active');
  }));
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
  if (!currentSlug && repos.length) loadRepo(repos[0]);
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

function drawGraph(graph) {
  const svg = d3.select('#graph');
  svg.selectAll('*').remove();
  const { width, height } = svg.node().getBoundingClientRect();
  const g = svg.append('g');
  svg.call(d3.zoom().scaleExtent([0.1, 6]).on('zoom', (ev) => g.attr('transform', ev.transform)));

  if (simulation) simulation.stop();
  const r = (d) => 3 + Math.min(14, Math.sqrt(d.degree));

  const link = g.append('g').selectAll('line').data(graph.links).join('line').attr('class', 'link');
  const node = g.append('g').selectAll('g').data(graph.nodes).join('g').attr('class', 'node');

  node.append('circle')
    .attr('r', r)
    .attr('fill', (d) => palette[((d.community % palette.length) + palette.length) % palette.length])
    .attr('stroke', '#0d1117').attr('stroke-width', 1)
    .style('cursor', 'pointer')
    .on('click', (ev, d) => showNode(d));

  node.filter((d) => d.degree > 8).append('text')
    .attr('dy', -10).attr('text-anchor', 'middle').text((d) => d.label);

  node.call(d3.drag()
    .on('start', (ev, d) => { if (!ev.active) simulation.alphaTarget(0.2).restart(); d.fx = d.x; d.fy = d.y; })
    .on('drag', (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
    .on('end', (ev, d) => { if (!ev.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; }));

  simulation = d3.forceSimulation(graph.nodes)
    .force('link', d3.forceLink(graph.links).id((d) => d.id).distance(40).strength(0.3))
    .force('charge', d3.forceManyBody().strength(-60))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collide', d3.forceCollide().radius((d) => r(d) + 2))
    .on('tick', () => {
      link.attr('x1', (d) => d.source.x).attr('y1', (d) => d.source.y)
          .attr('x2', (d) => d.target.x).attr('y2', (d) => d.target.y);
      node.attr('transform', (d) => `translate(${d.x},${d.y})`);
    });

  window._nodesSel = node;
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
  window._nodesSel.select('circle')
    .attr('opacity', (d) => !q || d.label.toLowerCase().includes(q) ? 1 : 0.12);
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
