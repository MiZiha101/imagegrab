/**
 * 图提取 ImageGrab · 官网交互脚本
 * 功能：滚动进场动画、导航栏吸顶与高亮、移动端汉堡菜单、年份更新。
 * 纯原生 JS，不依赖任何框架或 CDN；双击 index.html 即可运行。
 */
(function () {
  'use strict';

  // ---------------- 1. 年份自动更新 ----------------
  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  // ---------------- 2. 导航栏：滚动后加深毛玻璃阴影 ----------------
  const header = document.getElementById('site-header');
  const onScrollHeader = () => {
    if (!header) return;
    header.classList.toggle('is-scrolled', window.scrollY > 8);
  };
  onScrollHeader();
  window.addEventListener('scroll', onScrollHeader, { passive: true });

  // ---------------- 3. 移动端汉堡菜单 ----------------
  const nav = document.getElementById('nav');
  const navToggle = document.getElementById('nav-toggle');

  function closeNav() {
    if (!nav || !navToggle) return;
    nav.classList.remove('is-open');
    navToggle.setAttribute('aria-expanded', 'false');
    navToggle.setAttribute('aria-label', '展开菜单');
  }

  function toggleNav() {
    if (!nav || !navToggle) return;
    const open = nav.classList.toggle('is-open');
    navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    navToggle.setAttribute('aria-label', open ? '收起菜单' : '展开菜单');
  }

  if (navToggle) {
    navToggle.addEventListener('click', toggleNav);
  }

  if (nav) {
    // 点击锚点后自动收起菜单
    nav.querySelectorAll('a').forEach((link) => {
      link.addEventListener('click', closeNav);
    });
  }

  // Esc 或点击菜单外部时收起
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeNav();
  });

  document.addEventListener('click', (event) => {
    if (!nav || !navToggle) return;
    if (!nav.classList.contains('is-open')) return;
    if (nav.contains(event.target) || navToggle.contains(event.target)) return;
    closeNav();
  });

  // ---------------- 4. IntersectionObserver：滚动淡入上移 ----------------
  const revealNodes = Array.from(document.querySelectorAll('.reveal'));
  const revealAll = () => revealNodes.forEach((node) => node.classList.add('is-visible'));

  if (!('IntersectionObserver' in window)) {
    // 旧浏览器直接全部显示，避免内容不可见
    revealAll();
  } else {
    const revealObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          revealObserver.unobserve(entry.target);
        });
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.08 }
    );
    revealNodes.forEach((node) => revealObserver.observe(node));
  }

  // ---------------- 5. 滚动监听：导航锚点高亮 ----------------
  const links = Array.from(document.querySelectorAll('.nav__link'));
  const targets = links
    .map((link) => {
      const id = link.getAttribute('href');
      const el = id && id.startsWith('#') ? document.querySelector(id) : null;
      return el ? { link, el } : null;
    })
    .filter(Boolean);

  function highlightNav() {
    if (!targets.length) return;
    // 视口上方约 1/3 处作为判定线
    const line = window.scrollY + window.innerHeight * 0.32;
    let current = targets[0];
    targets.forEach((item) => {
      if (item.el.offsetTop <= line) current = item;
    });
    links.forEach((link) => link.classList.remove('is-active'));
    current.link.classList.add('is-active');
  }

  // requestAnimationFrame 节流，避免滚动时频繁重绘
  let ticking = false;
  window.addEventListener(
    'scroll',
    () => {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(() => {
        highlightNav();
        ticking = false;
      });
    },
    { passive: true }
  );
  highlightNav();

  // ---------------- 6. 占位链接提醒（上线前记得替换） ----------------
  document.querySelectorAll('a[href*="your-name"]').forEach((link) => {
    console.info('[ImageGrab] 记得把占位链接换成你自己的仓库地址：', link.href);
  });
})();
