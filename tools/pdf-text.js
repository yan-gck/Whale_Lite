#!/usr/bin/env node
/**
 * pdf-text.js — 从 PDF 抽取文本（基于 unpdf，正确处理子集化嵌入字体）
 *
 * 为什么不自己写解析器：
 *   教学类 PDF 常把字体子集化，内容流里的 (\037\036\035) 只是字形索引，
 *   必须查 /ToUnicode CMap 才能还原文字。自己实现要在「对象边界扫描、
 *   stream 关键字识别、CRLF、嵌套流」这些细节上反复踩坑，不值得。
 *   这里直接用 unpdf（pdf.js 的服务端封装）。
 *
 * 用法：
 *   node tools/pdf-text.js <file.pdf> [输出.txt]
 *   node tools/pdf-text.js <file.pdf> --pages=5    只取前 5 页
 *   node tools/pdf-text.js <file.pdf> --dump       打印每页字符数
 */

'use strict';

const fs = require('node:fs');

async function extractPdfText(file, { maxPages = 0 } = {}) {
  const { extractText, getDocumentProxy } = await import('unpdf');

  const buf = new Uint8Array(fs.readFileSync(file));
  const pdf = await getDocumentProxy(buf);
  const { text, totalPages } = await extractText(pdf, { mergePages: false });

  const pages = (Array.isArray(text) ? text : [text]).map((t, i) => ({
    num: i + 1,
    text: cleanText(String(t || '')),
  }));

  const used = maxPages > 0 ? pages.slice(0, maxPages) : pages;

  return {
    pages: used,
    text: used.map((p) => p.text).join('\n\n'),
    pageCount: used.length,
    totalPages,
  };
}

/** 整理排版：合并被 PDF 硬换行切断的行，压缩多余空行 */
function cleanText(t) {
  return t
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 按对话切分这本教材。
 *
 * 排版上的坑：
 *   · 目录里也全是 "Dialogue N-N: Title"，必须剔掉
 *   · 正文里标题有时排在对话【下方】，所以不能简单用"标题之间"当区间
 *     ——那样相邻两段会互相串味（实测 1-2 与 1-3 拿到同一段）
 *
 * 做法：先全文找出所有【说话人区块】（连续的大写说话人行），
 * 再把每个区块分配给离它最近的标题（优先取区块之后的标题，
 * 因为标题在对话下方时，紧跟其后的就是下一段的标题）。
 */
function splitDialogues(text) {
  const speakerRe = /^([A-Z][A-Z.'\- ]{1,24}):\s*(.+)$/;

  // 1) 全文扫描说话人行，聚成连续区块
  const lines = text.split('\n');
  const lineStart = [];
  let acc = 0;
  for (const l of lines) { lineStart.push(acc); acc += l.length + 1; }

  const blocks = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    const mm = speakerRe.exec(raw);
    if (mm) {
      if (!cur) cur = { startLine: i, endLine: i, lines: [] };
      cur.endLine = i;
      cur.lines.push(raw);
    } else if (cur) {
      // 允许少量非说话人短行夹在中间（PDF 换行残留），过长则视为区块结束
      if (raw.length <= 60 && !/^(LANGUAGE|NOTES|CULTURE|GRAMMAR|VOCABULARY)/.test(raw)) {
        cur.lines.push(raw);
        cur.endLine = i;
      } else {
        blocks.push(cur); cur = null;
      }
    }
  }
  if (cur) blocks.push(cur);

  // 只保留像样的对话区块（至少 2 行、且以说话人开头）
  const good = blocks.filter((b) => b.lines.filter((l) => speakerRe.test(l)).length >= 2);
  if (!good.length) return [];

  // 2) 全文找标题
  const headRe = /Dialogue\s+(\d+)\s*[-–.]\s*(\d+)\s*[:：]\s*([^\n]{2,80})/g;
  const marks = [];
  let m;
  while ((m = headRe.exec(text)) !== null) {
    marks.push({ index: m.index, num: `${m[1]}-${m[2]}`, title: m[3].trim() });
  }

  // 3) 区块 → 标题归属。
  //    标题通常在对话上方（少数在下方），所以优先取"区块之后最近的标题"，
  //    但必须距离够近（MAX_GAP）：否则会把区块错记到隔了好几段的标题上
  //    （实测 1-2 与 1-3 会因此拿到同一段）。太远就退回"之前最近的标题"。
  const MAX_GAP = 2600;
  const out = new Map();
  for (const b of good) {
    const bStart = lineStart[b.startLine];
    const bEnd = lineStart[b.endLine];

    let head = marks.find((mk) => mk.index >= bEnd && mk.index - bEnd <= MAX_GAP);
    if (!head) {
      const before = marks.filter((mk) => mk.index <= bStart);
      head = before[before.length - 1];
    }
    if (!head) continue;

    // 砍掉区块尾巴上串入的 "LANGUAGE NOTES" 等小节
    const stopRe = /^(LANGUAGE\s+NOTES|CULTURE\s+NOTES|GRAMMAR\s+NOTES|VOCABULARY|NOTES)\b/i;
    const cut = b.lines.findIndex((l) => stopRe.test(l.trim()));
    const keep = cut > 0 ? b.lines.slice(0, cut) : b.lines;

    const entry = {
      num: head.num,
      title: head.title,
      lines: keep,
      body: keep.join('\n'),
    };
    // 同一标题下多个区块时取行数最多的（目录/残片行数少）
    const prev = out.get(head.num);
    if (!prev || entry.lines.length > prev.lines.length) out.set(head.num, entry);
  }

  return [...out.values()].sort((a, b) => {
    const [an, am] = a.num.split('-').map(Number);
    const [bn, bm] = b.num.split('-').map(Number);
    return an - bn || am - bm;
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.log(`用法：node tools/pdf-text.js <file.pdf> [输出.txt] [选项]

选项：
  --pages=N   只处理前 N 页
  --dump      打印每页字符数与前 500 字符
  --split     按 "Dialogue N-N:" 切分并打印各段标题`);
    process.exit(1);
  }

  const file = args[0];
  if (!fs.existsSync(file)) { console.error('文件不存在：' + file); process.exit(1); }

  const pagesArg = args.find((a) => a.startsWith('--pages='));
  const maxPages = pagesArg ? Number(pagesArg.split('=')[1]) : 0;

  const res = await extractPdfText(file, { maxPages });

  if (args.includes('--dump')) {
    console.log(`总页数：${res.totalPages}，处理：${res.pageCount}`);
    res.pages.slice(0, 12).forEach((p) => console.log(`  第 ${p.num} 页: ${p.text.length} 字符`));
    console.log('--- 前 500 字符 ---');
    console.log(res.text.slice(0, 500));
  }

  if (args.includes('--split')) {
    const ds = splitDialogues(res.text);
    console.log(`\n切分出 ${ds.length} 段对话：`);
    ds.forEach((d) => console.log(`  ${d.num}  ${d.title}  (${d.body.length} 字符)`));
  }

  const outArg = args.find((a) => !a.startsWith('--') && a !== file);
  if (outArg) {
    fs.writeFileSync(outArg, res.text, 'utf8');
    console.log(`已写出 ${outArg}（${res.text.length} 字符）`);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('[error] ' + e.message); process.exit(1); });
}

module.exports = { extractPdfText, splitDialogues, cleanText };
