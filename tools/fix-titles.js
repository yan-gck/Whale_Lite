#!/usr/bin/env node
/**
 * fix-titles.js — 修正资料包标题里缺失的空格
 *
 * 背景（一次真实的踩坑）：
 *   fetch-resources.js 生成美国国务院对话标题时写成了
 *       slug.replace(/_/g, ' ').replace(/\b\w/g, upper)
 *   但更早的版本是先做首字母大写再替换下划线，于是 "formal_greetings"
 *   变成 "FormalGreetings"（下划线紧贴字母，\b 匹配不到词边界）。
 *   脚本已修，这里把已经生成的 meta.json / .txt / .lrc 里的标题一并修正。
 *
 * 用法：node tools/fix-titles.js [--dry-run]
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const AUDIO_DIR = path.join(ROOT, 'audio');
const DRY = process.argv.includes('--dry-run');

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.opus', '.flac', '.webm', '.mp4']);

/**
 * 修正美国国务院对话标题里缺失的空格。
 *
 * ⚠️ 不要写成通用的"小写-大写交界处插空格"：
 *    那样会把 LibriSpeech 拆成 "Libri Speech"、LibriVox 拆成 "Libri Vox"
 *    （实测误改了 124 个标题）。这里只针对出问题的那一类标题，
 *    即形如 "美式英语对话 · 1-1 FormalGreetings" 的 slug 驼峰。
 */
function fixTitle(s) {
  const t = String(s);
  // 只处理「美式英语对话」前缀的标题
  if (!t.startsWith('美式英语对话')) return t;
  const m = /^(美式英语对话 · .*?)([A-Za-z].*)$/.exec(t);
  if (!m) return t;
  return t.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s{2,}/g, ' ').trim();
}

/** 旧的激进实现，保留作参考（不要用于全库） */
function fixSpacing(s) {
  return String(s)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function main() {
  console.log(DRY ? '模式：dry-run（不写文件）' : '模式：写入');
  console.log('');

  let fixed = 0;
  let scanned = 0;

  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.isFile() || !e.name.endsWith('.meta.json')) continue;

      scanned++;
      let meta;
      try { meta = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { continue; }

      const oldTitle = String(meta.title || '');
      const newTitle = fixTitle(oldTitle);
      if (newTitle === oldTitle) continue;

      console.log(`  ${path.basename(full)}`);
      console.log(`    旧：${oldTitle}`);
      console.log(`    新：${newTitle}`);

      if (!DRY) {
        meta.title = newTitle;
        fs.writeFileSync(full, JSON.stringify(meta, null, 2), 'utf8');

        // 同步 questions.json 里的 title
        const qPath = full.replace(/\.meta\.json$/, '.questions.json');
        if (fs.existsSync(qPath)) {
          try {
            const q = JSON.parse(fs.readFileSync(qPath, 'utf8'));
            if (q.title) { q.title = fixTitle(q.title); fs.writeFileSync(qPath, JSON.stringify(q, null, 2), 'utf8'); }
          } catch { /* 忽略 */ }
        }

        // 同步 .lrc 的 [ti:]
        const lrcPath = full.replace(/\.meta\.json$/, '.lrc');
        if (fs.existsSync(lrcPath)) {
          const lrc = fs.readFileSync(lrcPath, 'utf8')
            .replace(/^\[ti:.*\]$/m, `[ti:${newTitle}]`);
          fs.writeFileSync(lrcPath, lrc, 'utf8');
        }
      }
      fixed++;
    }
  };

  walk(AUDIO_DIR);

  console.log('');
  console.log(`扫描 ${scanned} 个 meta.json，修正 ${fixed} 个标题${DRY ? '（dry-run）' : ''}`);
  console.log('');
}

if (require.main === module) main();

module.exports = { fixTitle, fixSpacing };
