#!/usr/bin/env python3
"""Checks a Dizayn SEO post after prep.py: the post is well formed (playbook limits) and present in every generated file.
Usage: check_post.py <worktree> <slug> [new|existing]   Prints one problem per line; exit 0 when there are none."""
import json
import os
import re
import sys

wt, slug = sys.argv[1], sys.argv[2]
is_new = (sys.argv[3] if len(sys.argv) > 3 else "new") == "new"
sys.path.insert(0, os.path.join(wt, "_src"))
bad = []
try:
    import posts as PO
    p = next((x for x in PO.POSTS if x["slug"] == slug), None)
except Exception as e:  # a syntax error in the source the writer edited
    print("the post source does not load: %s: %s" % (type(e).__name__, str(e)[:200])); sys.exit(1)
if not p:
    print("no post with slug %s in _src (add it to POSTS in _src/posts_agent.py)" % slug); sys.exit(1)
for k in ("slug", "stage", "cat", "title", "h1", "desc", "lede", "mins", "body"):
    if k not in p:
        bad.append("the post has no %r" % k)
if not bad:
    if p["stage"] not in ("unaware", "problem", "solution", "product"):
        bad.append("stage must be unaware, problem, solution or product")
    if not re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", slug):
        bad.append("slug must be lowercase kebab-case")
    if not (25 <= len(p["title"]) <= 62): bad.append("title is %d characters (use 25 to 62)" % len(p["title"]))
    if not (80 <= len(p["desc"]) <= 156): bad.append("desc is %d characters (use 80 to 156)" % len(p["desc"]))
    if not isinstance(p["mins"], int): bad.append("mins must be an integer")
    try:
        body = PO.render(p)
    except KeyError as e:
        body = ""; bad.append("body uses %%(%s)s but S/TABLES has no such key" % e.args[0])
    h2 = re.findall(r'<h2 id="([^"]+)">', body)
    if len(h2) < 3: bad.append("use at least 3 <h2 id=\"...\"> sections")
    if len(set(h2)) != len(h2): bad.append("every <h2> needs a unique id")
    links = re.findall(r'href="(/[^"#]*)', body)
    if is_new:  # an improved post is judged on what changed, not on weaknesses it already had
        if len(links) < 3: bad.append("add at least 3 internal links (found %d)" % len(links))
        if not any(l.startswith(("/services", "/pricing", "/ai-visibility-checker", "/contact")) for l in links):
            bad.append("link at least once to a page that sells (/services/..., /pricing or /ai-visibility-checker)")
        words = len(re.sub(r"<[^>]+>", " ", body).split())
        if words < 700: bad.append("only %d words (aim for 900 or more)" % words)
route = "/blog/" + slug
site = "https://www.dizaynseo.com"
for f in ("blog/%s.html" % slug, "md/blog/%s.md" % slug):
    if not os.path.exists(os.path.join(wt, f)):
        bad.append("%s was not generated" % f)
if is_new:
    def has(f, needle):
        return os.path.exists(os.path.join(wt, f)) and needle in open(os.path.join(wt, f), encoding="utf-8").read()
    for f, needle in (("sitemap.xml", "<loc>%s%s</loc>" % (site, route)), ("llms.txt", "](%s%s)" % (site, route)), ("llms-full.txt", "Source: %s%s\n" % (site, route)),
                      ("api/_index.js", '"route": "%s"' % route), ("agent-tools.js", '"%s"' % route), ("vercel.json", '"source": "%s"' % route)):
        if not has(f, needle):
            bad.append("%s has no entry for the post" % f)
    if not has("blog.html", "/blog/%s" % slug):
        bad.append("blog.html does not list the post")
for f in ("vercel.json", "agent/kb.json", "agent/ai-catalog.json"):
    try:
        json.load(open(os.path.join(wt, f), encoding="utf-8"))
    except Exception as e:
        bad.append("%s is not valid JSON: %s" % (f, e))
print("\n".join(bad))
sys.exit(1 if bad else 0)
