/**
 * 图提取 ImageGrab · content script
 * ------------------------------------------------------------
 * 职责：
 *   1. 判断当前是不是「淘宝/天猫、京东、拼多多商家版」的商品详情页；
 *   2. 是的话在右下角注入一个悬浮按钮「获取图片」；
 *   3. 点击后扫描页面里所有商品图（含懒加载属性、srcset、背景图），
 *      过滤图标/logo/占位图/小图，补全绝对地址并去重；
 *   4. 通过 chrome.runtime.sendMessage 把图片列表交给 background，
 *      由 background 打开新页面 gallery.html 集中展示。
 *
 * 注意：本文件运行在页面上下文（隔离环境），不要直接操作扩展 API 之外的东西。
 */
(function () {
  'use strict';

  // 防止同一页面被重复注入
  if (window.__imageGrabInjected) return;
  window.__imageGrabInjected = true;

  // ---------- 可调参数 ----------
  const MIN_SIDE = 100;            // 最短边小于 100 像素的一律当成图标/占位图丢弃
  const MAX_IMAGES = 200;          // 单次最多回传的图片数量，避免极端页面卡死
  const PROBE_LIMIT = 120;         // 最多对多少张「尺寸未知」的图片做探测
  const PROBE_CONCURRENCY = 6;     // 探测并发数
  const PROBE_TIMEOUT = 6000;      // 单张探测超时（毫秒）
  const DEEP_SCAN_STEPS = 10;      // 懒加载兜底：最多向下滚动多少屏
  const DEEP_SCAN_DELAY = 260;     // 每次滚动后的等待时间（毫秒）

  // 明显不是商品图的 URL 特征
  const BLOCK_PATTERN = /(sprite|icon|logo|avatar|favicon|placeholder|spacer|blank|loading|qrcode|erweima|1x1|holder)/i;

  // 支持的平台：hostname 匹配 + 详情页路径判断
  const PLATFORMS = [
    {
      key: 'taobao',
      name: '淘宝/天猫',
      host: /(^|\.)(taobao|tmall)\.com$/i,
      // item.taobao.com/item.htm、detail.tmall.com/item.htm、chaoshi.detail.tmall.com...
      page: /(item|detail|goods)/i
    },
    {
      key: 'jd',
      name: '京东',
      host: /(^|\.)jd\.com$/i,
      // item.jd.com/100012043978.html、item.m.jd.com/product/xxx.html、shop.jd.com/...
      page: /(\/\d+\.html|\/product\/|\/ware\/|shop\.jd\.com)/i
    },
    {
      key: 'pdd',
      name: '拼多多商家版',
      host: /(^|\.)(pinduoduo|yangkeduo)\.com$/i,
      // mobile.yangkeduo.com/goods.html?goods_id=xxx、mobile.pinduoduo.com/goods.html...
      page: /(goods|product|detail)/i
    }
  ];

  /** 当前页面属于哪个平台（不在三个平台内返回 null） */
  function detectPlatform() {
    const host = location.hostname;
    return PLATFORMS.find((p) => p.host.test(host)) || null;
  }

  /** 是否为「商品详情页」——只有详情页才注入按钮 */
  function isProductPage(platform) {
    if (!platform) return false;
    const target = location.hostname + location.pathname + location.search;
    return platform.page.test(target);
  }

  // ---------- 通用小工具 ----------

  /** 相对路径补全为绝对 URL，只保留 http/https */
  function toAbsolute(value, base) {
    if (!value) return '';
    const raw = String(value).trim().replace(/^['"]|['"]$/g, '');
    if (!raw || /^(data|blob|javascript|about):/i.test(raw)) return '';
    try {
      const url = new URL(raw, base || location.href);
      if (!/^https?:$/.test(url.protocol)) return '';
      return url.href;
    } catch (err) {
      return '';
    }
  }

  /** 从 srcset 中挑出最大的一张（取 width/height 描述符最大的） */
  function pickFromSrcset(srcset, base) {
    if (!srcset) return '';
    const items = srcset
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [url, descriptor] = part.split(/\s+/);
        const num = parseFloat(descriptor) || 0;
        return { url, weight: num };
      })
      .filter((it) => it.url);
    if (!items.length) return '';
    items.sort((a, b) => b.weight - a.weight);
    return toAbsolute(items[0].url, base);
  }

  /** 页面里图片地址的常见懒加载属性（不同平台写法不同，做兼容） */
  const LAZY_ATTRS = [
    'src',
    'data-src',
    'data-lazy-src',
    'data-original',
    'data-ks-lazyload',
    'data-lazyload',
    'data-lazy',
    'data-url',
    'data-image',
    'data-img'
  ];

  /**
   * 收集页面上的图片候选。
   * 返回 Map<url, {url, w, h}>，w/h 为 0 表示暂时未知。
   */
  function collectCandidates() {
    const found = new Map();

    const add = (url, w, h) => {
      if (!url) return;
      const known = found.get(url);
      if (known) {
        // 同一个 URL 出现多次时，保留已知的最大尺寸
        if (!known.w && w) {
          known.w = w;
          known.h = h;
        }
        return;
      }
      found.set(url, { url, w: w || 0, h: h || 0 });
    };

    // 1) <img> 标签：src / currentSrc / srcset / 各种懒加载属性
    document.querySelectorAll('img').forEach((img) => {
      const w = img.naturalWidth || 0;
      const h = img.naturalHeight || 0;
      if (img.currentSrc) add(toAbsolute(img.currentSrc), w, h);
      LAZY_ATTRS.forEach((attr) => {
        const val = img.getAttribute(attr);
        if (val) add(toAbsolute(val), w, h);
      });
      const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
      if (srcset) add(pickFromSrcset(srcset), w, h);
    });

    // 1b) <picture>/<source> 的 srcset（部分电商详情用响应式图源）
    document.querySelectorAll('picture source[srcset], source[data-srcset]').forEach((source) => {
      const srcset = source.getAttribute('srcset') || source.getAttribute('data-srcset');
      if (srcset) add(pickFromSrcset(srcset));
    });

    // 2) 背景图：只扫内联样式和常见图片容器，避免全量遍历导致卡顿
    const bgSelector =
      '[style*="background-image"],[class*="banner"],[class*="pic"],[class*="img"],[class*="photo"],[class*="detail"],[class*="desc"]';
    const bgNodes = document.querySelectorAll(bgSelector);
    const limit = Math.min(bgNodes.length, 3000);
    for (let i = 0; i < limit; i += 1) {
      const node = bgNodes[i];
      const bg = window.getComputedStyle(node).backgroundImage;
      if (!bg || bg.indexOf('url(') === -1) continue;
      const matches = bg.match(/url\((['"]?)(.*?)\1\)/g) || [];
      matches.forEach((match) => {
        const inner = match.replace(/^url\((['"]?)/, '').replace(/(['"]?)\)$/, '');
        add(toAbsolute(inner));
      });
    }

    return found;
  }

  /** 探测一张远程图片的真实尺寸（加载失败返回 0,0） */
  function probeSize(url) {
    return new Promise((resolve) => {
      const img = new Image();
      let settled = false;
      const finish = (w, h) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        img.onload = null;
        img.onerror = null;
        resolve({ w, h });
      };
      const timer = setTimeout(() => finish(0, 0), PROBE_TIMEOUT);
      img.onload = () => finish(img.naturalWidth || 0, img.naturalHeight || 0);
      img.onerror = () => finish(0, 0);
      // 不发送 referer，减少部分 CDN 的热链拦截
      img.referrerPolicy = 'no-referrer';
      img.decoding = 'async';
      img.src = url;
    });
  }

  /** 并发探测，返回补充了尺寸的列表 */
  async function enrichSizes(list) {
    const unknown = [];
    list.forEach((item) => {
      if (!item.w || !item.h) unknown.push(item);
    });

    const queue = unknown.slice(0, PROBE_LIMIT);
    let cursor = 0;

    async function worker() {
      while (cursor < queue.length) {
        const item = queue[cursor];
        cursor += 1;
        // eslint-disable-next-line no-await-in-loop
        const size = await probeSize(item.url);
        if (size.w && size.h) {
          item.w = size.w;
          item.h = size.h;
        }
      }
    }

    const workers = [];
    for (let i = 0; i < Math.min(PROBE_CONCURRENCY, queue.length); i += 1) {
      workers.push(worker());
    }
    await Promise.all(workers);
    return list;
  }

  /** 懒加载兜底：把页面滚到底再滚回顶部，触发懒加载图片 */
  async function deepScroll() {
    const startY = window.scrollY || 0;
    const step = Math.max(window.innerHeight * 0.9, 400);
    for (let i = 0; i < DEEP_SCAN_STEPS; i += 1) {
      window.scrollBy(0, step);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, DEEP_SCAN_DELAY));
      if (window.scrollY + window.innerHeight >= document.body.scrollHeight - 4) break;
    }
    window.scrollTo(0, startY);
    await new Promise((r) => setTimeout(r, 200));
  }

  /** 过滤 + 排序 + 截断 */
  function refine(list) {
    const refined = list.filter((item) => {
      if (!item.url) return false;
      if (BLOCK_PATTERN.test(item.url)) return false;
      // 尺寸已知且过小 → 丢；尺寸未知 → 保留（后面在画廊里显示"未知"）
      if (item.w && item.h && (item.w < MIN_SIDE || item.h < MIN_SIDE)) return false;
      return true;
    });
    refined.sort((a, b) => b.w * b.h - a.w * a.h);
    return refined.slice(0, MAX_IMAGES);
  }

  /** 完整扫描流程 */
  async function scanPage(platform) {
    // 先收一轮（含 data-src 等懒加载属性里已写好的地址）
    let list = Array.from(collectCandidates().values());
    const before = list.length;

    // 懒加载兜底：无论首屏有多少候选，都向下滚一遍再扫一次。
    // 电商详情页大量图只在进入视口后才写入 DOM / 替换 src；
    // 仅靠「候选 < 3」触发滚动，在首屏已有缩略图时会漏掉详情区大图。
    showStatus('正在滚动页面以触发懒加载…', 'info');
    await deepScroll();
    const again = collectCandidates();
    list = Array.from(again.values());
    if (list.length > before) {
      showStatus(`懒加载后又发现 ${list.length - before} 张，共 ${list.length} 张候选`, 'info');
    }

    await enrichSizes(list);
    return refine(list);
  }

  // ---------- 按钮 UI ----------

  let button = null;
  let statusEl = null;
  let scanning = false;

  function buildButton() {
    const wrap = document.createElement('div');
    wrap.id = 'imagegrab-widget';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ig-btn';
    btn.innerHTML = `
      <span class="ig-btn__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="4" width="18" height="16" rx="3"></rect>
          <circle cx="9" cy="10" r="1.6"></circle>
          <path d="M4 17l4.5-4.5 3.2 3.2 2.3-2.3L20 17"></path>
        </svg>
      </span>
      <span class="ig-btn__label">获取图片</span>
      <span class="ig-btn__spinner" aria-hidden="true"></span>
    `;
    btn.title = '图提取：扫描本页所有商品图';
    btn.addEventListener('click', onButtonClick);

    const status = document.createElement('div');
    status.className = 'ig-status';
    status.setAttribute('role', 'status');

    wrap.appendChild(btn);
    wrap.appendChild(status);
    document.documentElement.appendChild(wrap);

    button = btn;
    statusEl = status;
    return wrap;
  }

  function setButtonState(mode, text) {
    if (!button) return;
    button.dataset.state = mode;
    const label = button.querySelector('.ig-btn__label');
    if (label) label.textContent = text;
  }

  function showStatus(text, kind) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.dataset.kind = kind || 'info';
    statusEl.classList.add('is-visible');
    clearTimeout(showStatus._timer);
    showStatus._timer = setTimeout(() => statusEl.classList.remove('is-visible'), 4200);
  }

  async function onButtonClick() {
    if (scanning) return;
    const platform = detectPlatform();
    if (!platform) return;

    scanning = true;
    setButtonState('scanning', '扫描中…');
    showStatus('正在扫描页面图片，请稍候…', 'info');

    try {
      const images = await scanPage(platform);
      if (!images.length) {
        setButtonState('idle', '获取图片');
        showStatus('没找到可下载的商品图，试试先把详情页往下滚一滚', 'warn');
        return;
      }

      // 交给 background：保存列表 + 打开 gallery.html
      const result = await chrome.runtime.sendMessage({
        type: 'IG_EXTRACTED',
        payload: {
          images,
          pageUrl: location.href,
          pageTitle: document.title,
          platform: platform.name,
          ts: Date.now()
        }
      });

      if (result && result.ok) {
        setButtonState('done', `已获取 ${images.length} 张`);
        showStatus(`共 ${images.length} 张图片，已在新标签页打开「图提取」画廊`, 'success');
        setTimeout(() => setButtonState('idle', '获取图片'), 4000);
      } else {
        setButtonState('idle', '获取图片');
        showStatus('打开画廊失败，请重试', 'warn');
      }
    } catch (err) {
      setButtonState('idle', '获取图片');
      showStatus(`扫描出错：${err && err.message ? err.message : err}`, 'warn');
    } finally {
      scanning = false;
    }
  }

  // ---------- 挂载 / 卸载 ----------

  function mount() {
    if (document.getElementById('imagegrab-widget')) return;
    buildButton();
  }

  function unmount() {
    const node = document.getElementById('imagegrab-widget');
    if (node) node.remove();
    button = null;
    statusEl = null;
  }

  /** 单页应用（SPA）路由变化时重新判断是否需要显示按钮 */
  function sync() {
    const platform = detectPlatform();
    const visible = isProductPage(platform);
    if (visible) {
      if (!document.getElementById('imagegrab-widget')) mount();
    } else {
      unmount();
    }
  }

  // 首次判断
  sync();

  // 监听 SPA 路由变化 + DOM 重建（淘宝详情页会频繁重绘）
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      sync();
    } else if (!document.getElementById('imagegrab-widget') && isProductPage(detectPlatform())) {
      mount();
    }
  }, 1500);
})();
