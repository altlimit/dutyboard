// What agents write — notes, questions, outcome summaries — is markdown: they are told so, and it is
// what they write unprompted anyway. This renders the part of it a report uses: paragraphs, lists
// (nested, numbered, checkboxes), `code`, fenced blocks, **bold**, *emphasis*, links, headings,
// quotes, rules and pipe tables.
//
// Safe by construction, not by sanitising afterwards: every piece of the text is HTML-escaped before
// it is placed, and the only tags in the output are the ones built here. A link is made only for
// http(s), and opens elsewhere without the page's referrer. The text can be anything a session read —
// a web page, a mailbox — so nothing in it may become markup.

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => s.replace(/[&<>"']/g, (c) => ESC[c]);

// The title shows where a link really goes, whatever its label says.
const link = (href, label) => `<a href="${href}" title="${href}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>`;

// Trailing punctuation belongs to the sentence, not the URL — and so does a closing bracket the URL
// did not open: "(see https://x.y/z)". Counted once, then walked back: linear however it ends.
function trimURL(url) {
  let open = 0;
  let close = 0;
  for (const c of url) {
    if (c === "(") open++;
    else if (c === ")") close++;
  }
  let end = url.length;
  for (;;) {
    const c = url[end - 1];
    if (c && ".,;:!?'\"".includes(c)) end--;
    else if (c === ")" && open < close) {
      end--;
      close--;
    } else break;
  }
  return [url.slice(0, end), url.slice(end)];
}

/** One line's inline markdown, as HTML. */
export function inline(text) {
  const held = [];
  const hold = (html) => `\u0000${held.push(html) - 1}\u0000`;
  let s = String(text).replace(/\u0000/g, "");
  // Code first: nothing inside it is markdown.
  s = codeSpans(s, (code) => hold(`<code>${esc(code.trim() || code)}</code>`));
  // A URL never takes in a held piece (\u0000): pieces are markup, and a URL becomes an attribute.
  // Only a label may hold one, and a label is text.
  s = s.replace(LINK, (_, label, url) => hold(link(esc(url), inlineMarks(esc(label)))));
  s = s.replace(/(^|[\s(<])(https?:\/\/[^\s<>\u0000]+)/g, (_, before, raw) => {
    const [url, rest] = trimURL(raw);
    return before + hold(link(esc(url), esc(url))) + rest;
  });
  s = inlineMarks(esc(s));
  // A held piece can hold an earlier one — code in a link's label — so pieces are restored inside
  // pieces too. Only ever earlier ones, so this ends.
  const restore = (html) => html.replace(/\u0000(\d+)\u0000/g, (_, i) => restore(held[+i] ?? ""));
  return restore(s);
}

// Every pattern below is written so that no text can make it backtrack far: a long line is anyone's
// to write, and a slow pattern runs on every render of a duty's page. Two quantifiers that can match
// the same characters side by side (\s*\s*, [^)]+[^)]*) are what make a pattern slow, so there are
// none: where one would be needed, plain code does that part instead. scripts/markdown-check.mjs
// times each against text built to find out.

// A link: [label](https://…). The URL's characters exclude brackets, so each ( can only open a
// balanced pair, and the label's exclude [, so each [ starts at most one attempt.
const LINK = /\[([^[\]\n]+)\]\((https?:\/\/[^\s()\u0000]+(?:\([^\s()\u0000]*\)[^\s()\u0000]*)*)\)/g;

// Code spans: a run of backticks, to the next run of the same length. Paired by scanning, once.
function codeSpans(s, make) {
  const runs = [];
  for (let i = 0; i < s.length; ) {
    if (s[i] !== "`") {
      i++;
      continue;
    }
    let j = i;
    while (s[j] === "`") j++;
    runs.push([i, j - i]);
    i = j;
  }
  if (runs.length < 2) return s;
  const byLength = new Map();
  runs.forEach(([, n], k) => {
    if (!byLength.has(n)) byLength.set(n, []);
    byLength.get(n).push(k);
  });
  const next = new Map(); // per length, how far into its runs the search has got
  let out = "";
  let last = 0;
  for (let k = 0; k < runs.length; ) {
    const [start, n] = runs[k];
    const same = byLength.get(n);
    let p = next.get(n) || 0;
    while (p < same.length && same[p] <= k) p++;
    next.set(n, p);
    if (p === same.length) {
      k++;
      continue;
    }
    const close = same[p];
    out += s.slice(last, start) + make(s.slice(start + n, runs[close][0]));
    last = runs[close][0] + n;
    k = close + 1;
  }
  return out + s.slice(last);
}

// Bold and emphasis on already-escaped text. Underscores only at word edges, so snake_case and
// duty_01M6P7XQ stay as they are. A span never runs past the next opener of its kind.
function inlineMarks(s) {
  return s
    .replace(/\*\*(?=\S)((?:[^*]|\*(?!\*))*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w])__(?=\S)((?:[^_]|_(?!_))*?\S)__(?!\w)/g, "$1<strong>$2</strong>")
    .replace(/(^|[^\w*])\*(?=[^\s*])([^*]*?[^\s*])\*(?![\w*])/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_])_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~(?=\S)((?:[^~]|~(?!~))*?\S)~~/g, "<del>$1</del>");
}

// A fence opens with three or more ` or ~; what follows is its language, which nothing here uses.
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
function fence(line) {
  const m = line.match(FENCE);
  return m && !(m[1][0] === "`" && m[2].includes("`")) ? m[1] : "";
}
const closesFence = (line, open) => {
  const t = line.trim();
  return line.length - line.trimStart().length <= 3 && t.length >= open.length && t === open[0].repeat(t.length);
};

// "## Results ##": the text, without the closing hashes. A # that is part of a word stays: "C#".
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
function headingText(text) {
  let t = text.trimEnd();
  let end = t.length;
  while (end > 0 && t[end - 1] === "#") end--;
  if (end === 0 || t[end - 1] === " " || t[end - 1] === "\t") t = t.slice(0, end);
  return t.trim();
}

// ---, ***, ___ (spaces between allowed).
const isRule = (line) => line.length - line.trimStart().length <= 3 && /^([-*_])\1{2,}$/.test(line.replace(/[ \t]+/g, ""));

const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
// Past these, deeper nesting is shown as text: nothing a report needs, and each level is a call.
const MAX_LIST_DEPTH = 8;
const MAX_QUOTE_DEPTH = 6;
// The server caps every field far below this; it is here so the renderer does not depend on that.
const MAX_CHARS = 20000;

const cells = (line) => {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
};

// A table's second line: |---|:---:|, its cells all dashes with an optional colon at either end.
const isTableRule = (line) => line.includes("-") && cells(line).every((c) => /^:?-+:?$/.test(c));
const isTableStart = (lines, i) => lines[i].includes("|") && i + 1 < lines.length && isTableRule(lines[i + 1]);

// A line that starts a block of its own, so it ends the paragraph before it.
const startsBlock = (lines, i, depth) => {
  const l = lines[i];
  return fence(l) || HEADING.test(l) || isRule(l) || ITEM.test(l) || (QUOTE.test(l) && depth < MAX_QUOTE_DEPTH) || isTableStart(lines, i);
};

function list(lines, i, depth = 1) {
  // Items at the first item's indent belong to this list; deeper ones nest in the item above them.
  const first = lines[i].match(ITEM);
  const indent = first[1].replace(/\t/g, "    ").length;
  const ordered = /\d/.test(first[2]);
  const start = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  while (i < lines.length) {
    const m = lines[i].match(ITEM);
    const lineIndent = (lines[i].match(/^\s*/)[0] || "").replace(/\t/g, "    ").length;
    if (m && lineIndent === indent && /\d/.test(m[2]) === ordered) {
      items.push({ text: [m[3]], children: "" });
      i++;
    } else if (m && lineIndent > indent && items.length && depth < MAX_LIST_DEPTH) {
      const [html, next] = list(lines, i, depth + 1);
      items[items.length - 1].children += html;
      i = next;
    } else if (lines[i].trim() && lineIndent > indent && items.length) {
      items[items.length - 1].text.push(lines[i].trim()); // a wrapped item
      i++;
    } else {
      break;
    }
  }
  const body = items
    .map(({ text, children }) => {
      let t = text.join("\n");
      let box = "";
      const check = t.match(/^\[([ xX])\]\s+/);
      if (check) {
        box = `<span class="md-check" aria-hidden="true">${check[1] === " " ? "☐" : "☑"}</span> `;
        t = t.slice(check[0].length);
      }
      return `<li${check ? ' class="md-task"' : ""}>${box}${t.split("\n").map(inline).join("<br>")}${children}</li>`;
    })
    .join("");
  const tag = ordered ? "ol" : "ul";
  return [`<${tag}${ordered && start !== 1 ? ` start="${start}"` : ""}>${body}</${tag}>`, i];
}

function blocks(lines, depth = 0) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    let m;
    const open = fence(line);
    if (open) {
      const body = [];
      i++;
      while (i < lines.length && !closesFence(lines[i], open)) body.push(lines[i++]);
      i++; // the closing fence, or the end
      out.push(`<pre class="md-code"><code>${esc(body.join("\n"))}</code></pre>`);
    } else if ((m = line.match(HEADING))) {
      out.push(`<p class="md-h">${inline(headingText(m[2]))}</p>`);
      i++;
    } else if (isRule(line)) {
      out.push("<hr>");
      i++;
    } else if (ITEM.test(line)) {
      const [html, next] = list(lines, i);
      out.push(html);
      i = next;
    } else if (QUOTE.test(line) && depth < MAX_QUOTE_DEPTH) {
      const body = [];
      while (i < lines.length && (m = lines[i].match(QUOTE))) {
        body.push(m[1]);
        i++;
      }
      out.push(`<blockquote>${blocks(body, depth + 1)}</blockquote>`);
    } else if (isTableStart(lines, i)) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : ""));
      const td = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ""}>${inline(c)}</${tag}>`;
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(
        `<div class="md-table"><table><thead><tr>${head.map((c, k) => td("th", c, k)).join("")}</tr></thead>` +
          `<tbody>${rows.map((r) => `<tr>${head.map((_, k) => td("td", r[k] ?? "", k)).join("")}</tr>`).join("")}</tbody></table></div>`,
      );
    } else {
      // A paragraph: its lines kept as lines, since people and agents both break them on purpose.
      const body = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !startsBlock(lines, i, depth)) body.push(lines[i++]);
      out.push(`<p>${body.map((l) => inline(l.trim())).join("<br>")}</p>`);
    }
  }
  return out.join("");
}

/** Markdown as HTML that is safe to put in the page with v-html. */
export function markdown(text) {
  if (text == null || text === "") return "";
  let s = String(text).replace(/\u0000/g, ""); // never meaningful, and the placeholders' marker
  if (s.length > MAX_CHARS) s = s.slice(0, MAX_CHARS) + "…";
  try {
    return blocks(s.replace(/\r\n?/g, "\n").split("\n"));
  } catch {
    // Whatever went wrong, the duty's page still shows what was written — as text.
    return `<p class="md-raw">${esc(s)}</p>`;
  }
}

/** The same text as one plain line, for a card's preview: no markers, links as their labels. */
export function plain(text) {
  if (!text) return "";
  let s = String(text).replace(/\u0000/g, "");
  if (s.length > MAX_CHARS) s = s.slice(0, MAX_CHARS);
  // A line at a time, with the same line tests the renderer uses.
  const out = [];
  for (let line of s.replace(/\r\n?/g, "\n").split("\n")) {
    if (fence(line) || isRule(line) || isTableRule(line)) continue;
    line = line
      .replace(/^ {0,3}#{1,6}[ \t]+/, "")
      .replace(/^ {0,3}>[ \t]?/, "")
      .replace(/^[ \t]*([-*+]|\d{1,9}[.)])[ \t]+(\[[ xX]\][ \t]+)?/, "");
    line = codeSpans(line, (code) => code.trim() || code)
      .replace(LINK, "$1")
      .replace(/(\*\*|__|~~)(?=\S)((?:[^*_~]|[*_~](?![*_~]))*?\S)\1/g, "$2")
      .replace(/(^|[^\w*])\*(?=[^\s*])([^*]*?[^\s*])\*(?![\w*])/g, "$1$2")
      .trim();
    if (line) out.push(line);
  }
  return out.join(" · ");
}
