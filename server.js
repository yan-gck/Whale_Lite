#!/usr/bin/env node
/**
 * server.js — 听力播放器本地服务（仅 HTTP 层）
 *
 * 职责：
 *   1. 提供 /api/lessons、/api/lesson/<id> 课程接口
 *   2. 提供支持 HTTP Range 的音频流（拖动进度条必需）
 *   3. 托管 public/ 下的静态前端
 *
 * 为什么必须起服务，而不能直接双击 index.html：
 *   file:// 协议下 <audio> 无法发 Range 请求，浏览器也会因同源策略拒绝读取同目录的 .lrc。
 *
 * 素材扫描与解析逻辑在 lib/library.js。
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { AUDIO_EXT, MIME, buildLibrary, readFileMaybe } = require('./lib/library');

const ROOT = __dirname;
const AUDIO_DIR = path.join(ROOT, 'audio');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 4180);
const HOST = process.env.HOST || '127.0.0.1';

// ---------------------------------------------------------------- 响应工具

function sendJson(res, code, data) {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, code, text, type = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

/** 读取请求体并限制大小，防止被塞爆内存 */
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 支持 Range 的文件流；音视频拖动进度条依赖 206 响应 */
function sendFileWithRange(req, res, absPath, contentType) {
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return sendText(res, 404, 'Not found');
  }

  const total = stat.size;
  const range = req.headers.range;

  if (!range) {
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': total,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(absPath).pipe(res);
    return;
  }

  const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
  if (!m) {
    res.writeHead(416, { 'Content-Range': `bytes */${total}` });
    return res.end();
  }

  let start = m[1] === '' ? null : Number(m[1]);
  let end = m[2] === '' ? null : Number(m[2]);

  if (start === null && end === null) {
    res.writeHead(416, { 'Content-Range': `bytes */${total}` });
    return res.end();
  }
  if (start === null) {
    // 后缀范围：最后 N 字节
    start = Math.max(0, total - end);
    end = total - 1;
  } else if (end === null || end >= total) {
    end = total - 1;
  }

  if (start > end || start >= total) {
    res.writeHead(416, { 'Content-Range': `bytes */${total}` });
    return res.end();
  }

  res.writeHead(206, {
    'Content-Type': contentType,
    'Content-Range': `bytes ${start}-${end}/${total}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Cache-Control': 'no-cache',
  });

  const stream = fs.createReadStream(absPath, { start, end });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/** 把 URL 路径安全映射到 AUDIO_DIR，阻断 ../ 穿越 */
function safeAudioPath(relPath) {
  const abs = path.resolve(AUDIO_DIR, relPath);
  const rootWithSep = AUDIO_DIR.endsWith(path.sep) ? AUDIO_DIR : AUDIO_DIR + path.sep;
  if (abs !== AUDIO_DIR && !abs.startsWith(rootWithSep)) return null;
  return abs;
}

// ---------------------------------------------------------------- 路由

const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    // 用 WHATWG URL 而不是已废弃的 url.parse
    const reqUrl = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    pathname = decodeURIComponent(reqUrl.pathname || '/');
  } catch {
    return sendText(res, 400, 'Bad request');
  }

  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
    return sendText(res, 405, 'Method not allowed');
  }

  try {
    // ---- 手动修订原文 / 题目（用户在界面上改 OCR 与转写的错误）
    if (req.method === 'POST' && pathname === '/api/edit') {
      let body;
      try {
        body = JSON.parse((await readBody(req, 32 * 1024 * 1024)) || '{}');
      } catch {
        return sendJson(res, 400, { error: '请求体解析失败' });
      }
      try {
        const edit = require('./lib/edit');
        const { lessonId, what, lines, questions, action } = body;
        let out;
        if (action === 'revert') out = edit.revert(lessonId, what);
        else if (what === 'transcript') out = edit.saveTranscript(lessonId, lines);
        else if (what === 'questions') out = edit.saveQuestions(lessonId, questions);
        else return sendJson(res, 400, { error: 'what 必须是 transcript 或 questions' });
        return sendJson(res, 200, out);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    // ---- 导入资料：音频 / 原文 / 解析 / 原题（前端用文件选择器上传）
    if (req.method === 'POST' && pathname === '/api/import') {
      let payload;
      try {
        // 音频走 base64，体积大，放宽到 256 MB
        payload = JSON.parse((await readBody(req, 256 * 1024 * 1024)) || '{}');
      } catch {
        return sendJson(res, 400, { error: '请求体解析失败（可能过大）' });
      }
      try {
        const { handleImport } = require('./lib/import');
        const out = await handleImport({ root: ROOT, audioRoot: AUDIO_DIR, payload });
        return sendJson(res, 200, out);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    // ---- 前端探测到音频时长后回写缓存，
    //      这样课程列表不必等音频加载就能显示时长（用户导入的音频没有 .meta.json）
    if (req.method === 'POST' && pathname === '/api/duration') {
      let payload;
      try {
        payload = JSON.parse((await readBody(req, 4096)) || '{}');
      } catch {
        return sendJson(res, 400, { error: 'invalid json' });
      }

      const { id, duration } = payload;
      const secs = Number(duration);
      if (typeof id !== 'string' || !id || !Number.isFinite(secs) || secs <= 0 || secs > 86400) {
        return sendJson(res, 400, { error: 'invalid id or duration' });
      }

      // 只允许写 audio/ 下确实存在的课程，避免任意路径写入
      const lessons = await buildLibrary(AUDIO_DIR);
      if (!lessons.some((l) => l.manifest.id === id)) {
        return sendJson(res, 404, { error: 'lesson not found', id });
      }

      const abs = path.resolve(AUDIO_DIR, id);
      const rootWithSep = AUDIO_DIR.endsWith(path.sep) ? AUDIO_DIR : AUDIO_DIR + path.sep;
      if (!abs.startsWith(rootWithSep)) return sendJson(res, 403, { error: 'forbidden' });

      const base = abs.slice(0, abs.length - path.extname(abs).length);
      await fsp.writeFile(`${base}.duration`, secs.toFixed(2), 'utf8');
      return sendJson(res, 200, { ok: true, id, duration: secs });
    }

    // ---- API
    if (pathname === '/api/lessons') {
      const lessons = await buildLibrary(AUDIO_DIR);
      return sendJson(res, 200, {
        root: AUDIO_DIR,
        count: lessons.length,
        lessons: lessons.map((l) => l.manifest),
      });
    }

    if (pathname.startsWith('/api/lesson/')) {
      // pathname 已整体解码过一次，故此处 id 与 manifest.id 同形
      const id = pathname.slice('/api/lesson/'.length);
      const lessons = await buildLibrary(AUDIO_DIR);
      const found = lessons.find((l) => l.manifest.id === id || l.id === id);
      if (!found) return sendJson(res, 404, { error: 'lesson not found', id });
      return sendJson(res, 200, found);
    }

    // ---- 音频 / 字幕素材
    if (pathname.startsWith('/media/')) {
      const abs = safeAudioPath(pathname.slice('/media/'.length));
      if (!abs) return sendText(res, 403, 'Forbidden');
      const ext = path.extname(abs).toLowerCase();
      const type = MIME[ext] || 'application/octet-stream';
      if (AUDIO_EXT.has(ext)) return sendFileWithRange(req, res, abs, type);
      const text = readFileMaybe(abs);
      if (text == null) return sendText(res, 404, 'Not found');
      return sendText(res, 200, text, type);
    }

    // ---- 静态前端
    const rel = pathname === '/' ? '/index.html' : pathname;
    const abs = path.resolve(PUBLIC_DIR, '.' + rel);
    const pubRoot = PUBLIC_DIR.endsWith(path.sep) ? PUBLIC_DIR : PUBLIC_DIR + path.sep;
    if (abs !== PUBLIC_DIR && !abs.startsWith(pubRoot)) return sendText(res, 403, 'Forbidden');

    const stat = await fsp.stat(abs);
    if (stat.isDirectory()) return sendText(res, 404, 'Not found');
    const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    return sendFileWithRange(req, res, abs, type);
  } catch {
    return sendText(res, 404, 'Not found');
  }
});

// 仅在被直接执行时监听端口；被 require 时（例如测试里拿 server 实例）不自动监听
if (require.main === module) {
  server.listen(PORT, HOST, async () => {
    const lessons = await buildLibrary(AUDIO_DIR);
    const base = `http://${HOST}:${PORT}`;
    console.log('');
    console.log('  🎧  Whale Lite 已启动');
    console.log(`      地址：${base}`);
    console.log(`      素材目录：${AUDIO_DIR}`);
    console.log(`      已发现课程：${lessons.length} 个`);
    if (!lessons.length) {
      console.log('      （audio/ 为空，先运行：powershell -File tools/make-demo.ps1）');
    }
    console.log('');
  });
}

module.exports = { server, AUDIO_DIR, PUBLIC_DIR };
