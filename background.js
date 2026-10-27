/**
 * 图提取 ImageGrab · background (Manifest V3 Service Worker)
 * ------------------------------------------------------------
 * 职责：
 *   1. 接收 content.js 传来的图片列表，落到 chrome.storage.local；
 *   2. 打开 / 复用扩展内的 gallery.html 标签页；
 *   3. 接收画廊的下载请求：fetch 图片 → OffscreenCanvas 转 PNG → chrome.downloads 保存；
 *   4. 下载过程中用 IG_PROGRESS 消息回传进度，结束后回传结果。
 *
 * 说明：MV3 的 Service Worker 里没有 document，所以图片转码用
 *       createImageBitmap + OffscreenCanvas，而不是 DOM canvas。
 */

const STORAGE_KEY = 'ig:lastResult';
const GALLERY_PAGE = 'gallery.html';
const DEFAULT_PREFIX = '商品图';

/** 保存提取结果（画廊页面从这里读数据） */
async function saveResult(payload) {
  await chrome.storage.local.set({ [STORAGE_KEY]: payload });
}

/**
 * 清理文件名前缀：去掉路径分隔符与 Windows 非法字符，避免下载落盘失败。
 * 空字符串时回落到默认「商品图」。
 */
function sanitizePrefix(raw) {
  const cleaned = String(raw || '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 40);
  return cleaned || DEFAULT_PREFIX;
}

/**
 * 打开画廊页；已经开着就切回去。
 * 注意：chrome.tabs.query 按 url 过滤需要 "tabs" 权限（会多一条权限提示），
 * 这里改用「记住 tabId + tabs.get 校验」的方式，避免多申请权限。
 */
async function openGallery() {
  const url = chrome.runtime.getURL(GALLERY_PAGE);
  const { igGalleryTabId } = await chrome.storage.local.get('igGalleryTabId');
  if (igGalleryTabId) {
    try {
      await chrome.tabs.get(igGalleryTabId);
      await chrome.tabs.update(igGalleryTabId, { active: true, url });
      return igGalleryTabId;
    } catch (err) {
      // 标签页已被关掉，走下面的新建流程
    }
  }
  const tab = await chrome.tabs.create({ url });
  await chrome.storage.local.set({ igGalleryTabId: tab.id });
  return tab.id;
}

/** Blob → data URL（Service Worker 里没有 FileReader 也能用的写法） */
async function blobToDataUrl(blob) {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buffer.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, buffer.subarray(i, i + CHUNK));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

/**
 * 把任意格式（jpg / webp / png / gif）的图片转成 PNG 的 data URL。
 * 跨域图片在这里用扩展权限 fetch，绕开页面 canvas 的跨域限制。
 */
async function toPngDataUrl(imageUrl) {
  const res = await fetch(imageUrl, { credentials: 'omit', cache: 'force-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  if (!blob.size) throw new Error('图片内容为空');
  if (blob.type === 'image/png') {
    // 本来就是 PNG，直接返回，省一次解码
    return blobToDataUrl(blob);
  }
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建绘图上下文');
    ctx.drawImage(bitmap, 0, 0);
    const pngBlob = await canvas.convertToBlob({ type: 'image/png' });
    return blobToDataUrl(pngBlob);
  } finally {
    if (bitmap.close) bitmap.close();
  }
}

/** 序号补零：1 → 001 */
function padIndex(n) {
  return String(n).padStart(3, '0');
}

/** 从 URL 猜一个扩展名，只在少数转码失败时兜底用 */
function guessExt(imageUrl) {
  const match = /\.(jpe?g|png|webp|gif|bmp|avif)(?:[?#]|$)/i.exec(decodeURIComponent(imageUrl));
  return match ? match[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
}

/** 给画廊页回传进度（没有接收者时静默失败） */
function postProgress(payload) {
  chrome.runtime.sendMessage({ type: 'IG_PROGRESS', payload }).catch(() => {});
}

/**
 * 批量下载。
 * 每张图都尝试转 PNG；转码失败（极端防盗链）时退化为下载原图，并在结果里标注。
 * @param {Array<{url:string}>} items
 * @param {string} [prefix] 文件名前缀，默认「商品图」
 */
async function downloadBatch(items, prefix) {
  const total = items.length;
  const failures = [];
  let okCount = 0;
  const namePrefix = sanitizePrefix(prefix);

  for (let i = 0; i < total; i += 1) {
    const item = items[i];
    const index = i + 1;
    const baseName = `${namePrefix}_${padIndex(index)}`;
    // 开始处理第 index 张前先报进度（done = 已完成数）
    postProgress({ done: i, total, current: item.url, ok: okCount, fail: failures.length });

    try {
      const dataUrl = await toPngDataUrl(item.url);
      await chrome.downloads.download({
        url: dataUrl,
        filename: `${baseName}.png`,
        conflictAction: 'uniquify',
        saveAs: false
      });
      okCount += 1;
    } catch (err) {
      // 兜底：直接下载原图（至少不让用户空手而归），文件名保留原扩展名
      try {
        await chrome.downloads.download({
          url: item.url,
          filename: `${baseName}_原图.${guessExt(item.url)}`,
          conflictAction: 'uniquify',
          saveAs: false
        });
        okCount += 1;
        failures.push({ url: item.url, reason: `未能转 PNG，已下载原图（${err.message || err}）` });
      } catch (err2) {
        failures.push({ url: item.url, reason: String(err2.message || err2) });
      }
    }

    // 每张处理完立刻回传，画廊进度条才能实时往前走
    postProgress({ done: index, total, current: item.url, ok: okCount, fail: failures.length });
  }

  postProgress({ done: total, total, ok: okCount, fail: failures.length, finished: true });
  return { ok: okCount, fail: failures.length, total, failures };
}

// ---------------- 消息路由 ----------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message && message.type;

  if (type === 'IG_EXTRACTED') {
    (async () => {
      try {
        await saveResult(message.payload);
        await openGallery();
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();
    return true; // 异步响应
  }

  if (type === 'IG_DOWNLOAD') {
    (async () => {
      try {
        const payload = message.payload || {};
        const items = payload.items || [];
        if (!items.length) {
          sendResponse({ ok: true, result: { ok: 0, fail: 0, total: 0, failures: [] } });
          return;
        }
        const result = await downloadBatch(items, payload.prefix);
        sendResponse({ ok: true, result });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();
    return true;
  }

  if (type === 'IG_OPEN_GALLERY') {
    (async () => {
      try {
        await openGallery();
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  return false;
});

/** 点击工具栏图标：直接打开上一次提取的图库 */
chrome.action.onClicked.addListener(async () => {
  await openGallery();
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[ImageGrab] 安装完成：打开商品详情页，点击右下角「获取图片」试试。');
});
