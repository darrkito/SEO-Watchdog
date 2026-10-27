"""HTML (the <main> of a built page) -> the markdown twin body, in the dialect of the partner's generator (checked by replay, see aeo_lite.py)."""
import html as _html
import re
from html.parser import HTMLParser

SITE = "https://www.dizaynseo.com"
VOID = {"br", "img", "input", "meta", "link", "hr", "source"}
SKIP = {"script", "style", "svg", "form", "noscript", "button", "select"}
BLOCK = {"p", "div", "section", "article", "header", "footer", "main", "ul", "ol", "li", "h1", "h2", "h3", "h4", "table", "thead", "tbody", "tr", "details", "summary", "dl", "dt", "dd", "figure", "figcaption", "blockquote", "nav", "aside"}


class Node:
    def __init__(self, tag, attrs=None, parent=None):
        self.tag, self.attrs, self.parent, self.kids = tag, dict(attrs or []), parent, []

    def cls(self):
        return set((self.attrs.get("class") or "").split())


class Tree(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("root")
        self.cur = self.root

    def handle_starttag(self, tag, attrs):
        n = Node(tag, attrs, self.cur)
        self.cur.kids.append(n)
        if tag not in VOID:
            self.cur = n

    def handle_startendtag(self, tag, attrs):
        self.cur.kids.append(Node(tag, attrs, self.cur))

    def handle_endtag(self, tag):
        n = self.cur
        while n is not None and n.tag != tag:
            n = n.parent
        if n is not None and n.parent is not None:
            self.cur = n.parent

    def handle_data(self, data):
        self.cur.kids.append(data)


def absu(u):
    if u.startswith("/"):
        return SITE + u
    return u


def inline(n):
    """Text of a node with inline formatting, no block structure."""
    out = []
    for k in n.kids:
        if isinstance(k, str):
            out.append(k)
            continue
        if k.tag in SKIP:
            continue
        if k.tag == "br":
            out.append(" ")
            continue
        if k.tag == "img":
            alt = k.attrs.get("alt", "")
            if alt:
                out.append("![%s](%s)" % (alt, absu(k.attrs.get("src", ""))))
            continue
        t = inline(k)
        if k.tag == "a" and k.attrs.get("href") and t.strip():
            out.append("[%s](%s)" % (t, absu(k.attrs["href"])))
        elif k.tag in ("strong", "b") and t.strip():
            out.append("**%s**" % t)
        elif k.tag == "code" and t.strip():
            out.append("`%s`" % t)
        elif k.tag == "em" and t.strip():
            out.append("*%s*" % t)
        else:
            out.append(t)
    return "".join(out)


def has_block(n):
    return any(not isinstance(k, str) and (k.tag in BLOCK or has_block(k)) for k in n.kids if not isinstance(k, str) and k.tag not in SKIP)


def table(n):
    rows = []

    def walk(x):
        for k in x.kids:
            if isinstance(k, str):
                continue
            if k.tag == "tr":
                rows.append([re.sub(r"\s+", " ", inline(c)).strip().replace("|", "\\|") for c in k.kids if not isinstance(c, str) and c.tag in ("td", "th")])
            else:
                walk(k)
    walk(n)
    if not rows:
        return ""
    w = max(len(r) for r in rows)
    rows = [r + [""] * (w - len(r)) for r in rows]
    lines = ["| " + " | ".join(rows[0]) + " |", "|" + "---|" * w]
    lines += ["| " + " | ".join(r) + " |" for r in rows[1:]]
    return "\n".join(lines)


def blocks(n, out):
    run = []

    def flush():
        t = re.sub(r"[ \t\r\n]+", " ", "".join(run)).strip()
        if t:
            out.append(t)
        run.clear()
    for k in n.kids:
        if isinstance(k, str):
            run.append(k)
            continue
        if k.tag in SKIP or "toc" in k.cls() and k.tag == "nav":
            continue
        if k.tag == "ol" and "crumbs" in k.cls():
            flush()
            a, in_article = k.parent, False
            while a is not None:
                in_article = in_article or a.tag == "article"
                a = a.parent
            if in_article:  # the generator keeps the breadcrumb of articles only, as "N. last item"
                items = [x for x in k.kids if not isinstance(x, str) and x.tag == "li"]
                out.append("%d. %s" % (len(items), re.sub(r"\s+", " ", inline(items[-1])).strip()))
        elif k.tag == "table":
            flush(); out.append(table(k))
        elif k.tag in ("h1", "h2", "h3", "h4"):
            flush(); out.append("%s %s" % ("#" * int(k.tag[1]), re.sub(r"\s+", " ", inline(k)).strip()))
        elif k.tag == "li":
            flush()
            ordered = n.tag == "ol"
            idx = 1 + sum(1 for x in n.kids[:n.kids.index(k)] if not isinstance(x, str) and x.tag == "li")
            out.append(("%d. " % idx if ordered else "- ") + re.sub(r"[ \t\r\n]+", " ", inline(k)).strip())
        elif k.tag == "a" and has_block(k):
            # a card: every child's text glued together, as one link; sibling cards share one paragraph
            txt = "".join(re.sub(r"\s+", " ", inline(c) if not isinstance(c, str) else c) for c in k.kids)
            run.append("[%s](%s)" % (txt.strip(), absu(k.attrs.get("href", ""))))
        elif k.tag in BLOCK or has_block(k):
            flush(); blocks(k, out)
        else:
            run.append(inline(Node("x")) if False else _inl(k))
    flush()


def _inl(k):
    n = Node("x"); n.kids = [k]
    return inline(n)


def main_to_md(main_html):
    t = Tree(); t.feed(main_html)
    out = []
    blocks(t.root, out)
    return "\n\n".join(out) + "\n"


def page_md(page_html):
    m = re.search(r"<main[^>]*>(.*)</main>", page_html, re.S)
    main = m.group(1)
    # the generator drops a label that only repeats the page name in the breadcrumb ("Blog" over the blog index)
    c = re.search(r'<ol class="crumbs">.*?<li aria-current="page">(.*?)</li></ol>', main, re.S)
    if c:
        main = main.replace('<p class="over">%s</p>' % c.group(1), "", 1)
    return main_to_md(main)
