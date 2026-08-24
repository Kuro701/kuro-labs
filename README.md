# kurolabs.net

Static site. No build step, no framework, no dependencies — plain HTML and one
stylesheet. Deployed to Cloudflare Pages.

## Adding a game

1. Drop the game in `games/<slug>/` (an `index.html` and whatever it needs), or
   leave it hosted elsewhere and just point `url` at it.
2. Add an entry to `games/games.json`:

```json
{
  "slug": "my-game",
  "title": "My Game",
  "blurb": "One or two sentences.",
  "url": "/games/my-game/",
  "status": "live",
  "players": "2–8",
  "language": "English",
  "thumb": null
}
```

That's the whole job. `games/index.html` renders itself from the manifest, so the
list never goes stale and no page needs editing. `status` is `live` or `wip`;
`wip` entries render greyed out with an "In development" badge and are not
clickable.

## Re-skinning

Six lines at the top of `assets/style.css` — three accent colours and three
greys. Every colour on the site resolves from those tokens; no raw hex lives in
a page. Same principle as the card game's theme block.

## Placeholders

Anything unfinished is wrapped in `<div class="todo">` and renders as a visible
orange dashed box. Nothing draft is styled to look finished. Delete the block
when the real content lands — and grep for `todo` before any launch.

## Deploying

Cloudflare Pages, connected to this repo, no build command, output directory is
the repo root. Custom domain `kurolabs.net`.

Local preview: `python -m http.server 8000` then http://localhost:8000 —
needed because the games list is fetched, and `fetch` does not work on `file://`.

## Notes

- Fonts come from Google Fonts (Cinzel for display). Everything else is a system
  font stack, so the page is readable before the webfont lands.
- `main` must be qualified as `main.wrap` for vertical padding — `.wrap` is a
  class and beats a bare element selector in the cascade. This already bit once.
