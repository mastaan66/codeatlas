"""Tests for scripts/analyze_graph.py — run via `python3 -m unittest discover -s tests`."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
ANALYZER = os.path.join(REPO, "scripts", "analyze_graph.py")
MEMOLITE_FIXTURE = os.path.join(HERE, "fixtures", "memolite-graph.json")


def run_analyzer(path):
    """Run the analyzer hermetically, as documented: python3 -I analyze_graph.py <graph.json>."""
    return subprocess.run(
        [sys.executable, "-I", ANALYZER, path],
        capture_output=True, text=True,
    )


def node(nid, label, community, source_file, callable_=False, line=1):
    return {
        "id": nid,
        "label": label,
        "community": community,
        "source_file": source_file,
        "source_location": f"{source_file}:{line}",
        "_callable": callable_,
    }


# 10 nodes, 2 communities. Degrees (from LINKS below):
#   A=5  F=4  J=3  B=D=E=G=2  C=H=1  I=0
SYNTHETIC = {
    "directed": True,
    "multigraph": False,
    "graph": {},
    "nodes": [
        node("A", "CoreHub", 0, "core/hub.py"),
        node("B", "helper_b()", 0, "core/util.py"),
        node("C", "leaf_c()", 0, "core/leaf.py", callable_=True),
        node("D", "leaf_d()", 0, "core/leaf.py", callable_=True, line=20),
        node("E", "glue_e", 0, "core/glue.py"),
        node("F", "ApiHub", 1, "api/hub.py"),
        node("G", "handler_g()", 1, "api/handlers.py"),
        node("H", "leaf_h()", 1, "api/leaf.py", callable_=True),
        node("I", "orphan_i", 1, "api/orphan.py"),
        node("J", "busy_j()", 1, "api/busy.py", callable_=True),
    ],
    "links": [
        {"source": "A", "target": "B"},
        {"source": "A", "target": "C"},
        {"source": "A", "target": "D"},
        {"source": "A", "target": "E"},
        {"source": "A", "target": "F"},  # inter-community 0 -> 1
        {"source": "B", "target": "D"},
        {"source": "F", "target": "G"},
        {"source": "F", "target": "H"},
        {"source": "F", "target": "J"},
        {"source": "G", "target": "J"},
        {"source": "E", "target": "J"},  # inter-community 0 -> 1
    ],
}


class TestSyntheticGraph(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fd, cls.path = tempfile.mkstemp(suffix=".json")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(SYNTHETIC, f)
        proc = run_analyzer(cls.path)
        if proc.returncode != 0:
            raise AssertionError(f"analyzer failed: {proc.stderr}")
        cls.out = json.loads(proc.stdout)  # must be valid JSON on stdout

    @classmethod
    def tearDownClass(cls):
        os.unlink(cls.path)

    def test_summary_counts(self):
        s = self.out["summary"]
        self.assertEqual(s["nodes"], 10)
        self.assertEqual(s["edges"], 11)
        self.assertEqual(s["communities"], 2)

    def test_god_nodes_ordered_by_degree(self):
        god = self.out["god_nodes"]
        degrees = [g["degree"] for g in god]
        self.assertEqual(degrees, sorted(degrees, reverse=True))
        self.assertEqual(god[0]["label"], "CoreHub")
        self.assertEqual(god[0]["degree"], 5)
        self.assertEqual(god[1]["label"], "ApiHub")
        self.assertEqual(god[1]["degree"], 4)

    def test_communities_include_both(self):
        comms = self.out["communities"]
        self.assertEqual({c["id"] for c in comms}, {0, 1})
        for c in comms:
            self.assertEqual(c["size"], 5)

    def test_good_first_spots_are_low_degree_callable_leaves(self):
        spots = self.out["good_first_spots"]
        self.assertEqual(
            sorted(s["label"] for s in spots),
            ["leaf_c()", "leaf_d()", "leaf_h()"],
        )
        for s in spots:
            self.assertGreaterEqual(s["degree"], 1)
            self.assertLessEqual(s["degree"], 2)
        # busy_j() is callable but degree 3; orphan_i is degree 0; neither qualifies.
        labels = {s["label"] for s in spots}
        self.assertNotIn("busy_j()", labels)
        self.assertNotIn("orphan_i", labels)

    def test_inter_community_edges(self):
        inter = self.out["inter_community_edges"]
        self.assertEqual(inter, [{"from": 0, "to": 1, "count": 2}])


class TestMemoliteGraph(unittest.TestCase):
    """The analyzer against the real memolite graph fixture."""

    @classmethod
    def setUpClass(cls):
        proc = run_analyzer(MEMOLITE_FIXTURE)
        if proc.returncode != 0:
            raise AssertionError(f"analyzer failed: {proc.stderr}")
        cls.out = json.loads(proc.stdout)

    def test_summary(self):
        self.assertEqual(self.out["summary"]["nodes"], 451)
        self.assertEqual(self.out["summary"]["communities"], 18)

    def test_memorystore_is_a_god_node(self):
        labels = [g["label"] for g in self.out["god_nodes"]]
        self.assertIn("MemoryStore", labels)


class TestMalformedInput(unittest.TestCase):
    def test_missing_file_exits_nonzero(self):
        proc = run_analyzer(os.path.join(HERE, "does-not-exist.json"))
        self.assertNotEqual(proc.returncode, 0)

    def test_invalid_json_exits_nonzero(self):
        fd, path = tempfile.mkstemp(suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write("{not json at all")
            proc = run_analyzer(path)
            self.assertNotEqual(proc.returncode, 0)
        finally:
            os.unlink(path)


if __name__ == "__main__":
    unittest.main()
