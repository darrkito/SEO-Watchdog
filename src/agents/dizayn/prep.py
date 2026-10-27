#!/usr/bin/env python3
"""Rebuild dizaynseo.com after a post was added or changed in _src, and bring every generated file along, the way the partner's
tools/aeo/build.py would (that generator is not on this machine).

  prep.py <worktree>        run inside the agents' worktree after the writer edited _src/posts*.py
  prep.py --selftest <repo> replay: drop a published post from a scratch copy, regenerate it, compare with what is committed

Pages that already exist keep their committed bytes (a 3-way merge of old build -> new build, so hand fixes survive); a new page is the
build plus the generator's layer. Markdown twins, sitemap.xml, llms.txt, llms-full.txt, api/_index.js, agent-tools.js and vercel.json
are updated for every new route. Stdlib only.
"""
import glob
import html as htmllib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import aeo_lite as A  # noqa: E402
import md_lite as M  # noqa: E402

SITE = A.SITE
SKIP_PAGES = {"404.html"}


def run(cwd, *cmd, check=True):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if check and r.returncode:
        raise SystemExit("%s failed in %s:\n%s%s" % (" ".join(cmd[:3]), cwd, r.stdout[-600:], r.stderr[-600:]))
    return r.stdout


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def write(p, s):
    os.makedirs(os.path.dirname(p) or ".", exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(s)


def html_files(root):
    out = []
    for f in glob.glob(os.path.join(root, "*.html")) + glob.glob(os.path.join(root, "*", "*.html")):
        rel = os.path.relpath(f, root)
        if rel.startswith(("_src", "node_modules")) or rel in SKIP_PAGES or "google" in rel.lower() and not rel.startswith(("blog", "work", "services")):
            continue
        out.append(rel)
    return sorted(out)


def mx_today():
    return (datetime.now(timezone.utc) - timedelta(hours=6)).strftime("%Y-%m-%d")


# ---------------------------------------------------------------- builds
def build_copy(src_dir):
    tmp = tempfile.mkdtemp(prefix="dz-")
    shutil.copytree(src_dir, tmp, dirs_exist_ok=True, ignore=shutil.ignore_patterns(".git", "node_modules", ".next"))
    run(tmp, sys.executable, "_src/build.py")
    return tmp


def head_copy(wt):
    tmp = tempfile.mkdtemp(prefix="dz-head-")
    archive = subprocess.run(["git", "archive", "HEAD"], cwd=wt, capture_output=True, check=True).stdout
    subprocess.run(["tar", "-x", "-C", tmp], input=archive, check=True)
    run(tmp, sys.executable, "_src/build.py")
    return tmp


# ---------------------------------------------------------------- 3-way merge of one HTML page (tokenised: one tag per line)
def tok(s):
    return s.replace("\n", "\x01").replace(">", ">\n")


def untok(s):
    return s.replace("\n", "").replace("\x01", "\n")


def merge_page(committed, old_built, new_built, rel):
    with tempfile.TemporaryDirectory() as d:
        for n, t in (("c", committed), ("o", old_built), ("n", new_built)):
            write(os.path.join(d, n), tok(t))
        r = subprocess.run(["git", "merge-file", "-p", os.path.join(d, "c"), os.path.join(d, "o"), os.path.join(d, "n")], capture_output=True, text=True)
    if r.returncode:
        raise SystemExit("page %s: the committed HTML was edited by hand where this change also edits it (merge conflict)" % rel)
    return untok(r.stdout)


# ---------------------------------------------------------------- per-file helpers
def meta_of(page_html):
    t = re.search(r"<title>(.*?)</title>", page_html, re.S).group(1)
    d = re.search(r'<meta name="description" content="(.*?)"', page_html, re.S).group(1)
    return htmllib.unescape(t).strip(), htmllib.unescape(d).strip()


def q(s):
    return json.dumps(s, ensure_ascii=False)


def md_twin(root, route, page_html):
    title, desc = meta_of(page_html)
    sib = read(os.path.join(root, "md/blog/geo-vs-seo.md")).split("\n---\n", 1)[0].split("\n")
    static = [l for l in sib if l.split(":", 1)[0] in ("language", "site", "publisher", "contact_email", "license")]
    url = SITE + route
    fm = "\n".join(["---", "url: " + q(url), "title: " + q(title), "description: " + q(desc)] + static + ["html_version: " + q(url), "---"]) + "\n"
    return fm + M.page_md(page_html), title, desc


def md_body(twin):
    return twin.split("\n---\n", 1)[1]


def updated_of(page_html):
    m = re.findall(r'<time datetime="(\d{4}-\d{2}-\d{2})">', page_html)
    return max(m) if m else None


def sitemap_add(root, route, lastmod):
    p = os.path.join(root, "sitemap.xml"); s = read(p)
    if "<loc>%s%s</loc>" % (SITE, route) in s:
        return
    entry = "<url><loc>%s%s</loc><lastmod>%s</lastmod>\n    <image:image><image:loc>%s/media/og.jpg</image:loc></image:image>\n  </url>" % (SITE, route, lastmod, SITE)
    blogs = [m for m in re.finditer(r"<url><loc>%s/blog/[^<]+</loc>.*?</url>" % re.escape(SITE), s, re.S)]
    at = blogs[-1].end()
    write(p, s[:at] + "\n  " + entry + s[at:])


def llms_txt_add(root, route, title, desc):
    p = os.path.join(root, "llms.txt"); s = read(p)
    url = SITE + route
    if "(%s)" % url in s:
        return
    line = "- [%s](%s): %s — markdown: `%s/%s`" % (title, url, desc, SITE, A.md_file_of(route))
    lines = s.split("\n")
    blog = [(i, re.search(r"\]\((%s/blog/[^)]+)\)" % re.escape(SITE), l).group(1)) for i, l in enumerate(lines) if "](%s/blog/" % SITE in l]
    after = next((i for i, u in blog if u > url), None)  # the list is alphabetical by URL
    lines.insert(after if after is not None else blog[-1][0] + 1, line)
    write(p, "\n".join(lines))


def llms_full_put(root, route, body):
    p = os.path.join(root, "llms-full.txt"); s = read(p)
    url = SITE + route
    marker = "\n---\n\nSource: "
    parts = s.split(marker)
    head, secs = parts[0], parts[1:]
    new = "%s\n\n%s" % (url, body)
    out, done = [], False
    for sec in secs:
        u = sec.split("\n", 1)[0]
        if u == url:
            out.append(new if sec.endswith("\n") else new.rstrip("\n")); done = True
        else:
            out.append(sec)
    if not done:
        out.append(new)
        out.sort(key=lambda x: x.split("\n", 1)[0])
    write(p, head + "".join(marker + x for x in out))


def flat(body):
    return re.sub(r"\s+", " ", body.strip()) + " "


def index_put(root, route, title, desc, body):
    p = os.path.join(root, "api/_index.js"); s = read(p)
    pre, arr = s.split("module.exports = ", 1)
    d = json.loads(arr.rstrip().rstrip(";"))
    f = flat(body)
    e = {"route": route, "url": SITE + route, "markdown": "%s/%s" % (SITE, A.md_file_of(route)), "title": title, "description": desc,
         "language": "en-US", "tokens": round(len(f) / 3.85), "body": f[:4000]}
    d = [x for x in d if x["route"] != route] + [e]
    d.sort(key=lambda x: x["route"])
    write(p, pre + "module.exports = " + json.dumps(d, ensure_ascii=False) + ";\n")


def agent_tools_add(root, route):
    p = os.path.join(root, "agent-tools.js"); s = read(p)
    m = re.search(r'\[("/[^\]]*"/blog/[^\]]*)\]', s) or re.search(r'\[("/about"[^\]]*)\]', s)
    if not m:
        raise SystemExit("agent-tools.js: route list not found")
    items = re.findall(r'"([^"]+)"', m.group(1))
    if route in items:
        return
    items = sorted(items + [route])
    write(p, s[:m.start()] + "[" + ", ".join('"%s"' % i for i in items) + "]" + s[m.end():])


def vercel_add(root, route):
    p = os.path.join(root, "vercel.json"); v = json.loads(read(p))
    md = "/" + A.md_file_of(route)
    sib = "/blog/geo-vs-seo"

    def clone(sec, pred, make):
        if any(x.get("source") == route and pred(x) for x in v[sec]):
            return
        idx = max(i for i, x in enumerate(v[sec]) if x.get("source", "").startswith("/blog/") and pred(x))
        ref = next(x for x in v[sec] if x.get("source") == sib and pred(x))
        v[sec].insert(idx + 1, make(json.loads(json.dumps(ref))))

    def md_rw(x):
        x["source"] = route; x["destination"] = md; return x

    def html_rw(x):
        x["source"] = route; x["destination"] = route + ".html"; return x

    def hdr(x):
        x["source"] = route
        for h in x["headers"]:
            h["value"] = h["value"].replace("/md/blog/geo-vs-seo.md", md)
        return x
    clone("rewrites", lambda x: "has" in x, md_rw)
    clone("rewrites", lambda x: "has" not in x, html_rw)
    clone("headers", lambda x: True, hdr)
    write(p, json.dumps(v, indent=2, ensure_ascii=False) + "\n")


# ---------------------------------------------------------------- main
def restore_generated(wt):
    tracked = [f for f in run(wt, "git", "ls-files").split("\n") if f and not f.startswith("_src/")]
    for i in range(0, len(tracked), 200):
        run(wt, "git", "checkout", "HEAD", "--", *tracked[i:i + 200])
    run(wt, "git", "clean", "-fdq", "--", ".", ":(exclude)_src", ":(exclude)node_modules")


def prep(wt):
    restore_generated(wt)
    old, new = head_copy(wt), build_copy(wt)
    try:
        A.load_conversion(read(os.path.join(wt, "blog/geo-vs-seo.html")))
        changed, added = [], []
        for rel in html_files(new):
            route = A.route_of(rel)
            nb = read(os.path.join(new, rel))
            if not os.path.exists(os.path.join(old, rel)):
                write(os.path.join(wt, rel), A.apply_html(nb, route)); added.append(route); continue
            ob = read(os.path.join(old, rel))
            if ob != nb:
                write(os.path.join(wt, rel), merge_page(read(os.path.join(wt, rel)), ob, nb, rel)); changed.append(route)
        today = mx_today()
        for route in added + changed:
            if not route.startswith("/blog"):
                continue
            rel = route.strip("/") + ".html"
            page = read(os.path.join(wt, rel))
            twin, title, desc = md_twin(wt, route, page)
            write(os.path.join(wt, A.md_file_of(route)), twin)
            llms_full_put(wt, route, md_body(twin))
            index_put(wt, route, title, desc, md_body(twin))
            if route in added:
                sitemap_add(wt, route, updated_of(page) or today); llms_txt_add(wt, route, title, desc); agent_tools_add(wt, route); vercel_add(wt, route)
        for f in ("vercel.json", "api/_index.js", "agent/kb.json"):
            if os.path.exists(os.path.join(wt, f)) and f.endswith(".json"):
                json.loads(read(os.path.join(wt, f)))
        print(json.dumps({"added": added, "changed": changed}))
    finally:
        shutil.rmtree(old, ignore_errors=True); shutil.rmtree(new, ignore_errors=True)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    prep(sys.argv[1])
