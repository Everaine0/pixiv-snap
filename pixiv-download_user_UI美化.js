// ==UserScript==
// @name         Pixiv 一键下载器
// @namespace    https://github.com/Everaine0/pixiv-snap
// @version      1.0.0
// @description  在 Pixiv 作品页添加固定悬浮按钮，复用浏览器 Cookie 直接下载：插画多页自动打包 ZIP，动图下载帧包+帧时序JSON，小说下载为带元数据的 TXT。进度显示已优化为纯 x/x 格式。
// @author       Everaine0
// @match        https://www.pixiv.net/artworks/*
// @match        https://www.pixiv.net//artworks/*
// @match        https://www.pixiv.net/novel/show.php*
// @match        https://www.pixiv.net/novel/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      www.pixiv.net
// @connect      i.pximg.net
// @connect      *.pximg.net
// @run-at       document-idle
// @license      MIT
// ==/UserScript==
(function () {
'use strict';
/* ============================================================
配置
============================================================ */
const CONFIG = {
  position: 'bottom-right',
  margin: 24,
  zipNameTpl: '{title}',
  fileInZipTpl: '{title}_{index}',
  singleFileTpl: '{title}',
  ugoiraNameTpl: '{title}_ugoira',
  novelNameTpl: '{title}',
  concurrency: 3,
  imageTimeoutMs: 180000,
  zipTimeoutMs: 300000,
  showProgress: true,
};

const POS_CSS = {
  'bottom-right': { bottom: `${CONFIG.margin}px`, right: `${CONFIG.margin}px` },
  'bottom-left': { bottom: `${CONFIG.margin}px`, left: `${CONFIG.margin}px` },
  'top-right': { top: `${CONFIG.margin}px`, right: `${CONFIG.margin}px` },
  'top-left': { top: `${CONFIG.margin}px`, left: `${CONFIG.margin}px` },
};

/* ============================================================
通用工具
============================================================ */
function sanitizeFilename(name) {
  if (!name) return 'untitled';
  const cleaned = String(name)
    .replace(/[\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || /^(CON|PRN|AUX|NUL|COM\d|LPT\d)$/i.test(cleaned)) {
    return 'untitled';
  }
  return cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned;
}

function renderTpl(tpl, ctx) {
  return sanitizeFilename(
    tpl
      .replace(/{title}/g, ctx.title || '')
      .replace(/{id}/g, ctx.id || '')
      .replace(/{author}/g, ctx.author || '')
      .replace(/{index}/g, ctx.index != null ? ctx.index : '')
  );
}

function extractExt(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/(.[a-zA-Z0-9]+)$/);
    return m ? m[1].toLowerCase() : '.jpg';
  } catch (e) {
    return '.jpg';
  }
}

function padNum(n, total) {
  const len = String(total).length;
  return String(n).padStart(len, '0');
}

function gmXhr(opts) {
  const fn = (typeof GM_xmlhttpRequest !== 'undefined')
    ? GM_xmlhttpRequest
    : (typeof GM !== 'undefined' && GM.xmlHttpRequest) ? GM.xmlHttpRequest : null;
  if (!fn) return Promise.reject(new Error('GM_xmlhttpRequest 不可用，请检查脚本管理器权限'));
  return new Promise((resolve, reject) => {
    fn(Object.assign({}, opts, {
      onload: (res) => resolve(res),
      onerror: (err) => reject(new Error('网络请求失败: ' + (err && err.error ? err.error : 'unknown'))),
      ontimeout: () => reject(new Error('请求超时')),
      onabort: () => reject(new Error('请求被中止')),
    }));
  });
}

async function fetchJson(url) {
  const res = await gmXhr({
    method: 'GET',
    url,
    headers: {
      'Accept': 'application/json',
      'Referer': 'https://www.pixiv.net/',
      'X-User-Id': (document.cookie.match(/PHPSESSID=([^;]+)/) || [])[1] || '',
    },
    timeout: 30000,
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}: ${url}`);
  let data;
  try {
    data = typeof res.response === 'string' ? JSON.parse(res.response) : res.response;
  } catch (e) {
    throw new Error('JSON 解析失败: ' + url);
  }
  if (data.error) throw new Error('Pixiv AJAX 错误: ' + (data.message || '未知错误'));
  return data.body;
}

async function fetchBinary(url, onProgress, timeoutMs) {
  const res = await gmXhr({
    method: 'GET',
    url,
    headers: {
      'Referer': 'https://www.pixiv.net/',
      'Accept': 'image/*,*/*;q=0.8',
    },
    responseType: 'arraybuffer',
    timeout: timeoutMs || CONFIG.imageTimeoutMs,
    onprogress: onProgress ? (e) => onProgress(e.loaded, e.total) : undefined,
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`下载失败 HTTP ${res.status}: ${url}`);
  return res.response;
}

/* ============================================================
纯手写 ZIP 打包器（STORE 模式）
============================================================ */
const ZIP_CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = ZIP_CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function strToUtf8Bytes(str) { return new TextEncoder().encode(str); }
function dosTime(date) { return ((date.getHours() & 0x1F) << 11) | ((date.getMinutes() & 0x3F) << 5) | ((Math.floor(date.getSeconds() / 2)) & 0x1F); }
function dosDate(date) { return (((date.getFullYear() - 1980) & 0x7F) << 9) | (((date.getMonth() + 1) & 0x0F) << 5) | (date.getDate() & 0x1F); }

function zipWriteU16(arr, off, val) { arr[off] = val & 0xFF; arr[off + 1] = (val >>> 8) & 0xFF; }
function zipWriteU32(arr, off, val) { arr[off] = val & 0xFF; arr[off + 1] = (val >>> 8) & 0xFF; arr[off + 2] = (val >>> 16) & 0xFF; arr[off + 3] = (val >>> 24) & 0xFF; }

function buildZip(files, onProgress) {
  return new Promise((resolve, reject) => {
    try {
      if (!files || files.length === 0) return reject(new Error('无文件可打包'));
      const total = files.length;
      onProgress = onProgress || (() => {});
      onProgress(0);
      setTimeout(() => {
        try {
          const chunks = [];
          const centralEntries = [];
          let offset = 0;
          for (let i = 0; i < total; i++) {
            const file = files[i];
            const nameBytes = strToUtf8Bytes(file.name);
            const data = file.data;
            const crc = crc32(data);
            const now = new Date();
            const time = dosTime(now);
            const date = dosDate(now);
            const isUTF8 = /[\x00-\x7F]/.test(file.name) === false || /[^\x00-\x7F]/.test(file.name);

            const localHeader = new Uint8Array(30 + nameBytes.length);
            zipWriteU32(localHeader, 0, 0x04034b50);
            zipWriteU16(localHeader, 4, 20);
            zipWriteU16(localHeader, 6, isUTF8 ? 0x0800 : 0);
            zipWriteU16(localHeader, 8, 0);
            zipWriteU16(localHeader, 10, time);
            zipWriteU16(localHeader, 12, date);
            zipWriteU32(localHeader, 14, crc);
            zipWriteU32(localHeader, 18, data.length);
            zipWriteU32(localHeader, 22, data.length);
            zipWriteU16(localHeader, 26, nameBytes.length);
            zipWriteU16(localHeader, 28, 0);
            localHeader.set(nameBytes, 30);

            chunks.push(localHeader);
            chunks.push(data);
            const localHeaderOffset = offset;
            offset += localHeader.length + data.length;

            const centralHeader = new Uint8Array(46 + nameBytes.length);
            zipWriteU32(centralHeader, 0, 0x02014b50);
            zipWriteU16(centralHeader, 4, 20);
            zipWriteU16(centralHeader, 6, 20);
            zipWriteU16(centralHeader, 8, isUTF8 ? 0x0800 : 0);
            zipWriteU16(centralHeader, 10, 0);
            zipWriteU16(centralHeader, 12, time);
            zipWriteU16(centralHeader, 14, date);
            zipWriteU32(centralHeader, 16, crc);
            zipWriteU32(centralHeader, 20, data.length);
            zipWriteU32(centralHeader, 24, data.length);
            zipWriteU16(centralHeader, 28, nameBytes.length);
            zipWriteU16(centralHeader, 30, 0);
            zipWriteU16(centralHeader, 32, 0);
            zipWriteU16(centralHeader, 34, 0);
            zipWriteU16(centralHeader, 36, 0);
            zipWriteU32(centralHeader, 38, 0);
            zipWriteU32(centralHeader, 42, localHeaderOffset);
            centralHeader.set(nameBytes, 46);
            centralEntries.push(centralHeader);

            if ((i % 5 === 0) || i === total - 1) onProgress(Math.round(((i + 1) / total) * 90));
          }

          const centralOffset = offset;
          let centralSize = 0;
          for (const c of centralEntries) {
            chunks.push(c);
            centralSize += c.length;
            offset += c.length;
          }

          const eocd = new Uint8Array(22);
          zipWriteU32(eocd, 0, 0x06054b50);
          zipWriteU16(eocd, 4, 0);
          zipWriteU16(eocd, 6, 0);
          zipWriteU16(eocd, 8, centralEntries.length);
          zipWriteU16(eocd, 10, centralEntries.length);
          zipWriteU32(eocd, 12, centralSize);
          zipWriteU32(eocd, 16, centralOffset);
          zipWriteU16(eocd, 20, 0);
          chunks.push(eocd);

          onProgress(100);
          resolve(new Blob(chunks, { type: 'application/zip' }));
        } catch (err) { reject(err); }
      }, 30);
    } catch (e) { reject(e); }
  });
}

function abToU8(ab) { return ab instanceof Uint8Array ? ab : new Uint8Array(ab); }

function throttle(fn, intervalMs) {
  let lastCall = 0, pendingArg = null, scheduled = false;
  return function (arg) {
    const now = Date.now();
    pendingArg = arg;
    if (now - lastCall >= intervalMs) {
      lastCall = now;
      fn(pendingArg);
      pendingArg = null;
    } else if (!scheduled) {
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        lastCall = Date.now();
        if (pendingArg !== null) { const a = pendingArg; pendingArg = null; fn(a); }
      }, intervalMs - (now - lastCall));
    }
  };
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.style.display = 'none';
  document.body.appendChild(a); a.click();
  setTimeout(() => { if (a.parentNode) document.body.removeChild(a); URL.revokeObjectURL(url); }, 2000);
}

/* ============================================================
Pixiv Web API 封装
============================================================ */
async function getIllustInfo(id) { return fetchJson(`https://www.pixiv.net/ajax/illust/${id}`); }
async function getIllustPages(id) { return fetchJson(`https://www.pixiv.net/ajax/illust/${id}/pages`); }
async function getUgoiraMeta(id) { return fetchJson(`https://www.pixiv.net/ajax/illust/${id}/ugoira_meta`); }

// ---- 小说 API ----
async function getNovelInfo(id) { return fetchJson(`https://www.pixiv.net/ajax/novel/${id}?lang=zh`); }
async function getNovelText(id) {
  // 先尝试专用文本 API
  try {
    return await fetchJson(`https://www.pixiv.net/ajax/novel/${id}/text?lang=zh`);
  } catch (e) {
    // 回退：从详情中提取 content 字段
    const detail = await getNovelInfo(id);
    if (detail && detail.content) {
      return { novel_text: detail.content };
    }
    throw new Error('无法获取小说正文内容');
  }
}

/* ============================================================
页面类型检测 & ID 提取
============================================================ */
function getPageType() {
  const path = window.location.pathname;
  const search = window.location.search;
  if (/\/artworks\/\d+/.test(path)) return 'illust';
  if (/\/novel\//.test(path) || /novel\/show\.php/.test(path)) return 'novel';
  return null;
}

function getIllustIdFromUrl() {
  const m = window.location.pathname.match(/\/artworks\/(\d+)/);
  return m ? m[1] : null;
}

function getNovelIdFromUrl() {
  // /novel/show.php?id=12345 或 /novel/12345
  const searchMatch = window.location.search.match(/[?&]id=(\d+)/);
  if (searchMatch) return searchMatch[1];
  const pathMatch = window.location.pathname.match(/\/novel\/(\d+)/);
  if (pathMatch) return pathMatch[1];
  return null;
}

function getCurrentId() {
  const type = getPageType();
  if (type === 'illust') return getIllustIdFromUrl();
  if (type === 'novel') return getNovelIdFromUrl();
  return null;
}

/* ============================================================
下载核心逻辑
============================================================ */
async function mapWithConcurrency(items, worker, concurrency, onItemDone) {
  const results = new Array(items.length);
  let cursor = 0, done = 0;
  const n = Math.max(1, Math.min(concurrency, items.length));
  async function run() {
    while (cursor < items.length) {
      const idx = cursor++;
      let ok = false, value, error;
      try { value = await worker(items[idx], idx); ok = true; } catch (e) { error = e; }
      results[idx] = ok ? { ok: true, value } : { ok: false, error };
      done++;
      if (onItemDone) { try { onItemDone(done, items.length, idx); } catch (_) {} }
    }
  }
  const runners = [];
  for (let i = 0; i < n; i++) runners.push(run());
  await Promise.all(runners);
  return results;
}

async function downloadArtwork(id, onProgress) {
  onProgress({ stage: 'fetch-info', text: '获取作品信息…' });
  const info = await getIllustInfo(id);
  const ctx = {
    id, title: info.title || String(id), author: info.userName || 'unknown',
    userId: info.userId, illustType: info.illustType, pageCount: info.pageCount || 1,
    tags: (info.tags && info.tags.tags) ? info.tags.tags.map(t => t.tag) : [],
    url: `https://www.pixiv.net/artworks/${id}`,
  };
  if (ctx.illustType === 2) return downloadUgoira(ctx, onProgress);
  return downloadImages(ctx, onProgress);
}

async function downloadImages(ctx, onProgress) {
  onProgress({ stage: 'fetch-pages', text: '获取分页信息…' });
  const pages = await getIllustPages(ctx.id);
  if (!pages || pages.length === 0) throw new Error('未找到任何图片页面');

  if (pages.length === 1) {
    const url = pages[0].urls.original;
    if (!url) throw new Error('原图地址缺失');
    const ext = extractExt(url);
    const filename = renderTpl(CONFIG.singleFileTpl, ctx) + ext;
    onProgress({ stage: 'downloading', text: `下载中 1/1`, current: 0, total: 1 });
    const buf = await fetchBinary(url, undefined, CONFIG.imageTimeoutMs);
    triggerDownload(new Blob([buf]), filename);
    onProgress({ stage: 'done', text: '下载完成' });
    return { type: 'single', filename };
  }

  const total = pages.length;
  onProgress({ stage: 'downloading', text: `下载中 0/${total}`, current: 0, total });
  const fileMap = {}, fileOrder = [];
  let failCount = 0;
  const throttledProgress = throttle((p) => onProgress(p), 50);

  await mapWithConcurrency(
    pages,
    async (page, idx) => {
      const url = page.urls.original;
      if (!url) throw new Error(`第 ${idx + 1} 页原图地址缺失`);
      const buf = await fetchBinary(url, undefined, CONFIG.imageTimeoutMs);
      const ext = extractExt(url);
      const filename = renderTpl(CONFIG.fileInZipTpl, Object.assign({}, ctx, { index: padNum(idx + 1, total) })) + ext;
      fileMap[filename] = abToU8(buf);
      fileOrder.push({ idx, filename });
    },
    CONFIG.concurrency,
    (done) => {
      const doneCount = done - failCount;
      throttledProgress({ stage: 'downloading', text: `下载中 ${doneCount}/${total}${failCount ? ` (失败 ${failCount})` : ''}`, current: doneCount, total });
    }
  );

  failCount = total - fileOrder.length;
  if (fileOrder.length === 0) throw new Error(`所有 ${total} 页下载均失败`);

  const meta = { pixiv_id: ctx.id, title: ctx.title, author: { id: ctx.userId, name: ctx.author }, tags: ctx.tags, original_url: ctx.url, page_count: ctx.pageCount, illust_type: ctx.illustType, downloaded_at: new Date().toISOString(), source: 'Pixiv 一键下载器 v2.0' };
  const metaBytes = strToUtf8Bytes(JSON.stringify(meta, null, 2));
  const zipEntries = fileOrder.map((item) => ({ name: item.filename, data: fileMap[item.filename] }));
  zipEntries.push({ name: '_pixiv_metadata.json', data: metaBytes });

  onProgress({ stage: 'zipping', text: `打包中 ${zipEntries.length}/${zipEntries.length}`, current: zipEntries.length, total: zipEntries.length });
  await new Promise(r => setTimeout(r, 50));
  const zipBlob = await buildZip(zipEntries, () => {});

  const zipName = renderTpl(CONFIG.zipNameTpl, ctx) + '.zip';
  triggerDownload(zipBlob, zipName);
  onProgress({ stage: 'done', text: `下载完成（${fileOrder.length}/${total} 页）` });
  return { type: 'zip', filename: zipName, pages: fileOrder.length, failed: failCount };
}

async function downloadUgoira(ctx, onProgress) {
  onProgress({ stage: 'fetch-ugoira', text: '获取动图元数据…' });
  const meta = await getUgoiraMeta(ctx.id);
  const zipUrl = meta.originalSrc;
  if (!zipUrl) throw new Error('动图 zip 地址缺失');

  onProgress({ stage: 'downloading', text: '下载动图帧包 1/1', current: 0, total: 1 });
  const buf = await fetchBinary(zipUrl, undefined, CONFIG.imageTimeoutMs);

  const ugoiraName = renderTpl(CONFIG.ugoiraNameTpl, ctx) + '.zip';
  triggerDownload(new Blob([buf]), ugoiraName);

  const frames = (meta.frames || []).map(f => ({ file: f.file, delay: f.delay }));
  const frameInfo = {
    pixiv_id: ctx.id, title: ctx.title, author: { id: ctx.userId, name: ctx.author }, tags: ctx.tags,
    original_url: ctx.url, illust_type: 2, ugoira_zip: zipUrl, frames,
    downloaded_at: new Date().toISOString(),
    note: '使用本 JSON 与同名 _ugoira.zip，配合 ffmpeg / pillow 等工具可重打包为 gif/webp/mp4',
  };
  setTimeout(() => {
    triggerDownload(new Blob([JSON.stringify(frameInfo, null, 2)], { type: 'application/json' }), renderTpl(CONFIG.ugoiraNameTpl, ctx) + '_frames.json');
  }, 600);

  onProgress({ stage: 'done', text: '动图下载完成' });
  return { type: 'ugoira', filename: ugoiraName, frames: frames.length };
}

/* ============================================================
小说下载核心逻辑
============================================================ */
async function downloadNovel(id, onProgress) {
  onProgress({ stage: 'fetch-info', text: '获取小说信息…' });
  const info = await getNovelInfo(id);

  // 提取小说元数据
  const title = info.title || String(id);
  const author = info.userName || 'unknown';
  const userId = info.userId || '';
  const createDate = info.createDate || '';
  const tags = (info.tags && info.tags.tags) ? info.tags.tags.map(t => {
    if (t.translatedTag) return `${t.tag} (${t.translatedTag})`;
    return t.tag;
  }) : [];
  const description = info.description || '';
  const seriesId = info.seriesNavData ? info.seriesNavData.seriesId : null;
  const seriesTitle = info.seriesNavData ? info.seriesNavData.title : null;
  const wordCount = info.wordCount || 0;
  const bookmarkCount = info.bookmarkCount || 0;
  const novelUrl = `https://www.pixiv.net/novel/show.php?id=${id}`;

  onProgress({ stage: 'fetch-text', text: '获取小说正文…' });

  // 获取小说正文
  let novelText;
  try {
    const textData = await getNovelText(id);
    novelText = textData.novel_text || textData.body || '';
  } catch (e) {
    // 终极回退：尝试从 info.content 提取
    if (info.content) {
      novelText = info.content;
    } else {
      throw new Error('无法获取小说正文: ' + (e.message || String(e)));
    }
  }

  if (!novelText) throw new Error('小说正文为空');

  onProgress({ stage: 'building', text: '生成小说文件…' });

  // 构建带元数据头部的 TXT 内容
  const headerLines = [
    `Title: ${title}`,
    `Author: ${author}`,
    `Author ID: ${userId}`,
    `Tags: ${tags.join(', ') || 'None'}`,
    `Original URL: ${novelUrl}`,
    `Created: ${createDate ? new Date(createDate).toISOString() : 'Unknown'}`,
    `Word Count: ${wordCount}`,
    `Bookmarks: ${bookmarkCount}`,
  ];

  // 如果有系列信息，追加系列头
  if (seriesId && seriesTitle) {
    headerLines.push(`Series: ${seriesTitle} (ID: ${seriesId})`);
  }

  // 如果有简介，追加简介
  if (description) {
    headerLines.push('');
    headerLines.push(`Description: ${description}`);
  }

  headerLines.push('');
  headerLines.push('---');
  headerLines.push('');

  const content = headerLines.join('\n') + novelText;

  // 构建文件名
  const ctx = { id, title, author };
  const filename = renderTpl(CONFIG.novelNameTpl, ctx) + '.txt';

  // 下载 TXT 文件
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  triggerDownload(blob, filename);

  // 同时生成并下载元数据 JSON
  const pixivMetadata = {
    pixiv_id: Number(id),
    title: title,
    author: { id: userId, name: author },
    tags: (info.tags && info.tags.tags) ? info.tags.tags.map(t => ({ name: t.tag, translated_name: t.translatedTag || undefined })) : [],
    original_url: novelUrl,
    create_date: createDate,
    type: 'novel',
    word_count: wordCount,
    total_bookmarks: bookmarkCount,
    description: description || undefined,
    series: seriesId ? { id: seriesId, title: seriesTitle } : undefined,
    downloaded_at: new Date().toISOString(),
    source: 'Pixiv 一键下载器 v2.0',
  };

  // 清理 undefined 字段
  Object.keys(pixivMetadata).forEach(key => pixivMetadata[key] === undefined && delete pixivMetadata[key]);

  setTimeout(() => {
    const metaBlob = new Blob([JSON.stringify(pixivMetadata, null, 2)], { type: 'application/json' });
    triggerDownload(metaBlob, renderTpl(CONFIG.novelNameTpl, ctx) + '_metadata.json');
  }, 600);

  onProgress({ stage: 'done', text: '小说下载完成' });
  return { type: 'novel', filename, wordCount, title, author };
}

/* ============================================================
UI：悬浮按钮 + 可展开面板
============================================================ */
function injectStyles() {
  const css = `.pfd-root { position: fixed; ${Object.entries(POS_CSS[CONFIG.position]).map(([k, v]) =>`${k}: ${v};`).join(' ')} z-index: 2147483647; user-select: none; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
.pfd-btn { width: 52px; height: 52px; border-radius: 50%; background: linear-gradient(135deg, #0096fa 0%, #0073d6 100%); color: #fff; border: none; cursor: pointer; box-shadow: 0 4px 16px rgba(0,150,250,.35); display: flex; align-items: center; justify-content: center; transition: transform .2s, box-shadow .2s, background .25s; position: relative; }
.pfd-btn:hover { transform: scale(1.08); box-shadow: 0 6px 20px rgba(0,150,250,.5); } .pfd-btn:active { transform: scale(0.95); } .pfd-btn svg { width: 26px; height: 26px; fill: #fff; pointer-events: none; }
.pfd-btn.pfd-busy { background: linear-gradient(135deg, #9ca3af 0%, #6b7280 100%); cursor: wait; animation: pfd-pulse 1.6s infinite; } .pfd-btn.pfd-done { background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%); } .pfd-btn.pfd-error { background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); }
@keyframes pfd-pulse { 0%,100%{ box-shadow:0 0 0 0 rgba(0,150,250,.4); } 50%{ box-shadow:0 0 0 12px rgba(0,150,250,0); } }
.pfd-panel { position: absolute; right: 64px; bottom: 0; min-width: 280px; max-width: 380px; background: #fff; color: #333; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,.18); padding: 14px 16px; display: none; flex-direction: column; gap: 10px; animation: pfd-slidein .2s ease-out; }
@keyframes pfd-slidein { from { opacity:0; transform:translateX(10px); } to { opacity:1; transform:translateX(0); } }
.pfd-panel.pfd-open { display: flex; }
.pfd-title { font-size: 14px; font-weight: 600; color: #0096fa; display: flex; align-items: center; gap: 6px; } .pfd-title::before { content:''; display:inline-block; width:4px; height:14px; background:#0096fa; border-radius:2px; }
.pfd-row { display: flex; align-items: center; gap: 6px; font-size: 13px; color: #555; flex-wrap: wrap; } .pfd-row strong { color: #111; font-weight: 600; } .pfd-row .pfd-type-badge { display: inline-block; padding: 1px 7px; border-radius: 4px; font-size: 11px; font-weight: 500; background: #e8f4fd; color: #0096fa; } .pfd-row .pfd-type-badge.pfd-novel-badge { background: #fef3c7; color: #d97706; }
.pfd-novel-meta { font-size: 12px; color: #888; display: flex; flex-wrap: wrap; gap: 8px; padding: 4px 0; }
.pfd-novel-meta span { display: inline-flex; align-items: center; gap: 2px; }
.pfd-actions { display: flex; gap: 8px; flex-wrap: wrap; } .pfd-actions button { flex: 1; min-width: 110px; padding: 8px 10px; font-size: 13px; font-weight: 500; border: none; border-radius: 8px; cursor: pointer; color: #fff; background: #0096fa; transition: background .15s, transform .1s; display: flex; align-items: center; justify-content: center; gap: 4px; } .pfd-actions button:hover { background: #0073d6; } .pfd-actions button:active { transform: scale(0.97); } .pfd-actions button.pfd-secondary { background: #e8e8e8; color: #333; } .pfd-actions button.pfd-secondary:hover { background: #d8d8d8; } .pfd-actions button.pfd-novel-btn { background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); } .pfd-actions button.pfd-novel-btn:hover { background: linear-gradient(135deg, #d97706 0%, #b45309 100%); } .pfd-actions button:disabled { background: #ccc; cursor: not-allowed; }
.pfd-progress { width: 100%; height: 6px; background: #eee; border-radius: 3px; overflow: hidden; display: none; } .pfd-progress.pfd-show { display: block; } .pfd-progress > div { height: 100%; background: linear-gradient(90deg, #0096fa 0%, #0073d6 100%); width: 0; transition: width .25s; } .pfd-progress.pfd-novel-progress > div { background: linear-gradient(90deg, #f59e0b 0%, #d97706 100%); }
.pfd-log { max-height: 120px; overflow-y: auto; font-size: 12px; line-height: 1.5; background: #f7f7f9; border-radius: 6px; padding: 6px 8px; color: #666; display: none; } .pfd-log.pfd-show { display: block; } .pfd-log p { margin: 2px 0; } .pfd-log .pfd-err { color: #d63031; } .pfd-log .pfd-ok { color: #00b894; } .pfd-log .pfd-info { color: #555; }
.pfd-toggle { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #666; cursor: pointer; } .pfd-toggle input { margin: 0; cursor: pointer; }
.pfd-close { position: absolute; top: 8px; right: 8px; width: 22px; height: 22px; border: none; background: transparent; cursor: pointer; font-size: 16px; color: #999; line-height: 1; border-radius: 4px; transition: background .15s, color .15s; } .pfd-close:hover { color: #333; background: #f0f0f0; }
.pfd-badge { position: absolute; top: -4px; right: -4px; min-width: 18px; height: 18px; background: #ff3b30; color: #fff; border-radius: 9px; font-size: 11px; font-weight: 600; display: none; align-items: center; justify-content: center; padding: 0 5px; box-shadow: 0 2px 6px rgba(255,59,48,.4); } .pfd-badge.pfd-show { display: flex; }
.pfd-toast { position: fixed; left: 50%; bottom: 32px; transform: translateX(-50%) translateY(20px); background: rgba(17, 24, 39, 0.95); color: #fff; padding: 12px 20px; border-radius: 10px; font-size: 13.5px; z-index: 2147483647; box-shadow: 0 8px 28px rgba(0,0,0,.35); opacity: 0; transition: opacity .25s, transform .25s; max-width: 90vw; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; } .pfd-toast.pfd-show { opacity: 1; transform: translateX(-50%) translateY(0); } .pfd-toast.pfd-ok { background: rgba(22, 163, 74, 0.95); } .pfd-toast.pfd-err { background: rgba(220, 38, 38, 0.95); }`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
}

const ICON_DOWNLOAD_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a1 1 0 0 1 1 1v9.59l2.3-2.3a1 1 0 1 1 1.4 1.42l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.42L11 13.6V4a1 1 0 0 1 1-1zM5 19a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1z"/></svg>`;
const ICON_NOVEL_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6H6zm0 2h7v5h5v11H6V4zm9 .5L18.5 8H15V4.5z"/><path d="M8 12h8v1.5H8zm0 3h6v1.5H8z"/></svg>`;
const ILLUST_TYPE_MAP = { 0: '插画', 1: '漫画', 2: '动图' };

function createUI() {
  const root = document.createElement('div');
  root.className = 'pfd-root';
  root.innerHTML = `
    <div class="pfd-panel" id="pfd-panel">
      <button class="pfd-close" id="pfd-close" title="关闭">×</button>
      <div class="pfd-title">Pixiv 一键下载器</div>
      <div class="pfd-row" id="pfd-info">当前作品 ID: <strong>—</strong> · 类型: <span class="pfd-type-badge" id="pfd-type">—</span></div>
      <div class="pfd-novel-meta" id="pfd-novel-meta" style="display:none;"></div>
      <div class="pfd-actions" id="pfd-actions">
        <button id="pfd-dl-cur" title="下载当前作品的所有图片（含动图）">⬇️ 下载当前作品</button>
        <button class="pfd-secondary" id="pfd-dl-copy" title="复制作品 ID 到剪贴板">📋 复制 ID</button>
      </div>
      <div class="pfd-progress" id="pfd-progress"><div></div></div>
      <div class="pfd-log" id="pfd-log"></div>
      <label class="pfd-toggle"><input type="checkbox" id="pfd-t-showlog" checked> 显示详细日志</label>
      <label class="pfd-toggle"><input type="checkbox" id="pfd-t-autoclose"> 下载开始后自动收起面板</label>
    </div>
    <div class="pfd-badge" id="pfd-badge">!</div>
    <button class="pfd-btn" id="pfd-btn" title="Pixiv 一键下载器（点击展开）">${ICON_DOWNLOAD_SVG}</button>`;

  const $ = (id) => root.querySelector(`#${id}`);
  const $btn = $('pfd-btn'), $panel = $('pfd-panel'), $close = $('pfd-close'), $info = $('pfd-info'), $typeBadge = $('pfd-type');
  const $dlCur = $('pfd-dl-cur'), $dlCopy = $('pfd-dl-copy'), $progress = $('pfd-progress'), $progressBar = $progress.firstElementChild;
  const $log = $('pfd-log'), $badge = $('pfd-badge'), $showLog = $('pfd-t-showlog'), $autoClose = $('pfd-t-autoclose');
  const $novelMeta = $('pfd-novel-meta');

  const openPanel = () => $panel.classList.add('pfd-open');
  const closePanel = () => $panel.classList.remove('pfd-open');
  const togglePanel = () => $panel.classList.contains('pfd-open') ? closePanel() : openPanel();
  const setBusy = (busy) => { $btn.classList.toggle('pfd-busy', busy); $btn.disabled = busy; $dlCur.disabled = busy; };
  const setState = (state) => { $btn.classList.remove('pfd-busy', 'pfd-done', 'pfd-error'); if (state === 'busy') $btn.classList.add('pfd-busy'); else if (state === 'done') $btn.classList.add('pfd-done'); else if (state === 'error') $btn.classList.add('pfd-error'); };
  const setProgress = (pct, show) => { $progress.classList.toggle('pfd-show', show !== false); $progressBar.style.width = `${Math.max(0, Math.min(100, pct * 100))}%`; };
  const clearLog = () => { $log.innerHTML = ''; $log.classList.remove('pfd-show'); };
  const appendLog = (text, type) => {
    const t = type || 'info';
    if (!$showLog.checked && t !== 'err' && t !== 'ok') return;
    $log.classList.add('pfd-show');
    const p = document.createElement('p'); if (t) p.className = `pfd-${t}`;
    p.textContent = text; $log.appendChild(p); $log.scrollTop = $log.scrollHeight;
  };
  const setBadge = (show, text) => { $badge.classList.toggle('pfd-show', show); if (text != null) $badge.textContent = text; };

  // 更新面板信息——统一处理插画/小说
  const setInfo = (id, type, extra) => {
    const strong = $info.querySelector('strong');
    if (strong) strong.textContent = id || '—';

    // 根据页面类型切换按钮和样式
    if (type === 'novel') {
      $typeBadge.textContent = '小说';
      $typeBadge.className = 'pfd-type-badge pfd-novel-badge';
      $dlCur.className = 'pfd-novel-btn';
      $dlCur.innerHTML = `${ICON_NOVEL_SVG} 下载小说`;
      $dlCur.title = '下载小说为 TXT（含元数据头部）';
      $progress.classList.add('pfd-novel-progress');
      $btn.innerHTML = ICON_NOVEL_SVG;

      // 显示小说专属元数据
      if (extra) {
        $novelMeta.style.display = 'flex';
        $novelMeta.innerHTML = '';
        if (extra.wordCount) {
          const wc = document.createElement('span');
          wc.textContent = `📝 ${extra.wordCount} 字`;
          $novelMeta.appendChild(wc);
        }
        if (extra.bookmarkCount != null) {
          const bc = document.createElement('span');
          bc.textContent = `❤️ ${extra.bookmarkCount}`;
          $novelMeta.appendChild(bc);
        }
        if (extra.seriesTitle) {
          const sc = document.createElement('span');
          sc.textContent = `📚 ${extra.seriesTitle}`;
          $novelMeta.appendChild(sc);
        }
      }
    } else {
      $typeBadge.textContent = ILLUST_TYPE_MAP[type] || (type != null ? type : '—');
      $typeBadge.className = 'pfd-type-badge';
      $dlCur.className = '';
      $dlCur.innerHTML = '⬇️ 下载当前作品';
      $dlCur.title = '下载当前作品的所有图片（含动图）';
      $progress.classList.remove('pfd-novel-progress');
      $btn.innerHTML = ICON_DOWNLOAD_SVG;
      $novelMeta.style.display = 'none';
      $novelMeta.innerHTML = '';
    }
  };

  $btn.addEventListener('click', (e) => { e.stopPropagation(); togglePanel(); });
  $close.addEventListener('click', (e) => { e.stopPropagation(); closePanel(); });
  document.addEventListener('click', (e) => { if (!root.contains(e.target)) closePanel(); });
  $dlCopy.addEventListener('click', async () => {
    const id = getCurrentId();
    if (!id) { appendLog('当前页面不是作品页', 'err'); return; }
    try { await navigator.clipboard.writeText(id); appendLog(`已复制 ID: ${id}`, 'ok'); }
    catch (e) { const ta = document.createElement('textarea'); ta.value = id; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); appendLog(`已复制 ID: ${id}`, 'ok'); } catch (_) { appendLog('复制失败，请手动复制: ' + id, 'err'); } document.body.removeChild(ta); }
  });
  $showLog.addEventListener('change', () => { if (!$showLog.checked) { $log.querySelectorAll('p:not(.pfd-err):not(.pfd-ok)').forEach(p => p.remove()); if (!$log.children.length) $log.classList.remove('pfd-show'); } });
  $dlCur.addEventListener('click', () => { if ($btn.disabled) return; if ($autoClose.checked) closePanel(); handleDownload({ setBusy, setState, setProgress, appendLog, clearLog, setBadge }); });

  return { root, openPanel, closePanel, setInfo, setBusy, setState, setProgress, appendLog, clearLog, setBadge };
}

function showToast(text, type, duration) {
  const t = document.createElement('div');
  t.className = `pfd-toast ${type === 'ok' ? 'pfd-ok' : type === 'err' ? 'pfd-err' : ''}`;
  t.textContent = text; document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('pfd-show'));
  setTimeout(() => { t.classList.remove('pfd-show'); setTimeout(() => t.remove(), 300); }, duration || 3000);
}

let isDownloading = false;

async function handleDownload(ui) {
  if (isDownloading) return;
  const pageType = getPageType();
  const id = getCurrentId();
  if (!id || !pageType) { ui.appendLog('当前页面不是作品页', 'err'); ui.setBadge(true, '!'); showToast('当前页面不是作品页', 'err'); return; }

  isDownloading = true; ui.setBusy(true); ui.setState('busy'); ui.setProgress(0); ui.clearLog(); ui.setBadge(false);

  const typeLabel = pageType === 'novel' ? '小说' : '作品';
  ui.appendLog(`▶ 开始下载${typeLabel} ${id}`);

  try {
    let result;
    if (pageType === 'novel') {
      result = await downloadNovel(id, (p) => {
        let pct = 0;
        if (p.percent != null) pct = p.percent / 100;
        else if (p.total && p.current != null) pct = p.current / p.total;
        ui.setProgress(pct);
        if (p.text) {
          let type = 'info';
          if (p.stage === 'done') type = 'ok';
          ui.appendLog(p.text, type);
        }
      });
    } else {
      result = await downloadArtwork(id, (p) => {
        let pct = 0;
        if (p.percent != null) pct = p.percent / 100;
        else if (p.total && p.current != null) pct = p.current / p.total;
        ui.setProgress(pct);
        if (p.text) {
          let type = 'info';
          if (p.stage === 'done') type = 'ok';
          ui.appendLog(p.text, type);
        }
      });
    }

    ui.setProgress(1); ui.setState('done');
    let msg;
    if (result.type === 'novel') {
      msg = `✓ 完成：${result.filename}（${result.wordCount || '?'} 字）`;
    } else if (result.type === 'single') {
      msg = `✓ 完成：${result.filename}`;
    } else if (result.type === 'zip') {
      msg = `✓ 完成：${result.filename}（${result.pages} 页${result.failed ? `，失败 ${result.failed} 页` : ''}）`;
    } else if (result.type === 'ugoira') {
      msg = `✓ 完成：${result.filename}（${result.frames} 帧）`;
    }
    ui.appendLog(msg, 'ok');
    if (result.type === 'zip' && result.failed) ui.setBadge(true, String(result.failed));
    showToast(msg, 'ok', 4000);
    setTimeout(() => { if (window.$btnEl) { $btnEl.setState('idle'); $btnEl.setProgress(0, false); } }, 3000);
  } catch (err) {
    console.error('[Pixiv DL]', err);
    ui.setState('error');
    const errMsg = err && err.message ? err.message : String(err);
    ui.appendLog(`✗ 失败：${errMsg}`, 'err'); ui.setBadge(true, '!');
    showToast('下载失败：' + errMsg, 'err', 5000);
    setTimeout(() => { if (window.$btnEl) { $btnEl.setState('idle'); $btnEl.setProgress(0, false); } }, 3500);
  } finally { isDownloading = false; ui.setBusy(false); }
}

function watchUrlChange(onChange) {
  let last = window.location.href;
  const check = () => { if (window.location.href !== last) { last = window.location.href; onChange(); } };
  ['pushState', 'replaceState'].forEach((fn) => { const orig = history[fn]; history[fn] = function () { const ret = orig.apply(this, arguments); setTimeout(check, 0); return ret; }; });
  window.addEventListener('popstate', check);
  setInterval(check, 1000);
}

function isSupportedPage() {
  return /\/artworks\/\d+/.test(window.location.pathname) || /\/novel\//.test(window.location.pathname) || /novel\/show\.php/.test(window.location.pathname);
}

let $btnEl = null;

async function ensureButton() {
  if (!isSupportedPage()) { if ($btnEl && $btnEl.root && $btnEl.root.parentNode) $btnEl.root.parentNode.removeChild($btnEl.root); $btnEl = null; return; }
  if ($btnEl && document.body.contains($btnEl.root)) {
    const id = getCurrentId();
    const pageType = getPageType();
    if (id) {
      $btnEl.setInfo(id, pageType === 'novel' ? 'novel' : null);
      if (pageType === 'novel') {
        getNovelInfo(id).then(info => {
          if ($btnEl) $btnEl.setInfo(id, 'novel', {
            wordCount: info.wordCount,
            bookmarkCount: info.bookmarkCount,
            seriesTitle: info.seriesNavData ? info.seriesNavData.title : null,
          });
        }).catch(() => {});
      } else {
        getIllustInfo(id).then(info => { if ($btnEl) $btnEl.setInfo(id, info.illustType); }).catch(() => {});
      }
    }
    return;
  }
  $btnEl = createUI(); window.$btnEl = $btnEl;
  document.body.appendChild($btnEl.root);
  const id = getCurrentId();
  const pageType = getPageType();
  if (id) {
    $btnEl.setInfo(id, pageType === 'novel' ? 'novel' : null);
    if (pageType === 'novel') {
      getNovelInfo(id).then(info => {
        if ($btnEl) $btnEl.setInfo(id, 'novel', {
          wordCount: info.wordCount,
          bookmarkCount: info.bookmarkCount,
          seriesTitle: info.seriesNavData ? info.seriesNavData.title : null,
        });
      }).catch(() => {});
    } else {
      getIllustInfo(id).then(info => { if ($btnEl) $btnEl.setInfo(id, info.illustType); }).catch(() => {});
    }
  }
}

function init() {
  injectStyles(); ensureButton();
  watchUrlChange(() => { ensureButton(); if ($btnEl) { $btnEl.setState('idle'); $btnEl.setProgress(0, false); $btnEl.clearLog(); $btnEl.setBadge(false); } });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
})();
