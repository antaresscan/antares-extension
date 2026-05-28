import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// SEO / discoverability invariants for what the antares-extension
// deployment actually serves to public crawlers.
//
// Scope: this repo's Vercel deployment only serves /privacy.html, /api/*,
// /token.html, and a 301 redirect at /. The marketing landing lives in
// the separate antares-website repo with its own SEO.

const repoRoot = join(__dirname, "..")

describe("token.html — should not be indexed", () => {
  const body = readFileSync(join(repoRoot, "token.html"), "utf-8")

  it("explicitly tells crawlers not to index the token analysis page", () => {
    // token.html is a data-display page that needs a #data hash payload to
    // render anything useful. Indexing the bare URL would surface an empty
    // / error state in search results — pure SEO harm.
    expect(body).toMatch(/<meta\s+name="robots"\s+content="noindex,\s*nofollow"/)
  })
})

describe("robots.txt", () => {
  const body = readFileSync(join(repoRoot, "robots.txt"), "utf-8")

  it("allows the root by default", () => {
    expect(body).toMatch(/User-agent:\s*\*/)
    expect(body).toMatch(/^Allow:\s*\/$/m)
  })

  it("disallows /api/ and /token.html", () => {
    expect(body).toContain("Disallow: /api/")
    expect(body).toContain("Disallow: /token.html")
  })

  it("references the sitemap", () => {
    expect(body).toContain("Sitemap: https://antares-extension.vercel.app/sitemap.xml")
  })
})

describe("sitemap.xml", () => {
  const body = readFileSync(join(repoRoot, "sitemap.xml"), "utf-8")

  it("is a valid XML document with the sitemap urlset namespace", () => {
    expect(body).toMatch(/<\?xml\s+version="1\.0"\s+encoding="UTF-8"\?>/)
    expect(body).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"')
  })

  it("lists privacy.html as the only public page on this deployment", () => {
    expect(body).toContain("https://antares-extension.vercel.app/privacy.html</loc>")
  })

  it("does not list pages we explicitly disallow in robots.txt", () => {
    expect(body).not.toContain("token.html</loc>")
    expect(body).not.toContain("/api/")
  })

  it("does not list the bare root — it is a redirect, not a page", () => {
    // `/` 301s to the canonical website on GitHub Pages. Listing it in
    // our sitemap would tell Google to crawl a redirect that lands on
    // a different host — wasteful at best, confusing at worst.
    expect(body).not.toContain("<loc>https://antares-extension.vercel.app/</loc>")
  })
})

describe("vercel.json — root redirect to canonical site", () => {
  type VercelConfig = {
    redirects?: Array<{ source: string; destination: string; permanent?: boolean }>
  }
  const config = JSON.parse(readFileSync(join(repoRoot, "vercel.json"), "utf-8")) as VercelConfig

  it("redirects bare / to the antaresscan.com canonical site", () => {
    // Updated from the legacy GH Pages mirror (comealamaisongroupe.github.io
    // /antares-website/) to the custom domain antaresscan.com that's been
    // canonical since v1.3.2. CWS reviewers + organic Google traffic landing
    // on antares-extension.vercel.app/ should bounce to the real marketing
    // site, not the deprecated mirror.
    const rootRedirect = config.redirects?.find(r => r.source === "/")
    expect(rootRedirect).toBeDefined()
    expect(rootRedirect?.destination).toBe("https://antaresscan.com/")
    expect(rootRedirect?.permanent).toBe(true)
  })
})
