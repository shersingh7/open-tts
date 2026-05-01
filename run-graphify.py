#!/usr/bin/env python3
"""Run graphify pipeline on a target directory. Standalone script."""
import json
import sys
import os
from pathlib import Path

# Add graphify's pipx venv to path if needed
PIP_PYTHON = "/Users/shersingh/.local/pipx/venvs/graphifyy/bin/python"
OUTPUT_DIR = None  # Will be set from args

def main():
    if len(sys.argv) < 2:
        print("Usage: run-graphify.py <target_dir> [--output-dir <dir>]")
        sys.exit(1)
    
    target = Path(sys.argv[1]).resolve()
    for i, arg in enumerate(sys.argv[2:], 2):
        if arg == "--output-dir" and i + 1 < len(sys.argv):
            global OUTPUT_DIR
            OUTPUT_DIR = Path(sys.argv[i + 1])
    
    if OUTPUT_DIR is None:
        OUTPUT_DIR = target / "graphify-out"
    
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    
    # Import graphify modules (runs in graphify's pipx python)
    from graphify.detect import detect
    from graphify.extract import collect_files, extract
    from graphify.build import build_from_json
    from graphify.cluster import cluster, score_all
    from graphify.analyze import god_nodes, surprising_connections, suggest_questions
    from graphify.report import generate
    from graphify.export import to_json, to_html
    
    # Step 1: Detect
    print(f"=== Detecting files in {target} ===")
    detection = detect(target)
    (OUTPUT_DIR / ".graphify_detect.json").write_text(json.dumps(detection, indent=2))
    
    total = detection.get("total_files", 0)
    words = detection.get("total_words", 0)
    print(f"Corpus: {total} files, ~{words:,} words")
    for ftype, files in detection.get("files", {}).items():
        print(f"  {ftype}: {len(files)} files")
    
    skipped = detection.get("skipped_sensitive", [])
    if skipped:
        print(f"  Skipped {len(skipped)} sensitive files")
    
    if total == 0:
        print("No supported files found. Exiting.")
        sys.exit(1)
    
    # Step 2: AST extraction (code files)
    print("\n=== AST Extraction (code files) ===")
    code_files = []
    for f in detection.get("files", {}).get("code", []):
        p = Path(f)
        code_files.extend(collect_files(p) if p.is_dir() else [p])
    
    if code_files:
        ast_result = extract(code_files)
        (OUTPUT_DIR / ".graphify_ast.json").write_text(json.dumps(ast_result, indent=2))
        print(f"AST: {len(ast_result['nodes'])} nodes, {len(ast_result['edges'])} edges")
    else:
        ast_result = {"nodes": [], "edges": [], "input_tokens": 0, "output_tokens": 0}
        (OUTPUT_DIR / ".graphify_ast.json").write_text(json.dumps(ast_result, indent=2))
        print("No code files - skipping AST extraction")
    
    # Step 3: Semantic extraction placeholder
    # For a code-heavy project, AST may be sufficient. 
    # Semantic extraction requires an LLM API and is the expensive step.
    # We'll create an empty semantic result and note this.
    doc_files = detection.get("files", {}).get("document", [])
    image_files = detection.get("files", {}).get("image", [])
    
    if doc_files or image_files:
        print(f"\n=== Semantic Extraction ({len(doc_files)} docs, {len(image_files)} images) ===")
        print("SKIPPED: Semantic extraction requires LLM API (Claude/GPT).")
        print("To run semantic extraction, use the /graphify skill in an AI coding assistant.")
        print("For now, building graph from AST extraction only.")
    
    semantic_result = {"nodes": [], "edges": [], "hyperedges": [], "input_tokens": 0, "output_tokens": 0}
    (OUTPUT_DIR / ".graphify_semantic.json").write_text(json.dumps(semantic_result, indent=2))
    
    # Step 4: Merge AST + semantic
    print("\n=== Merging extraction results ===")
    seen = {n["id"] for n in ast_result["nodes"]}
    merged_nodes = list(ast_result["nodes"])
    for n in semantic_result["nodes"]:
        if n["id"] not in seen:
            merged_nodes.append(n)
            seen.add(n["id"])
    
    merged_edges = ast_result["edges"] + semantic_result["edges"]
    merged = {
        "nodes": merged_nodes,
        "edges": merged_edges,
        "hyperedges": semantic_result.get("hyperedges", []),
        "input_tokens": semantic_result.get("input_tokens", 0),
        "output_tokens": semantic_result.get("output_tokens", 0),
    }
    (OUTPUT_DIR / ".graphify_extract.json").write_text(json.dumps(merged, indent=2))
    print(f"Merged: {len(merged_nodes)} nodes, {len(merged_edges)} edges")
    
    # Step 5: Build graph, cluster, analyze
    print("\n=== Building graph ===")
    G = build_from_json(merged)
    
    if G.number_of_nodes() == 0:
        print("ERROR: Graph is empty - extraction produced no nodes.")
        sys.exit(1)
    
    print(f"Graph: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges")
    
    print("Clustering with Leiden...")
    communities = cluster(G)
    cohesion = score_all(G, communities)
    print(f"Communities: {len(communities)}")
    
    print("Analyzing...")
    gods = god_nodes(G)
    surprises = surprising_connections(G, communities)
    labels = {cid: f"Community {cid}" for cid in communities}
    questions = suggest_questions(G, communities, labels)
    
    # Step 6: Generate report
    print("\n=== Generating report ===")
    tokens = {"input": merged.get("input_tokens", 0), "output": merged.get("output_tokens", 0)}
    report = generate(G, communities, cohesion, labels, gods, surprises, detection, tokens, str(target), suggested_questions=questions)
    (OUTPUT_DIR / "GRAPH_REPORT.md").write_text(report)
    print(f"Written: {OUTPUT_DIR / 'GRAPH_REPORT.md'}")
    
    # Step 7: Export JSON
    to_json(G, communities, str(OUTPUT_DIR / "graph.json"))
    print(f"Written: {OUTPUT_DIR / 'graph.json'}")
    
    # Step 8: Export HTML (if graph not too large)
    if G.number_of_nodes() <= 5000:
        to_html(G, communities, str(OUTPUT_DIR / "graph.html"), community_labels=labels)
        print(f"Written: {OUTPUT_DIR / 'graph.html'}")
    else:
        print(f"Graph too large ({G.number_of_nodes()} nodes) for HTML viz")
    
    # Save analysis for reference
    analysis = {
        "communities": {str(k): v for k, v in communities.items()},
        "cohesion": {str(k): v for k, v in cohesion.items()},
        "gods": gods,
        "surprises": surprises,
        "questions": questions,
    }
    (OUTPUT_DIR / ".graphify_analysis.json").write_text(json.dumps(analysis, indent=2))
    
    print(f"\n=== COMPLETE ===")
    print(f"Output directory: {OUTPUT_DIR}")
    print(f"Nodes: {G.number_of_nodes()}, Edges: {G.number_of_edges()}, Communities: {len(communities)}")
    print(f"God nodes: {len(gods)}")
    print(f"Surprising connections: {len(surprises)}")
    print(f"\nOpen {OUTPUT_DIR / 'graph.html'} in a browser to explore the graph interactively.")

if __name__ == "__main__":
    main()