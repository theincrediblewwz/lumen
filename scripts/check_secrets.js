#!/usr/bin/env node
/**
 * check_secrets.js — 提交前密钥扫描（兜底防线）
 *
 * 为什么需要它：.gitignore 只能挡住「未跟踪」的文件，挡不住
 *   1) git add -f 强制添加
 *   2) 先提交、后加入 .gitignore 的文件（已被跟踪，忽略规则无效）
 *   3) 硬编码进源码的密钥
 *
 * 用法：
 *   node scripts/check_secrets.js          # 检查暂存区 + 已跟踪文件
 *   node scripts/check_secrets.js --staged # 只检查暂存区
 *
 * 退出码：0 = 通过；1 = 发现疑似密钥，请勿提交。
 */
import { execFileSync } from 'node:child_process';

/** 需要真实密钥特征的模式（避免误伤文档中的示例文字） */
const PATTERNS = [
  { name: 'OpenAI API Key', re: /sk-[A-Za-z0-9]{20,}/, hint: '以 sk- 开头且后接 20 位以上随机串' },
  { name: 'Anthropic API Key', re: /sk-ant-[A-Za-z0-9_-]{20,}/, hint: 'sk-ant- 前缀' },
  { name: 'GitHub Token', re: /gh[pousr]_[A-Za-z0-9]{30,}/, hint: 'ghp_/gho_/ghu_/ghs_/ghr_ 前缀' },
  { name: 'Slack Token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/, hint: 'xoxb-/xoxp- 等前缀' },
  { name: 'AWS Access Key', re: /AKIA[0-9A-Z]{16}/, hint: 'AKIA 前缀' },
  { name: '私钥', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/, hint: 'PEM 私钥头' },
  {
    name: '赋值型密钥',
    re: /(?:api[_-]?key|secret|passwd|password|token|bearer)\s*[:=]\s*['"][^'"\s]{16,}['"]/i,
    hint: '形如 api_key = "长串" 的硬编码',
  },
];

/** 这些路径不参与「内容扫描」（文档里会出现示例文字，属于正常） */
const SCAN_SKIP = (file) =>
  /\.md$/i.test(file) ||
  /(^|\/)(docs|scripts)\//.test(file) ||
  /\.env\.example$/i.test(file) ||
  /check_secrets\.js$/.test(file);

/** 这些路径一旦被跟踪/暂存就直接判失败（私密目录与 env） */
const FORBIDDEN_PATH = (file) =>
  /(^|\/)\.local\//.test(file) ||
  /(^|\/)\.env$/i.test(file) ||
  /(^|\/)\.env\.(?!example$)[^/]+$/i.test(file);

function git(args) {
  try {
    // stderr 静默：首次提交前 `git show HEAD:<file>` 必然失败，属预期情况
    return execFileSync('git', args, {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (e) {
    return null;
  }
}

function inRepo() {
  return git(['rev-parse', '--is-inside-work-tree']) !== null;
}

function main() {
  const onlyStaged = process.argv.includes('--staged');

  if (!inRepo()) {
    console.log('ℹ️  当前不在 git 仓库中，跳过检查。');
    process.exit(0);
  }

  const problems = [];

  // ---------- 1) 路径检查 ----------
  const staged = (git(['diff', '--cached', '--name-only', '--diff-filter=ACM']) || '')
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const tracked = onlyStaged ? [] : (git(['ls-files']) || '')
    .split('\n').map((s) => s.trim()).filter(Boolean);

  for (const f of new Set([...staged, ...tracked])) {
    if (FORBIDDEN_PATH(f)) {
      problems.push({ file: f, kind: '路径', name: '私密文件不该入库', detail: '.local/ 或 .env* 只能存在于本地' });
    }
  }

  // ---------- 2) 内容检查：暂存区 diff ----------
  const stagedDiff = git(['diff', '--cached']) || '';
  scanText('<暂存区 diff>', stagedDiff, problems, (line) => {
    // 只关心新增行
    return line.startsWith('+') && !line.startsWith('+++');
  });

  // ---------- 3) 内容检查：已跟踪文件（覆盖「先提交后忽略」的情况）----------
  if (!onlyStaged) {
    for (const f of tracked) {
      if (SCAN_SKIP(f) || FORBIDDEN_PATH(f)) continue;
      const content = readTracked(f);
      if (content) scanText(f, content, problems);
    }
  }

  // ---------- 输出 ----------
  if (problems.length === 0) {
    console.log('✅ 未发现疑似密钥，可以提交。');
    process.exit(0);
  }

  console.error(`\n❌ 发现 ${problems.length} 处疑似密钥/私密文件，请处理后重试：\n`);
  for (const p of problems) {
    console.error(`  · [${p.kind}] ${p.file}`);
    console.error(`    命中：${p.name}`);
    if (p.line) console.error(`    行 ${p.line}: ${p.snippet}`);
    if (p.detail) console.error(`    说明：${p.detail}`);
    console.error('');
  }
  console.error('处理建议：');
  console.error('  1) 把密钥移到 .local/ 目录（已 gitignore）');
  console.error('  2) 若文件已被跟踪：git rm --cached <file> 后重新忽略');
  console.error('  3) 若确为误报（如文档示例），调整 scripts/check_secrets.js 的 SCAN_SKIP\n');
  process.exit(1);
}

function readTracked(file) {
  try {
    const out = git(['show', `HEAD:${file}`]);
    if (out === null) return null;
    // 粗略判断二进制
    if (out.includes('\u0000')) return null;
    return out;
  } catch (e) {
    return null;
  }
}

function scanText(file, text, problems, lineFilter) {
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.replace(/^(\+|-)/, '');
    if (lineFilter && !lineFilter(raw)) return;
    for (const p of PATTERNS) {
      if (p.re.test(line)) {
        problems.push({
          file,
          kind: '内容',
          name: `${p.name}（${p.hint}）`,
          line: i + 1,
          snippet: line.trim().slice(0, 120),
        });
        break;
      }
    }
  });
}

main();
