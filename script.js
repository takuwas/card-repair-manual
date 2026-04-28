/**
 * ポケモンカード修復マニュアル — フロントエンドスクリプト
 *
 * 機能:
 *  - manual.md を fetch して marked で HTML に変換
 *  - 見出しから TOC を自動生成
 *  - スクロール位置に応じて TOC をハイライト
 *  - 検索（タイトル + 本文）
 *  - :target に飛んだ時に黄色ハイライト（CSSのアニメーション）
 *  - ダークモード切替（localStorage 永続化）
 *  - モバイル: ハンバーガーメニュー
 *  - Callout box の検出（先頭絵文字でカラー分類）
 */

(function () {
  'use strict';

  const MD_URL = 'manual.md';
  const STORAGE_KEY_THEME = 'cardrepair-theme';
  const STORAGE_KEY_TOC_OPEN = 'cardrepair-toc-open';

  const $content = document.getElementById('content');
  const $toc = document.getElementById('toc');
  const $sidebar = document.getElementById('sidebar');
  const $sidebarToggle = document.getElementById('sidebar-toggle');
  const $themeToggle = document.getElementById('theme-toggle');
  const $search = document.getElementById('search');
  const $searchResults = document.getElementById('search-results');
  const $searchList = document.getElementById('search-results-list');
  const $searchCount = document.getElementById('search-count');
  const $searchClose = document.getElementById('search-close');

  // -------- テーマ初期化 --------
  function initTheme() {
    const saved = localStorage.getItem(STORAGE_KEY_THEME);
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = saved || (prefersDark ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
    $themeToggle.textContent = theme === 'dark' ? '☀️' : '🌙';
  }

  $themeToggle.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem(STORAGE_KEY_THEME, next);
    $themeToggle.textContent = next === 'dark' ? '☀️' : '🌙';
  });

  initTheme();

  // -------- マニュアル本体の取得とレンダリング --------
  async function loadManual() {
    try {
      const res = await fetch(MD_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const md = await res.text();
      renderMarkdown(md);
    } catch (e) {
      $content.innerHTML = `<div style="color:var(--color-danger);padding:40px 0;">
        <h2>マニュアルの読み込みに失敗しました</h2>
        <p><code>manual.md</code> が同じディレクトリに存在することを確認してください。</p>
        <p>エラー: ${e.message}</p>
      </div>`;
    }
  }

  // -------- marked.js の設定 --------
  function configureMarked() {
    marked.setOptions({
      gfm: true,           // GitHub Flavored Markdown
      breaks: false,
      pedantic: false,
      smartLists: true,
      headerIds: true,
      mangle: false,
    });

    // 見出しに対するアンカー ID 生成（日本語対応）
    const slugify = (text) => {
      return text
        .toString()
        .toLowerCase()
        .trim()
        .replace(/[\s　]+/g, '-')
        .replace(/[\/\\?%*:|"<>#&（）()「」【】、。,．!！?？]/g, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    };

    // カスタムレンダラー
    const renderer = new marked.Renderer();

    // 見出しに #anchor を持たせる
    renderer.heading = function (text, level, raw) {
      // raw は元の見出しテキスト（marked v12 では token を渡す可能性があるので念のため文字列化）
      const cleanText = typeof raw === 'string' ? raw : (typeof text === 'string' ? text : String(text));
      const id = slugify(cleanText.replace(/<[^>]+>/g, ''));
      return `<h${level} id="${id}">${text} <a class="anchor" href="#${id}" aria-label="この見出しへのリンク">#</a></h${level}>\n`;
    };

    // 外部リンクは新規ウィンドウ
    renderer.link = function (href, title, text) {
      const isExternal = /^https?:\/\//i.test(href);
      const titleAttr = title ? ` title="${title}"` : '';
      const targetAttr = isExternal ? ' target="_blank" rel="noopener noreferrer"' : '';
      return `<a href="${href}"${titleAttr}${targetAttr}>${text}</a>`;
    };

    marked.use({ renderer });
  }

  // -------- レンダリング --------
  function renderMarkdown(md) {
    configureMarked();

    const rawHtml = marked.parse(md);
    // DOMPurify でサニタイズ（XSS対策）
    const cleanHtml = DOMPurify.sanitize(rawHtml, {
      ADD_ATTR: ['target', 'rel', 'id'],
    });

    $content.innerHTML = cleanHtml;

    // Callout box の検出と classify
    classifyCallouts();

    // TOC 生成
    buildTOC();

    // ハッシュ付きでアクセスされた場合、その要素にスクロール（CSSの:targetが発火）
    if (location.hash) {
      // 一度ハッシュを外して再設定することで :target を確実に発火
      const hash = location.hash;
      requestAnimationFrame(() => {
        location.hash = '';
        requestAnimationFrame(() => {
          location.hash = hash;
        });
      });
    }

    // スクロールに応じた TOC ハイライト
    setupScrollSpy();
  }

  // -------- Callout 検出 --------
  // blockquote の先頭テキストを見て、絵文字に応じて class を付与
  function classifyCallouts() {
    const blockquotes = $content.querySelectorAll('blockquote');
    blockquotes.forEach(bq => {
      const text = bq.textContent.trim();
      if (text.startsWith('🚫')) bq.classList.add('callout-danger');
      else if (text.startsWith('⚠️')) bq.classList.add('callout-warning');
      else if (text.startsWith('📌')) bq.classList.add('callout-note');
      else if (text.startsWith('💡')) bq.classList.add('callout-tip');
      else if (text.startsWith('💬')) bq.classList.add('callout-voice');
      else if (text.startsWith('🔧')) bq.classList.add('callout-tip');
    });
  }

  // -------- TOC 生成 --------
  function buildTOC() {
    const headings = $content.querySelectorAll('h1, h2, h3');
    if (headings.length === 0) {
      $toc.innerHTML = '<div class="toc-loading">見出しがありません</div>';
      return;
    }

    const ul = document.createElement('ul');
    headings.forEach(h => {
      const level = parseInt(h.tagName.charAt(1), 10);
      // h4以降はTOCに含めない
      if (level > 3) return;

      const li = document.createElement('li');
      li.className = `toc-h${level}`;

      const a = document.createElement('a');
      a.href = '#' + h.id;
      // テキストは見出しから anchor リンク部分を除いて取得
      const headingText = Array.from(h.childNodes)
        .filter(n => !(n.nodeType === Node.ELEMENT_NODE && n.classList.contains('anchor')))
        .map(n => n.textContent)
        .join('')
        .trim();
      a.textContent = headingText;
      a.dataset.target = h.id;

      li.appendChild(a);
      ul.appendChild(li);
    });

    $toc.innerHTML = '';
    $toc.appendChild(ul);

    // クリック時にモバイルでサイドバー閉じる
    $toc.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', (e) => {
        if (window.innerWidth <= 900) {
          closeSidebar();
        }
        // クリック後、:target を再発火させるため、一度ハッシュを外して再設定
        const targetId = a.dataset.target;
        if (targetId) {
          e.preventDefault();
          history.pushState(null, '', '#' + targetId);
          // hashchange を強制的に発火させる
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        }
      });
    });
  }

  // -------- :target 再発火（同じハッシュをクリックした時にも黄色ハイライトを出す） --------
  window.addEventListener('hashchange', () => {
    const hash = location.hash;
    if (!hash) return;
    const target = document.querySelector(hash);
    if (!target) return;

    // 既に :target になっている要素のアニメーションをリセット
    target.style.animation = 'none';
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // 強制 reflow
    void target.offsetWidth;
    target.style.animation = '';
  });

  // -------- ScrollSpy（スクロール位置に応じてTOCをハイライト） --------
  function setupScrollSpy() {
    const headings = Array.from($content.querySelectorAll('h1, h2, h3'));
    const tocLinks = Array.from($toc.querySelectorAll('a'));

    if (headings.length === 0) return;

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const id = entry.target.id;
          tocLinks.forEach(a => {
            if (a.dataset.target === id) {
              a.classList.add('active');
              // サイドバー内で見える位置にスクロール
              const sidebarRect = $sidebar.getBoundingClientRect();
              const linkRect = a.getBoundingClientRect();
              if (linkRect.top < sidebarRect.top || linkRect.bottom > sidebarRect.bottom) {
                a.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
              }
            } else {
              a.classList.remove('active');
            }
          });
        }
      });
    }, {
      rootMargin: '-80px 0px -70% 0px',
      threshold: 0,
    });

    headings.forEach(h => observer.observe(h));
  }

  // -------- 検索 --------
  let searchIndex = []; // [{id, level, title, body}]

  function buildSearchIndex() {
    searchIndex = [];
    const headings = $content.querySelectorAll('h1, h2, h3, h4');
    headings.forEach(h => {
      const id = h.id;
      const level = parseInt(h.tagName.charAt(1), 10);
      const title = Array.from(h.childNodes)
        .filter(n => !(n.nodeType === Node.ELEMENT_NODE && n.classList.contains('anchor')))
        .map(n => n.textContent)
        .join('')
        .trim();

      // 次の見出しまでのテキストを body として収集
      let body = '';
      let next = h.nextElementSibling;
      while (next && !/^H[1-6]$/.test(next.tagName)) {
        body += ' ' + next.textContent;
        next = next.nextElementSibling;
        if (body.length > 800) break;
      }

      searchIndex.push({ id, level, title, body: body.trim().slice(0, 800) });
    });
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function escapeHTML(s) {
    return s.replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function highlightMatch(text, query) {
    const escaped = escapeHTML(text);
    if (!query) return escaped;
    const re = new RegExp('(' + escapeRegex(query) + ')', 'gi');
    return escaped.replace(re, '<mark>$1</mark>');
  }

  function makeSnippet(body, query) {
    if (!query || !body) return body.slice(0, 120);
    const lower = body.toLowerCase();
    const idx = lower.indexOf(query.toLowerCase());
    if (idx === -1) return body.slice(0, 120);
    const start = Math.max(0, idx - 40);
    const end = Math.min(body.length, idx + query.length + 80);
    let snippet = body.slice(start, end);
    if (start > 0) snippet = '…' + snippet;
    if (end < body.length) snippet = snippet + '…';
    return snippet;
  }

  function performSearch(query) {
    if (!query.trim()) {
      $searchResults.hidden = true;
      return;
    }

    if (searchIndex.length === 0) buildSearchIndex();

    const q = query.toLowerCase();
    const results = searchIndex.filter(item => {
      return item.title.toLowerCase().includes(q) || item.body.toLowerCase().includes(q);
    });

    // 章番号の重みづけ（タイトルマッチを優先）
    results.sort((a, b) => {
      const aTitle = a.title.toLowerCase().includes(q) ? 0 : 1;
      const bTitle = b.title.toLowerCase().includes(q) ? 0 : 1;
      if (aTitle !== bTitle) return aTitle - bTitle;
      return a.level - b.level;
    });

    $searchCount.textContent = `${results.length}件ヒット`;

    if (results.length === 0) {
      $searchList.innerHTML = '<li class="no-results">該当する項目はありません</li>';
    } else {
      $searchList.innerHTML = results.slice(0, 50).map(r => {
        const titleHTML = highlightMatch(r.title, query);
        const snippet = makeSnippet(r.body, query);
        const snippetHTML = highlightMatch(snippet, query);
        return `<li>
          <a href="#${r.id}" data-target="${r.id}">
            <span class="result-title">${titleHTML}</span>
            <span class="result-snippet">${snippetHTML}</span>
          </a>
        </li>`;
      }).join('');

      // クリックハンドラを再設定（モバイルでサイドバー閉じる、:target 発火）
      $searchList.querySelectorAll('a').forEach(a => {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          const targetId = a.dataset.target;
          history.pushState(null, '', '#' + targetId);
          window.dispatchEvent(new HashChangeEvent('hashchange'));
          $searchResults.hidden = true;
          $search.value = '';
          if (window.innerWidth <= 900) closeSidebar();
        });
      });
    }

    $searchResults.hidden = false;
  }

  // 検索入力イベント（debounce）
  let searchTimer = null;
  $search.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => performSearch(e.target.value), 150);
  });

  $searchClose.addEventListener('click', () => {
    $searchResults.hidden = true;
    $search.value = '';
  });

  // Esc で検索閉じる
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $searchResults.hidden = true;
      $search.blur();
    }
    // Ctrl+K / Cmd+K で検索フォーカス
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      $search.focus();
      $search.select();
    }
  });

  // 検索結果外クリックで閉じる
  document.addEventListener('click', (e) => {
    if ($searchResults.hidden) return;
    if ($searchResults.contains(e.target) || $search.contains(e.target)) return;
    $searchResults.hidden = true;
  });

  // -------- サイドバー（モバイル） --------
  function openSidebar() {
    $sidebar.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeSidebar() {
    $sidebar.classList.remove('open');
    document.body.style.overflow = '';
  }

  $sidebarToggle.addEventListener('click', () => {
    if ($sidebar.classList.contains('open')) {
      closeSidebar();
    } else {
      openSidebar();
    }
  });

  // モバイルで本文クリック → サイドバー閉じる
  $content.addEventListener('click', () => {
    if (window.innerWidth <= 900 && $sidebar.classList.contains('open')) {
      closeSidebar();
    }
  });

  // ウィンドウリサイズ
  window.addEventListener('resize', () => {
    if (window.innerWidth > 900) {
      $sidebar.classList.remove('open');
      document.body.style.overflow = '';
    }
  });

  // -------- 起動 --------
  loadManual();
})();
