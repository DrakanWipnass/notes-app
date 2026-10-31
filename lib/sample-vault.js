// Seeds an empty vault with a short feature tour (delete the "Tour" folder whenever you like).
const fs = require('fs').promises;
const path = require('path');

const FILES = {
  'Tour/Welcome.md': `---
tags: [tour, start-here]
aliases: [Home]
---
# Welcome to Notebook

A local-first, Obsidian-style vault that runs in your browser. Notes are plain \`.md\` files in a folder on your disk; GitHub sync is just git.

## Getting around
- **Ctrl+O** quick switcher · **Ctrl+P** command palette · **Ctrl+Shift+F** search
- **Ctrl+E** toggles editing / reading view · **Ctrl+\\\\** split view · **Alt+N** new note · **Alt+W** close tab · **Ctrl+S** save (autosave is on)
- Ctrl/Cmd-click (or middle-click) a link to open it in a new tab
- Hover a link while holding **Ctrl** to preview it

## Tour
1. [[Markdown features]] — callouts, math, mermaid, tasks, tables, footnotes
2. [[HTML embeds]] — render HTML/CSS block diagrams inside notes
3. [[Linking and graph]] — wikilinks, backlinks, tags and the graph view
4. [[GitHub sync]] — store the vault in a GitHub repo

> [!tip] Make it yours
> Delete the \`Tour\` folder when you're done. Everything is just files.

#tour
`,

  'Tour/Markdown features.md': `Back to [[Welcome]].

## Text
**Bold**, *italic*, ~~strike~~, ==highlight==, \`inline code\`, and a footnote.[^1]

## Callouts
> [!note] Notes
> Callouts use Obsidian's syntax: \`> [!type] Title\`.

> [!warning]- Collapsed by default (click me)
> Add \`-\` after the type to start collapsed, \`+\` to start open.

> [!success] Types
> note, abstract, info, todo, tip, success, question, warning, failure, danger, bug, example, quote

## Tasks
- [x] Write the first note
- [ ] Click a checkbox in reading view — it updates the markdown
- [ ] Try the graph view

## Table
| Peripheral | Clock | Notes |
|:--|--:|:-:|
| ePWM | 200 MHz | HRPWM capable |
| ADC | 100 MHz | 4 instances |

## Math
Inline: $e^{i\\pi} + 1 = 0$, and display:

$$
\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}
$$

## Code
\`\`\`c
void isr(void) {
    counter++;          // syntax highlighted
}
\`\`\`

## Mermaid
\`\`\`mermaid
flowchart LR
  A[Sensor] --> B(ADC) --> C{Compare}
  C -->|trip| D[PWM off]
  C -->|ok| E[Control loop]
\`\`\`

## Embeds
Transclude another note's section: ![[Linking and graph#Tags]]

[^1]: Footnotes render at the bottom of the note.

#tour #markdown
`,

  'Tour/HTML embeds.md': `Notebook renders HTML + CSS inside notes, so an image of a block diagram can be rebuilt as crisp, searchable, theme-aware HTML.

There are three ways to do it.

## 1. An \`html-embed\` code block
Put the HTML (with its own \`<style>\`) in a fenced block whose language is \`html-embed\`. It renders in an isolated scope, so its CSS can't leak into the app or other notes.

\`\`\`html-embed
<style>
  .bd { display:flex; align-items:center; gap:14px; flex-wrap:wrap; font: 13px/1.3 system-ui, sans-serif; padding: 8px 0; }
  .bd .blk { border: 2px solid #10b981; border-radius: 10px; padding: 12px 16px; min-width: 96px; text-align:center; background: rgba(16,185,129,.12); }
  .bd .blk b { display:block; font-size: 14px; margin-bottom: 2px; }
  .bd .blk small { opacity: .7; }
  .bd .arrow { position:relative; width: 46px; height: 2px; background: currentColor; opacity:.6; }
  .bd .arrow::after { content:""; position:absolute; right:-1px; top:-5px; border: 6px solid transparent; border-left: 9px solid currentColor; border-right: 0; }
  .bd .hot { border-color: #e5534b; background: rgba(229,83,75,.12); }
</style>
<div class="bd">
  <div class="blk"><b>Sensor</b><small>shunt + amp</small></div>
  <div class="arrow"></div>
  <div class="blk"><b>ADC</b><small>12-bit, SOC0</small></div>
  <div class="arrow"></div>
  <div class="blk hot"><b>CMPSS</b><small>trip @ 3.2 A</small></div>
  <div class="arrow"></div>
  <div class="blk"><b>ePWM</b><small>trip zone</small></div>
</div>
\`\`\`

## 2. Embed a whole \`.html\` file
Keep bigger diagrams as their own file and embed them like an image:

![[Pipeline.html]]

Set a fixed height with \`![[Pipeline.html|400]]\`. Hover over an embed and click ⤢ to open it full screen.

## 3. Inline HTML
Plain HTML also works directly in markdown: <span style="padding:2px 8px;border-radius:99px;background:#2f9e6a;color:white;font-size:12px">inline badge</span>

<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:8px 0">
  <div style="border:1px solid var(--bg-mod-border, #444);border-radius:8px;padding:10px">Cell A</div>
  <div style="border:1px solid var(--bg-mod-border, #444);border-radius:8px;padding:10px">Cell B</div>
  <div style="border:1px solid var(--bg-mod-border, #444);border-radius:8px;padding:10px">Cell C</div>
</div>

## Interactive embeds (scripts)
If an \`html-embed\` block contains a \`<script>\`, it runs in a **sandboxed iframe**, which can't touch your vault:

\`\`\`html-embed
<button id="b" style="padding:6px 14px;border-radius:6px;border:1px solid #888;background:#10b981;color:#fff;cursor:pointer">Clicked 0 times</button>
<script>
  let n = 0; const b = document.getElementById('b');
  b.onclick = () => b.textContent = 'Clicked ' + (++n) + ' times';
</script>
\`\`\`

> [!tip] Tip
> In the editor, run **Insert HTML embed block** from the command palette (Ctrl+P) to get a starter block.

#tour #html
`,

  'Tour/Pipeline.html': `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  :root { --c1:#10b981; --c2:#3b82f6; --c3:#d08a2b; }
  body { margin: 0; padding: 16px; font: 13px/1.35 system-ui, sans-serif; color: inherit; }
  h3 { margin: 0 0 12px; font-size: 14px; letter-spacing: .02em; opacity: .8; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 18px 28px; }
  .stage { border-radius: 10px; padding: 12px; border: 2px solid var(--c); background: color-mix(in srgb, var(--c) 14%, transparent); position: relative; }
  .stage b { display: block; margin-bottom: 4px; }
  .stage ul { margin: 0; padding-left: 16px; opacity: .85; }
  .stage:not(:nth-child(4n))::after { content: "➜"; position: absolute; right: -22px; top: 50%; transform: translateY(-50%); opacity: .6; font-size: 16px; }
  .a { --c: var(--c1); } .b { --c: var(--c2); } .c { --c: var(--c3); }
  .bus { grid-column: 1 / -1; text-align: center; padding: 6px; border-radius: 8px; border: 2px dashed currentColor; opacity: .6; }
</style>
</head>
<body>
  <h3>Control pipeline (standalone .html file)</h3>
  <div class="grid">
    <div class="stage a"><b>Acquire</b><ul><li>ADC SOC</li><li>Oversample</li></ul></div>
    <div class="stage a"><b>Filter</b><ul><li>IIR</li><li>Offset trim</li></ul></div>
    <div class="stage b"><b>Control</b><ul><li>PI loop</li><li>Anti-windup</li></ul></div>
    <div class="stage c"><b>Actuate</b><ul><li>ePWM CMPA</li><li>Deadband</li></ul></div>
    <div class="bus">Shared RAM / interconnect</div>
  </div>
</body>
</html>
`,

  'Tour/Linking and graph.md': `## Wikilinks
- \`[[Note]]\` → [[Welcome]]
- \`[[Note|alias]]\` → [[Markdown features|the feature list]]
- \`[[Note#Heading]]\` → [[HTML embeds#2. Embed a whole .html file]]
- A link to a note that doesn't exist yet shows dimmed — click it to create it: [[My first idea]]

## Backlinks
Open the right sidebar (the icon at the top right) to see **backlinks**, **outgoing links**, the **outline** and a **local graph** for the current note.

## Tags
Tags like #tour or nested ones like #project/alpha show up in the Tags pane. Click a tag to search for it.

## Graph view
Click the graph icon in the left ribbon (or Ctrl+G). Drag nodes, scroll to zoom, click to open.

See also [[GitHub sync]].

#tour #project/alpha
`,

  'Tour/GitHub sync.md': `Your vault is a normal folder. To store it on GitHub:

1. Create a repo on GitHub (private is fine), e.g. \`notes\`.
2. Open **Settings → GitHub sync** (the gear in the bottom-left), paste the repo URL, and press **Connect**.
3. Press the sync button in the status bar, or switch on auto-sync.

Each sync commits your changes, pulls anything new from GitHub, and pushes. It uses your normal \`git\` login (Git Credential Manager on Windows), so there's no token to paste.

> [!warning] Conflicts
> If the same note changed on two machines, it gets \`<<<<<<<\` conflict markers. Edit the note to keep what you want, then sync again.

Back to [[Welcome]].

#tour
`,
};

async function seedVault(dir) {
  for (const [rel, content] of Object.entries(FILES)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  await fs.writeFile(path.join(dir, '.gitignore'), '.trash/\n.DS_Store\nThumbs.db\n');
}

module.exports = { seedVault };
