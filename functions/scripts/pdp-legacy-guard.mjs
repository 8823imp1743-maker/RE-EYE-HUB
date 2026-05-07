/**
 * PDP 在庫: 曖昧な古い経路（no_size_but_buyable / getBodyStructuredText）の再導入をブロック。
 * お守り文は pdp-shoe-stock.js 先頭ブロック（import 前）内のみ可。
 * npm test から同梱。walk 対象は lib / api＋リポ api・index.js・lib のみ（scripts 自身は走査外）。
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const functionsRoot = join(__dir, '..');
const repoRoot = join(functionsRoot, '..');

const LEGACY = ['getBodyStructuredText', 'no_size_but_buyable'];

/** PDP fail-close と矛盾する曖昧捷の名前・文字列パターン（pdp-shoe-stock.js の先頭ブロックコメント以外） */
const FAIL_CLOSE_BANNED = [
  'isYahooSizeUrl',
  'yahoo_url_body',
  'yahoo_url_match',
  'rakuten_includes_assist',
  'rakuten_script_match',
  'fetch_fail_but_allow',
  'checkRakutenScript',
  'getBodyInlineScriptsText',
  'commerceHasStandaloneShoeCmToken',
  'text_match',
];
const CALL_SITE = /getBodyStructuredText\s*\(/g;

const SKIP_NAMES = new Set(['node_modules', '.git', 'dist', 'build']);

/**
 * @param {string} dir
 * @param {string[]} out
 */
async function walkJs(dir, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_NAMES.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      await walkJs(p, out);
    } else if (e.isFile()) {
      const ex = extname(e.name);
      if (ex === '.js' || ex === '.mjs' || ex === '.cjs') out.push(p);
    }
  }
}

/**
 * @param {string} absPath
 * @param {string} relHint
 * @param {string} reason
 */
function fail(absPath, relHint, reason) {
  console.error(`[pdp-legacy-guard] 阻止: ${reason} — ${relHint || absPath}`);
  process.exit(1);
}

function isTestFile(p) {
  return /\.test\.(m?js|jsx|cjs)$/.test(p) || /[\\/]__tests__[\\/]/.test(p);
}

/**
 * @param {boolean} [onlyCalls] テストファイルはコメントに禁止語が出るため呼び出し検査のみ
 */
function scanFileContent(absPath, baseForRel, relHint, onlyCalls) {
  const rel = relHint || relative(baseForRel, absPath) || absPath;
  return readFile(absPath, 'utf8').then((raw) => {
    if (!onlyCalls) {
      for (const s of LEGACY) {
        if (raw.includes(s)) fail(absPath, rel, `曖昧経路名 ${s} の出現`);
      }
    }
    const callMatches = raw.match(new RegExp(CALL_SITE.source, 'g'));
    if (callMatches && callMatches.length) {
      fail(absPath, rel, 'structured 本文抽出の旧呼び出しが存在');
    }
  });
}

/**
 * 先頭ブロックコメントの閉じ行（* とスラッシュだけの行）の次行からをコード扱い
 * @param {string[]} lines
 */
function codeAfterFirstBlockClose(lines) {
  const cap = 80;
  const idx = lines.findIndex(
    (l, i) => i < cap && /^\s*\*\/\s*$/.test(l)
  );
  if (idx < 0) return { code: lines.join('\n'), firstCodeLine1: 1 };
  let s = idx + 1;
  while (s < lines.length && lines[s].trim() === '') s++;
  return { code: lines.slice(s).join('\n'), firstCodeLine1: s + 1 };
}

/**
 * pdp-shoe-stock.js: 先頭ブロック外にレガシー名不可
 * @param {string} absPath
 */
function scanPdpMain(absPath) {
  const rel = relative(functionsRoot, absPath) || absPath;
  return readFile(absPath, 'utf8').then((raw) => {
    const lines = raw.split(/\n/);
    const { code, firstCodeLine1 } = codeAfterFirstBlockClose(lines);
    for (const term of LEGACY) {
      if (code.includes(term)) {
        fail(
          absPath,
          rel,
          term + ' が L' + firstCodeLine1 + ' 以降（先頭ブロックコメント外に不可）'
        );
      }
    }
    for (const term of FAIL_CLOSE_BANNED) {
      if (code.includes(term)) {
        fail(
          absPath,
          rel,
          `fail-close 違反: ${term}（曖昧捷の復活） が L${firstCodeLine1} 以降`
        );
      }
    }
    const callMatches = code.match(new RegExp(CALL_SITE.source, 'g'));
    if (callMatches && callMatches.length) {
      fail(absPath, rel, 'structured 本文抽出の旧呼び出しがお守り外');
    }
  });
}

function fileExists(p) {
  return stat(p)
    .then((s) => s.isFile())
    .catch(() => false);
}

function runPdpLegacyGuard() {
  const inFunctions = [];
  const pdpMain = join(functionsRoot, 'lib', 'pdp-shoe-stock.js');

  const jobs = (async () => {
    for (const sub of ['lib', 'api']) {
      await walkJs(join(functionsRoot, sub), inFunctions);
    }
    const inRoot = [];
    await walkJs(join(repoRoot, 'api'), inRoot).catch(() => {});
    if (await fileExists(join(repoRoot, 'index.js'))) inRoot.push(join(repoRoot, 'index.js'));
    await walkJs(join(repoRoot, 'lib'), inRoot).catch(() => {});

    if (await fileExists(pdpMain)) {
      await scanPdpMain(pdpMain);
    }

    for (const p of inFunctions) {
      if (p.endsWith('pdp-shoe-stock.js')) continue;
      await scanFileContent(p, functionsRoot, '', isTestFile(p));
    }
    for (const p of inRoot) {
      await scanFileContent(p, repoRoot, '', isTestFile(p));
    }
  })();

  return jobs;
}

runPdpLegacyGuard().catch((e) => {
  console.error(e);
  process.exit(1);
});
