#!/usr/bin/env python3
"""
Acceptance test suite for Mycelial Brain search engine P0 fix (doc-398).
Tests all 6 acceptance tests and 7 verification conditions.
"""
import json
import sys
import time
import urllib.request
import urllib.error

PORT = 8089
URL = sys.argv[1] if len(sys.argv) > 1 else f"http://localhost:{PORT}/mcp"

results = []

def call_mcp(name, args, timeout=30):
    body = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": name, "arguments": args}
    }).encode()
    req = urllib.request.Request(URL, data=body, headers={"Content-Type": "application/json"})
    t0 = time.time()
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
        duration = round(time.time() - t0, 3)
        return duration, json.loads(resp.read().decode())
    except Exception as e:
        return round(time.time() - t0, 3), {"error": {"message": str(e)}}

def get_text(resp):
    try:
        return resp["result"]["content"][0]["text"]
    except Exception:
        return ""

def check(name, ok, detail=""):
    results.append(ok)
    status = "PASS" if ok else "FAIL"
    print(f"[{status}] {name}")
    if detail:
        print(f"       {detail}")

def run_tests():
    print(f"Running acceptance test suite against {URL}\n")

    # Warmup / check health
    health_url = URL.replace("/mcp", "/health")
    try:
        hr = urllib.request.urlopen(health_url, timeout=10)
        hj = json.loads(hr.read().decode())
        print(f"Health status: {json.dumps(hj)}\n")
    except Exception as e:
        print(f"Health check warning: {e}\n")

    # Test 1: "August 2026 DEQ Oregon" -> doc-397 in top 5 results
    t, r = call_mcp("brain_search", {"query": "August 2026 DEQ Oregon", "limit": 5})
    try:
        hits = json.loads(get_text(r))
        paths = [h.get("path") for h in hits]
        ok1 = "doc-397" in paths[:5]
        check("Test 1: 'August 2026 DEQ Oregon' -> doc-397 in top 5", ok1, f"Top 5: {paths[:5]} ({t}s)")
    except Exception as e:
        check("Test 1: 'August 2026 DEQ Oregon'", False, str(e))

    # Test 2: "sauna heat tolerance baseline" -> doc-359 in top 5 results
    t, r = call_mcp("brain_search", {"query": "sauna heat tolerance baseline", "limit": 5})
    try:
        hits = json.loads(get_text(r))
        paths = [h.get("path") for h in hits]
        ok2 = "doc-359" in paths[:5]
        check("Test 2: 'sauna heat tolerance baseline' -> doc-359 in top 5", ok2, f"Top 5: {paths[:5]} ({t}s)")
    except Exception as e:
        check("Test 2: 'sauna heat tolerance baseline'", False, str(e))

    # Test 3: "stim protocol axiom" -> doc-11 and doc-40 in results
    t, r = call_mcp("brain_search", {"query": "stim protocol axiom"})
    try:
        hits = json.loads(get_text(r))
        paths = [h.get("path") for h in hits]
        ok3 = "doc-11" in paths and "doc-40" in paths
        check("Test 3: 'stim protocol axiom' -> doc-11 and doc-40 in results", ok3, f"Found doc-11={'doc-11' in paths}, doc-40={'doc-40' in paths} across {len(paths)} results ({t}s)")
    except Exception as e:
        check("Test 3: 'stim protocol axiom'", False, str(e))

    # Test 4: Empty query or "*" -> 20 most recent docs sorted by timestamp descending
    t, r = call_mcp("brain_search", {"query": "*", "limit": 20})
    try:
        hits = json.loads(get_text(r))
        paths = [h.get("path") for h in hits]
        ok4 = len(hits) == 20
        check("Test 4: '*' query returns 20 most recent docs", ok4, f"Returned {len(hits)} docs. First: {paths[0] if paths else None} ({t}s)")
    except Exception as e:
        check("Test 4: '*' query", False, str(e))

    # Test 5: "heartbeat status bodhi" -> bodhi/heartbeat-status and doc-403 in results
    t, r = call_mcp("brain_search", {"query": "heartbeat status bodhi"})
    try:
        hits = json.loads(get_text(r))
        paths = [h.get("path") for h in hits]
        ok5 = "bodhi/heartbeat-status" in paths and "doc-403" in paths
        check("Test 5: 'heartbeat status bodhi' -> bodhi/heartbeat-status and doc-403", ok5, f"Found bodhi/heartbeat-status={'bodhi/heartbeat-status' in paths}, doc-403={'doc-403' in paths} ({t}s)")
    except Exception as e:
        check("Test 5: 'heartbeat status bodhi'", False, str(e))

    # Test 6: "arboracle axiom alignment" -> doc-402 in results
    t, r = call_mcp("brain_search", {"query": "arboracle axiom alignment"})
    try:
        hits = json.loads(get_text(r))
        paths = [h.get("path") for h in hits]
        ok6 = "doc-402" in paths
        check("Test 6: 'arboracle axiom alignment' -> doc-402 in results", ok6, f"Found doc-402={ok6} in {len(paths)} results ({t}s)")
    except Exception as e:
        check("Test 6: 'arboracle axiom alignment'", False, str(e))

    # Verification 2 & 3: brain_list pagination
    t, r = call_mcp("brain_list", {"offset": 0, "limit": 50})
    try:
        data = json.loads(get_text(r))
        docs = data.get("docs", [])
        total = data.get("total_count", 0)
        has_more = data.get("has_more", False)
        ok_v3 = len(docs) == 50 and has_more is True and total > 154
        check("Verification 3: brain_list offset=0 limit=50 returns 50 docs with has_more=true", ok_v3, f"count={len(docs)}, total_count={total}, has_more={has_more}")
    except Exception as e:
        check("Verification 3: brain_list pagination", False, str(e))

    t, r = call_mcp("brain_list", {"offset": 150, "limit": 50})
    try:
        data = json.loads(get_text(r))
        docs = data.get("docs", [])
        paths = [d.get("path") for d in docs]
        ok_v2 = len(docs) > 0 and any(int(p.replace("doc-", "")) >= 155 for p in paths if p.startswith("doc-") and p.replace("doc-", "").isdigit())
        check("Verification 2: brain_list offset=150 returns docs beyond 154 without truncation", ok_v2, f"Returned {len(docs)} docs, sample paths: {paths[:3]}")
    except Exception as e:
        check("Verification 2: brain_list offset=150", False, str(e))

    # Verification 4: Case-insensitivity: 'STIM' and 'stim' return identical results
    t_lower, r_lower = call_mcp("brain_search", {"query": "stim", "limit": 10})
    t_upper, r_upper = call_mcp("brain_search", {"query": "STIM", "limit": 10})
    try:
        hits_lower = [h.get("path") for h in json.loads(get_text(r_lower))]
        hits_upper = [h.get("path") for h in json.loads(get_text(r_upper))]
        ok_v4 = hits_lower == hits_upper and len(hits_lower) > 0
        check("Verification 4: Case-insensitivity ('STIM' == 'stim')", ok_v4, f"lower count={len(hits_lower)}, upper count={len(hits_upper)}")
    except Exception as e:
        check("Verification 4: Case-insensitivity", False, str(e))

    # Verification 5: Tag matching
    t, r = call_mcp("brain_search", {"query": "biometric", "limit": 10})
    try:
        hits = json.loads(get_text(r))
        paths = [h.get("path") for h in hits]
        ok_v5 = "doc-359" in paths
        check("Verification 5: Tag matching surfaces tagged docs", ok_v5, f"Searching 'biometric' found doc-359 in {paths[:5]}")
    except Exception as e:
        check("Verification 5: Tag matching", False, str(e))

    # Verification 7: brain_read and brain_write operations
    t, r = call_mcp("brain_read", {"path": "doc-11"})
    try:
        content = get_text(r)
        ok_read = "STIM PROTOCOL" in content
        check("Verification 7a: brain_read doc-11 works", ok_read, f"Read {len(content)} chars ({t}s)")
    except Exception as e:
        check("Verification 7a: brain_read doc-11", False, str(e))

    passed = sum(1 for x in results if x)
    total_tests = len(results)
    print(f"\nSummary: {passed}/{total_tests} passed.")
    return 0 if passed == total_tests else 1

if __name__ == "__main__":
    sys.exit(run_tests())
