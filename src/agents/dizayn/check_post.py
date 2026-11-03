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
# Spanish twins are optional for existing posts, but mandatory for new ones.
try:
    import posts_es as ES
except Exception as e:
    ES = None
    bad.append("posts_es.py does not load: %s: %s" % (type(e).__name__, str(e)[:200]))
if ES:
    try:
        twin = ES.twin_of(slug)
    except Exception as e:
        twin = None
        bad.append("Spanish twin lookup failed: %s" % e)
    if twin is None and is_new:
        bad.append("no Spanish twin: add the translation to POSTS_ES in _src/posts_es.py (paridad EN/ES)")
    if twin is not None:
        required = ("en", "slug", "stage", "cat", "title", "h1", "desc", "lede", "mins", "body")
        missing = [k for k in required if k not in twin]
        for k in missing: bad.append("Spanish twin has no %r" % k)
        if not missing:
            es_slug = twin["slug"]
            if twin["en"] != slug: bad.append("Spanish twin en does not match the English slug")
            if not re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", es_slug) or es_slug == slug:
                bad.append("Spanish slug must be distinct lowercase ASCII kebab-case")
            if sum(x.get("slug") == es_slug for x in ES.POSTS_ES) != 1:
                bad.append("Spanish slug is not unique")
            if twin["stage"] != p.get("stage") or twin["stage"] not in ES.STAGES_ES:
                bad.append("Spanish stage must match English and exist in STAGES_ES")
            if not 25 <= len(twin["title"]) <= 62: bad.append("Spanish title must be 25 to 62 characters")
            if not 80 <= len(twin["desc"]) <= 156: bad.append("Spanish desc must be 80 to 156 characters")
            if twin["mins"] != p.get("mins"): bad.append("Spanish mins must match English")
            for k in ("title", "h1", "desc", "lede", "body"):
                if "—" in twin[k] and "—" not in p.get(k, ""):
                    bad.append("Spanish %s has an em dash absent from English" % k)
            try:
                es_body = ES.render_es(twin)
            except KeyError as e:
                es_body = None
                bad.append("Spanish body uses %%(%s)s but its sources/tables have no such key" % e.args[0])
            except Exception as e:
                es_body = None
                bad.append("Spanish render_es failed: %s" % e)
            if es_body is not None:
                try: en_body = PO.render(p)
                except Exception: en_body = None
                if en_body is not None:
                    if re.findall(r'<h2 id="([^"]+)">', es_body) != re.findall(r'<h2 id="([^"]+)">', en_body):
                        bad.append("Spanish h2 ids or order differ from English")
                    for pattern, label in ((r'<table\b', 'table'), (r'href="http', 'external link'), (r'href="/', 'internal link')):
                        if len(re.findall(pattern, es_body)) != len(re.findall(pattern, en_body)):
                            bad.append("Spanish %s count differs from English" % label)
                text = re.sub(r'<a\b[^>]*>.*?</a>', ' ', es_body, flags=re.I | re.S)
                text = re.sub(r'<[^>]*>', ' ', text)
                leaks = re.findall(r'\b(?:the|your|you|with)\b', text, flags=re.I)
                if len(leaks) > 3: bad.append("Spanish body has English words: " + ", ".join(leaks))
            if is_new:
                es_route = "/es/blog/" + es_slug
                for f in ("es/blog/%s.html" % es_slug, "md/es/blog/%s.md" % es_slug):
                    if not os.path.exists(os.path.join(wt, f)): bad.append("%s was not generated" % f)
                for f, needle in (("sitemap.xml", "<loc>%s%s</loc>" % (site, es_route)), ("llms.txt", "](%s%s)" % (site, es_route)), ("llms-full.txt", "Source: %s%s\n" % (site, es_route)), ("api/_index.js", '\"route\": \"%s\"' % es_route), ("vercel.json", '\"source\": \"%s\"' % es_route), ("agent-tools.js", '\"%s\"' % es_route)):
                    if not has(f, needle): bad.append("%s has no entry for the Spanish post" % f)
                if not has("es/blog.html", es_route): bad.append("es/blog.html does not list the Spanish post")
                if not has("blog/%s.html" % slug, 'hreflang="es-US" href="%s%s"' % (site, es_route)):
                    bad.append("English html has no Spanish hreflang")
                if not has("es/blog/%s.html" % es_slug, 'hreflang="en-US" href="%s%s"' % (site, route)):
                    bad.append("Spanish html has no English hreflang")
if bad: print("\n".join(bad))
sys.exit(1 if bad else 0)
