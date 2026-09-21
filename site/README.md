# Kuro Labs website source

The published site is static HTML. Regenerate it after changing catalog JSON or page templates:

```powershell
Set-Location -LiteralPath 'D:\Cowork\kuro-labs'
node .\site\build-site.cjs
if ($LASTEXITCODE -ne 0) { throw 'Website generation failed.' }
```

- `site/pages.cjs`: main-page copy and layouts, adapted from approved mockup v002.
- `site/build-site.cjs`: shared document shell, product and project detail pages, metadata, 404.
- `public/assets/techno.css`: approved black/red design. Legacy style.css is retained for older consumers.
- `public/assets/site.js`: mobile menu and compatibility for existing `?p=` detail links.
- `public/shop/products.json`, `public/projects/projects.json`, `public/games/games.json`: catalog content; regenerate after editing.
- `site/generated-files.json`: generated HTML paths. Game applications are never generated or modified.

Preview by serving `public/`. The generated pages work without JavaScript; JavaScript adds the compact mobile menu and old query-link routing. Cloudflare configuration remains in wrangler.jsonc. A Git push is not by itself evidence of deployment; verify the hosting result separately.
