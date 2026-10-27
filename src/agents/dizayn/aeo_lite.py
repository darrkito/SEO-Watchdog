"""Stand-in for the part of the partner's tools/aeo/build.py that matters when a post is added.

The generator is not on this machine, so this reproduces its output for HTML pages and derived files and is checked against what is
already committed (test/dizayn-prep.test.ts replays every existing page: if the generator's output ever differs, that test fails).
Only stdlib.
"""
import re

SITE = "https://www.dizaynseo.com"
HEAD_OPEN, HEAD_CLOSE = "\n  <!-- AEO:agent-discovery -->\n", "  <!-- /AEO:agent-discovery -->\n"
BODY_OPEN = "<!-- AEO:conversion-events -->\n"

# the click-to-lead-event script that the generator appends before </body>, taken verbatim from a committed page
CONVERSION = None  # filled by load_conversion() from any committed page, so it is never retyped


def route_of(file):
    """'blog/geo-vs-seo.html' -> '/blog/geo-vs-seo'; the home page is dizaynseo.html -> '/'."""
    f = file[:-5] if file.endswith(".html") else file
    return "/" if f == "dizaynseo" else "/" + f


def md_file_of(route):
    return "md/index.md" if route == "/" else "md" + route + ".md"


def head_block(route):
    md = SITE + "/" + md_file_of(route)
    return (HEAD_OPEN +
            '  <link rel="alternate" type="text/markdown" href="%s" title="Markdown version for AI agents">\n' % md +
            '  <link rel="api-catalog" href="%s/.well-known/api-catalog">\n' % SITE +
            '  <link rel="describedby" type="application/json" href="%s/.well-known/ai-catalog.json" title="Agent capability manifest">\n' % SITE +
            '  <link rel="service-desc" type="application/json" href="%s/openapi.json" title="Public REST API">\n' % SITE +
            '  <link rel="service-doc" type="text/markdown" href="%s/llms.txt" title="Site guide for language models">\n' % SITE +
            '  <script src="/agent-tools-extra.js" defer></script>\n  <script src="/agent-tools.js" defer></script>\n' + HEAD_CLOSE)


def load_conversion(committed_html):
    """The conversion-events block, copied from a page that already has it."""
    global CONVERSION
    i = committed_html.index(BODY_OPEN)
    CONVERSION = committed_html[i:committed_html.index("</body>")]
    return CONVERSION


def apply_html(built_html, route):
    """built_html (output of _src/build.py) -> the page as committed: agent-discovery links before </head>, lead events before </body>."""
    assert CONVERSION, "call load_conversion() first"
    assert built_html.count("</head>") == 1 and built_html.count("</body>") == 1, route
    return built_html.replace("</head>", head_block(route) + "</head>").replace("</body>", CONVERSION + "</body>")
