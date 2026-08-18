// api/analyze.js
// Real website analysis backend for SiteIQ.
// Deployed as a Vercel Serverless Function.
//
// What it does:
// 1. Takes a URL the user typed in on the frontend.
// 2. Calls Google's PageSpeed Insights API (free, official, public data only)
//    to get real Performance / SEO / Accessibility / Best Practices scores.
// 3. Fetches the site's own HTML (server-side, so no CORS issues) to check
//    for social links and a blog/content section.
// 4. Sends back one JSON object shaped exactly like the old fake "data" object,
//    so the existing frontend charts/report UI don't need to change.

export default async function handler(req, res) {
  // Allow the frontend to call this from the browser
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST with { "url": "https://example.com" }' });
  }

  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Missing "url" in request body.' });

  // Normalize the URL (add https:// if missing)
  let target;
  try {
    target = new URL(url.match(/^https?:\/\//i) ? url : `https://${url}`);
  } catch {
    return res.status(400).json({ error: 'That doesn\'t look like a valid URL.' });
  }

  const API_KEY = process.env.PAGESPEED_API_KEY;
  if (!API_KEY) {
    return res.status(500).json({
      error: 'Server is missing PAGESPEED_API_KEY. Add it in your Vercel project\'s Environment Variables.'
    });
  }

  try {
    // ---- 1. Real Lighthouse scores from Google PageSpeed Insights ----
    const categories = ['performance', 'seo', 'accessibility', 'best-practices'];
    const catParams = categories.map(c => `category=${c}`).join('&');
    const psiUrl =
      `https://www.googleapis.com/pagespeedonline/v5/runPagespeed` +
      `?url=${encodeURIComponent(target.href)}&key=${API_KEY}&strategy=mobile&${catParams}`;

    const psiResp = await fetch(psiUrl);
    const psiData = await psiResp.json();

    if (psiData.error) {
      return res.status(502).json({
        error: `PageSpeed API error: ${psiData.error.message || 'could not analyze that URL.'}`
      });
    }

    const lh = psiData.lighthouseResult;
    const cats = lh.categories;
    const audits = lh.audits;

    const perf = Math.round((cats.performance?.score ?? 0) * 100);
    const seo = Math.round((cats.seo?.score ?? 0) * 100);
    const ux = Math.round((cats.accessibility?.score ?? 0) * 100);
    const tech = Math.round((cats['best-practices']?.score ?? 0) * 100);
    const speedIndexMs = audits['speed-index']?.numericValue;
    const speed = speedIndexMs ? Number((speedIndexMs / 1000).toFixed(1)) : null;

    // ---- 2. Fetch the raw page HTML for content/social signal checks ----
    let html = '';
    try {
      const pageResp = await fetch(target.href, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SiteIQ-Bot/1.0)' }
      });
      html = await pageResp.text();
    } catch {
      html = ''; // if this fails, we just skip content/social heuristics
    }

    const socialPlatforms = ['facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'linkedin.com', 'tiktok.com', 'youtube.com'];
    const socialFound = socialPlatforms.filter(p => html.includes(p));
    const social = Math.min(100, socialFound.length * 18);
    const hasBlog = /\b(blog|articles|insights|news)\b/i.test(html);
    const content = hasBlog ? 65 : 32;

    const overall = Math.round((perf + seo + ux + tech + social + content) / 6);

    // ---- 3. Build the checklist from REAL Lighthouse audit results ----
    const auditMap = [
      { id: 'is-on-https', title: 'HTTPS enabled' },
      { id: 'meta-description', title: 'Meta description present' },
      { id: 'viewport', title: 'Mobile viewport configured' },
      { id: 'tap-targets', title: 'Tap targets sized appropriately' },
      { id: 'image-alt', title: 'Images have alt text' },
      { id: 'uses-optimized-images', title: 'Images are optimized' },
      { id: 'document-title', title: 'Page has a title tag' },
      { id: 'link-text', title: 'Links have descriptive text' },
    ];

    const checks = auditMap
      .map(({ id, title }) => {
        const a = audits[id];
        if (!a) return null;
        let status = 'pass';
        if (a.score === 0) status = 'fail';
        else if (a.score === null || (a.score !== null && a.score < 1)) status = 'warn';
        return {
          status,
          title,
          desc: a.title,
          detail: (a.description || '').replace(/\[.*?\]\(.*?\)/g, '').trim(),
        };
      })
      .filter(Boolean);

    // Add the two heuristic checks we computed ourselves
    checks.push({
      status: socialFound.length >= 2 ? 'pass' : socialFound.length === 1 ? 'warn' : 'fail',
      title: 'Social media presence',
      desc: socialFound.length ? `Linked to: ${socialFound.join(', ')}` : 'No social links found on the homepage.',
      detail: 'Linking active social profiles helps visitors find and trust the business.'
    });
    checks.push({
      status: hasBlog ? 'pass' : 'warn',
      title: 'Blog / content section',
      desc: hasBlog ? 'A content or blog section was detected.' : 'No blog or articles section detected.',
      detail: 'Regularly published content supports organic search visibility over time.'
    });

    return res.status(200).json({
      url: target.href,
      score: overall,
      seo, perf, ux, content, social, tech,
      speed: speed ?? 'N/A',
      checks,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: 'Analysis failed. The site may be blocking automated requests, or is unreachable.'
    });
  }
}
