/**
 * 图提取 ImageGrab · gallery.js
 * ------------------------------------------------------------
 * 画廊页逻辑：
 *   1. 从 chrome.storage.local 读出 content.js 传来的图片列表；
 *   2. 网格渲染 + 勾选 + 全选/反选 + 尺寸筛选 + 文件名前缀；
 *   3. 点「下载选中」把勾选的图片交给 background 转 PNG 并下载；
 *   4. 监听 background 回传的下载进度，实时更新进度条与结果提示。
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'ig:lastResult';

  const state = {
    images: [],
    selected: new Set(), // 存 URL，切换筛选条件时不丢勾选
    prefix: '商品图',
    minSide: 100,
    downloading: false
  };

  // ---------- DOM ----------
  const grid = document.getElementById('grid');
  const empty = document.getElementById('empty');
  const emptyTitle = document.getElementById('empty-title');
  const emptyDesc = document.getElementById('empty-desc');
  const sourceLabel = document.getElementById('source-label');
  const sourceLinkWrap = document.getElementById('source-link-wrap');
  const sourceLink = document.getElementById('source-link');
  const prefixInput = document.getElementById('prefix-input');
  const minSizeSelect = document.getElementById('min-size');
  const selectAllBtn = document.getElementById('select-all');
  const invertBtn = document.getElementById('invert');
  const selectedCount = document.getElementById('selected-count');
  const downloadBtn = document.getElementById('download');
  const progress = document.getElementById('progress');
  const progressFill = document.getElementById('progress-fill');
  const progressText = document.getElementById('progress-text');
  const toasts = document.getElementById('toasts');

  // ---------- 小工具 ----------

  function pad(n) {
    return String(n).padStart(3, '0');
  }

  function toast(message, kind) {
    const el = document.createElement('div');
    el.className = `toast${kind ? ` is-${kind}` : ''}`;
    el.textContent = message;
    toasts.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
      setTimeout(() => el.remove(), 240);
    }, 4200);
  }

  /** 当前筛选条件下可见的图片 */
  function visibleImages() {
    return state.images.filter((img) => {
      if (!img.w || !img.h) return true; // 尺寸未知的也展示
      return img.w >= state.minSide && img.h >= state.minSide;
    });
  }

  function visibleSelection() {
    return visibleImages().filter((img) => state.selected.has(img.url));
  }

  function updateCounts() {
    const count = visibleSelection().length;
    selectedCount.textContent = `已选 ${count} 张`;
    downloadBtn.disabled = count === 0 || state.downloading;
    downloadBtn.textContent = state.downloading ? '下载中…' : `下载选中${count ? `（${count}）` : ''}`;
  }

  // ---------- 渲染 ----------

  function renderSource(payload) {
    if (!payload) {
      sourceLabel.textContent = '等待提取结果…';
      return;
    }
    const pageTitle = (payload.pageTitle || '').trim();
    const platform = payload.platform || '';
    sourceLabel.textContent = `${platform} · ${pageTitle || payload.pageUrl || ''}`;
    sourceLabel.title = `${pageTitle}\n${payload.pageUrl || ''}`;

    if (payload.pageUrl) {
      sourceLink.href = payload.pageUrl;
      sourceLinkWrap.hidden = false;
    }
  }

  function render() {
    const list = visibleImages();
    grid.textContent = '';

    if (!state.images.length) {
      emptyTitle.textContent = '还没有提取到图片';
      emptyDesc.textContent = '请打开淘宝 / 京东 / 拼多多商家版的商品详情页，点击右下角「获取图片」。';
      empty.hidden = false;
      grid.hidden = true;
      updateCounts();
      return;
    }

    if (!list.length) {
      emptyTitle.textContent = '没有符合尺寸条件的图片';
      emptyDesc.textContent = '把顶部「最小尺寸」调小或选「不限」，就能看到全部图片。';
    }

    empty.hidden = list.length > 0;
    grid.hidden = list.length === 0;

    const fragment = document.createDocumentFragment();

    list.forEach((img, index) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.dataset.url = img.url;
      card.setAttribute('role', 'listitem');
      if (state.selected.has(img.url)) card.classList.add('is-selected');

      const thumb = document.createElement('label');
      thumb.className = 'card__thumb';

      const checkWrap = document.createElement('span');
      checkWrap.className = 'card__check';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = state.selected.has(img.url);
      checkbox.setAttribute('aria-label', `选择第 ${index + 1} 张图片`);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) state.selected.add(img.url);
        else state.selected.delete(img.url);
        card.classList.toggle('is-selected', checkbox.checked);
        updateCounts();
      });
      checkWrap.appendChild(checkbox);

      const pic = document.createElement('img');
      pic.src = img.url;
      pic.alt = `商品图 ${index + 1}`;
      pic.loading = 'lazy';
      pic.referrerPolicy = 'no-referrer';
      pic.addEventListener('error', () => {
        pic.style.opacity = '0.25';
        const badge = document.createElement('span');
        badge.className = 'card__badge';
        badge.textContent = '加载失败';
        card.appendChild(badge);
      });

      thumb.appendChild(checkWrap);
      thumb.appendChild(pic);

      const meta = document.createElement('div');
      meta.className = 'card__meta';

      const name = document.createElement('span');
      name.className = 'card__name';
      name.textContent = `${state.prefix}_${pad(index + 1)}.png`;

      const size = document.createElement('span');
      size.className = 'card__size';
      size.textContent = img.w && img.h ? `${img.w}×${img.h}` : '尺寸未知';

      meta.appendChild(name);
      meta.appendChild(size);
      card.appendChild(thumb);
      card.appendChild(meta);
      fragment.appendChild(card);
    });

    grid.appendChild(fragment);
    updateCounts();
  }

  // ---------- 事件 ----------

  selectAllBtn.addEventListener('click', () => {
    visibleImages().forEach((img) => state.selected.add(img.url));
    render();
  });

  invertBtn.addEventListener('click', () => {
    visibleImages().forEach((img) => {
      if (state.selected.has(img.url)) state.selected.delete(img.url);
      else state.selected.add(img.url);
    });
    render();
  });

  prefixInput.addEventListener('input', () => {
    const value = prefixInput.value.trim();
    state.prefix = value || '商品图';
    // 只刷新文件名，不重建整个网格
    grid.querySelectorAll('.card').forEach((card, index) => {
      const nameEl = card.querySelector('.card__name');
      if (nameEl) nameEl.textContent = `${state.prefix}_${pad(index + 1)}.png`;
    });
  });

  minSizeSelect.addEventListener('change', () => {
    state.minSide = Number(minSizeSelect.value) || 0;
    render();
  });

  downloadBtn.addEventListener('click', async () => {
    if (state.downloading) return;
    const items = visibleSelection().map((img) => ({ url: img.url, w: img.w, h: img.h }));
    if (!items.length) {
      toast('请先勾选要下载的图片', 'warn');
      return;
    }

    state.downloading = true;
    updateCounts();
    progress.hidden = false;
    progressFill.style.width = '0%';
    progressText.textContent = `0 / ${items.length}`;
    toast(`开始下载 ${items.length} 张图片，正在转换为 PNG…`);

    try {
      const res = await chrome.runtime.sendMessage({
        type: 'IG_DOWNLOAD',
        payload: { items, prefix: state.prefix }
      });
      if (!res || !res.ok) {
        toast(`下载失败：${(res && res.error) || '未知错误'}`, 'error');
        progress.hidden = true;
        return;
      }
      const { ok, fail, failures } = res.result;
      // 完成后把进度条留在 100%，文案显示结果；几秒后再收起，避免一闪而过
      progress.hidden = false;
      progressFill.style.width = '100%';
      progressText.textContent = fail === 0
        ? `全部完成：成功 ${ok} 张`
        : `完成：成功 ${ok} 张，失败/降级 ${fail} 张`;
      if (fail === 0) {
        toast(`全部完成：${ok} 张 PNG 已保存到浏览器默认下载目录`, 'ok');
      } else {
        toast(`完成：成功 ${ok} 张，失败/降级 ${fail} 张（详见下方提示）`, 'warn');
        failures.slice(0, 3).forEach((item) => toast(item.reason, 'warn'));
      }
      clearTimeout(downloadBtn._hideProgress);
      downloadBtn._hideProgress = setTimeout(() => {
        if (!state.downloading) progress.hidden = true;
      }, 3200);
    } catch (err) {
      toast(`下载出错：${err && err.message ? err.message : err}`, 'error');
      progress.hidden = true;
    } finally {
      state.downloading = false;
      updateCounts();
    }
  });

  // 监听 background 的进度消息
  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== 'IG_PROGRESS') return;
    const { done, total, ok, fail, finished } = message.payload || {};
    if (!total) return;
    const percent = Math.min(100, Math.round((done / total) * 100));
    progress.hidden = false;
    progressFill.style.width = `${percent}%`;
    progressText.textContent = finished
      ? `完成：成功 ${ok} 张，失败 ${fail} 张`
      : `${done} / ${total}（成功 ${ok || 0}）`;
  });

  // 画廊开着的时候，如果又从商品页提取了一次，自动刷新
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[STORAGE_KEY]) return;
    const payload = changes[STORAGE_KEY].newValue;
    if (!payload || !Array.isArray(payload.images)) return;
    loadPayload(payload, true);
  });

  // ---------- 初始化 ----------

  function loadPayload(payload, notify) {
    state.images = payload.images || [];
    state.selected.clear();
    // 默认全选，用户只需取消不要的
    state.images.forEach((img) => state.selected.add(img.url));
    renderSource(payload);
    render();
    if (notify) toast(`已更新：本次提取到 ${state.images.length} 张图片`, 'ok');
  }

  async function init() {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      const payload = stored && stored[STORAGE_KEY];
      if (payload && Array.isArray(payload.images)) {
        loadPayload(payload, false);
      } else {
        renderSource(null);
        render();
      }
    } catch (err) {
      renderSource(null);
      render();
      toast('读取提取结果失败，请回到商品页重新点击「获取图片」', 'warn');
    }
  }

  init();
})();
