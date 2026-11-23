// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** A file's lines under its own line break (SPEC.md section 3). */
interface FileState {
  br: '\r\n' | '\n';
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const trailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** Line equality at one matching tier (SPEC.md section 5). */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trailWs(a) === trailWs(b);
  return trimWs(a) === trimWs(b);
}

/** Positions at or after `from` where O occurs in `lines` at `tier`; `eofOnly` keeps only occurrences ending at the last line. */
function occurrencesFrom(lines: string[], O: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= lines.length; i++) {
    if (eofOnly && i + O.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(lines[i + j]!, O[j]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

function occurrences(lines: string[], O: string[], tier: number): number[] {
  return occurrencesFrom(lines, O, tier, 0, false);
}

/** First tier (0, or 0..2 unless strict) at which O occurs at least once at or after `from`; null when it occurs at no tier. */
function findTierFrom(lines: string[], O: string[], from: number, strict: boolean, eofOnly: boolean): number | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    if (occurrencesFrom(lines, O, t, from, eofOnly).length > 0) return t;
  }
  return null;
}

function findTier(lines: string[], O: string[], strict: boolean): number | null {
  return findTierFrom(lines, O, 0, strict, false);
}

/** One line of a hunk or chunk body. kind ' ' is a context line, '-' an old line, '+' a new line, '\\' a marker line. */
interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

/** Split a body into its old lines O and its new lines N. A context line of N remembers which line of O it is, so it is written as the file's own matched line. */
function splitBody(body: BodyLine[]): { O: string[]; N: { text: string; ctx: boolean; oIdx: number }[] } {
  const O: string[] = [];
  const N: { text: string; ctx: boolean; oIdx: number }[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      O.push(b.text);
      N.push({ text: b.text, ctx: true, oIdx: O.length - 1 });
    } else if (b.kind === '-') {
      O.push(b.text);
    } else if (b.kind === '+') {
      N.push({ text: b.text, ctx: false, oIdx: -1 });
    }
  }
  return { O, N };
}

/** Build the lines that replace O's match at position `i`: context lines come from the file, other lines of N are re-indented at tier 2. */
function buildReplacement(fileLines: string[], i: number, O: string[], N: { text: string; ctx: boolean; oIdx: number }[], tier: number): string[] {
  const F = leadWs(fileLines[i] ?? '');
  const P = leadWs(O[0] ?? '');
  const out: string[] = [];
  for (const n of N) {
    if (n.ctx) {
      out.push(fileLines[i + n.oIdx]!);
    } else if (tier === 2 && !/^\s*$/.test(n.text) && n.text.startsWith(P)) {
      out.push(F + n.text.slice(P.length));
    } else {
      out.push(n.text);
    }
  }
  return out;
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One unified hunk: A is the old file's start line (1-based), body its lines in order. */
interface Hunk {
  A: number;
  body: BodyLine[];
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function hunkNoEol(h: Hunk): boolean {
  for (let k = h.body.length - 1; k >= 0; k--) {
    const b = h.body[k]!;
    if (b.kind === ' ' || b.kind === '+') {
      const next = h.body[k + 1];
      return next !== undefined && next.kind === '\\';
    }
  }
  return false;
}

/** Whether a `\` line follows the section's last `+` line (for a created file). */
function sectionCreateNoEol(hunks: Hunk[]): boolean {
  let noEol = false;
  for (const h of hunks) {
    for (let k = 0; k < h.body.length; k++) {
      if (h.body[k]!.kind === '+') {
        const next = h.body[k + 1];
        noEol = next !== undefined && next.kind === '\\';
      }
    }
  }
  return noEol;
}

/** Apply a section's hunks to a file's text (SPEC.md section 6). Throws Fail('no-match', path) when a hunk's old lines are not found. */
function applyHunks(before: string, path: string, hunks: Hunk[], strict: boolean): string {
  const f = splitFile(before);
  const lines = f.lines.slice();
  let final = f.final;
  let d = 0;
  for (const h of hunks) {
    const { O, N } = splitBody(h.body);
    const noEol = hunkNoEol(h);
    if (O.length === 0) {
      const at = Math.max(0, Math.min(h.A + d, lines.length));
      const rep = N.map((n) => n.text);
      const touchesEnd = at === lines.length;
      lines.splice(at, 0, ...rep);
      if (touchesEnd) final = !noEol;
      d += N.length;
    } else {
      const tier = findTier(lines, O, strict);
      if (tier === null) throw new Fail('no-match', path);
      const occ = occurrences(lines, O, tier);
      const target = h.A - 1 + d;
      let chosen = occ[0]!;
      for (const p of occ) {
        if (Math.abs(p - target) < Math.abs(chosen - target)) chosen = p;
      }
      const touchesEnd = chosen + O.length === lines.length;
      const rep = buildReplacement(lines, chosen, O, N, tier);
      lines.splice(chosen, O.length, ...rep);
      if (touchesEnd) final = !noEol;
      d += N.length - O.length;
    }
  }
  return joinFile({ br: f.br, lines, final });
}

/** The path after `--- ` or `+++ `: text after the four characters, up to the first tab, surrounding spaces removed, one leading a/ or b/ removed. */
function diffPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** Read a unified diff patch (SPEC.md section 6) into one edit per section. */
function parseUnified(lines: string[], strict: boolean, recordMove: (oldP: string, newP: string) => void): Edit[] {
  const edits: Edit[] = [];
  const hunkHead = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const diffHead = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
  const n = lines.length;

  // One section under construction; its paths come from the ---/+++ pair, the rename lines, or the diff --git line, in that order.
  let sec: { hunks: Hunk[] } | null = null;
  let pairOld: string | null = null;
  let pairNew: string | null = null;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let diffOld: string | null = null;
  let diffNew: string | null = null;
  let secHasPair = false;
  let secHasHunk = false;
  let secNewFile = false;
  let secDelFile = false;
  let hunk: Hunk | null = null;
  let inBody = false;

  const flushHunk = (): void => {
    if (hunk !== null && sec !== null) {
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.kind === ' ' && last.text === '') hunk.body.pop();
        else break;
      }
      sec.hunks.push(hunk);
      secHasHunk = true;
      hunk = null;
    }
  };

  const finishSection = (): void => {
    flushHunk();
    if (sec === null) return;
    const oldPath = pairOld ?? renameFrom ?? diffOld ?? '';
    const newPath = pairNew ?? renameTo ?? diffNew ?? '';
    const create = oldPath === '/dev/null' || secNewFile;
    const del = newPath === '/dev/null' || secDelFile;
    const hunks = sec.hunks;
    const edit: Edit = (tree) => {
      if (oldPath !== '/dev/null' && !safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (newPath !== '/dev/null' && !safe(newPath)) throw new Fail('unsafe', newPath);
      if (oldPath === '/dev/null' && newPath === '/dev/null') throw new Fail('unsafe', '/dev/null');
      if (create) {
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const plus: string[] = [];
        for (const hh of hunks) for (const b of hh.body) if (b.kind === '+') plus.push(b.text);
        const final = !sectionCreateNoEol(hunks);
        tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (final ? '\n' : ''));
      } else if (del) {
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.now.set(oldPath, null);
      } else if (oldPath !== newPath) {
        const before = tree.get(oldPath);
        if (before === null) throw new Fail('missing', oldPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const result = applyHunks(before, oldPath, hunks, strict);
        tree.now.set(oldPath, null);
        tree.now.set(newPath, result);
        recordMove(oldPath, newPath);
      } else {
        const before = tree.get(oldPath);
        if (before === null) throw new Fail('missing', oldPath);
        tree.now.set(oldPath, applyHunks(before, oldPath, hunks, strict));
      }
    };
    edits.push(edit);
    sec = null;
    pairOld = null;
    pairNew = null;
    renameFrom = null;
    renameTo = null;
    diffOld = null;
    diffNew = null;
    secHasPair = false;
    secHasHunk = false;
    secNewFile = false;
    secDelFile = false;
  };

  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (inBody) {
      if (line.startsWith('diff --git ') || (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
        flushHunk();
        inBody = false;
        continue;
      }
      if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\')) {
        hunk!.body.push({ kind: line === '' ? ' ' : (line[0] as ' ' | '-' | '+' | '\\'), text: line === '' ? '' : line.slice(1) });
        i++;
        continue;
      }
      flushHunk();
      inBody = false;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = hunkHead.exec(line);
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { A: parseInt(m[1]!, 10), body: [] };
      inBody = true;
      i++;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = diffHead.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      finishSection();
      sec = { hunks: [] };
      diffOld = m[1]!;
      diffNew = m[2]!;
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1] ?? '';
      if (next.startsWith('+++ ')) {
        if (sec === null || secHasPair || secHasHunk) {
          finishSection();
          sec = { hunks: [] };
          pairOld = diffPath(line);
          pairNew = diffPath(next);
          secHasPair = true;
        } else {
          pairOld = diffPath(line);
          pairNew = diffPath(next);
          secHasPair = true;
        }
        i += 2;
        continue;
      }
      if (sec !== null) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (sec !== null && !secHasHunk) {
      if (line.startsWith('rename from ')) {
        if (renameFrom === null) renameFrom = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        if (renameTo === null) renameTo = line.slice('rename to '.length).trim();
      } else if (/^new file mode(\s|$)/.test(line)) {
        secNewFile = true;
      } else if (/^deleted file mode(\s|$)/.test(line)) {
        secDelFile = true;
      }
    }
    i++;
  }
  finishSection();
  return edits;
}

/** One SEARCH/REPLACE block as an edit (SPEC.md section 7). */
function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const tier = findTier(f.lines, oldLines, strict);
    if (tier === null) throw new Fail('no-match', path);
    const occ = occurrences(f.lines, oldLines, tier);
    if (occ.length > 1) throw new Fail('ambiguous', path);
    const rep = buildReplacement(f.lines, occ[0]!, oldLines, newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 })), tier);
    const lines = f.lines.slice();
    lines.splice(occ[0]!, oldLines.length, ...rep);
    tree.now.set(path, joinFile({ br: f.br, lines, final: f.final }));
  };
}

/** Read a SEARCH/REPLACE patch (SPEC.md section 7) into one edit per block. */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i++; continue; }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplaceEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = searchIdx + 1; j < n; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') { sep = j; break; }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = sep + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, sep);
    const newLines = lines.slice(sep + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  return edits;
}

/** One V4A chunk: an optional anchor line, its body lines, and whether `*** End of File` anchors it to the end of the file. */
interface VChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

/** Apply an Update File section's chunks to a file's text (SPEC.md section 8). */
function applyChunks(before: string, path: string, chunks: VChunk[], strict: boolean): string {
  const f = splitFile(before);
  const lines = f.lines.slice();
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      let pos = -1;
      const max = strict ? 0 : 2;
      for (let t = 0; t <= max && pos < 0; t++) {
        for (let k = cursor; k < lines.length; k++) {
          if (lineEq(lines[k]!, ch.anchor, t)) { pos = k; break; }
        }
      }
      if (pos < 0) throw new Fail('no-match', path);
      cursor = pos + 1;
    }
    const { O, N } = splitBody(ch.body);
    if (O.length === 0) {
      const at = ch.eof ? lines.length : cursor;
      const rep = N.map((n) => n.text);
      lines.splice(at, 0, ...rep);
      cursor = at + rep.length;
    } else {
      const tier = findTierFrom(lines, O, cursor, strict, ch.eof);
      if (tier === null) throw new Fail('no-match', path);
      const occ = occurrencesFrom(lines, O, tier, cursor, ch.eof);
      if (occ.length === 0) throw new Fail('no-match', path);
      const chosen = occ[0]!;
      const rep = buildReplacement(lines, chosen, O, N, tier);
      lines.splice(chosen, O.length, ...rep);
      cursor = chosen + rep.length;
    }
  }
  return joinFile({ br: f.br, lines, final: f.final });
}

/** Read a V4A patch (SPEC.md section 8) into one edit per section. */
function parseV4a(lines: string[], strict: boolean, recordMove: (oldP: string, newP: string) => void): Edit[] {
  const edits: Edit[] = [];
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) { last = k; break; }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const end = last;
  const sectionStart = (l: string): 'add' | 'delete' | 'update' | null => {
    if (l.startsWith('*** Add File: ')) return 'add';
    if (l.startsWith('*** Delete File: ')) return 'delete';
    if (l.startsWith('*** Update File: ')) return 'update';
    return null;
  };
  let i = first + 1;
  while (i < end) {
    const line = lines[i]!;
    if (blank(line)) { i++; continue; }
    const kind = sectionStart(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const start = i;
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
    const path = line.slice(prefix.length).trim();
    i++;
    const raw: { text: string; idx: number }[] = [];
    while (i < end && sectionStart(lines[i]!) === null) {
      raw.push({ text: lines[i]!, idx: i });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (r.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (kind === 'delete') {
      for (const r of raw) {
        if (!blank(r.text)) throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let moveTo: string | null = null;
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let chunkStarted = false;
      let firstLine = true;
      for (const r of raw) {
        const l = r.text;
        if (firstLine && l.startsWith('*** Move to: ')) {
          moveTo = l.slice('*** Move to: '.length).trim();
          firstLine = false;
          continue;
        }
        firstLine = false;
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          chunks.push(cur);
          chunkStarted = true;
          continue;
        }
        if (l.trimEnd() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${r.idx + 1}`);
          cur.eof = true;
          cur = null;
          continue;
        }
        if (l.startsWith('*** ')) throw new Exit2(`error: parse ${r.idx + 1}`);
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) {
            if (!chunkStarted) {
              cur = { anchor: null, body: [], eof: false };
              chunks.push(cur);
              chunkStarted = true;
            } else {
              throw new Exit2(`error: parse ${r.idx + 1}`);
            }
          }
          cur.body.push({ kind: l === '' ? ' ' : (l[0] as ' ' | '-' | '+'), text: l === '' ? '' : l.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${start + 1}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        const before = tree.get(path);
        if (before === null) throw new Fail('missing', path);
        if (moveTo !== null) {
          if (!safe(moveTo)) throw new Fail('unsafe', moveTo);
          if (tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        }
        const result = applyChunks(before, path, chunks, strict);
        if (moveTo !== null) {
          tree.now.set(path, null);
          tree.now.set(moveTo, result);
          recordMove(path, moveTo);
        } else {
          tree.now.set(path, result);
        }
      });
    }
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Array<[string, string]> = [];
  const recordMove = (oldP: string, newP: string): void => {
    moves.push([oldP, newP]);
  };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict, recordMove);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict, recordMove);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const moveByNew = new Map<string, string>();
  for (const [oldP, newP] of moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      moveByNew.set(newP, oldP);
    }
  }
  const coveredOld = new Set<string>([...moveByNew.values()]);
  const entries: { key: string; line: string }[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (coveredOld.has(p)) continue;
    if (moveByNew.has(p)) entries.push({ key: p, line: `R ${moveByNew.get(p)} -> ${p}` });
    else entries.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = entries.map((e) => e.line);
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
