#!/usr/bin/env python3
"""Publish the private working tree to asjames18/fuelmore-radar main.

Git HTTPS pushes reject the stored token in this environment, so releases go
through the GitHub REST API: blobs -> tree -> commit -> move refs/heads/main.

Usage:
    release-private.py [--dry-run] "<commit-message>"

Only files that differ from the current main tree are committed, on top of
the current main tree (base_tree), so nothing already on main is lost.
Local .gitignore patterns are respected, plus release/ and *-qa.png which
are local-only artifacts.

After a successful run the scheduled publisher (refresh-activity.yml) picks
up the new main on its next run; trigger it manually with workflow_dispatch
if the change is needed sooner.
"""
import base64
import fnmatch
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.expanduser("~/workspace/skills/github/bin"))
from cred import add_surrogate_to_request, DynamicCredentialError  # noqa: E402

API = "https://api.github.com"
REPO = "asjames18/fuelmore-radar"
CREDENTIAL = "custom.github"
PRIVATE_DIR = os.path.expanduser("~/workspace/fuelmore-radar-private")

# Extra local-only artifacts beyond .gitignore.
EXTRA_EXCLUDES = {"release", "dist-public", "public-export", "__pycache__"}
EXTRA_FILE_PATTERNS = ("*-qa.png",)


def load_gitignore(root):
    patterns = []
    path = os.path.join(root, ".gitignore")
    if not os.path.exists(path):
        return patterns
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            patterns.append(line)
    return patterns


def ignored(rel, patterns):
    # Directory patterns like "node_modules" or ".radar-data/" match the top segment.
    top = rel.split(os.sep)[0]
    if top in EXTRA_EXCLUDES:
        return True
    for pat in EXTRA_FILE_PATTERNS:
        if fnmatch.fnmatch(os.path.basename(rel), pat):
            return True
    for pat in patterns:
        clean = pat.lstrip("/").rstrip("/")
        if "/" not in clean:
            if fnmatch.fnmatch(top, clean) or fnmatch.fnmatch(os.path.basename(rel), clean):
                return True
        elif rel == clean or rel.startswith(clean + os.sep):
            return True
    return False


def local_files(root, patterns):
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = os.path.relpath(dirpath, root)
        # Prune ignored directories early.
        dirnames[:] = [d for d in dirnames
                       if not d.startswith(".")
                       and not ignored(os.path.join(rel_dir, d) if rel_dir != "." else d, patterns)]
        for name in filenames:
            if name.startswith("._"):
                continue
            rel = os.path.join(rel_dir, name) if rel_dir != "." else name
            if not ignored(rel, patterns):
                out.append(rel)
    return sorted(out)


def blob_sha(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


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


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    dry_run = "--dry-run" in sys.argv
    if len(args) != 1:
        print(__doc__)
        return 2
    message = args[0]

    patterns = load_gitignore(PRIVATE_DIR)
    files = local_files(PRIVATE_DIR, patterns)
    print(f"Local files considered: {len(files)}")

    ref = api("GET", f"/repos/{REPO}/git/refs/heads/main")
    base_commit = ref["object"]["sha"]
    commit_obj = api("GET", f"/repos/{REPO}/git/commits/{base_commit}")
    base_tree = commit_obj["tree"]["sha"]
    print(f"Base: {base_commit[:12]} ({commit_obj['message'].splitlines()[0][:80]})")
    tree = api("GET", f"/repos/{REPO}/git/trees/{base_tree}?recursive=1")
    remote_blobs = {e["path"]: e["sha"] for e in tree.get("tree", []) if e["type"] == "blob"}

    changed = []
    for rel in files:
        with open(os.path.join(PRIVATE_DIR, rel), "rb") as f:
            data = f.read()
        if remote_blobs.get(rel) != blob_sha(data):
            changed.append(rel)
    print(f"Changed/new files vs main: {len(changed)}")
    for rel in changed:
        print(f"  {rel}")
    if not changed:
        print("No changes vs private main; nothing to release.")
        return 0
    if dry_run:
        print("Dry run: no commit created.")
        return 0

    blobs = {}
    for i, rel in enumerate(changed, 1):
        with open(os.path.join(PRIVATE_DIR, rel), "rb") as f:
            content = base64.b64encode(f.read()).decode()
        print(f"  uploading blob {i}/{len(changed)}: {rel}", flush=True)
        blob = api("POST", f"/repos/{REPO}/git/blobs",
                   {"content": content, "encoding": "base64"})
        blobs[rel] = blob["sha"]
    print(f"Created {len(blobs)} blobs.", flush=True)

    new_tree = api("POST", f"/repos/{REPO}/git/trees", {
        "base_tree": base_tree,
        "tree": [{"path": rel, "mode": "100644", "type": "blob", "sha": blobs[rel]}
                 for rel in changed],
    })
    print(f"Tree: {new_tree['sha']}")

    new_commit = api("POST", f"/repos/{REPO}/git/commits", {
        "message": message,
        "tree": new_tree["sha"],
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
