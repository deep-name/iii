#!/usr/bin/env node
// Extracts the visible content of website/index.html into a plain-text /
// markdown snapshot for AI agents and LLM ingestion. Writes:
//   website/ai/index.html  — HTML wrapper (browser-viewable, /ai route)
//   website/ai.md          — raw markdown (direct LLM fetch at /ai.md)
//
// Source of truth: top-level <section aria-label="..."> blocks in
// index.html. Per-section we keep <h1..h4>, <p>, <li>, and visible
// <a>/<code>/<pre> text; everything else (svgs, scripts, styles,
// hidden nodes, animation scaffolding) is dropped.
//
// Zero runtime dependencies — runs anywhere Node 18+ is available.
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(process.cwd());
const INDEX_HTML = path.join(ROOT, "index.html");
const OUT_HTML = path.join(ROOT, "ai", "index.html");
const OUT_MD = path.join(ROOT, "ai.md");

const HTML_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  copy: "©",
};

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => HTML_ENTITIES[name] ?? m);
}

function stripBlock(html, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi");
  return html.replace(re, "");
}

function stripVoidTags(html, tags) {
  for (const tag of tags) {
    html = html.replace(new RegExp(`<${tag}\\b[^>]*/?>`, "gi"), "");
  }
  return html;
}

function stripHiddenNodes(html) {
  // Drop any element flagged aria-hidden="true" or hidden — non-greedy match
  // on matching tag pairs is unreliable across nesting, so we only filter
  // self-contained leaf elements. Decorative content already lives in <svg>
  // which we strip wholesale.
  return html.replace(
    /<(div|span|i|button|figure)\b[^>]*\baria-hidden=["']true["'][^>]*>[\s\S]*?<\/\1>/gi,
    "",
  );
}

function tagText(html) {
  // Collapse all remaining tags to whitespace, decode entities, normalize
  // whitespace.
  return decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractSections(body) {
  // Find top-level <section aria-label="..."> blocks. We use a lightweight
  // depth tracker on <section> opens/closes to grab the matching slice for
  // each labeled section, regardless of inner nesting.
  const sections = [];
  const openRe = /<section\b([^>]*)>/gi;
  let match;
  while ((match = openRe.exec(body)) !== null) {
    const attrs = match[1] ?? "";
    const labelMatch = attrs.match(/aria-label=["']([^"']+)["']/i);
    if (!labelMatch) continue;
    const label = labelMatch[1];
    const startIdx = match.index;
    const innerStart = openRe.lastIndex;

    // Walk forward tracking section depth.
    let depth = 1;
    const cursorRe = /<section\b[^>]*>|<\/section>/gi;
    cursorRe.lastIndex = innerStart;
    let endIdx = -1;
    let cursor;
    while ((cursor = cursorRe.exec(body)) !== null) {
      if (cursor[0].toLowerCase().startsWith("</")) {
        depth -= 1;
        if (depth === 0) {
          endIdx = cursor.index;
          break;
        }
      } else {
        depth += 1;
      }
    }
    if (endIdx === -1) continue;

    sections.push({
      label,
      html: body.slice(innerStart, endIdx),
    });

    openRe.lastIndex = endIdx;
  }
  return sections;
}

function extractCodeBlock(attrs, raw) {
  // Pull data-lang for the markdown fence hint, default to no language.
  const langMatch = attrs.match(/data-lang=["']([\w+-]+)["']/i);
  const lang = langMatch ? langMatch[1] : "";

  // Strip the inner <code> wrapper plus any inline syntax-highlight spans
  // (e.g. <span class="hl-cmt" data-cmt="…">), keeping their text content
  // so inline comments survive in the snippet.
  let code = raw
    .replace(/<\/?code\b[^>]*>/gi, "")
    .replace(/<[^>]+>/g, "");
  code = decodeEntities(code);

  // Trim leading/trailing blank lines but preserve internal indentation —
  // critical for code readability.
  code = code.replace(/^\n+/, "").replace(/\s+$/, "");

  return { lang, code };
}

function sectionToMarkdown({ label, html }) {
  const lines = [`## ${label}`, ""];

  // Pull out ordered headings, paragraphs, list items, and code blocks in
  // document order. Capture the opening-tag attributes so <pre data-lang>
  // can be turned into a fenced code block with the right language hint.
  const blockRe = /<(h[1-4]|p|li|blockquote|pre)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  const seen = new Set();
  let m;
  while ((m = blockRe.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const attrs = m[2];
    const raw = m[3];

    if (tag === "pre") {
      const { lang, code } = extractCodeBlock(attrs, raw);
      if (!code) continue;
      // Dedupe by raw code content (different code examples must survive
      // even when their language matches a previous block).
      const key = `pre::${code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`\`\`\`${lang}`);
      lines.push(code);
      lines.push("```");
      lines.push("");
      continue;
    }

    const text = tagText(raw);
    if (!text || text.length < 2) continue;
    // Dedupe identical text within the same section (animation scaffolding
    // sometimes repeats hero strings).
    const key = `${tag}::${text}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (tag === "h1") lines.push(`### ${text}`);
    else if (tag === "h2") lines.push(`### ${text}`);
    else if (tag === "h3") lines.push(`#### ${text}`);
    else if (tag === "h4") lines.push(`##### ${text}`);
    else if (tag === "li") lines.push(`- ${text}`);
    else if (tag === "blockquote") lines.push(`> ${text}`);
    else lines.push(text);
    lines.push("");
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function extractTitle(html) {
  const m = html.match(/<title>([\s\S]*?)<\/title>/i);
  return m ? tagText(m[1]) : "iii";
}

function extractDescription(html) {
  const m = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);
  return m ? decodeEntities(m[1]) : "";
}

async function main() {
  const html = await fs.readFile(INDEX_HTML, "utf8");
  const title = extractTitle(html);
  const description = extractDescription(html);

  // Slice out the body so we don't traverse inline scripts/styles in <head>.
  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i);
  if (!bodyMatch) throw new Error("generate-machine-markdown: no <body> in index.html");
  let body = bodyMatch[1];

  body = stripBlock(body, "script");
  body = stripBlock(body, "style");
  body = stripBlock(body, "noscript");
  body = stripBlock(body, "svg");
  body = stripBlock(body, "template");
  body = stripVoidTags(body, ["br", "hr", "img", "source", "input"]);
  body = stripHiddenNodes(body);

  const sections = extractSections(body);
  if (sections.length === 0) {
    throw new Error("generate-machine-markdown: no <section aria-label> blocks found");
  }

  const lastUpdated = new Date().toISOString().slice(0, 10);
  const header = [
    `# ${title}`,
    "",
    description,
    "",
    "> Machine-readable snapshot of the iii homepage. Auto-generated from index.html at build time.",
    "",
    `Last updated: ${lastUpdated}`,
    "",
    "Canonical URLs: https://iii.dev/ (homepage), https://iii.dev/llms.txt, https://iii.dev/AGENTS.md",
    "",
    "---",
    "",
  ].join("\n");

  const sectionBlocks = sections.map(sectionToMarkdown).filter(Boolean);
  const markdown = `${header}${sectionBlocks.join("\n\n")}\n`;

  await fs.mkdir(path.dirname(OUT_HTML), { recursive: true });
  await fs.writeFile(OUT_MD, markdown, "utf8");
  await fs.writeFile(OUT_HTML, buildHtmlWrapper(title, description, markdown), "utf8");

  const relMd = path.relative(ROOT, OUT_MD);
  const relHtml = path.relative(ROOT, OUT_HTML);
  console.log(`generated ${relMd} (${markdown.length} chars)`);
  console.log(`generated ${relHtml}`);
}

function escapeHtml(s) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildHtmlWrapper(title, description, markdown) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)} — machine-readable</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <link rel="canonical" href="https://iii.dev/ai" />
    <meta name="robots" content="index,follow" />
    <link rel="alternate" type="text/markdown" href="/ai.md" />
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0;
        background: #0a0a0a;
        color: #f3f4f6;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      }
      main { max-width: 880px; margin: 0 auto; padding: 32px 20px; }
      pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        line-height: 1.55;
        font-size: 14px;
      }
    </style>
  </head>
  <body>
    <main>
      <pre id="machine-markdown">${escapeHtml(markdown)}</pre>
    </main>
  </body>
</html>
`;
}

main().catch((err) => {
  console.error("generate-machine-markdown failed:", err);
  process.exitCode = 1;
});
