#!/usr/bin/env node
/**
 * paths.js — 项目里那几个「约定位置」集中在这里，别在各处硬编码
 *
 * 整理后的目录约定：
 *
 *   F:\DSH workshop\listening-player\          电脑版 + 全部素材（项目本体）
 *   F:\DSH workshop\Whale-Lite-手机版\           手机要用的东西：APK + 补充包 + 安装说明
 *
 * 两条必须守住的规矩：
 *   ① **项目路径保持 ASCII**。build-apk.js 通过临时 .bat 调用 aapt2/apksigner，
 *      而 cmd 解析含中文的 .bat 会错位（见 HANDOFF 踩坑 1）。
 *      所以产物先落在 build/ 下的 ASCII 路径，再用 Node 的 fs 拷到中文目录。
 *   ② **补充包/APK 只认「手机版」目录**，但保留对旧位置（项目根）的兼容查找，
 *      免得老的构建脚本或手工放的文件突然找不到。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MOBILE_DIR = path.join(ROOT, '..', 'Whale-Lite-手机版');

/** 手机版目录不存在就建一个 */
function ensureMobileDir() {
  if (!fs.existsSync(MOBILE_DIR)) fs.mkdirSync(MOBILE_DIR, { recursive: true });
  return MOBILE_DIR;
}

/** 找产物：先看手机版目录，再退回项目根（兼容旧位置） */
function resolveDeliverable(name) {
  const mobile = path.join(MOBILE_DIR, name);
  if (fs.existsSync(mobile)) return mobile;
  const legacy = path.join(ROOT, name);
  if (fs.existsSync(legacy)) return legacy;
  return mobile;    // 默认给手机版目录下的路径（构建时用它当目标）
}

/** 列出所有补充包（手机版目录 + 项目根） */
function findPacks() {
  const out = [];
  for (const dir of [MOBILE_DIR, ROOT]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.toLowerCase().endsWith('.lppack')) continue;
      const abs = path.join(dir, f);
      if (out.some((p) => path.basename(p) === f)) continue;   // 同名只取手机版那份
      out.push(abs);
    }
  }
  return out.sort();
}

module.exports = { ROOT, MOBILE_DIR, ensureMobileDir, resolveDeliverable, findPacks };
