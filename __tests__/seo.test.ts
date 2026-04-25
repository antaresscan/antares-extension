import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// SEO / discoverability invariants for the public landing surface.
// Same rationale as privacy-html.test.ts: e2e runs against production and
// can't validate a PR's content before deploy. These assertions live as
// unit tests so a regression fails CI before anything ships.

const repoRoot = join(__dirname, "..")

describe("index.html — SEO basics", () => {
  const body = readFileSync(join(repoRoot, "index.html"), "utf-8")

  it("declares a canonical URL", () => {
    expect(body).toMatch(/<link\s+rel="canonical"\s+href="https:\/\/antares-website\.vercel\.app\/"/)
  })

  it("opts in to search-engine indexing explicitly", () => {
    expect(body).toMatch(/<meta\s+name="robots"\s+content="index,\s*follow"/)
  })

  it("publishes Open Graph url for social previews", () => {
    expect(body).toContain('property="og:url"')
    expect(body).toContain('https://antares-website.vercel.app/')
  })

  it("embeds JSON-LD SoftwareApplication structured data", () => {
    expect(body).toContain('<script type="application/ld+json">')
    expect(body).toContain('"@type": "SoftwareApplication"')
    expect(body).toContain('"@context": "https://schema.org"')
    expect(body).toContain('"name": "Antares"')
    expect(body).toContain('"applicationSubCategory": "SecurityApplication"')
  })

  it("links Privacy Policy and Security from the footer", () => {
    expect(body).toContain('href="/privacy.html"')
    expect(body).toContain('SECURITY.md')
  })

  it("declares a theme-color so mobile browsers chrome match the brand", () => {
    expect(body).toMatch(/<meta\s+name="theme-color"/)
  })
})

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

  it("references the sitemap with the canonical URL", () => {
    expect(body).toContain("Sitemap: https://antares-website.vercel.app/sitemap.xml")
  })
})

describe("sitemap.xml", () => {
  const body = readFileSync(join(repoRoot, "sitemap.xml"), "utf-8")

  it("is a valid XML document with the sitemap urlset namespace", () => {
    expect(body).toMatch(/^<\?xml\s+version="1\.0"\s+encoding="UTF-8"\?>/)
    expect(body).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"')
  })

  it("lists the public pages we want indexed", () => {
    expect(body).toContain("https://antares-website.vercel.app/</loc>")
    expect(body).toContain("https://antares-website.vercel.app/privacy.html</loc>")
  })

  it("does not list pages we explicitly disallow in robots.txt", () => {
    expect(body).not.toContain("token.html")
    expect(body).not.toContain("/api/")
  })
})
