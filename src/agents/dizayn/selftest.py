#!/usr/bin/env python3
"""Replay test for prep.py: remove a published post from a scratch copy of the site (source, page, twin and every registry),
add it back through prep.py and compare with what the real generator committed. Usage: selftest.py <repo> [slug]"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import aeo_lite as A  # noqa: E402
import prep as P  # noqa: E402

CARDS = re.compile(r"^\[.*\]\(https://www\.dizaynseo\.com/blog/[^)]*\)$", re.M)


def git(cwd, *a):
    return P.run(cwd, "git", "-c", "user.email=t@t", "-c", "user.name=t", *a)


def clone(repo):
    d = tempfile.mkdtemp(prefix="dz-self-")
    subprocess.run(["git", "clone", "-q", "--no-hardlinks", repo, d], check=True)
    return d


def drop_post_source(src, slug):
    lines = src.split("\n")
    i = next(k for k, l in enumerate(lines) if l.strip() == '"slug": "%s",' % slug)
    start = i - 1
    assert lines[start] == "{", lines[start]
    if lines[start - 1].startswith("# ="):
        start -= 1
    end = next(k for k in range(i, len(lines)) if lines[k] == "},")
    return "\n".join(lines[:start] + lines[end + 1:])


def main(repo, slug):
    route = "/blog/" + slug
    orig, scratch = clone(repo), clone(repo)
    orig_head = P.run(orig, "git", "rev-parse", "HEAD").strip()
    # ---- pre-state: the site as it was before the post existed
    sf = os.path.join(scratch, "_src/posts_funnel.py")
    full_src = P.read(sf)
    P.write(sf, drop_post_source(full_src, slug))
    A.load_conversion(P.read(os.path.join(scratch, "blog/geo-vs-seo.html")))
    pre = P.build_copy(scratch)
    for rel in P.html_files(pre):
        if rel == "blog/%s.html" % slug:
            continue
        p = os.path.join(scratch, rel)
        committed = P.read(p)
        # pages whose committed bytes are not "build + layer" were hand-edited: leave them alone
        if committed == A.apply_html(P.read(os.path.join(P.build_copy(orig) if False else pre, rel)), A.route_of(rel)) or rel in ("blog.html",) or rel.startswith("blog/"):
            P.write(p, A.apply_html(P.read(os.path.join(pre, rel)), A.route_of(rel)))
    for f in ("blog/%s.html" % slug, "md/blog/%s.md" % slug):
        os.remove(os.path.join(scratch, f))
    s = P.read(os.path.join(scratch, "sitemap.xml"))
    P.write(os.path.join(scratch, "sitemap.xml"), re.sub(r"\n  <url><loc>%s%s</loc>.*?</url>" % (re.escape(A.SITE), re.escape(route)), "", s, flags=re.S))
    t = P.read(os.path.join(scratch, "llms.txt"))
    P.write(os.path.join(scratch, "llms.txt"), "\n".join(l for l in t.split("\n") if "](%s%s)" % (A.SITE, route) not in l))
    L = P.read(os.path.join(scratch, "llms-full.txt")); parts = L.split("\n---\n\nSource: ")
    P.write(os.path.join(scratch, "llms-full.txt"), parts[0] + "".join("\n---\n\nSource: " + x for x in parts[1:] if x.split("\n", 1)[0] != A.SITE + route))
    ij = P.read(os.path.join(scratch, "api/_index.js")); pre_js, arr = ij.split("module.exports = ", 1)
    P.write(os.path.join(scratch, "api/_index.js"), pre_js + "module.exports = " + json.dumps([e for e in json.loads(arr.rstrip().rstrip(";")) if e["route"] != route], ensure_ascii=False) + ";\n")
    at = P.read(os.path.join(scratch, "agent-tools.js")); P.write(os.path.join(scratch, "agent-tools.js"), at.replace('"%s", ' % route, ""))
    v = json.loads(P.read(os.path.join(scratch, "vercel.json")))
    for sec in ("rewrites", "headers"):
        v[sec] = [x for x in v[sec] if x.get("source") != route]
    P.write(os.path.join(scratch, "vercel.json"), json.dumps(v, indent=2, ensure_ascii=False) + "\n")
    git(scratch, "add", "-A"); git(scratch, "commit", "-qm", "pre-state")
    # ---- act: the writer adds the post back to the source, prep does the rest
    P.write(sf, full_src)
    out = P.run(scratch, sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "prep.py"), scratch)
    print("prep:", out.strip().splitlines()[-1])
    # ---- compare
    bad = []

    def same(rel, norm=lambda x: x):
        a, b = P.read(os.path.join(orig, rel)), P.read(os.path.join(scratch, rel))
        if norm(a) != norm(b):
            i = next((k for k, (x, y) in enumerate(zip(norm(a), norm(b))) if x != y), min(len(a), len(b)))
            bad.append("%s differs near %r | %r" % (rel, norm(a)[max(0, i - 50):i + 90], norm(b)[max(0, i - 50):i + 90]))
    for rel in P.html_files(orig):
        if rel.startswith("work/"):
            continue
        same(rel)
    for rel in ("sitemap.xml", "llms.txt", "vercel.json", "agent-tools.js"):
        same(rel)
    same("md/blog/%s.md" % slug, lambda x: CARDS.sub("<cards>", x))
    # the llms-full section and the index entry of the post
    sec = lambda root: next(x for x in P.read(os.path.join(root, "llms-full.txt")).split("\n---\n\nSource: ")[1:] if x.startswith(A.SITE + route + "\n"))
    if CARDS.sub("<cards>", sec(orig)) != CARDS.sub("<cards>", sec(scratch)):
        bad.append("llms-full section differs")
    ent = lambda root: next(e for e in json.loads(P.read(os.path.join(root, "api/_index.js")).split("module.exports = ", 1)[1].rstrip().rstrip(";")) if e["route"] == route)
    ea, eb = ent(orig), ent(scratch)
    for k in ("route", "url", "markdown", "title", "description", "language"):
        if ea[k] != eb[k]:
            bad.append("index entry %s: %r != %r" % (k, ea[k], eb[k]))
    if abs(ea["tokens"] - eb["tokens"]) > 0.1 * ea["tokens"]:
        bad.append("index tokens far off: %s vs %s" % (ea["tokens"], eb["tokens"]))
    for d in (orig, scratch):
        shutil.rmtree(d, ignore_errors=True)
    if bad:
        print("REPLAY FAILED"); [print(" -", b) for b in bad]; sys.exit(1)
    print("REPLAY OK: %s regenerated byte-for-byte (page, blog index, twin, sitemap, llms.txt, vercel.json, agent-tools.js)" % route)


def newpost(repo):
    """What the writer does, minus the model: append a post to posts_agent.py, run prep, then the validator. Also: prep twice changes nothing."""
    scratch = clone(repo)
    here = os.path.dirname(os.path.abspath(__file__))
    para = "<p>%s</p>\n" % " ".join(["Service-area businesses can show a hidden address in Google Business Profile and still rank in the Map Pack when the category, services and reviews are complete."] * 5)
    post = {"slug": "zz-agent-test-post", "stage": "solution", "cat": "AI search", "title": "Agent test post: how replay checks work in practice",
            "h1": "Agent test post: how replay checks work", "desc": "A throwaway post used by the watchdog's tests to prove that a new article reaches every generated file the way the real generator does it.",
            "lede": "A test article. It is never published.", "mins": 4,
            "body": "".join('<h2 id="s%d">Section number %d about replay checks?</h2>\n%s' % (i, i, para * 2) for i in range(4)) +
                    '<p>See <a href="/services/seo">SEO for U.S. service businesses</a>, <a href="/ai-visibility-checker">the free AI visibility checker</a> and <a href="/blog/geo-vs-seo">GEO vs SEO</a>.</p>\n'}
    with open(os.path.join(scratch, "_src/posts_agent.py"), "a", encoding="utf-8") as f:
        f.write("\nPOSTS.append(%r)\n" % post)
    out = P.run(scratch, sys.executable, os.path.join(here, "prep.py"), scratch)
    assert '"added": ["/blog/zz-agent-test-post"]' in out, out
    chk = subprocess.run([sys.executable, os.path.join(here, "check_post.py"), scratch, post["slug"], "new"], capture_output=True, text=True)
    assert chk.returncode == 0, "validator rejected a good post: " + chk.stdout
    snap = P.run(scratch, "git", "status", "--short") + P.run(scratch, "git", "diff", "--stat")
    P.run(scratch, sys.executable, os.path.join(here, "prep.py"), scratch)
    assert snap == P.run(scratch, "git", "status", "--short") + P.run(scratch, "git", "diff", "--stat"), "prep is not idempotent"
    twin = P.read(os.path.join(scratch, "md/blog/zz-agent-test-post.md"))
    assert twin.startswith('---\nurl: "https://www.dizaynseo.com/blog/zz-agent-test-post"') and "\n## Section number 0 about replay checks?" in twin
    page = P.read(os.path.join(scratch, "blog/zz-agent-test-post.html"))
    assert "<!-- AEO:agent-discovery -->" in page and "<!-- AEO:conversion-events -->" in page
    # a bad post is refused with plain reasons
    bad = dict(post, title="Too short", desc="short", body='<h2 id="a">One section</h2><p>Few words.</p>')
    with open(os.path.join(scratch, "_src/posts_agent.py"), "a", encoding="utf-8") as f:
        f.write("\nPOSTS[-1].update(%r)\n" % {k: bad[k] for k in ("title", "desc", "body")})
    P.run(scratch, sys.executable, os.path.join(here, "prep.py"), scratch)
    chk = subprocess.run([sys.executable, os.path.join(here, "check_post.py"), scratch, post["slug"], "new"], capture_output=True, text=True)
    assert chk.returncode == 1 and "title is 9 characters" in chk.stdout and "at least 3 <h2" in chk.stdout, chk.stdout
    shutil.rmtree(scratch, ignore_errors=True)
    print("NEWPOST OK: a new post reaches the page, twin, sitemap, llms*.txt, index, routes; prep is idempotent; a bad post is refused")


if __name__ == "__main__":
    if sys.argv[1] == "--newpost":
        newpost(sys.argv[2])
    else:
        main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "local-seo-ai-search-glossary")
