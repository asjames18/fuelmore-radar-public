#!/usr/bin/env python3
"""Publish a public-export candidate to asjames18/fuelmore-radar-public.

Git HTTPS pushes reject the stored token in this environment, so releases go
through the GitHub REST API: blobs -> tree -> commit -> move refs/heads/main.

Usage:
    release-public.py <candidate-dir> <commit-message>

Only files that differ from the local public checkout (~/workspace/fuelmore-radar,
expected to be at origin/main) are committed, on top of the current main tree.
After a successful run:
    cd ~/workspace/fuelmore-radar && git fetch origin && git reset --hard origin/main
"""
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.expanduser("~/workspace/skills/github/bin"))
from cred import add_surrogate_to_request, DynamicCredentialError  # noqa: E402

API = "https://api.github.com"
REPO = "asjames18/fuelmore-radar-public"
CREDENTIAL = "custom.github"
PUBLIC_DIR = os.path.expanduser("~/workspace/fuelmore-radar")
# Local-only artifacts that live in the checkout but never in a candidate.
SKIP_NAMES = {".git", "node_modules", "dist-public", ".wrangler", ".radar-data"}


def api(method, path, payload=None, retries=3):
    body = json.dumps(payload).encode() if payload is not None else None
    last = None
    for attempt in range(1, retries + 1):
        req = urllib.request.Request(API + path, data=body, method=method,
                                     headers={"Accept": "application/vnd.github+json"})
        if body:
            req.add_header("Content-Type", "application/json")
        add_surrogate_to_request(req, CREDENTIAL, allowed_hosts=("api.github.com",))
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                raw = resp.read()
            return json.loads(raw) if raw else None
        except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
            last = e
            print(f"  api {method} {path} attempt {attempt}/{retries} failed: {e}; retrying...",
                  flush=True)
            time.sleep(2 * attempt)
    raise last


def candidate_files(candidate):
    out = []
    for root, dirs, files in os.walk(candidate):
        dirs[:] = [d for d in dirs if d not in SKIP_NAMES and not d.startswith(".")]
        for name in files:
            if name.startswith("._"):
                continue
            full = os.path.join(root, name)
            rel = os.path.relpath(full, candidate)
            out.append(rel)
    return sorted(out)


def changed_files(candidate):
    changed = []
    for rel in candidate_files(candidate):
        cand_path = os.path.join(candidate, rel)
        pub_path = os.path.join(PUBLIC_DIR, rel)
        if not os.path.exists(pub_path):
            changed.append(rel)
            continue
        with open(cand_path, "rb") as f:
            cand_bytes = f.read()
        with open(pub_path, "rb") as f:
            pub_bytes = f.read()
        if cand_bytes != pub_bytes:
            changed.append(rel)
    return changed


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    candidate, message = sys.argv[1], sys.argv[2]
    files = changed_files(candidate)
    if not files:
        print("No changes vs local public checkout; nothing to release.")
        return 0
    print(f"Changed files ({len(files)}):")
    for rel in files:
        print(f"  {rel}")

    blobs = {}
    for i, rel in enumerate(files, 1):
        with open(os.path.join(candidate, rel), "rb") as f:
            content = base64.b64encode(f.read()).decode()
        print(f"  uploading blob {i}/{len(files)}: {rel}", flush=True)
        blob = api("POST", f"/repos/{REPO}/git/blobs",
                   {"content": content, "encoding": "base64"})
        blobs[rel] = blob["sha"]
    print(f"Created {len(blobs)} blobs.", flush=True)

    ref = api("GET", f"/repos/{REPO}/git/refs/heads/main")
    base_commit = ref["object"]["sha"]
    commit_obj = api("GET", f"/repos/{REPO}/git/commits/{base_commit}")
    base_tree = commit_obj["tree"]["sha"]

    tree = api("POST", f"/repos/{REPO}/git/trees", {
        "base_tree": base_tree,
        "tree": [{"path": rel, "mode": "100644", "type": "blob", "sha": blobs[rel]}
                 for rel in files],
    })
    print(f"Tree: {tree['sha']}")

    new_commit = api("POST", f"/repos/{REPO}/git/commits", {
        "message": message,
        "tree": tree["sha"],
        "parents": [base_commit],
    })
    print(f"Commit: {new_commit['sha']}")

    api("PATCH", f"/repos/{REPO}/git/refs/heads/main", {"sha": new_commit["sha"]})
    print(f"refs/heads/main -> {new_commit['sha']}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except DynamicCredentialError as e:
        print(f"Credential error: {e}", file=sys.stderr)
        sys.exit(3)
