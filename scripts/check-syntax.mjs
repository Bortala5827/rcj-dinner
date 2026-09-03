// 语法门禁：npm run check
// 血泪教训：Pages 部署不做语法检查，一个跨行的单引号字符串就能让整个后台 JS 挂掉，
// 而 `git push` 成功 ≠ 代码正确。所以每次提交前必须跑这个。
//
// 检查范围：
//   1. functions/**/*.js  —— 按 ESM 校验（Pages Functions 是 module）
//   2. assets/**/*.js     —— 按 script 校验
//   3. *.html 里的内联 <script> —— 抽出来单独校验
//
// 额外扫两个常见的 AI 输出污染：跨行单引号字符串、CSS 值里混进裸标识符。

import { readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const tmp = mkdtempSync(join(tmpdir(), 'dinner-check-'));
let failures = 0;
let checked = 0;

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.git' || name.startsWith('.tmp')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function check(label, code, kind) {
  checked++;
  const file = join(tmp, 'c' + checked + (kind === 'module' ? '.mjs' : '.cjs'));
  writeFileSync(file, code, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log('  ok   ' + label);
  } catch (e) {
    failures++;
    const msg = (e.stderr ? e.stderr.toString() : e.message).split('\n').slice(0, 6).join('\n');
    console.log('  FAIL ' + label + '\n' + msg);
  }
}

const files = walk(ROOT);

console.log('[1] functions/**/*.js (ESM)');
for (const f of files) {
  const rel = relative(ROOT, f).replace(/\\/g, '/');
  if (rel.startsWith('functions/') && extname(f) === '.js') check(rel, readFileSync(f, 'utf8'), 'module');
}

console.log('[2] assets/**/*.js (script)');
for (const f of files) {
  const rel = relative(ROOT, f).replace(/\\/g, '/');
  if (rel.startsWith('assets/') && extname(f) === '.js') check(rel, readFileSync(f, 'utf8'), 'script');
}

console.log('[3] 内联 <script>');
for (const f of files) {
  if (extname(f) !== '.html') continue;
  const rel = relative(ROOT, f).replace(/\\/g, '/');
  const html = readFileSync(f, 'utf8');
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  let n = 0;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/.test(attrs)) continue;
    if (/type\s*=\s*["'](?!module|text\/javascript|application\/javascript)/i.test(attrs)) continue;
    n++;
    check(`${rel} <script#${n}>`, m[2], /type\s*=\s*["']module/i.test(attrs) ? 'module' : 'script');
  }
  if (!n) console.log('  --   ' + rel + ' (无内联脚本)');
}

console.log('[4] 污染扫描');
const CSS_BAD = /(color|background|border|fill)\s*:\s*#[0-9a-fA-F]*[g-zG-Z][0-9a-zA-Z]*/;
for (const f of files) {
  const ext = extname(f);
  if (!['.js', '.mjs', '.html', '.css'].includes(ext)) continue;
  const rel = relative(ROOT, f).replace(/\\/g, '/');
  const lines = readFileSync(f, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    if (CSS_BAD.test(line)) {
      failures++;
      console.log(`  FAIL ${rel}:${i + 1} 颜色值里有非法字符 → ${line.trim().slice(0, 90)}`);
    }
    // 单引号字符串未闭合且行尾不是续行符 → 大概率是跨行单引号
    const q = (line.match(/(^|[^\\])'/g) || []).length;
    if (q % 2 === 1 && /'[^']*$/.test(line) && !/\\$/.test(line) && !/\/\//.test(line)) {
      const tail = line.replace(/.*'/, '');
      if (/<[a-z]/i.test(tail)) {
        failures++;
        console.log(`  FAIL ${rel}:${i + 1} 疑似跨行单引号 HTML 字符串（请改用反引号）→ ${line.trim().slice(0, 90)}`);
      }
    }
  });
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n共检查 ${checked} 段代码，${failures} 处问题。`);
process.exit(failures ? 1 : 0);
