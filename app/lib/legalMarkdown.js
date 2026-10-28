// Small markdown renderer for the public legal pages. It writes only the tags it generates
// (headings, paragraphs, lists, links, bold). Raw HTML in the file is escaped, never passed through.
// Front matter is a single "updated: YYYY-MM-DD" field used as "Last updated".

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export function parseFrontMatter(src) {
  const text = String(src ?? '').replace(/^\uFEFF/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: text.slice(m[0].length) };
}

// http(s) or a same-site path. javascript:, data:, and protocol-relative links are dropped.
export function safeHref(raw) {
  const href = String(raw || '').trim();
  if (!href || /[\u0000-\u001f\u007f\s]/.test(href)) return null;
  if (href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/\\')) return href;
  let u;
  try { u = new URL(href); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  return u.href;
}

export function formatUpdated(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime()) || d.getUTCMonth() !== Number(m[2]) - 1) return null;
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' }).format(d);
}

function renderInline(raw) {
  const re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(raw))) {
    out += escapeHtml(raw.slice(last, m.index));
    if (m[1] != null) out += `<strong>${escapeHtml(m[1])}</strong>`;
    else {
      const href = safeHref(m[3]);
      const label = escapeHtml(m[2]);
      out += href ? `<a href="${escapeHtml(href)}">${label}</a>` : label;
    }
    last = m.index + m[0].length;
  }
  out += escapeHtml(raw.slice(last));
  return out;
}

function blocksOf(body) {
  const lines = String(body || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  let list = [];
  const flushPara = () => {
    if (!para.length) return;
    blocks.push({ type: 'p', text: para.join(' ') });
    para = [];
  };
  const flushList = () => {
    if (!list.length) return;
    blocks.push({ type: 'ul', items: list });
    list = [];
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { flushPara(); flushList(); continue; }
    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushPara(); flushList();
      blocks.push({ type: `h${heading[1].length}`, text: heading[2] });
      continue;
    }
    const item = /^[-*]\s+(.+)$/.exec(trimmed);
    if (item) { flushPara(); list.push(item[1]); continue; }
    flushList();
    para.push(trimmed);
  }
  flushPara(); flushList();
  return blocks;
}

export function renderLegalMarkdown(src) {
  const { meta, body } = parseFrontMatter(src);
  const html = blocksOf(body).map((b) => {
    if (b.type === 'ul') return `<ul>${b.items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</ul>`;
    return `<${b.type}>${renderInline(b.text)}</${b.type}>`;
  }).join('');
  return { updated: meta.updated || null, updatedLabel: formatUpdated(meta.updated), html };
}
