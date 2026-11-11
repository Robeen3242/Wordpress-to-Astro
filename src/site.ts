/** Bounded, read-only crawl. Never clicks buttons or submits forms. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractWebsite } from './extractor.js';
import { canonicalPageUrl, isDiscoverablePage, localRoute } from './routes.js';

export type SitePage = { sourceUrl: string; route: string; folder: string; finalUrl: string };
export type SiteManifest = { schemaVersion: 1; sourceUrl: string; pages: SitePage[]; warnings: string[] };
export type CrawlOptions = { maxPages?: number; additionalUrls?: string[]; outputDirectory?: string };

export async function extractSite(sourceUrl: string, options: CrawlOptions = {}): Promise<{ outputDirectory: string; manifest: SiteManifest }> {
  const root = canonicalPageUrl(sourceUrl);
  const rootOrigin = new URL(root).origin;
  const seeds = (options.additionalUrls ?? []).map(u => canonicalPageUrl(u, root));
  const allowedOrigins = new Set([rootOrigin, ...seeds.map(u => new URL(u).origin)]);
  const maxPages = options.maxPages ?? 12;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new Error('maxPages must be between 1 and 100');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDirectory = path.resolve(options.outputDirectory ?? path.join('output', `${new URL(root).hostname}-${timestamp}-site`));
  const manifest: SiteManifest = { schemaVersion: 1, sourceUrl: root, pages: [], warnings: [] };
  const queue = [root, ...seeds];
  const queued = new Set(queue);
  const visited = new Set<string>();
  const usedRoutes = new Set<string>();
  await fs.mkdir(outputDirectory, { recursive: true });
  while (queue.length && manifest.pages.length < maxPages) {
    const url = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);
    if (!isDiscoverablePage(url, root, allowedOrigins)) continue;
    const route = localRoute(url, rootOrigin);
    if (usedRoutes.has(route)) { manifest.warnings.push(`Route collision: ${url} -> ${route}`); continue; }
    const folder = `pages/${String(manifest.pages.length).padStart(3, '0')}`;
    const destination = path.join(outputDirectory, folder);
    try {
      const result = await extractWebsite(url, destination);
      const desktop = JSON.parse(await fs.readFile(path.join(destination, 'desktop-data.json'), 'utf8')) as { links: { href: string }[] };
      const report = JSON.parse(await fs.readFile(result.reportPath, 'utf8')) as { pages: { viewport: string; finalUrl: string }[] };
      const finalUrl = report.pages.find(p => p.viewport === 'desktop')?.finalUrl ?? url;
      if (!allowedOrigins.has(new URL(finalUrl).origin)) {
        manifest.warnings.push(`Excluded redirect outside approved origins: ${url} -> ${finalUrl}`);
        continue;
      }
      const canonicalFinal = canonicalPageUrl(finalUrl);
      if (canonicalFinal !== url && manifest.pages.some(p => canonicalPageUrl(p.finalUrl) === canonicalFinal)) {
        manifest.warnings.push(`Duplicate redirected page: ${url} -> ${finalUrl}`);
        continue;
      }
      manifest.pages.push({ sourceUrl: url, route, folder, finalUrl });
      usedRoutes.add(route);
      for (const link of desktop.links) {
        if (!isDiscoverablePage(link.href, url, allowedOrigins)) continue;
        const candidate = canonicalPageUrl(link.href, url);
        if (!visited.has(candidate) && !queued.has(candidate)) { queue.push(candidate); queued.add(candidate); }
      }
    } catch (error) { manifest.warnings.push(`Failed to capture ${url}: ${String(error)}`); }
  }
  if (queue.length) manifest.warnings.push(`Page limit ${maxPages} reached; ${queue.length} additional discovered pages not captured.`);
  await fs.writeFile(path.join(outputDirectory, 'site-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { outputDirectory, manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [, , url, limit, ...additionalUrls] = process.argv;
  if (!url) { console.error('Usage: node dist/site.js URL [maxPages=12] [additionalSeedUrl ...]'); process.exitCode = 1; }
  else extractSite(url, { maxPages: limit ? Number(limit) : 12, additionalUrls }).then(r => {
    console.log(`Captured ${r.manifest.pages.length} pages in ${r.outputDirectory}`);
    r.manifest.warnings.forEach(w => console.warn(w));
  }).catch(e => { console.error(e); process.exitCode = 1; });
}
