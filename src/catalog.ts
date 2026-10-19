// Plain-language meaning of every rule and change: what it is, why it matters, what to do.
// The dashboard and alerts read from here, so a non-SEO person can act on a finding.

export type Area = 'Indexing' | 'Site health' | 'Languages' | 'Structured data' | 'Content';
export type RuleInfo = { title: string; why: string; fix: string; area: Area };

export const RULES: Record<string, RuleInfo> = {
  'fetch.timeout': { area: 'Site health', title: 'Pages that never load', why: 'The page did not answer within 20 seconds. Google gives up too, so it can drop the page from search.', fix: 'Open the page yourself. If it hangs, check the route/loader for a redirect or data fetch that never finishes.' },
  'fetch.error': { area: 'Site health', title: 'Pages that could not be reached', why: 'The connection failed (DNS, TLS or network). Visitors and search engines get nothing.', fix: 'Check that the domain, hosting and certificate are working for this URL.' },
  'status.5xx': { area: 'Site health', title: 'Server errors', why: 'The server crashed on these pages. Repeated 5xx errors make Google crawl less and eventually drop pages.', fix: 'Check the hosting/runtime logs for these URLs and fix the error.' },
  'status.4xx': { area: 'Site health', title: 'Broken pages', why: 'These URLs return "not found" or a similar error but are listed in your sitemap or linked from your pages.', fix: 'Restore the page, redirect it to its replacement, or remove the link/sitemap entry.' },
  'redirect.loop': { area: 'Site health', title: 'Redirect loops', why: 'The page redirects in a circle and never loads, for people and for Google.', fix: 'Find the redirect rule that points back to itself (often a slug map entry) and remove it.' },
  'redirect.chain': { area: 'Site health', title: 'Redirect chains', why: 'Several redirects in a row slow the page down and waste crawl budget.', fix: 'Point the first URL straight at the final one.' },
  'sitemap.redirect': { area: 'Indexing', title: 'Sitemap lists old URLs', why: 'Your sitemap points to URLs that redirect elsewhere, which tells Google the sitemap is out of date.', fix: 'List the final URL in the sitemap instead.' },
  'link.redirect': { area: 'Site health', title: 'Internal links that redirect', why: 'Your own links send visitors through a redirect. Harmless, but slower.', fix: 'Update the links to the final URL.' },
  'indexability.noindex': { area: 'Indexing', title: 'Pages hidden from Google', why: 'These pages are in your sitemap but tell Google not to index them, so they cannot appear in search or AI answers.', fix: 'Remove the noindex. If the page really should be hidden, take it out of the sitemap instead.' },
  'canonical.cross_host': { area: 'Indexing', title: 'Pages pointing Google to another website', why: 'The canonical tag tells Google the "real" page lives on a different domain, so this page gives its ranking away.', fix: 'Set the canonical to this site\'s own URL. Usually one wrong SITE_URL setting.' },
  'canonical.elsewhere': { area: 'Indexing', title: 'Sitemap pages that point to a different URL', why: 'The sitemap lists one URL, but the page says the real version is another. Google gets mixed signals.', fix: 'Make the sitemap URL and the canonical URL the same.' },
  'canonical.multiple': { area: 'Indexing', title: 'More than one canonical tag', why: 'With two canonicals, Google may ignore both.', fix: 'Keep a single canonical tag per page.' },
  'og_url.cross_host': { area: 'Content', title: 'Share links pointing to another website', why: 'When someone shares the page on social media or WhatsApp, the preview links to another domain.', fix: 'Set og:url to this site\'s own URL.' },
  'jsonld.invalid': { area: 'Structured data', title: 'Broken structured data', why: 'The JSON-LD (the data Google and AI engines read) has a syntax error, so all of it is ignored.', fix: 'Validate the JSON-LD block and fix the syntax.' },
  'faq.schema_not_visible': { area: 'Structured data', title: 'FAQ data that visitors can\'t see', why: 'The FAQ schema lists questions that are not on the visible page. Google treats this as misleading, and AI engines lose the exact question/answer match.', fix: 'Make the schema read from the same list the page renders, so both always match.' },
  'schema.missing_in_alternate': { area: 'Languages', title: 'Schema missing in one language', why: 'One language version has rich data (FAQ, product, article) and its translation does not, so that language loses rich results.', fix: 'Add the same schema to the other language version.' },
  'url.double_lang_prefix': { area: 'Languages', title: 'Doubled language prefix (/en/en/)', why: 'A doubled prefix creates broken or duplicate URLs.', fix: 'Fix the link or URL builder that adds the language prefix twice.' },
  'hreflang.region_vs_market': { area: 'Languages', title: 'Language tags targeting the wrong country', why: 'hreflang tells Google which country a page is for. A region outside your market can show the wrong page, or list products where you don\'t sell.', fix: 'Use a language-only tag (e.g. "en") or the correct country.' },
  'hreflang.not_reciprocal': { area: 'Languages', title: 'Translations that don\'t link back', why: 'Language pairs must point to each other. One-way links are ignored by Google.', fix: 'Add the missing return hreflang link on the translated page.' },
  'hreflang.target_broken': { area: 'Languages', title: 'Language links to broken pages', why: 'A hreflang tag points at a page that errors or redirects, so the language pairing is ignored.', fix: 'Point hreflang at the working final URL of the translation.' },
  'hreflang.no_x_default': { area: 'Languages', title: 'No default language page', why: 'Without x-default, Google guesses which version to show visitors from other countries.', fix: 'Add an x-default hreflang pointing to your main language version.' },
  'html.lang_missing': { area: 'Languages', title: 'Language not declared', why: 'The page doesn\'t say what language it is in, which affects search, translation and screen readers.', fix: 'Add lang="es" or lang="en" to the <html> tag.' },
  'title.missing': { area: 'Content', title: 'Pages without a title', why: 'The title is what people click in Google. Without one, Google invents it.', fix: 'Add a descriptive <title>.' },
  'title.multiple': { area: 'Content', title: 'Pages with two titles', why: 'Two <title> tags confuse search engines about which one to show.', fix: 'Keep one <title> per page.' },
  'title.long': { area: 'Content', title: 'Titles that get cut off in Google', why: 'Titles over ~60 characters are truncated in search results.', fix: 'Shorten the SEO title. You can keep the longer headline on the page itself.' },
  'title.duplicate': { area: 'Content', title: 'Pages competing with each other', why: 'Several pages share the same title, so Google and AI engines can\'t tell which one to show, and often show a competitor instead.', fix: 'Give each page a unique title, or merge pages that cover the same topic.' },
  'meta.description_missing': { area: 'Content', title: 'No search snippet text', why: 'Without a meta description, Google picks random text for your search result.', fix: 'Write a 1-2 sentence description of the page.' },
  'h1.missing': { area: 'Content', title: 'Pages without a main heading', why: 'The H1 tells visitors and search engines what the page is about.', fix: 'Add one clear H1 heading.' },
  'soft404': { area: 'Indexing', title: 'Error pages that look "OK"', why: 'The page says "not found" but returns success, so Google may index an error page.', fix: 'Return a real 404 status for missing content.' },
  'render.empty_shell': { area: 'Indexing', title: 'Content only appears after JavaScript', why: 'The HTML that search engines and AI crawlers download is nearly empty. Many AI crawlers don\'t run JavaScript, so they see nothing.', fix: 'Render the main content on the server (SSR/SSG).' },
  'sitemap.missing_indexable': { area: 'Indexing', title: 'Pages missing from the sitemap', why: 'Google can index these pages, but your sitemap doesn\'t list them, so they get discovered late or not at all.', fix: 'Add them to the sitemap, or add noindex if they shouldn\'t be in search.' },
  'robots.unavailable': { area: 'Site health', title: 'robots.txt is down', why: 'When robots.txt errors, Google stops crawling the whole site until it recovers.', fix: 'Make /robots.txt return 200 (or 404 if you have none).' },
  'robots.blocks_google': { area: 'Indexing', title: 'Google is blocked from the site', why: 'robots.txt tells Googlebot not to crawl the homepage, so the site disappears from search.', fix: 'Remove the Disallow rule that covers "/" for Googlebot.' },
  'sitemap.missing': { area: 'Indexing', title: 'No sitemap', why: 'Without a sitemap, Google has to find every page through links.', fix: 'Publish /sitemap.xml and reference it in robots.txt.' },
  'ssl.error': { area: 'Site health', title: 'Security certificate problem', why: 'Browsers show a security warning and most visitors leave.', fix: 'Renew or fix the TLS certificate at your host.' },
  'ssl.expiring': { area: 'Site health', title: 'Security certificate expiring soon', why: 'When it expires, browsers block the site with a warning.', fix: 'Renew the certificate, or check that auto-renewal is working.' },
  'domain.expiring': { area: 'Site health', title: 'Domain expiring soon', why: 'If the domain lapses, the whole site goes offline and someone else can buy it.', fix: 'Renew the domain and turn on auto-renew.' },
};

export const ruleInfo = (id: string): RuleInfo =>
  RULES[id] ?? { area: 'Content', title: id, why: '', fix: '' };

export type Tone = 'good' | 'bad' | 'neutral';
export type ChangeText = { text: string; tone: Tone };

/** One change event as a sentence. */
export function describeChange(e: { type: string; field: string | null; before: string | null; after: string | null }): ChangeText {
  const f = e.field;
  switch (e.type) {
    case 'page.new': return { text: 'New page found', tone: 'neutral' };
    case 'page.gone': return { text: 'Page no longer found on the site', tone: 'bad' };
    case 'sitemap.added': return { text: 'Added to the sitemap', tone: 'good' };
    case 'sitemap.removed': return { text: 'Removed from the sitemap', tone: 'bad' };
    case 'robots.changed': return { text: 'robots.txt was edited', tone: 'neutral' };
    case 'robots.bot_access': return { text: `${f} is now ${e.after}`, tone: e.after === 'blocked' ? 'bad' : 'good' };
    case 'sitemap.count': return { text: `Sitemap went from ${e.before} to ${e.after} URLs`, tone: Number(e.after) < Number(e.before) ? 'bad' : 'neutral' };
  }
  if (f === 'noindex') return e.after === 'true'
    ? { text: 'Page is now hidden from Google (noindex)', tone: 'bad' }
    : { text: 'Page can be indexed by Google again', tone: 'good' };
  if (f === 'status') {
    const after = Number(e.after);
    return { text: `Status changed ${e.before} → ${e.after}`, tone: after >= 400 || after === 0 ? 'bad' : Number(e.before) >= 400 ? 'good' : 'neutral' };
  }
  const label: Record<string, string> = {
    title: 'Title changed', meta_description: 'Search description changed', h1: 'Main heading changed', canonical: 'Canonical URL changed',
    robots: 'Robots tag changed', lang: 'Page language changed', hreflang: 'Language links changed', jsonld_types: 'Structured data types changed',
    faq_questions: 'Number of FAQ questions changed', content: 'Page text was edited', final_url: 'Now redirects somewhere else',
  };
  return { text: label[f ?? ''] ?? `${f} changed`, tone: 'neutral' };
}
