# MDVault

A local-first, Obsidian-style markdown vault that runs in your browser.

- **Your notes are plain files.** A vault is a folder of `.md` notes plus attachments, in `./vault` by default.
- **GitHub storage is just git.** The vault folder is a git repo that MDVault commits, pulls and pushes for you.
- **Everything works offline.** The server has no runtime dependencies, and the front-end libraries are served locally from `node_modules`.

## Run

```bat
start.bat                   :: installs deps on first run, opens http://127.0.0.1:3001
```
or
```sh
npm install
npm start                                   # vault in ./vault
VAULT_DIR="D:/Notes" PORT=4000 npm start    # use an existing folder as the vault
```
In Chrome or Edge you can install it as an app (menu → *Install MDVault*) to get its own window.

## Features (Obsidian parity)
| | |
|---|---|
| Editor | CodeMirror with markdown highlighting, `[[` link autocomplete (including `[[note#heading`), list continuation, Ctrl+B/I/K, Alt+↑/↓, image paste/drop into `attachments/` |
| Views | Editing, reading and **split** (live preview) views; tabs with back/forward history; inline title that renames the file |
| Markdown | Wikilinks `[[a]]`, `[[a\|alias]]`, `[[a#heading]]`; embeds `![[note]]`, `![[note#section]]`, `![[img.png\|300]]`; callouts (foldable); tasks (clickable); tables; footnotes; `==highlight==`; `#tags/nested`; `$math$` / `$$math$$` (KaTeX); Mermaid; frontmatter properties; `%%comments%%` |
| Navigation | File explorer (drag to move, context menu, sorting), quick switcher (Ctrl+O), command palette (Ctrl+P), full-text search with `tag:` `path:` `file:` filters, tags pane, bookmarks |
| Knowledge graph | Global graph (Ctrl+G) with tag, orphan and attachment toggles; local graph; backlinks with context; unlinked mentions; outgoing links; outline |
| Files | Renaming updates links across the vault; deleted files go to `.trash/`; daily notes; templates (`{{title}}`, `{{date}}`, `{{time}}`); changes made on disk outside the app show up live |
| Look | Obsidian-like dark and light themes, accent hue, font size, readable line width |

## HTML / CSS embeds
You can rebuild an image (for example a block diagram) as HTML/CSS and render it inside a note:

````md
```html-embed
<style> .blk { border: 2px solid #10b981; border-radius: 8px; padding: 10px; } </style>
<div class="blk">ADC</div>
```

![[diagram.html]]          ← embed a whole .html file (optional height: ![[diagram.html|400]])
````

- **`html-embed` blocks** render in their own Shadow DOM, so their CSS can't leak into the app or other notes. Selectors like `:root` and `body` are re-pointed at the embed.
- **Blocks with `<script>` and `.html` file embeds** run in a sandboxed iframe that auto-sizes to its content. They can't reach your vault or the API.
- **Plain inline HTML** in markdown also works. Scripts and `on*` handlers are stripped.
- **Viewing and editing:** hover an embed to see its source or open it full screen. `.html` files open in the editor with a live split preview.

## GitHub sync
1. Create a repository on GitHub (private is fine).
2. Go to **Settings → GitHub sync**, paste the repo URL, then press **Connect**. Empty repos and repos that already contain notes both work.
3. Sync from the status bar or the ribbon (Ctrl+Shift+S), or set an auto-sync interval. You can also pull on startup.

Each sync does `git add -A` → commit → `pull --no-rebase` → `push`, using your normal git credentials (Git Credential Manager on Windows, or SSH).

If two machines edited the same note, it gets `<<<<<<<` markers. Fix the note in the editor and sync again to finish the merge. Each note's commit history is shown in the right sidebar under **ⓘ**.

## Security notes
- The server listens on `127.0.0.1` only.
- Every write needs an `X-MDVault` header, so other websites can't write to your vault through localhost.
- Vault `.html` files are never served as HTML from the app's origin.

## Hosting (Render or similar)
Set these environment variables on the service:

| Variable | Purpose |
|---|---|
| `NOTES_PASSWORD` | **Required.** The browser asks for it; any username works. The server refuses to start publicly without it. |
| `GITHUB_REPO` | Notes repository, e.g. `DrakanWipnass/notes`. It's cloned into the vault on start. |
| `GITHUB_TOKEN` | Token with write access (contents: read/write) to that repo. |
| `GITHUB_BRANCH` | Optional. Defaults to the repo's default branch. |
| `AUTO_SYNC_SECONDS` | Optional. Edits are committed and pushed this many seconds after the last change (default 20). |

- Build command: `npm install`. Start command: `npm start`.
- Render's disk is wiped on every deploy and restart, so GitHub is where your notes really live; anything not yet pushed is lost on a restart.
- On Render the server listens on `0.0.0.0`. Locally it stays on `127.0.0.1`.
