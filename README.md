# Kuro Labs

Static website with the approved black/red design, seven main pages, product/project details and browser games.

## Preview

Serve `public/` with a local HTTP server and open its localhost address. HTML pages and navigation work without JavaScript; the mobile menu and legacy project query links use `public/assets/site.js`.

## Update content

Edit the catalogs in `public/shop/products.json`, `public/projects/projects.json`, or `public/games/games.json`. Then regenerate the HTML using Node.js:

```powershell
Set-Location -LiteralPath 'D:\Cowork\kuro-labs'
node .\site\build-site.cjs
if ($LASTEXITCODE -ne 0) { throw 'Website generation failed.' }
```

Commit the catalog edits and generated pages together. Changing a catalog alone does not update the generated HTML. See `site/README.md` for the source map. Game applications are independent and are not changed by generation.

## Design

Styles: `public/assets/techno.css`. Main layouts: `site/pages.cjs`. Shared document shell, product/project details and 404: `site/build-site.cjs`. Existing media files are reused. The old stylesheet is retained for existing consumers.

## Deployment

`wrangler.jsonc` configures the Cloudflare `kuro-labs` static-assets Worker to serve `public/`. Generated files are committed, so no build command is needed at hosting time. The Git remote is `https://github.com/Kuro701/kuro-labs.git`, branch `main`.

Kuro runs pushes/deployments. Whether a Git push triggers Cloudflare deployment has not been independently verified. Verify the live site after publishing before reporting a deployment complete.
