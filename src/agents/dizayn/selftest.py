#!/usr/bin/env python3
"""Replay test for prep.py: remove a published post from a scratch copy of the site (source, page, twin and every registry),
add it back through prep.py and compare with what the real generator committed. Usage: selftest.py <repo> [slug]"""
import json
import ast
import glob
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
    tree = ast.parse(src)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Dict) or not any(isinstance(k, ast.Constant) and k.value == "slug" and isinstance(v, ast.Constant) and v.value == slug for k, v in zip(node.keys, node.values)):
            continue
        # A list element ends in a comma; an agent post is a POSTS.append call.
        lines = src.splitlines(keepends=True)
        start, end = node.lineno - 1, node.end_lineno
        return "".join(lines[:start] + lines[end:])
    raise ValueError("post source not found: " + slug)


def source_file(repo, slug):
    for path in sorted(glob.glob(os.path.join(repo, "_src/posts*.py"))):
        try:
            drop_post_source(P.read(path), slug)
            return path
        except ValueError:
            continue
    raise ValueError("post source not found: " + slug)


def newest_slug(repo):
    agent_slugs = json.loads(P.run(os.path.join(repo, "_src"), sys.executable, "-c",
                                   "import json, posts_agent; print(json.dumps([p['slug'] for p in posts_agent.POSTS]))"))
    # only posts the watchdog itself wrote ("content(blog): ..." commits) can be replayed byte for byte; hand-written ones cannot
    for slug in reversed(agent_slugs):
        subj = P.run(repo, "git", "log", "--diff-filter=A", "--format=%s", "--", "blog/%s.html" % slug).strip()
        if subj.startswith("content(blog):"):
            return slug
    sitemap = P.read(os.path.join(repo, "sitemap.xml"))
    slugs = re.findall(r"<loc>%s/blog/([^<]+)</loc>" % re.escape(A.SITE), sitemap)
    for slug in reversed(slugs):
        try:
            source_file(repo, slug)
            return slug
        except ValueError:
            continue
    raise ValueError("no published post with source in _src")


def main(repo, slug):
    route = "/blog/" + slug
    orig, scratch = clone(repo), clone(repo)
    orig_head = P.run(orig, "git", "rev-parse", "HEAD").strip()
    # ---- pre-state: the site as it was before the post existed
    sf = source_file(scratch, slug)
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
    assert chk.returncode != 0 and "no Spanish twin" in chk.stdout, chk.stdout
    es_post = {"en": post["slug"], "slug": "zz-prueba-de-agente", "stage": post["stage"], "cat": "Búsqueda con IA",
               "title": "Prueba del agente: cómo funciona la revisión",
               "h1": "Cómo funciona la revisión del agente",
               "desc": "Un artículo de prueba para comprobar que cada página y registro se genera correctamente durante la revisión.",
               "lede": "Un artículo de prueba que nunca se publica.", "mins": post["mins"],
               "body": "".join('<h2 id="s%d">Sección %d de la revisión</h2>\n<p>Esta sección explica la revisión de las páginas generadas.</p>\n' % (i, i) for i in range(4)) +
                       '<p>Consulta <a href="/services/seo">servicios de SEO</a>, <a href="/ai-visibility-checker">la prueba de visibilidad</a> y <a href="/blog/geo-vs-seo">GEO y SEO</a>.</p>\n'}
    with open(os.path.join(scratch, "_src/posts_es.py"), "a", encoding="utf-8") as f:
        f.write("\nPOSTS_ES.append(%r)\n" % es_post)
    P.run(scratch, sys.executable, os.path.join(here, "prep.py"), scratch)
    chk = subprocess.run([sys.executable, os.path.join(here, "check_post.py"), scratch, post["slug"], "new"], capture_output=True, text=True)
    assert chk.returncode == 0 and chk.stdout == "", "validator rejected a good post: " + chk.stdout
    P.run(scratch, "git", "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A")
    P.run(scratch, "git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "draft")
    snap = P.run(scratch, "git", "status", "--short") + P.run(scratch, "git", "diff", "--stat")
    out = P.run(scratch, sys.executable, os.path.join(here, "prep.py"), scratch)
    assert out.strip() == '{"added": [], "changed": []}', out
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
        main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else newest_slug(sys.argv[1]))
