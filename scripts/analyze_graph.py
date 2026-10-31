#!/usr/bin/env python3
"""analyze_graph.py — distill a Graphify knowledge graph into onboarding facts.

Reads a graphify-out/graph.json (networkx node-link JSON) and prints a single
structured JSON document to stdout. That JSON is the *ground truth* the
repo-tour skill uses to write ONBOARDING.md, ARCHITECTURE.md and
GOOD-FIRST-SPOTS.md. Stdlib only; run hermetically:

    python3 -I scripts/analyze_graph.py path/to/graphify-out/graph.json
"""
import json
import os
import re
import sys
from collections import Counter, defaultdict

GOD_TOP = 10
TOP_MEMBERS = 8
LEAF_MAX_DEGREE = 2
MAX_SPOTS = 25
ENTRY_FILE_RE = re.compile(r"(^|/)(main|cli|app|index|server|run|__main__)\.[a-z]+$", re.I)


def load_graph(path):
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    for key in ("nodes", "links"):
        if key not in data:
            sys.exit(f"error: {path} has no '{key}' key — not a node-link graph.json")
    return data


def community_name(members):
    """Name a community after the directory most of its members live in."""
    dirs = Counter()
    for n in members:
        sf = n.get("source_file")
        if sf:
            dirs[os.path.dirname(sf) or "."] += 1
    if not dirs:
        return "misc"
    return dirs.most_common(1)[0][0]


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: python3 -I analyze_graph.py path/to/graph.json")
    data = load_graph(sys.argv[1])
    nodes = {n["id"]: n for n in data["nodes"]}
    links = data["links"]

    degree = Counter()
    for l in links:
        degree[l["source"]] += 1
        degree[l["target"]] += 1

    # --- communities ---------------------------------------------------
    comms = defaultdict(list)
    for n in data["nodes"]:
        comms[n.get("community", -1)].append(n)

    communities = []
    for cid, members in sorted(comms.items(), key=lambda kv: -len(kv[1])):
        top = sorted(members, key=lambda n: -degree[n["id"]])[:TOP_MEMBERS]
        files = Counter(n.get("source_file") for n in members if n.get("source_file"))
        communities.append({
            "id": cid,
            "name": community_name(members),
            "size": len(members),
            "top_members": [{
                "label": n.get("label", n["id"]),
                "file": n.get("source_file"),
                "location": n.get("source_location"),
                "degree": degree[n["id"]],
                "callable": bool(n.get("_callable")),
            } for n in top],
            "top_files": [f for f, _ in files.most_common(5)],
        })

    # --- god nodes ------------------------------------------------------
    god = []
    for nid, deg in degree.most_common():
        n = nodes.get(nid)
        if n is None:
            continue
        god.append({
            "label": n.get("label", nid),
            "file": n.get("source_file"),
            "location": n.get("source_location"),
            "degree": deg,
            "community": n.get("community"),
        })
        if len(god) >= GOD_TOP:
            break

    # --- inter-community edges (for the mermaid diagram) ----------------
    inter = Counter()
    for l in links:
        s, t = nodes.get(l["source"]), nodes.get(l["target"])
        if s is None or t is None:
            continue
        cs, ct = s.get("community", -1), t.get("community", -1)
        if cs != ct:
            inter[(cs, ct)] += 1
    inter_edges = [{"from": a, "to": b, "count": c}
                   for (a, b), c in inter.most_common(30)]

    # --- good first spots: low-degree callable leaves --------------------
    spots = []
    for n in data["nodes"]:
        if not n.get("_callable"):
            continue
        if n.get("file_type") not in (None, "code"):
            continue
        d = degree[n["id"]]
        if 1 <= d <= LEAF_MAX_DEGREE and n.get("source_file"):
            spots.append({
                "label": n.get("label", n["id"]),
                "file": n["source_file"],
                "location": n.get("source_location"),
                "degree": d,
                "community": n.get("community"),
            })
    spots.sort(key=lambda s: (s["degree"], s["file"], s["label"]))
    spots = spots[:MAX_SPOTS]

    # --- entry-point candidates ------------------------------------------
    entries = []
    for n in data["nodes"]:
        sf = n.get("source_file") or ""
        if ENTRY_FILE_RE.search(sf) and n.get("_callable"):
            entries.append({
                "label": n.get("label", n["id"]),
                "file": sf,
                "location": n.get("source_location"),
                "degree": degree[n["id"]],
                "community": n.get("community"),
            })
    entries.sort(key=lambda e: -e["degree"])
    entries = entries[:10]

    out = {
        "summary": {
            "nodes": len(data["nodes"]),
            "edges": len(links),
            "communities": len(comms),
            "built_at_commit": data.get("built_at_commit"),
        },
        "entry_points": entries,
        "god_nodes": god,
        "communities": communities,
        "inter_community_edges": inter_edges,
        "good_first_spots": spots,
    }
    json.dump(out, sys.stdout, indent=2)
    print()


if __name__ == "__main__":
    main()
