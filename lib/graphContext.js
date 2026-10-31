// Turn the knowledge graph into compact, grounded context for Gemma prompts.

function topByDegree(nodes, n) {
  return [...nodes].sort((a, b) => b.degree - a.degree).slice(0, n);
}

// Ground prompts in real code symbols; config/manifest nodes only if that's all there is.
function codeNodes(graph) {
  const code = graph.nodes.filter((n) => !n.meta);
  return code.length >= 10 ? code : graph.nodes;
}

function describeNode(n) {
  const where = n.file ? ` (${n.file}${n.loc ? ':' + n.loc : ''})` : '';
  return `- ${n.label}${where} [community ${n.community}, degree ${n.degree}]`;
}

function neighborLines(graph, ids, limit) {
  const idSet = new Set(ids);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const lines = [];
  for (const l of graph.links) {
    if (lines.length >= limit) break;
    if (idSet.has(l.source) || idSet.has(l.target)) {
      const s = byId.get(l.source);
      const t = byId.get(l.target);
      if (s && t) lines.push(`- ${s.label} --${l.rel || 'related'}--> ${t.label}`);
    }
  }
  return lines;
}

// Keyword-match the question against labels/files, then expand one hop.
function buildQuestionContext(graph, question) {
  const terms = question.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  const scored = codeNodes(graph).map((n) => {
    const hay = `${n.label} ${n.file || ''}`.toLowerCase();
    let score = 0;
    for (const t of terms) if (hay.includes(t)) score += 1;
    return { n, score };
  }).filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.n.degree - a.n.degree)
    .slice(0, 30)
    .map((s) => s.n);

  const anchors = scored.length ? scored : topByDegree(codeNodes(graph), 15);
  const hubs = topByDegree(codeNodes(graph), 10);

  return [
    `Repo stats: ${graph.stats.nodes} symbols, ${graph.stats.links} relationships, ${graph.stats.communities} modules (communities).`,
    `\n### Symbols matching the question`,
    ...anchors.map(describeNode),
    `\n### Their relationships`,
    ...neighborLines(graph, anchors.map((n) => n.id), 40),
    `\n### Most connected symbols overall`,
    ...hubs.map(describeNode),
  ].join('\n');
}

// Community-by-community digest for the onboarding tour.
function buildTourContext(graph) {
  const byCommunity = new Map();
  for (const n of codeNodes(graph)) {
    if (!byCommunity.has(n.community)) byCommunity.set(n.community, []);
    byCommunity.get(n.community).push(n);
  }
  const sections = [...byCommunity.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 10)
    .map(([c, members]) => {
      const top = topByDegree(members, 5);
      const files = [...new Set(top.map((n) => n.file).filter(Boolean))].slice(0, 5);
      return `Community ${c} (${members.length} symbols): key symbols ${top.map((n) => n.label).join(', ')}; files: ${files.join(', ')}`;
    });

  const entryish = codeNodes(graph).filter((n) =>
    /(^|\/)(main|cli|app|index|server|__main__)\.[a-z]+$/.test(n.file || ''));

  return [
    `Repo stats: ${graph.stats.nodes} symbols, ${graph.stats.links} relationships, ${graph.stats.communities} communities.`,
    `\n### Communities (largest first)`,
    ...sections,
    `\n### Likely entry points`,
    ...topByDegree(entryish, 8).map(describeNode),
    `\n### Most connected symbols ("god nodes")`,
    ...topByDegree(codeNodes(graph), 8).map(describeNode),
  ].join('\n');
}

module.exports = { buildQuestionContext, buildTourContext };
