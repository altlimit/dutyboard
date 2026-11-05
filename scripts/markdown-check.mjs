#!/usr/bin/env node
// The console's markdown: what agents write renders as a report, and nothing in it becomes markup
// the renderer did not build. Run: node scripts/markdown-check.mjs

import { markdown, plain } from "../app/src/lib/markdown.js";

let passed = 0;
const failures = [];
function check(label, got, want) {
  const ok = want instanceof RegExp ? want.test(got) : got === want;
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ✗ ${label}\n      got:  ${JSON.stringify(got)}\n      want: ${want instanceof RegExp ? want : JSON.stringify(want)}`);
  }
}
// Every tag in the output is one the renderer builds, with only the attributes it sets — so text that
// tried to be markup either stayed text or stayed inside an attribute's quotes.
const TAGS = new Set(["p", "br", "ul", "ol", "li", "span", "code", "pre", "strong", "em", "del", "a", "hr", "blockquote", "div", "table", "thead", "tbody", "tr", "th", "td"]);
function foreignMarkup(html) {
  if (html.includes("\u0000")) return "a placeholder left in the output";
  if (/[<>]/.test(html.replace(/<\/?([a-zA-Z0-9]+)([^>]*)>/g, ""))) return "an angle bracket outside a tag";
  for (const [, tag, attrs] of html.matchAll(/<\/?([a-zA-Z0-9]+)([^>]*)>/g)) {
    if (!TAGS.has(tag)) return `tag <${tag}>`;
    if (!/^(\s+(href|title|target|rel|class|style|start|aria-hidden)="[^"<>]*")*\s*$/.test(attrs)) return `attributes ${attrs}`;
    const href = attrs.match(/href="([^"]*)"/);
    if (href && !/^https?:\/\//.test(href[1])) return `href ${href[1]}`;
  }
  return "";
}
const none = (label, html) => check(label, foreignMarkup(html) ? `${foreignMarkup(html)} in ${html}` : "clean", "clean");

console.log("blocks");
check("a paragraph keeps its line breaks", markdown("one\ntwo"), "<p>one<br>two</p>");
check("blank lines make paragraphs", markdown("one\n\ntwo"), "<p>one</p><p>two</p>");
check("a list right after a line, no blank between", markdown("Social run 2 (19:30 UTC).\n- Logins: online\n- Mail: 1 message"), "<p>Social run 2 (19:30 UTC).</p><ul><li>Logins: online</li><li>Mail: 1 message</li></ul>");
check("numbered, from where it starts", markdown("3. c\n4. d"), '<ol start="3"><li>c</li><li>d</li></ol>');
check("nested", markdown("- a\n  - b\n  - c\n- d"), "<ul><li>a<ul><li>b</li><li>c</li></ul></li><li>d</li></ul>");
check("a wrapped item", markdown("- first line\n  carries on"), "<ul><li>first line<br>carries on</li></ul>");
check("tasks", markdown("- [ ] todo\n- [x] done"), /<li class="md-task"><span class="md-check" aria-hidden="true">☐<\/span> todo<\/li><li class="md-task"><span[^>]*>☑<\/span> done<\/li>/);
check("a heading is a strong line, not a page heading", markdown("## Results"), '<p class="md-h">Results</p>');
check("fenced code is kept exactly", markdown("```go\nif a < b {\n\t*x = 1\n}\n```"), '<pre class="md-code"><code>if a &lt; b {\n\t*x = 1\n}</code></pre>');
check("an unclosed fence runs to the end", markdown("```\nlog line"), '<pre class="md-code"><code>log line</code></pre>');
check("quote", markdown("> said\n> twice"), "<blockquote><p>said<br>twice</p></blockquote>");
check("rule", markdown("a\n\n---\n\nb"), "<p>a</p><hr><p>b</p>");
check(
  "table",
  markdown("| Site | Status |\n|---|:---:|\n| Reddit | skipped |\n| X | `ok` |"),
  '<div class="md-table"><table><thead><tr><th>Site</th><th style="text-align:center">Status</th></tr></thead><tbody><tr><td>Reddit</td><td style="text-align:center">skipped</td></tr><tr><td>X</td><td style="text-align:center"><code>ok</code></td></tr></tbody></table></div>',
);
check("CRLF", markdown("a\r\n- b"), "<p>a</p><ul><li>b</li></ul>");
check("nothing", markdown(""), "");

console.log("inline");
check("code", markdown("see `/agents/status` now"), "<p>see <code>/agents/status</code> now</p>");
check("nothing inside code is markdown", markdown("`**not bold** <b>`"), "<p><code>**not bold** &lt;b&gt;</code></p>");
check("bold and emphasis", markdown("**done** and *mostly* _fine_"), "<p><strong>done</strong> and <em>mostly</em> <em>fine</em></p>");
check("ids with underscores stay ids", markdown("duty_01M6P7XQ and ops/log_archive_2026"), "<p>duty_01M6P7XQ and ops/log_archive_2026</p>");
check("arithmetic stays arithmetic", markdown("35 * 12 * 3 = 1260"), "<p>35 * 12 * 3 = 1260</p>");
check("a bare link, without the full stop after it", markdown("Posted: https://www.moltbook.com/post/ff2e72d0."), '<p>Posted: <a href="https://www.moltbook.com/post/ff2e72d0" title="https://www.moltbook.com/post/ff2e72d0" target="_blank" rel="noopener noreferrer nofollow">https://www.moltbook.com/post/ff2e72d0</a>.</p>');
check("a bare link in brackets", markdown("(see https://x.y/a_b)"), /^<p>\(see <a href="https:\/\/x\.y\/a_b"[^>]*>https:\/\/x\.y\/a_b<\/a>\)<\/p>$/);
check("a link with its own brackets", markdown("https://en.wikipedia.org/wiki/Go_(language)"), /href="https:\/\/en\.wikipedia\.org\/wiki\/Go_\(language\)"/);
check("a named link", markdown("[the post](https://example.com/p?a=1&b=2)"), '<p><a href="https://example.com/p?a=1&amp;b=2" title="https://example.com/p?a=1&amp;b=2" target="_blank" rel="noopener noreferrer nofollow">the post</a></p>');

check("code in a link's label", markdown("[`x`](https://a.b)"), '<p><a href="https://a.b" title="https://a.b" target="_blank" rel="noopener noreferrer nofollow"><code>x</code></a></p>');

console.log("nothing becomes markup");
const evil = [
  "<script>alert(1)</script>",
  '<img src=x onerror="alert(1)">',
  "[click](javascript:alert(1))",
  "[x](https://e.com/\"onmouseover=alert(1)//)",
  'https://e.com/"><script>alert(1)</script>',
  "```\n</code></pre><script>alert(1)</script>\n```",
  "| <b>h</b> |\n|---|\n| <i onclick=x>c</i> |",
  "- <svg onload=alert(1)>",
  "`<script>`",
  "**<script>**",
  "\u00000\u0000 placeholder forgery",
  // Code held as a placeholder, then a URL running into it: the URL must stop short of it.
  '[a](https://x/`"><img src=x onerror=alert(1)>`)',
  'https://x/`<img src=x onerror=alert(1)>`',
  '[`<b>`](https://x/`"onmouseover="alert(1)`)',
];
for (const s of evil) {
  const html = markdown(s);
  none(`escaped: ${JSON.stringify(s).slice(0, 48)}`, html);
}
check("only http(s) links", markdown("[x](javascript:alert(1)) [y](data:text/html,hi) [z](http://ok.example)"), /^<p>\[x\]\(javascript:alert\(1\)\) \[y\]\(data:text\/html,hi\) <a href="http:\/\/ok\.example"/);
check("a quote in a URL cannot leave the attribute", markdown('https://e.com/a"b'), /href="https:\/\/e\.com\/a&quot;b"/);

console.log("nothing becomes markup, whatever the text");
{
  // Seeded, so a failure is the same failure on every run.
  let seed = 0x5eed;
  const rand = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  const parts = ["<", ">", '"', "'", "&", "`", "``", "*", "**", "_", "__", "~~", "[", "]", "(", ")", "|", "-", "1.", "#", ">", "\\", "\n", "\n\n", "  ", "\t", "https://", "http://e.com/", "javascript:", "data:", "<script>", "</p>", "onerror=", "x", "y", "\u0000", "\u00000\u0000", "```", "[ ]", "---", ":"];
  let bad = "";
  for (let n = 0; n < 4000 && !bad; n++) {
    let t = "";
    for (let k = rand(60); k >= 0; k--) t += parts[rand(parts.length)];
    const why = foreignMarkup(markdown(t)) || (/[<>]/.test(plain(t).replace(/[^<>]/g, "")) && "") || "";
    if (why) bad = `${why} from ${JSON.stringify(t)}`;
  }
  check("4000 generated texts", bad || "clean", "clean");
}

console.log("no text can stall the page");
{
  const N = 20000;
  const hostile = {
    "a URL ending in brackets": "https://x/" + ")".repeat(N),
    "quotes nested deep": ">".repeat(N) + " x",
    "lists nested deep": Array.from({ length: 3000 }, (_, i) => " ".repeat(i) + "- x").join("\n"),
    "fences": "```\n".repeat(N / 4),
    "backticks of every length": Array.from({ length: 200 }, (_, i) => "`".repeat(i + 1) + "a").join(""),
    "unclosed code": "`a".repeat(N),
    "unclosed bold": "**a ".repeat(N / 4),
    "unclosed emphasis": "_a ".repeat(N / 2),
    "half links": "[a](".repeat(N / 4),
    "table rules": "|---".repeat(N / 4) + "x\n|---|",
    "a wide table": "|".repeat(N) + "\n|---|\n" + "|a".repeat(N),
    "a long list": "- a\n".repeat(N),
    "more than any field holds": "word ".repeat(N),
    // Found by review: each was seconds long at 4000 characters before its pattern was rewritten.
    "a heading with a long gap": "# a" + " ".repeat(N) + "x",
    "a heading-like line in a paragraph": "text\n## a" + "\t".repeat(N) + "\nx",
    "link openers sharing one tail": "[".repeat(N / 3) + "x](https://" + "a".repeat(N / 2),
    "half-finished links": "[x](https://a".repeat(N / 13),
    "a link of open brackets": "[x](https://" + "a(".repeat(N / 2),
    "a fence with a long gap": "```" + " ".repeat(N) + "!",
    "a table rule with a long gap": "a|b\n-" + " ".repeat(N) + "x",
    "a line of spaces": " ".repeat(N) + "x",
    "only openers": "[".repeat(N),
    "bold that never closes": " **a".repeat(N / 4),
    "underscores that never close": " __a".repeat(N / 4),
    "strikes that never close": " ~~a".repeat(N / 4),
  };
  for (const [label, text] of Object.entries(hostile)) {
    for (const f of [markdown, plain]) {
      const t = performance.now();
      let out = "ok";
      try {
        const html = f(text);
        if (f === markdown && foreignMarkup(html)) out = foreignMarkup(html);
      } catch (e) {
        out = `threw ${e}`;
      }
      const ms = performance.now() - t;
      check(`${label} (${f.name}, ${ms.toFixed(0)}ms)`, out === "ok" && ms < 1000 ? "ok" : `${out}, ${ms.toFixed(0)}ms`, "ok");
    }
  }
}

console.log("plain");
check("a card's preview", plain("Social run 2.\n- **Logins**: `online`\n- [Mail](https://x.y): 1"), "Social run 2. · Logins: online · Mail: 1");
check("headings, quotes, fences and tables lose their markers", plain("## Done\n> yes\n```\ncode\n```\n|a|\n|---|"), "Done · yes · code · |a|");

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
