/**
 * 无浏览器环境下的冒烟测试：
 *   1) 用最小 DOM 桩运行 content.js，模拟点击「获取图片」，检查发给 background 的消息；
 *   2) 用 chrome API 桩运行 background.js，检查批量下载的文件名、进度消息、失败降级。
 * 运行：node test_extension.js
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let failures = 0;
function ok(cond, label, extra) {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${extra ? ' -> ' + JSON.stringify(extra) : ''}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- DOM 桩
function makeNode(tag) {
  const node = {
    tagName: (tag || 'div').toUpperCase(),
    children: [],
    attrs: {},
    dataset: {},
    style: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) this._s.add(c); else this._s.delete(c); },
      contains(c) { return this._s.has(c); }
    },
    listeners: {},
    textContent: '',
    innerHTML: '',
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
    appendChild(child) { this.children.push(child); child.parent = this; return child; },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    querySelector(sel) {
      if (sel === '.ig-btn__label') return this._label || (this._label = makeNode('span'));
      return null;
    },
    querySelectorAll() { return []; }
  };
  return node;
}

function makeImg(attrs, w, h) {
  const node = makeNode('img');
  node.attrs = attrs;
  node.naturalWidth = w || 0;
  node.naturalHeight = h || 0;
  node.currentSrc = attrs.src || '';
  return node;
}

function runContentScript() {
  const sent = [];
  const imgs = [
    makeImg({ src: '//img14.360buyimg.com/n0/jfs/t1/main.jpg' }, 800, 800),
    makeImg({ 'data-src': '//img14.360buyimg.com/n0/jfs/t1/lazy.webp', src: 'data:image/gif;base64,R0lGOD' }, 0, 0),
    makeImg({ src: 'https://img14.360buyimg.com/n0/jfs/t1/small_50x50.jpg' }, 50, 50),
    makeImg({ src: 'https://img14.360buyimg.com/n0/jfs/t1/sprite.png' }, 300, 300),
    makeImg({ src: '/relative/pic.png' }, 1200, 900)
  ];

  const widgetHolder = { children: [] };
  const document = {
    title: '测试商品 - 京东',
    body: { scrollHeight: 2000 },
    documentElement: { appendChild: (n) => { widgetHolder.children.push(n); document._widget = n; return n; } },
    getElementById: () => document._widget || null,
    querySelectorAll(sel) {
      if (sel === 'img') return imgs;
      return [];
    },
    createElement: makeNode,
    addEventListener() {}
  };

  const window = {
    scrollY: 0,
    innerHeight: 900,
    scrollBy() {},
    scrollTo() {},
    getComputedStyle: () => ({ backgroundImage: 'none' }),
    __imageGrabInjected: false
  };

  const location = {
    hostname: 'item.jd.com',
    pathname: '/100012043978.html',
    search: '',
    href: 'https://item.jd.com/100012043978.html'
  };

  const chrome = {
    runtime: {
      sendMessage(msg) {
        sent.push(msg);
        return Promise.resolve({ ok: true });
      }
    }
  };

  class FakeImage {
    constructor() { this.naturalWidth = 0; this.naturalHeight = 0; }
    set src(v) {
      this._src = v;
      setTimeout(() => {
        // 探测成功：给一个足够大的尺寸，让 lazy.webp 通过过滤
        this.naturalWidth = 1000;
        this.naturalHeight = 1000;
        if (this.onload) this.onload();
      }, 0);
    }
    get src() { return this._src; }
  }

  const code = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  const fn = new Function(
    'window', 'document', 'location', 'chrome', 'Image', 'setTimeout', 'clearTimeout', 'setInterval', 'URL',
    code
  );
  fn(window, document, location, chrome, FakeImage, setTimeout, clearTimeout, () => 1, URL);

  const widget = document._widget;
  const btn = widget.children.find((c) => c.tagName === 'BUTTON');
  return { widget, btn, sent, window };
}

async function testContent() {
  console.log('\n[1] content.js 冒烟测试');
  const { btn, sent } = runContentScript();
  ok(!!btn, '注入了「获取图片」按钮');
  ok(btn.innerHTML.includes('获取图片'), '按钮 HTML 内含「获取图片」文案');

  const clicks = btn.listeners.click || [];
  ok(clicks.length === 1, '按钮绑定了 click 处理器');

  await clicks[0]();
  // 扫描会执行 deepScroll（约 10×260ms）+ 尺寸探测，需轮询等待消息
  let extract = null;
  for (let i = 0; i < 80 && !extract; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await sleep(100);
    extract = sent.find((m) => m.type === 'IG_EXTRACTED');
  }
  ok(!!extract, '点击后向 background 发送了 IG_EXTRACTED');
  const images = extract ? extract.payload.images : [];
  ok(images.length === 3, '过滤后剩 3 张（小图/图标/1x1 被丢弃）', images.map((i) => i.url));
  ok(images.every((i) => /^https:\/\//.test(i.url)), '相对路径已补全为绝对 URL', images.map((i) => i.url));
  ok(images.some((i) => i.url.includes('lazy.webp')), '懒加载 data-src 被识别');
  ok(!images.some((i) => i.url.includes('50x50')), '50x50 小图被过滤');
  ok(!images.some((i) => i.url.includes('sprite')), 'sprite 图标被过滤');
  ok(
    images.every((img, i) => i === 0 || images[i - 1].w * images[i - 1].h >= img.w * img.h),
    '按面积从大到小排序',
    images.map((i) => [i.url.split('/').pop(), i.w, i.h])
  );
  ok(extract.payload.platform === '京东', '识别平台为京东', extract.payload.platform);
}

// ---------------------------------------------------------------- chrome 桩
function makeChromeStub(downloads, progress) {
  const storage = {};
  return {
    runtime: {
      onMessage: { addListener(fn) { this._fn = fn; }, _fn: null },
      onInstalled: { addListener() {} },
      sendMessage(msg) {
        progress.push(msg);
        return Promise.resolve();
      },
      getURL: (p) => 'chrome-extension://test/' + p
    },
    storage: {
      local: {
        get: async (key) => (key in storage ? { [key]: storage[key] } : {}),
        set: async (obj) => Object.assign(storage, obj)
      }
    },
    tabs: {
      create: async () => ({ id: 1 }),
      update: async () => ({}),
      get: async () => ({ id: 1 })
    },
    action: { onClicked: { addListener() {} } },
    downloads: {
      download: async (opts) => {
        downloads.push(opts);
        return downloads.length;
      }
    }
  };
}

function makeImageGlobals(failUrls) {
  const OffscreenCanvas = class {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return { drawImage() {} }; }
    async convertToBlob() { return new Blob([Buffer.from('png-bytes')], { type: 'image/png' }); }
  };
  const createImageBitmap = async (blob) => ({ width: 640, height: 480, close() {} });
  const fetchStub = async (url) => {
    if (failUrls.includes(url)) return { ok: false, status: 403, blob: async () => new Blob([]) };
    const type = /\.png/.test(url) ? 'image/png' : 'image/jpeg';
    return { ok: true, status: 200, blob: async () => new Blob([Buffer.from('img')], { type }) };
  };
  return { OffscreenCanvas, createImageBitmap, fetch: fetchStub };
}

async function testBackground() {
  console.log('\n[2] background.js 下载流程测试');
  const downloads = [];
  const progress = [];
  const chrome = makeChromeStub(downloads, progress);
  const { OffscreenCanvas, createImageBitmap, fetch } = makeImageGlobals([
    'https://img.alicdn.com/broken.jpg'
  ]);

  const code = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const fn = new Function(
    'chrome', 'fetch', 'OffscreenCanvas', 'createImageBitmap', 'btoa', 'Blob', 'console', 'URL',
    code
  );
  fn(chrome, fetch, OffscreenCanvas, createImageBitmap, btoa, Blob, console, URL);

  const handler = chrome.runtime.onMessage._fn;
  ok(typeof handler === 'function', '注册了 onMessage 监听');

  const send = (msg) => new Promise((resolve) => {
    handler(msg, {}, resolve);
  });

  const res1 = await send({
    type: 'IG_EXTRACTED',
    payload: { images: [{ url: 'https://img.360buyimg.com/a.jpg', w: 800, h: 800 }], pageUrl: 'https://item.jd.com/1.html', pageTitle: 't', platform: '京东' }
  });
  ok(res1 && res1.ok === true, 'IG_EXTRACTED 返回成功并打开画廊', res1);

  const res2 = await send({
    type: 'IG_DOWNLOAD',
    payload: {
      items: [
        { url: 'https://img.360buyimg.com/a.jpg' },
        { url: 'https://img.360buyimg.com/b.png' },
        { url: 'https://img.alicdn.com/broken.jpg' }
      ]
    }
  });

  ok(res2 && res2.ok === true, 'IG_DOWNLOAD 返回成功', res2);
  ok(downloads.length === 3, '依次触发了 3 次下载', downloads.map((d) => d.filename));
  ok(downloads[0].filename === '商品图_001.png', '文件名补零 001 + .png', downloads[0].filename);
  ok(downloads[1].filename === '商品图_002.png', '文件名为 商品图_002.png', downloads[1].filename);
  ok(
    downloads[0].url.startsWith('data:image/png;base64,') && downloads[1].url.startsWith('data:image/png;base64,'),
    '前两张转码为 PNG data URL',
    downloads.map((d) => d.url.slice(0, 24))
  );
  ok(res2.result.ok === 3, '成功计数为 3（含降级下载）', res2.result);
  ok(res2.result.fail === 1, '转码失败被记为 1 条降级', res2.result);
  ok(/原图/.test(downloads[2].filename), '失败项降级为「原图」下载', downloads[2].filename);

  const progressMsgs = progress.filter((m) => m.type === 'IG_PROGRESS');
  ok(progressMsgs.length >= 4, '回传了下载进度消息', progressMsgs.map((m) => m.payload.done));
  ok(progressMsgs[progressMsgs.length - 1].payload.finished === true, '最后一次进度带 finished 标记');

  const res3 = await send({ type: 'IG_DOWNLOAD', payload: { items: [] } });
  ok(res3.ok === true && res3.result.total === 0, '空列表不报错直接返回', res3);
}

(async () => {
  await testContent();
  await testBackground();
  console.log(`\n结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'}`);
  process.exit(failures === 0 ? 0 : 1);
})();
