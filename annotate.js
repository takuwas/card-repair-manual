/* ============================================================
 * カード損傷アノテーション収集ツール
 *   ─ ブラシ / 矩形 / 多角形 で範囲指定 → 損傷タイプ付与
 *   ─ IndexedDB に保存
 *   ─ ZIP (COCO + YOLO) / JSON エクスポート
 *   ─ 既存 diagnose.html / diagnose.js とは独立
 * ============================================================ */

(() => {
  'use strict';

  // ============================================================
  // 損傷タイプ定義 (D01〜D17)
  //   diagnose-ux-design.md §1 に準拠
  // ============================================================
  const DAMAGE_TYPES = [
    { id: 'D01', key: 'dent_light',      label: '軽度の凹み（点凹み）',          color: '#ffd166' },
    { id: 'D02', key: 'dent_severe',     label: '重度の凹み（深く広い）',        color: '#ef476f' },
    { id: 'D03', key: 'crease_light',    label: '軽度の折れ目（線状）',          color: '#ffb703' },
    { id: 'D04', key: 'crease_severe',   label: '重度の折れ目（隆起あり）',      color: '#d62828' },
    { id: 'D05', key: 'warp',            label: '反り（カード全体の弓形）',      color: '#06a77d' },
    { id: 'D06', key: 'distortion',      label: '歪み（不均一な変形）',          color: '#118ab2' },
    { id: 'D07', key: 'corner_crush',    label: '角の潰れ',                      color: '#9d4edd' },
    { id: 'D08', key: 'corner_peel',     label: '角のめくれ（剥離）',            color: '#7b2cbf' },
    { id: 'D09', key: 'edge_whitening',  label: 'エッジの白欠け',                color: '#a8dadc' },
    { id: 'D10', key: 'scratch_line',    label: '横線・小傷',                    color: '#e76f51' },
    { id: 'D11', key: 'holo_crease',     label: 'ホロ表面の折り目',              color: '#f4a261' },
    { id: 'D12', key: 'surface_dirt',    label: '表面汚れ（ホコリ・指紋）',      color: '#8d99ae' },
    { id: 'D13', key: 'print_line',      label: '印刷時の縦横線（mur）',         color: '#52796f' },
    { id: 'D14', key: 'stain_water',     label: '水シミ',                        color: '#0077b6' },
    { id: 'D15', key: 'back_wrinkle',    label: '加湿過多後の裏面シワ・鱗',      color: '#bc6c25' },
    { id: 'D16', key: 'roller_line',     label: 'ローラー線（押し跡）',          color: '#6a4c93' },
    { id: 'D17', key: 'heatpen_clouding',label: 'ヒートペン変色・曇り',          color: '#ff6b6b' },
  ];
  const DAMAGE_TYPE_BY_KEY = Object.fromEntries(DAMAGE_TYPES.map(d => [d.key, d]));

  // ============================================================
  // 設定値
  // ============================================================
  const CONFIG = {
    DB_NAME: 'card-annotations-db',
    DB_VERSION: 1,
    MIN_RECT_SIZE: 10,         // 矩形の最小辺長 (px, 元画像座標)
    MIN_MASK_AREA: 100,        // ブラシマスクの最小面積 (px², 元画像座標)
    MIN_POLYGON_VERTICES: 3,
    MIN_POLYGON_AREA: 100,
    MAX_IMAGE_DIM: 2000,       // 元画像のリサンプル上限
    THUMB_W: 200,
    THUMB_H: 280,
    THUMB_QUALITY: 0.7,
  };

  // ============================================================
  // ユーティリティ
  // ============================================================
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    // fallback
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function nowMs() { return Date.now(); }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function fmtBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function fmtDate(ts) {
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fmtDateForFilename(ts = Date.now()) {
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function safeText(v) {
    if (typeof DOMPurify === 'undefined' || !DOMPurify.sanitize) {
      const div = document.createElement('div');
      div.textContent = String(v ?? '');
      return div.innerHTML;
    }
    return DOMPurify.sanitize(String(v ?? ''));
  }

  // HTML テキスト・属性値用のエスケープ (DOMPurify を介さない単純なエスケープ)
  function escapeHtml(v) {
    return String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ============================================================
  // トースト通知
  // ============================================================
  function toast(message, type = 'info', durationMs = 3000) {
    const container = $('#toast-container');
    if (!container) return;
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .3s, transform .3s';
      el.style.opacity = '0';
      el.style.transform = 'translateX(40px)';
      setTimeout(() => el.remove(), 300);
    }, durationMs);
  }

  // ============================================================
  // 確認ダイアログ
  // ============================================================
  function confirmDialog(message, options = {}) {
    return new Promise(resolve => {
      const modal = $('#confirm-modal');
      $('#confirm-modal-message').textContent = message;
      $('#confirm-modal-title').textContent = options.title || '確認';
      const okBtn = $('#btn-confirm-ok');
      const cancelBtn = $('#btn-confirm-cancel');
      okBtn.textContent = options.okLabel || 'OK';
      cancelBtn.textContent = options.cancelLabel || 'キャンセル';
      modal.hidden = false;
      const cleanup = (result) => {
        modal.hidden = true;
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        document.removeEventListener('keydown', onKey);
        $$('[data-close-modal="confirm-modal"]').forEach(b => b.removeEventListener('click', onCancel));
        resolve(result);
      };
      const onOk = () => cleanup(true);
      const onCancel = () => cleanup(false);
      const onKey = (e) => {
        if (e.key === 'Escape') onCancel();
        else if (e.key === 'Enter') onOk();
      };
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      $$('[data-close-modal="confirm-modal"]').forEach(b => b.addEventListener('click', onCancel));
      document.addEventListener('keydown', onKey);
    });
  }

  // ============================================================
  // IndexedDB ラッパ
  // ============================================================
  const DB = (() => {
    let _db = null;

    function open() {
      if (_db) return Promise.resolve(_db);
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('images')) {
            const s = db.createObjectStore('images', { keyPath: 'id' });
            s.createIndex('uploadedAt', 'uploadedAt');
          }
          if (!db.objectStoreNames.contains('annotations')) {
            const s = db.createObjectStore('annotations', { keyPath: 'id' });
            s.createIndex('imageId', 'imageId');
            s.createIndex('damageType', 'damageType');
          }
        };
        req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
        req.onerror = (e) => reject(e.target.error);
      });
    }

    function tx(stores, mode = 'readonly') {
      return open().then(db => db.transaction(stores, mode));
    }

    function _wrap(req) {
      return new Promise((resolve, reject) => {
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => reject(e.target.error);
      });
    }

    return {
      async putImage(img) {
        const t = await tx(['images'], 'readwrite');
        await _wrap(t.objectStore('images').put(img));
      },
      async getImage(id) {
        const t = await tx(['images']);
        return _wrap(t.objectStore('images').get(id));
      },
      async getAllImages() {
        const t = await tx(['images']);
        return _wrap(t.objectStore('images').getAll());
      },
      async deleteImage(id) {
        const t = await tx(['images', 'annotations'], 'readwrite');
        // 同じトランザクション内で同期的に複数リクエストを発行する
        // (await を挟むとトランザクションがクローズされる可能性があるため)
        const imgStore = t.objectStore('images');
        const annStore = t.objectStore('annotations');
        const idx = annStore.index('imageId');
        imgStore.delete(id);
        return new Promise((resolve, reject) => {
          const cur = idx.openCursor(IDBKeyRange.only(id));
          cur.onsuccess = (e) => {
            const c = e.target.result;
            if (c) { c.delete(); c.continue(); }
          };
          cur.onerror = (e) => reject(e.target.error);
          t.oncomplete = () => resolve();
          t.onerror = (e) => reject(e.target.error);
          t.onabort = (e) => reject(e.target.error);
        });
      },
      async putAnnotation(annot) {
        const t = await tx(['annotations'], 'readwrite');
        await _wrap(t.objectStore('annotations').put(annot));
      },
      async deleteAnnotation(id) {
        const t = await tx(['annotations'], 'readwrite');
        await _wrap(t.objectStore('annotations').delete(id));
      },
      async getAnnotation(id) {
        const t = await tx(['annotations']);
        return _wrap(t.objectStore('annotations').get(id));
      },
      async getAllAnnotations() {
        const t = await tx(['annotations']);
        return _wrap(t.objectStore('annotations').getAll());
      },
      async getAnnotationsByImage(imageId) {
        const t = await tx(['annotations']);
        const idx = t.objectStore('annotations').index('imageId');
        return _wrap(idx.getAll(IDBKeyRange.only(imageId)));
      },
      async clearAll() {
        const t = await tx(['images', 'annotations'], 'readwrite');
        // 同じトランザクション内で同期的にリクエスト発行
        t.objectStore('images').clear();
        t.objectStore('annotations').clear();
        return new Promise((resolve, reject) => {
          t.oncomplete = () => resolve();
          t.onerror = (e) => reject(e.target.error);
          t.onabort = (e) => reject(e.target.error);
        });
      },
      // init() 等から DB を事前にオープンするためのエントリポイント
      open,
    };
  })();

  // ============================================================
  // 画像処理ユーティリティ
  // ============================================================
  function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => resolve({ img, dataUrl: e.target.result });
        img.onerror = () => reject(new Error('画像の読み込みに失敗しました'));
        img.src = e.target.result;
      };
      reader.onerror = () => reject(new Error('ファイル読み込みエラー'));
      reader.readAsDataURL(file);
    });
  }

  function downsampleImage(img, maxDim = CONFIG.MAX_IMAGE_DIM) {
    let { width: w, height: h } = img;
    if (w <= maxDim && h <= maxDim) {
      // そのまま canvas に書いて dataUrl 返す（フォーマット統一のため）
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0);
      return { width: w, height: h, dataUrl: canvas.toDataURL('image/jpeg', 0.92) };
    }
    const scale = maxDim / Math.max(w, h);
    const nw = Math.round(w * scale);
    const nh = Math.round(h * scale);
    const canvas = document.createElement('canvas');
    canvas.width = nw; canvas.height = nh;
    canvas.getContext('2d').drawImage(img, 0, 0, nw, nh);
    return { width: nw, height: nh, dataUrl: canvas.toDataURL('image/jpeg', 0.9) };
  }

  function makeThumbnail(img, maxW = CONFIG.THUMB_W, maxH = CONFIG.THUMB_H) {
    const { width: w, height: h } = img;
    const scale = Math.min(maxW / w, maxH / h, 1);
    const nw = Math.round(w * scale);
    const nh = Math.round(h * scale);
    const canvas = document.createElement('canvas');
    canvas.width = nw; canvas.height = nh;
    canvas.getContext('2d').drawImage(img, 0, 0, nw, nh);
    return canvas.toDataURL('image/jpeg', CONFIG.THUMB_QUALITY);
  }

  // ============================================================
  // マスク後処理
  //   - 連結成分ラベリング (4近傍 BFS)
  //   - 最大連結成分の bbox / 面積を算出
  // ============================================================
  function processMaskCanvas(maskCanvas) {
    const W = maskCanvas.width, H = maskCanvas.height;
    if (W === 0 || H === 0) return null;
    const ctx = maskCanvas.getContext('2d', { willReadFrequently: true });
    const imgData = ctx.getImageData(0, 0, W, H);
    const data = imgData.data;

    // バイナリマスク化 (alpha > 64 を foreground)
    const N = W * H;
    const bin = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      bin[i] = data[i * 4 + 3] > 64 ? 1 : 0;
    }

    // 連結成分ラベリング (4-connectivity, BFS)
    const labels = new Int32Array(N); // 0 = unlabeled
    let nextLabel = 0;
    const componentInfo = []; // [{label, count, minX, minY, maxX, maxY}]
    const queue = new Int32Array(N);

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const idx = y * W + x;
        if (bin[idx] !== 1 || labels[idx] !== 0) continue;
        nextLabel++;
        const info = { label: nextLabel, count: 0, minX: x, minY: y, maxX: x, maxY: y };
        let head = 0, tail = 0;
        queue[tail++] = idx;
        labels[idx] = nextLabel;
        while (head < tail) {
          const cur = queue[head++];
          const cy = (cur / W) | 0;
          const cx = cur - cy * W;
          info.count++;
          if (cx < info.minX) info.minX = cx;
          if (cy < info.minY) info.minY = cy;
          if (cx > info.maxX) info.maxX = cx;
          if (cy > info.maxY) info.maxY = cy;
          // 4-neighbors
          if (cx > 0)     { const n = cur - 1;     if (bin[n] === 1 && labels[n] === 0) { labels[n] = nextLabel; queue[tail++] = n; } }
          if (cx < W - 1) { const n = cur + 1;     if (bin[n] === 1 && labels[n] === 0) { labels[n] = nextLabel; queue[tail++] = n; } }
          if (cy > 0)     { const n = cur - W;     if (bin[n] === 1 && labels[n] === 0) { labels[n] = nextLabel; queue[tail++] = n; } }
          if (cy < H - 1) { const n = cur + W;     if (bin[n] === 1 && labels[n] === 0) { labels[n] = nextLabel; queue[tail++] = n; } }
        }
        componentInfo.push(info);
      }
    }

    if (componentInfo.length === 0) return null;
    // 最大連結成分のみ
    componentInfo.sort((a, b) => b.count - a.count);
    const top = componentInfo[0];

    // 最大連結成分のみを残した binary mask canvas を新規作成
    const filtered = document.createElement('canvas');
    filtered.width = W;
    filtered.height = H;
    const fctx = filtered.getContext('2d');
    const out = fctx.createImageData(W, H);
    const odata = out.data;
    for (let i = 0; i < N; i++) {
      if (labels[i] === top.label) {
        odata[i * 4]     = 255;
        odata[i * 4 + 1] = 255;
        odata[i * 4 + 2] = 255;
        odata[i * 4 + 3] = 255;
      } else {
        odata[i * 4 + 3] = 0;
      }
    }
    fctx.putImageData(out, 0, 0);

    return {
      area: top.count,
      bbox: {
        x: top.minX,
        y: top.minY,
        w: top.maxX - top.minX + 1,
        h: top.maxY - top.minY + 1,
      },
      maskCanvas: filtered,
    };
  }

  // ============================================================
  // 多角形面積 (shoelace)
  // ============================================================
  function polygonArea(points) {
    let s = 0;
    for (let i = 0; i < points.length; i++) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[(i + 1) % points.length];
      s += x1 * y2 - x2 * y1;
    }
    return Math.abs(s / 2);
  }

  function polygonBBox(points) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of points) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  function pointInPolygon(p, points) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i];
      const [xj, yj] = points[j];
      const intersect = ((yi > p[1]) !== (yj > p[1]))
        && (p[0] < (xj - xi) * (p[1] - yi) / ((yj - yi) || 1e-9) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  // ============================================================
  // アプリケーション状態
  // ============================================================
  const state = {
    images: [],          // {id, filename, width, height, dataUrl, thumbnailDataUrl, ...}
    annotations: [],     // 全画像分
    currentImageId: null,
    currentImage: null,  // HTMLImageElement (loaded)
    tool: null,          // 'rect' | 'brush' | 'polygon' | 'eraser' | null
    zoom: 1,
    brushSize: 20,
    selectedDamageKey: DAMAGE_TYPES[0].key,

    // 描画一時状態
    drawing: {
      active: false,
      start: null,       // {x, y} (元画像座標)
      end: null,
      maskCanvas: null,  // ブラシ用 (元画像サイズ)
      maskCtx: null,
      lastBrushPoint: null,
      polygonPoints: [], // [[x,y]...]
      mouseHover: null,  // 多角形プレビュー用
    },

    // 編集中の保留アノテーション (モーダル開いてる間)
    pendingAnnotation: null,

    highlightedAnnotationId: null,
  };

  // 編集対象 (既存アノテーションを編集する場合)
  let editingAnnotationId = null;

  // ============================================================
  // 初期化: 損傷タイプの select を埋める
  // ============================================================
  function populateDamageTypeSelects() {
    const selects = [$('#damage-type-select'), $('#form-damage-type')];
    for (const sel of selects) {
      if (!sel) continue;
      sel.innerHTML = DAMAGE_TYPES.map(d =>
        `<option value="${d.key}" data-color="${d.color}">${d.id} ${d.label}</option>`
      ).join('');
    }
  }

  // ============================================================
  // 画像追加 (ファイル → IndexedDB)
  // ============================================================
  async function addImageFiles(files) {
    if (!files || files.length === 0) return;
    let added = 0;
    for (const file of files) {
      if (!/^image\//.test(file.type)) {
        toast(`${file.name} は画像ではありません`, 'warn');
        continue;
      }
      try {
        const { img } = await loadImageFromFile(file);
        const ds = downsampleImage(img);
        // ダウンサンプル後の画像で再ロードして thumbnail を作る
        const dsImg = await new Promise((res, rej) => {
          const i = new Image();
          i.onload = () => res(i); i.onerror = rej; i.src = ds.dataUrl;
        });
        const thumbnailDataUrl = makeThumbnail(dsImg);
        const record = {
          id: uuid(),
          filename: file.name,
          width: ds.width,
          height: ds.height,
          dataUrl: ds.dataUrl,
          thumbnailDataUrl,
          uploadedAt: nowMs(),
          annotatedAt: null,
          fileSize: file.size,
        };
        await DB.putImage(record);
        state.images.push(record);
        added++;
      } catch (err) {
        console.error(err);
        toast(`${file.name} の読み込み失敗: ${err.message}`, 'error');
      }
    }
    if (added > 0) {
      toast(`${added} 件の画像を追加しました`, 'success');
      // 最初の追加画像を表示
      if (!state.currentImageId) {
        await selectImage(state.images[state.images.length - added].id);
      }
      renderImageList();
      renderStats();
      updateEmptyState();
    }
  }

  // ============================================================
  // 画像選択
  // ============================================================
  async function selectImage(imageId) {
    const rec = state.images.find(i => i.id === imageId);
    if (!rec) return;
    state.currentImageId = imageId;
    state.annotations = await DB.getAnnotationsByImage(imageId);
    // 画像を読み込み
    state.currentImage = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i); i.onerror = rej; i.src = rec.dataUrl;
    });
    state.zoom = 1;
    // updateEmptyState() を先に呼んで canvas-section を表示状態にする
    // (fitZoomToView は stage.clientWidth を読むため、表示前に呼ぶと 0 になる)
    updateEmptyState();
    fitZoomToView();
    renderCanvas();
    renderImageList();
    renderAnnotationList();
    updateCanvasMeta();
  }

  // ============================================================
  // 画像削除
  // ============================================================
  async function deleteImage(imageId) {
    const rec = state.images.find(i => i.id === imageId);
    if (!rec) return;
    const ok = await confirmDialog(
      `「${rec.filename}」を削除しますか？\nこの画像に紐づくアノテーション (${(await DB.getAnnotationsByImage(imageId)).length} 件) も削除されます。`,
      { title: '画像を削除', okLabel: '削除', cancelLabel: 'キャンセル' }
    );
    if (!ok) return;
    await DB.deleteImage(imageId);
    state.images = state.images.filter(i => i.id !== imageId);
    if (state.currentImageId === imageId) {
      state.currentImageId = null;
      state.currentImage = null;
      state.annotations = [];
      if (state.images.length > 0) await selectImage(state.images[0].id);
    }
    renderImageList();
    renderStats();
    renderCanvas();
    renderAnnotationList();
    updateEmptyState();
    toast('画像を削除しました', 'success');
  }

  // ============================================================
  // サイドバー: 画像リスト描画
  // ============================================================
  function renderImageList() {
    const ul = $('#image-list');
    if (!ul) return;
    if (state.images.length === 0) {
      ul.innerHTML = '<li class="image-list-empty">画像をアップロードしてください</li>';
      return;
    }
    ul.innerHTML = '';
    for (const img of state.images) {
      const annotCount = state.currentImageId === img.id
        ? state.annotations.length
        : (img._cachedAnnotCount ?? 0);
      const li = document.createElement('li');
      li.className = 'image-item' + (state.currentImageId === img.id ? ' active' : '');
      li.dataset.imageId = img.id;
      // 画像要素を構築 (innerHTML で data URL を埋めると DOMPurify 等で壊れる場合があるため、
      //  src は DOM プロパティ経由で設定する)
      const safeName = escapeHtml(img.filename);
      li.innerHTML = `
        <img class="image-thumb" alt="">
        <div class="image-info">
          <span class="image-name" title="${safeName}">${safeName}</span>
          <span class="image-meta">
            <span>${img.width}×${img.height}</span>
            <span class="annot-badge ${annotCount === 0 ? 'zero' : ''}">${annotCount}</span>
          </span>
        </div>
        <button type="button" class="image-delete" aria-label="削除" title="削除">×</button>
      `;
      const thumbEl = li.querySelector('.image-thumb');
      if (thumbEl && img.thumbnailDataUrl) thumbEl.src = img.thumbnailDataUrl;
      li.addEventListener('click', (e) => {
        if (e.target.classList.contains('image-delete')) {
          e.stopPropagation();
          deleteImage(img.id);
          return;
        }
        selectImage(img.id);
      });
      ul.appendChild(li);
    }
  }

  // ============================================================
  // 統計表示
  // ============================================================
  async function renderStats() {
    const allAnnots = await DB.getAllAnnotations();
    // 各画像のアノテ数をキャッシュ
    const countByImage = {};
    for (const a of allAnnots) countByImage[a.imageId] = (countByImage[a.imageId] || 0) + 1;
    for (const img of state.images) img._cachedAnnotCount = countByImage[img.id] || 0;

    $('#stat-image-count').textContent = state.images.length;
    $('#stat-annot-count').textContent = allAnnots.length;
    $('#stat-annotated-images').textContent = state.images.filter(i => (i._cachedAnnotCount || 0) > 0).length;

    // タイプ別件数の棒グラフ
    const counts = {};
    for (const a of allAnnots) counts[a.damageType] = (counts[a.damageType] || 0) + 1;
    const total = allAnnots.length;
    const barsEl = $('#stats-bars');
    if (total === 0) {
      barsEl.innerHTML = '<p class="stats-empty">まだアノテーションがありません</p>';
      return;
    }
    const max = Math.max(...Object.values(counts), 1);
    barsEl.innerHTML = '';
    for (const dt of DAMAGE_TYPES) {
      const c = counts[dt.key] || 0;
      if (c === 0) continue;
      const row = document.createElement('div');
      row.className = 'stats-bar-row';
      row.innerHTML = `
        <span class="stats-bar-color" style="background:${dt.color}"></span>
        <span class="stats-bar-label" title="${safeText(dt.id + ' ' + dt.label)}">${dt.id}</span>
        <span class="stats-bar-bar">
          <span class="stats-bar-fill" style="width:${(c / max * 100).toFixed(1)}%; background:${dt.color}"></span>
        </span>
        <span class="stats-bar-count">${c}</span>
      `;
      barsEl.appendChild(row);
    }
    // image list の バッジ更新
    renderImageList();
  }

  // ============================================================
  // Canvas 描画 (3レイヤー)
  //   canvas-image:       画像本体 (リサイズ済の元画像)
  //   canvas-annotations: 確定済アノテーション (rect / mask / polygon)
  //   canvas-draw:        現在描画中のプレビュー & マウス入力レイヤ
  // ============================================================
  function getCanvasElems() {
    return {
      stage: $('#canvas-stage'),
      cImg: $('#canvas-image'),
      cAnn: $('#canvas-annotations'),
      cDraw: $('#canvas-draw'),
    };
  }

  function fitZoomToView() {
    if (!state.currentImage) return;
    const stage = $('#canvas-stage');
    if (!stage) return;
    const stageW = stage.clientWidth - 16;
    if (stageW <= 0) {
      // 表示領域がまだ確定していない (canvas-section が hidden 等)
      // → デフォルトの zoom=1 を維持してフォールバック
      state.zoom = 1;
    } else {
      const scale = stageW / state.currentImage.width;
      // zoom-slider の min/max (0.1..3) と同期させる
      state.zoom = clamp(scale, 0.1, 3);
    }
    const slider = $('#zoom-slider');
    if (slider) slider.value = state.zoom;
    const zVal = $('#zoom-val');
    if (zVal) zVal.textContent = `${Math.round(state.zoom * 100)}%`;
  }

  function renderCanvas() {
    const { cImg, cAnn, cDraw } = getCanvasElems();
    if (!state.currentImage) {
      // クリア
      [cImg, cAnn, cDraw].forEach(c => {
        if (!c) return;
        c.width = 0; c.height = 0;
      });
      return;
    }

    const W = state.currentImage.width;
    const H = state.currentImage.height;
    const dW = Math.round(W * state.zoom);
    const dH = Math.round(H * state.zoom);

    for (const c of [cImg, cAnn, cDraw]) {
      c.width = dW;
      c.height = dH;
      c.style.width = `${dW}px`;
      c.style.height = `${dH}px`;
    }

    // 画像レイヤ
    const ictx = cImg.getContext('2d');
    ictx.imageSmoothingQuality = 'high';
    ictx.drawImage(state.currentImage, 0, 0, dW, dH);

    // アノテーションレイヤ
    renderAnnotationsLayer();
    // 描画レイヤはクリア
    cDraw.getContext('2d').clearRect(0, 0, dW, dH);
  }

  function renderAnnotationsLayer() {
    const { cAnn } = getCanvasElems();
    if (!cAnn || !state.currentImage) return;
    const ctx = cAnn.getContext('2d');
    ctx.clearRect(0, 0, cAnn.width, cAnn.height);
    const z = state.zoom;

    for (const a of state.annotations) {
      const dt = DAMAGE_TYPE_BY_KEY[a.damageType];
      const color = dt ? dt.color : '#ff5252';
      const isHl = state.highlightedAnnotationId === a.id;

      // 形状描画
      if (a.shape === 'rect') {
        const { x, y, w, h } = a.bbox;
        ctx.strokeStyle = color;
        ctx.fillStyle = color + '22'; // alpha
        ctx.lineWidth = isHl ? 4 : 2;
        ctx.fillRect(x * z, y * z, w * z, h * z);
        ctx.strokeRect(x * z, y * z, w * z, h * z);
      } else if (a.shape === 'mask' && a.maskDataUrl) {
        // mask png を描画
        if (!a._maskImg) {
          // ロードして再描画
          const img = new Image();
          img.onload = () => { a._maskImg = img; renderAnnotationsLayer(); };
          img.src = a.maskDataUrl;
        } else {
          // tinted overlay
          ctx.save();
          ctx.globalAlpha = isHl ? 0.65 : 0.45;
          // tinted: 元の白マスクに色を載せるため、まずマスク描画 → composite
          const tmp = document.createElement('canvas');
          tmp.width = cAnn.width; tmp.height = cAnn.height;
          const tctx = tmp.getContext('2d');
          tctx.drawImage(a._maskImg, 0, 0, cAnn.width, cAnn.height);
          tctx.globalCompositeOperation = 'source-in';
          tctx.fillStyle = color;
          tctx.fillRect(0, 0, cAnn.width, cAnn.height);
          ctx.drawImage(tmp, 0, 0);
          ctx.restore();
          // bbox 縁
          if (a.maskBbox) {
            ctx.strokeStyle = color;
            ctx.lineWidth = isHl ? 3 : 1;
            ctx.setLineDash(isHl ? [] : [4, 4]);
            ctx.strokeRect(a.maskBbox.x * z, a.maskBbox.y * z, a.maskBbox.w * z, a.maskBbox.h * z);
            ctx.setLineDash([]);
          }
        }
      } else if (a.shape === 'polygon' && a.polygonPoints) {
        ctx.strokeStyle = color;
        ctx.fillStyle = color + '22';
        ctx.lineWidth = isHl ? 4 : 2;
        ctx.beginPath();
        a.polygonPoints.forEach(([x, y], i) => {
          if (i === 0) ctx.moveTo(x * z, y * z);
          else ctx.lineTo(x * z, y * z);
        });
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }

      // 番号バッジ
      const idx = state.annotations.indexOf(a) + 1;
      const bbox = a.bbox || a.maskBbox || (a.polygonPoints ? polygonBBox(a.polygonPoints) : null);
      if (bbox) {
        const bx = bbox.x * z + 4;
        const by = bbox.y * z + 4;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(bx + 9, by + 9, 11, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(idx), bx + 9, by + 9);
      }
    }
  }

  function updateCanvasMeta() {
    if (!state.currentImage) {
      $('#canvas-meta-text').textContent = '—';
      return;
    }
    const rec = state.images.find(i => i.id === state.currentImageId);
    $('#canvas-meta-text').textContent =
      `${rec?.filename || ''} | ${state.currentImage.width}×${state.currentImage.height}px | ${Math.round(state.zoom * 100)}%`;
  }

  // ============================================================
  // Canvas 入力 → 元画像座標変換
  // ============================================================
  function eventToImageCoord(ev) {
    const cDraw = $('#canvas-draw');
    const rect = cDraw.getBoundingClientRect();
    const cx = ev.clientX - rect.left;
    const cy = ev.clientY - rect.top;
    return {
      x: cx / state.zoom,
      y: cy / state.zoom,
    };
  }

  // ============================================================
  // ツール選択
  // ============================================================
  function setTool(tool) {
    state.tool = tool;
    // ボタン表示
    $$('.tool-btn').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
    // ブラシコントロール表示
    $('#brush-controls').hidden = tool !== 'brush';
    // カーソル
    const cDraw = $('#canvas-draw');
    if (cDraw) {
      cDraw.classList.remove('tool-eraser', 'tool-none');
      if (tool === 'eraser') cDraw.classList.add('tool-eraser');
      else if (!tool) cDraw.classList.add('tool-none');
    }
    // ヒント
    const hints = {
      rect: 'ドラッグで矩形を描画 (最小10×10px)',
      brush: 'ドラッグで塗ってください (最小面積100px²)',
      polygon: 'クリックで頂点追加、ダブルクリックで閉じる、Esc でキャンセル',
      eraser: 'クリックで該当アノテーションを削除',
    };
    $('#tool-hint').textContent = hints[tool] || 'ツールを選択してください';
    // 多角形作業中ならクリア
    if (tool !== 'polygon') {
      state.drawing.polygonPoints = [];
      clearDrawLayer();
    }
  }

  function clearDrawLayer() {
    const c = $('#canvas-draw');
    if (c && c.width > 0) c.getContext('2d').clearRect(0, 0, c.width, c.height);
  }

  // ============================================================
  // 描画ハンドラ
  // ============================================================
  function attachCanvasEvents() {
    const cDraw = $('#canvas-draw');
    if (!cDraw) return;

    cDraw.addEventListener('mousedown', onPointerDown);
    cDraw.addEventListener('mousemove', onPointerMove);
    cDraw.addEventListener('mouseup', onPointerUp);
    cDraw.addEventListener('mouseleave', onPointerUp);
    cDraw.addEventListener('dblclick', onPointerDblClick);
    cDraw.addEventListener('click', onPointerClick);

    // touch (rudimentary)
    cDraw.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        e.preventDefault();
        const t = e.touches[0];
        onPointerDown({ clientX: t.clientX, clientY: t.clientY, button: 0, preventDefault: () => {} });
      }
    }, { passive: false });
    cDraw.addEventListener('touchmove', (e) => {
      if (e.touches.length === 1) {
        e.preventDefault();
        const t = e.touches[0];
        onPointerMove({ clientX: t.clientX, clientY: t.clientY, preventDefault: () => {} });
      }
    }, { passive: false });
    cDraw.addEventListener('touchend', (e) => {
      e.preventDefault();
      onPointerUp({ clientX: 0, clientY: 0 });
    });
  }

  function onPointerDown(ev) {
    if (!state.currentImage || !state.tool) return;
    if (state.tool === 'eraser' || state.tool === 'polygon') return; // click hander handles
    const p = eventToImageCoord(ev);
    state.drawing.active = true;
    state.drawing.start = p;
    state.drawing.end = p;

    if (state.tool === 'brush') {
      // マスクキャンバスを元画像サイズで作成
      const W = state.currentImage.width;
      const H = state.currentImage.height;
      const mc = document.createElement('canvas');
      mc.width = W;
      mc.height = H;
      state.drawing.maskCanvas = mc;
      state.drawing.maskCtx = mc.getContext('2d');
      state.drawing.lastBrushPoint = p;
      drawBrushPoint(p);
      drawBrushPreview();
    }
  }

  function onPointerMove(ev) {
    if (!state.currentImage) return;
    const p = eventToImageCoord(ev);

    // 多角形のホバープレビュー
    if (state.tool === 'polygon' && state.drawing.polygonPoints.length > 0) {
      state.drawing.mouseHover = p;
      drawPolygonPreview();
      return;
    }

    if (!state.drawing.active) return;
    state.drawing.end = p;

    if (state.tool === 'rect') {
      drawRectPreview();
    } else if (state.tool === 'brush') {
      // 線形補間して連続描画
      const lp = state.drawing.lastBrushPoint;
      if (lp) {
        const dx = p.x - lp.x;
        const dy = p.y - lp.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const step = Math.max(1, state.brushSize / 4);
        const steps = Math.ceil(dist / step);
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          drawBrushPoint({ x: lp.x + dx * t, y: lp.y + dy * t });
        }
      } else {
        drawBrushPoint(p);
      }
      state.drawing.lastBrushPoint = p;
      drawBrushPreview();
    }
  }

  function onPointerUp(ev) {
    if (!state.drawing.active) return;
    state.drawing.active = false;

    if (state.tool === 'rect') {
      finishRect();
    } else if (state.tool === 'brush') {
      finishBrush();
    }
    state.drawing.start = null;
    state.drawing.end = null;
    state.drawing.lastBrushPoint = null;
  }

  // ダブルクリック判定のため、polygon の click を少し遅延させる
  let _polygonClickTimer = null;
  function onPointerClick(ev) {
    if (!state.currentImage) return;
    const p = eventToImageCoord(ev);
    if (state.tool === 'eraser') {
      eraseAtPoint(p);
      return;
    }
    if (state.tool === 'polygon') {
      // dblclick との競合を避けるため遅延実行
      // (dblclick が発火したらこのタイマはキャンセルされる)
      if (_polygonClickTimer) clearTimeout(_polygonClickTimer);
      _polygonClickTimer = setTimeout(() => {
        _polygonClickTimer = null;
        state.drawing.polygonPoints.push([p.x, p.y]);
        drawPolygonPreview();
      }, 220);
    }
  }

  function onPointerDblClick(ev) {
    if (state.tool === 'polygon') {
      // 直前の click による頂点追加をキャンセル
      if (_polygonClickTimer) {
        clearTimeout(_polygonClickTimer);
        _polygonClickTimer = null;
      }
      finishPolygon();
    }
  }

  // ============================================================
  // 矩形ツール
  // ============================================================
  function drawRectPreview() {
    const cDraw = $('#canvas-draw');
    const ctx = cDraw.getContext('2d');
    ctx.clearRect(0, 0, cDraw.width, cDraw.height);
    const z = state.zoom;
    const s = state.drawing.start, e = state.drawing.end;
    const x = Math.min(s.x, e.x);
    const y = Math.min(s.y, e.y);
    const w = Math.abs(e.x - s.x);
    const h = Math.abs(e.y - s.y);
    const dt = DAMAGE_TYPE_BY_KEY[state.selectedDamageKey];
    const color = dt ? dt.color : '#ff5252';
    ctx.strokeStyle = color;
    ctx.fillStyle = color + '22';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.fillRect(x * z, y * z, w * z, h * z);
    ctx.strokeRect(x * z, y * z, w * z, h * z);
    ctx.setLineDash([]);
    // 寸法表示
    ctx.fillStyle = color;
    ctx.font = '12px sans-serif';
    ctx.fillText(`${Math.round(w)}×${Math.round(h)}`, x * z + 4, (y + h) * z - 4);
  }

  function finishRect() {
    const s = state.drawing.start, e = state.drawing.end;
    if (!s || !e) { clearDrawLayer(); return; }
    const W = state.currentImage.width;
    const H = state.currentImage.height;
    const x = clamp(Math.min(s.x, e.x), 0, W);
    const y = clamp(Math.min(s.y, e.y), 0, H);
    const w = Math.min(Math.abs(e.x - s.x), W - x);
    const h = Math.min(Math.abs(e.y - s.y), H - y);

    if (w < CONFIG.MIN_RECT_SIZE || h < CONFIG.MIN_RECT_SIZE) {
      toast(`矩形が小さすぎます (最小 ${CONFIG.MIN_RECT_SIZE}×${CONFIG.MIN_RECT_SIZE}px)`, 'warn');
      clearDrawLayer();
      return;
    }

    state.pendingAnnotation = {
      shape: 'rect',
      bbox: { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) },
    };
    clearDrawLayer();
    openLabelModal();
  }

  // ============================================================
  // ブラシツール
  // ============================================================
  function drawBrushPoint(p) {
    const ctx = state.drawing.maskCtx;
    if (!ctx) return;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(p.x, p.y, state.brushSize / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawBrushPreview() {
    const cDraw = $('#canvas-draw');
    const ctx = cDraw.getContext('2d');
    ctx.clearRect(0, 0, cDraw.width, cDraw.height);
    const dt = DAMAGE_TYPE_BY_KEY[state.selectedDamageKey];
    const color = dt ? dt.color : '#ff5252';
    // マスクをカラーオーバーレイ表示
    if (state.drawing.maskCanvas) {
      ctx.save();
      ctx.globalAlpha = 0.5;
      const tmp = document.createElement('canvas');
      tmp.width = cDraw.width; tmp.height = cDraw.height;
      const tctx = tmp.getContext('2d');
      tctx.drawImage(state.drawing.maskCanvas, 0, 0, cDraw.width, cDraw.height);
      tctx.globalCompositeOperation = 'source-in';
      tctx.fillStyle = color;
      tctx.fillRect(0, 0, cDraw.width, cDraw.height);
      ctx.drawImage(tmp, 0, 0);
      ctx.restore();
    }
  }

  function finishBrush() {
    const mc = state.drawing.maskCanvas;
    if (!mc) { clearDrawLayer(); return; }
    const result = processMaskCanvas(mc);
    if (!result) {
      toast('範囲が描画されていません', 'warn');
      clearDrawLayer();
      state.drawing.maskCanvas = null;
      state.drawing.maskCtx = null;
      return;
    }
    if (result.area < CONFIG.MIN_MASK_AREA) {
      toast(`範囲が小さすぎます (面積 ${result.area}px², 最小 ${CONFIG.MIN_MASK_AREA}px²)`, 'warn');
      clearDrawLayer();
      state.drawing.maskCanvas = null;
      state.drawing.maskCtx = null;
      return;
    }
    state.pendingAnnotation = {
      shape: 'mask',
      maskCanvas: result.maskCanvas,
      maskBbox: result.bbox,
      maskArea: result.area,
    };
    clearDrawLayer();
    state.drawing.maskCanvas = null;
    state.drawing.maskCtx = null;
    openLabelModal();
  }

  // ============================================================
  // 多角形ツール
  // ============================================================
  function drawPolygonPreview() {
    const cDraw = $('#canvas-draw');
    const ctx = cDraw.getContext('2d');
    ctx.clearRect(0, 0, cDraw.width, cDraw.height);
    const z = state.zoom;
    const pts = state.drawing.polygonPoints;
    if (pts.length === 0) return;
    const dt = DAMAGE_TYPE_BY_KEY[state.selectedDamageKey];
    const color = dt ? dt.color : '#ff9b00';
    ctx.strokeStyle = color;
    ctx.fillStyle = color + '22';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    pts.forEach(([x, y], i) => {
      if (i === 0) ctx.moveTo(x * z, y * z);
      else ctx.lineTo(x * z, y * z);
    });
    if (state.drawing.mouseHover && pts.length >= 1) {
      ctx.lineTo(state.drawing.mouseHover.x * z, state.drawing.mouseHover.y * z);
    }
    if (pts.length >= 3) {
      ctx.lineTo(pts[0][0] * z, pts[0][1] * z);
    }
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    // 頂点を点描画
    ctx.fillStyle = color;
    for (const [x, y] of pts) {
      ctx.beginPath();
      ctx.arc(x * z, y * z, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function finishPolygon() {
    const pts = state.drawing.polygonPoints;
    if (pts.length < CONFIG.MIN_POLYGON_VERTICES) {
      toast(`頂点が ${CONFIG.MIN_POLYGON_VERTICES} 個未満です`, 'warn');
      state.drawing.polygonPoints = [];
      clearDrawLayer();
      return;
    }
    const area = polygonArea(pts);
    if (area < CONFIG.MIN_POLYGON_AREA) {
      toast(`多角形が小さすぎます (面積 ${Math.round(area)}px²)`, 'warn');
      state.drawing.polygonPoints = [];
      clearDrawLayer();
      return;
    }
    state.pendingAnnotation = {
      shape: 'polygon',
      polygonPoints: pts.map(([x, y]) => [Math.round(x), Math.round(y)]),
    };
    state.drawing.polygonPoints = [];
    clearDrawLayer();
    openLabelModal();
  }

  function cancelPolygon() {
    state.drawing.polygonPoints = [];
    clearDrawLayer();
  }

  // ============================================================
  // 消しゴム
  // ============================================================
  async function eraseAtPoint(p) {
    // 上から順に判定 (描画順の最後が一番上にあると仮定)
    for (let i = state.annotations.length - 1; i >= 0; i--) {
      const a = state.annotations[i];
      if (hitTest(a, p)) {
        const dt = DAMAGE_TYPE_BY_KEY[a.damageType];
        const ok = await confirmDialog(
          `${dt ? dt.id + ' ' + dt.label : a.damageType} のアノテーションを削除しますか？`,
          { title: 'アノテーション削除', okLabel: '削除' }
        );
        if (!ok) return;
        await DB.deleteAnnotation(a.id);
        state.annotations.splice(i, 1);
        renderAnnotationsLayer();
        renderAnnotationList();
        renderStats();
        toast('削除しました', 'success');
        return;
      }
    }
    toast('クリック位置にアノテーションがありません', 'info', 1500);
  }

  function hitTest(a, p) {
    if (a.shape === 'rect') {
      const { x, y, w, h } = a.bbox;
      return p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h;
    }
    if (a.shape === 'polygon') {
      return pointInPolygon([p.x, p.y], a.polygonPoints);
    }
    if (a.shape === 'mask') {
      const b = a.maskBbox;
      if (!b) return false;
      // bbox 内ならヒット (簡易判定)
      return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
    }
    return false;
  }

  // ============================================================
  // ラベル入力モーダル
  // ============================================================
  function openLabelModal(existingAnnot = null) {
    const modal = $('#label-modal');
    // プレビュー描画
    const previewCanvas = $('#modal-preview-canvas');
    drawAnnotPreview(previewCanvas, state.pendingAnnotation || existingAnnot);

    // 形状情報表示
    const a = state.pendingAnnotation || existingAnnot;
    let shapeText = '', sizeText = '';
    if (a.shape === 'rect') {
      shapeText = '矩形';
      sizeText = `${a.bbox.w}×${a.bbox.h} px`;
    } else if (a.shape === 'mask') {
      shapeText = 'ブラシマスク';
      sizeText = `面積 ${a.maskArea} px² / bbox ${a.maskBbox.w}×${a.maskBbox.h}`;
    } else if (a.shape === 'polygon') {
      shapeText = `多角形 (${a.polygonPoints.length} 頂点)`;
      const bb = polygonBBox(a.polygonPoints);
      sizeText = `bbox ${Math.round(bb.w)}×${Math.round(bb.h)}`;
    }
    $('#modal-preview-shape').textContent = shapeText;
    $('#modal-preview-size').textContent = sizeText;

    // フォーム値設定
    if (existingAnnot) {
      $('#form-damage-type').value = existingAnnot.damageType;
      $$('input[name="severity"]').forEach(r => r.checked = (r.value === existingAnnot.severity));
      $('#form-confidence').value = existingAnnot.confidence;
      $('#form-confidence-val').textContent = existingAnnot.confidence;
      $('#form-notes').value = existingAnnot.notes || '';
      editingAnnotationId = existingAnnot.id;
    } else {
      $('#form-damage-type').value = state.selectedDamageKey;
      $$('input[name="severity"]').forEach(r => r.checked = (r.value === 'moderate'));
      $('#form-confidence').value = 3;
      $('#form-confidence-val').textContent = '3';
      $('#form-notes').value = '';
      editingAnnotationId = null;
    }

    modal.hidden = false;
    setTimeout(() => $('#form-damage-type').focus(), 50);
  }

  function closeLabelModal() {
    $('#label-modal').hidden = true;
    state.pendingAnnotation = null;
    editingAnnotationId = null;
  }

  function drawAnnotPreview(canvas, annot) {
    if (!canvas || !annot || !state.currentImage) return;
    const PREV_MAX = 120;
    const W = state.currentImage.width;
    const H = state.currentImage.height;

    // bbox を取り出す
    let bb;
    if (annot.shape === 'rect') bb = annot.bbox;
    else if (annot.shape === 'mask') bb = annot.maskBbox;
    else if (annot.shape === 'polygon') bb = polygonBBox(annot.polygonPoints);
    else return;

    // パディング
    const pad = Math.max(8, Math.round(Math.max(bb.w, bb.h) * 0.15));
    const sx = Math.max(0, bb.x - pad);
    const sy = Math.max(0, bb.y - pad);
    const sw = Math.min(W - sx, bb.w + 2 * pad);
    const sh = Math.min(H - sy, bb.h + 2 * pad);
    const scale = PREV_MAX / Math.max(sw, sh);
    const cw = Math.round(sw * scale);
    const ch = Math.round(sh * scale);
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(state.currentImage, sx, sy, sw, sh, 0, 0, cw, ch);
    // overlay
    const dt = DAMAGE_TYPE_BY_KEY[annot.damageType || state.selectedDamageKey];
    const color = dt ? dt.color : '#ff5252';
    ctx.strokeStyle = color;
    ctx.fillStyle = color + '33';
    ctx.lineWidth = 2;
    if (annot.shape === 'rect') {
      const rx = (annot.bbox.x - sx) * scale;
      const ry = (annot.bbox.y - sy) * scale;
      ctx.fillRect(rx, ry, annot.bbox.w * scale, annot.bbox.h * scale);
      ctx.strokeRect(rx, ry, annot.bbox.w * scale, annot.bbox.h * scale);
    } else if (annot.shape === 'polygon') {
      ctx.beginPath();
      annot.polygonPoints.forEach(([x, y], i) => {
        const px = (x - sx) * scale;
        const py = (y - sy) * scale;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else if (annot.shape === 'mask' && annot.maskCanvas) {
      ctx.save();
      ctx.globalAlpha = 0.5;
      // ピクセル単位で対応領域を抜き出して色付け
      const tmp = document.createElement('canvas');
      tmp.width = cw; tmp.height = ch;
      const tctx = tmp.getContext('2d');
      tctx.drawImage(annot.maskCanvas, sx, sy, sw, sh, 0, 0, cw, ch);
      tctx.globalCompositeOperation = 'source-in';
      tctx.fillStyle = color;
      tctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(tmp, 0, 0);
      ctx.restore();
    } else if (annot.shape === 'mask' && annot.maskDataUrl) {
      // 既存
      const im = new Image();
      im.onload = () => {
        ctx.save();
        ctx.globalAlpha = 0.5;
        const tmp = document.createElement('canvas');
        tmp.width = cw; tmp.height = ch;
        const tctx = tmp.getContext('2d');
        tctx.drawImage(im, sx, sy, sw, sh, 0, 0, cw, ch);
        tctx.globalCompositeOperation = 'source-in';
        tctx.fillStyle = color;
        tctx.fillRect(0, 0, cw, ch);
        ctx.drawImage(tmp, 0, 0);
        ctx.restore();
      };
      im.src = annot.maskDataUrl;
    }
  }

  // ============================================================
  // アノテーション保存
  // ============================================================
  async function saveAnnotationFromForm() {
    const damageType = $('#form-damage-type').value;
    const dt = DAMAGE_TYPE_BY_KEY[damageType];
    if (!dt) { toast('損傷タイプを選択してください', 'error'); return; }
    const severity = $$('input[name="severity"]:checked')[0]?.value || 'moderate';
    const confidence = parseInt($('#form-confidence').value, 10) || 3;
    const notes = ($('#form-notes').value || '').trim();
    const W = state.currentImage.width;
    const H = state.currentImage.height;

    let annot;
    if (editingAnnotationId) {
      // 既存編集
      annot = state.annotations.find(a => a.id === editingAnnotationId);
      if (!annot) { closeLabelModal(); return; }
      annot.damageType = damageType;
      annot.damageTypeLabel = dt.label;
      annot.severity = severity;
      annot.confidence = confidence;
      annot.notes = notes;
      annot.updatedAt = nowMs();
    } else {
      // 新規
      const p = state.pendingAnnotation;
      if (!p) { closeLabelModal(); return; }
      annot = {
        id: uuid(),
        imageId: state.currentImageId,
        damageType,
        damageTypeLabel: dt.label,
        severity,
        confidence,
        shape: p.shape,
        notes,
        createdAt: nowMs(),
        updatedAt: nowMs(),
      };
      if (p.shape === 'rect') {
        annot.bbox = p.bbox;
        annot.bboxNormalized = { x: p.bbox.x / W, y: p.bbox.y / H, w: p.bbox.w / W, h: p.bbox.h / H };
      } else if (p.shape === 'mask') {
        annot.maskDataUrl = p.maskCanvas.toDataURL('image/png');
        annot.maskBbox = p.maskBbox;
        annot.maskArea = p.maskArea;
        annot.bbox = p.maskBbox;
        annot.bboxNormalized = { x: p.maskBbox.x / W, y: p.maskBbox.y / H, w: p.maskBbox.w / W, h: p.maskBbox.h / H };
      } else if (p.shape === 'polygon') {
        annot.polygonPoints = p.polygonPoints;
        const bb = polygonBBox(p.polygonPoints);
        annot.bbox = { x: Math.round(bb.x), y: Math.round(bb.y), w: Math.round(bb.w), h: Math.round(bb.h) };
        annot.bboxNormalized = { x: bb.x / W, y: bb.y / H, w: bb.w / W, h: bb.h / H };
      }
      state.annotations.push(annot);
    }

    await DB.putAnnotation(annot);
    // 親画像の annotatedAt を更新
    const imgRec = state.images.find(i => i.id === state.currentImageId);
    if (imgRec) {
      imgRec.annotatedAt = nowMs();
      await DB.putImage(imgRec);
    }

    state.selectedDamageKey = damageType;
    $('#damage-type-select').value = damageType;

    closeLabelModal();
    renderAnnotationsLayer();
    renderAnnotationList();
    renderStats();
    toast(editingAnnotationId ? 'アノテーションを更新しました' : 'アノテーションを追加しました', 'success');
  }

  // ============================================================
  // アノテーションリスト (画像下)
  // ============================================================
  function renderAnnotationList() {
    const container = $('#annot-list');
    const badge = $('#annot-count-badge');
    badge.textContent = state.annotations.length;
    if (!state.currentImage) {
      container.innerHTML = '<p class="annot-list-empty">画像を選択してください</p>';
      return;
    }
    if (state.annotations.length === 0) {
      container.innerHTML = '<p class="annot-list-empty">まだアノテーションがありません。ツールを選択して描画してください。</p>';
      return;
    }
    container.innerHTML = '';
    state.annotations.forEach((a, i) => {
      const dt = DAMAGE_TYPE_BY_KEY[a.damageType];
      const color = dt ? dt.color : '#ff5252';
      const card = document.createElement('div');
      card.className = 'annot-card';
      card.style.color = color;
      card.dataset.annotId = a.id;
      const sevLabel = { mild: '軽度', moderate: '中度', severe: '重度' }[a.severity] || a.severity;
      const shapeLabel = { rect: '矩形', mask: 'マスク', polygon: '多角形' }[a.shape] || a.shape;

      // サムネ用 background-image (動的に作るので placeholder)
      card.innerHTML = `
        <div class="annot-card-thumb" data-thumb-target="${a.id}"></div>
        <div class="annot-card-body">
          <span class="annot-card-type" title="${safeText(dt ? dt.id + ' ' + dt.label : a.damageType)}">
            <span class="dtype-dot" style="background:${color}"></span>
            #${i + 1} ${dt ? dt.id : ''} ${safeText(dt ? dt.label : a.damageType)}
          </span>
          <span class="annot-card-tags">
            <span class="annot-tag tag-${a.severity}">${sevLabel}</span>
            <span class="annot-tag">${shapeLabel}</span>
            <span class="annot-tag">★${a.confidence}/5</span>
          </span>
          ${a.notes ? `<span class="annot-tag" style="background:transparent;color:var(--color-text-muted)">📝 ${safeText(a.notes.length > 24 ? a.notes.slice(0, 24) + '…' : a.notes)}</span>` : ''}
        </div>
        <div class="annot-card-actions">
          <button type="button" class="annot-action-btn" data-action="edit" aria-label="編集">編集</button>
          <button type="button" class="annot-action-btn danger" data-action="delete" aria-label="削除">削除</button>
        </div>
      `;
      card.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (btn) {
          e.stopPropagation();
          if (btn.dataset.action === 'edit') {
            openLabelModal(a);
          } else if (btn.dataset.action === 'delete') {
            (async () => {
              const ok = await confirmDialog('このアノテーションを削除しますか？', { title: '削除', okLabel: '削除' });
              if (!ok) return;
              await DB.deleteAnnotation(a.id);
              state.annotations = state.annotations.filter(x => x.id !== a.id);
              renderAnnotationsLayer();
              renderAnnotationList();
              renderStats();
              toast('削除しました', 'success');
            })();
          }
          return;
        }
        // ハイライト
        state.highlightedAnnotationId = a.id;
        renderAnnotationsLayer();
        $$('.annot-card').forEach(c => c.classList.toggle('highlighted', c.dataset.annotId === a.id));
        // 該当領域へスクロール
        const stage = $('#canvas-stage');
        const bb = a.bbox || a.maskBbox || (a.polygonPoints ? polygonBBox(a.polygonPoints) : null);
        if (bb) {
          stage.scrollTo({
            left: bb.x * state.zoom - 50,
            top: bb.y * state.zoom - 50,
            behavior: 'smooth',
          });
        }
      });
      container.appendChild(card);

      // サムネを描画
      buildAnnotThumb(a).then(url => {
        const tdiv = card.querySelector('.annot-card-thumb');
        if (tdiv && url) tdiv.style.backgroundImage = `url("${url}")`;
      });
    });
  }

  async function buildAnnotThumb(a) {
    if (!state.currentImage) return null;
    const W = state.currentImage.width, H = state.currentImage.height;
    let bb;
    if (a.shape === 'rect') bb = a.bbox;
    else if (a.shape === 'mask') bb = a.maskBbox;
    else if (a.shape === 'polygon') bb = polygonBBox(a.polygonPoints);
    if (!bb) return null;
    const pad = Math.max(8, Math.round(Math.max(bb.w, bb.h) * 0.15));
    const sx = Math.max(0, bb.x - pad);
    const sy = Math.max(0, bb.y - pad);
    const sw = Math.min(W - sx, bb.w + 2 * pad);
    const sh = Math.min(H - sy, bb.h + 2 * pad);
    const SIZE = 56;
    const canvas = document.createElement('canvas');
    canvas.width = SIZE; canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.drawImage(state.currentImage, sx, sy, sw, sh, 0, 0, SIZE, SIZE);
    return canvas.toDataURL('image/jpeg', 0.7);
  }

  // ============================================================
  // 全消し (現在画像のアノテーション削除)
  // ============================================================
  async function clearCurrentImageAnnotations() {
    if (!state.currentImageId) return;
    if (state.annotations.length === 0) {
      toast('削除するアノテーションがありません', 'info');
      return;
    }
    const ok = await confirmDialog(
      `この画像の ${state.annotations.length} 件のアノテーションを全て削除しますか？`,
      { title: '全削除', okLabel: '全削除' }
    );
    if (!ok) return;
    for (const a of state.annotations) {
      await DB.deleteAnnotation(a.id);
    }
    state.annotations = [];
    renderAnnotationsLayer();
    renderAnnotationList();
    renderStats();
    toast('全削除しました', 'success');
  }

  // ============================================================
  // アンドゥ (直前のアノテーション削除)
  // ============================================================
  async function undoLastAnnotation() {
    if (state.annotations.length === 0) {
      toast('元に戻す対象がありません', 'info');
      return;
    }
    // 最新作成日時のものを削除
    state.annotations.sort((a, b) => a.createdAt - b.createdAt);
    const last = state.annotations[state.annotations.length - 1];
    await DB.deleteAnnotation(last.id);
    state.annotations.pop();
    renderAnnotationsLayer();
    renderAnnotationList();
    renderStats();
    toast('直前のアノテーションを削除しました', 'success');
  }

  // ============================================================
  // 全データ削除
  // ============================================================
  async function clearAllData() {
    const ok = await confirmDialog(
      '全ての画像・アノテーションを削除します。よろしいですか？',
      { title: '全データ削除', okLabel: '全削除' }
    );
    if (!ok) return;
    await DB.clearAll();
    state.images = [];
    state.annotations = [];
    state.currentImageId = null;
    state.currentImage = null;
    renderImageList();
    renderStats();
    renderCanvas();
    renderAnnotationList();
    updateEmptyState();
    toast('全データを削除しました', 'success');
  }

  // ============================================================
  // 空状態の表示制御
  // ============================================================
  function updateEmptyState() {
    const hasImage = !!state.currentImage;
    $('#empty-state').hidden = hasImage;
    $('#tool-bar').hidden = !hasImage;
    $('#canvas-section').hidden = !hasImage;
    $('#annot-list-section').hidden = !hasImage;
  }

  // ============================================================
  // dataUrl ↔ Blob
  // ============================================================
  function dataUrlToBlob(dataUrl) {
    const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
    if (!m) return null;
    const mime = m[1];
    const bstr = atob(m[2]);
    const bytes = new Uint8Array(bstr.length);
    for (let i = 0; i < bstr.length; i++) bytes[i] = bstr.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  // ============================================================
  // YOLO形式変換
  //   <class_id> <x_center> <y_center> <width> <height> (0-1正規化)
  //   class_id は D01=0, D02=1, ...
  // ============================================================
  function annotationsToYolo(imageRec, annots) {
    const W = imageRec.width, H = imageRec.height;
    const lines = [];
    for (const a of annots) {
      const idx = DAMAGE_TYPES.findIndex(d => d.key === a.damageType);
      if (idx < 0) continue;
      let bb = a.bbox;
      if (!bb && a.shape === 'mask') bb = a.maskBbox;
      if (!bb && a.shape === 'polygon') bb = polygonBBox(a.polygonPoints);
      if (!bb) continue;
      const cx = (bb.x + bb.w / 2) / W;
      const cy = (bb.y + bb.h / 2) / H;
      const nw = bb.w / W;
      const nh = bb.h / H;
      lines.push(`${idx} ${cx.toFixed(6)} ${cy.toFixed(6)} ${nw.toFixed(6)} ${nh.toFixed(6)}`);
    }
    return lines.join('\n');
  }

  function yoloDataYaml(imageCount) {
    const names = DAMAGE_TYPES.map(d => `'${d.key}'`).join(', ');
    return `# YOLO data config
# Generated: ${new Date().toISOString()}
# Image count: ${imageCount}
path: .
train: images
val: images
nc: ${DAMAGE_TYPES.length}
names: [${names}]
`;
  }

  // ============================================================
  // COCO形式エクスポート
  // ============================================================
  async function buildCoco() {
    const allImages = await DB.getAllImages();
    const allAnnots = await DB.getAllAnnotations();
    const coco = {
      info: {
        description: 'Card damage annotation dataset',
        version: '1.0',
        date_created: new Date().toISOString(),
        contributor: 'Card Repair Manual / Annotation Tool',
      },
      licenses: [{ id: 1, name: 'Manual', url: '' }],
      categories: DAMAGE_TYPES.map((d, i) => ({
        id: i + 1,
        name: d.key,
        supercategory: 'damage',
        display_id: d.id,
        display_label: d.label,
      })),
      images: allImages.map((img, i) => ({
        id: i + 1,
        _uuid: img.id,
        file_name: yoloFilename(img, i),
        width: img.width,
        height: img.height,
        date_captured: new Date(img.uploadedAt).toISOString(),
      })),
      annotations: [],
    };
    const imgIdMap = Object.fromEntries(coco.images.map(im => [im._uuid, im.id]));
    let annId = 0;
    for (const a of allAnnots) {
      const cocoImgId = imgIdMap[a.imageId];
      if (!cocoImgId) continue;
      const catIdx = DAMAGE_TYPES.findIndex(d => d.key === a.damageType);
      if (catIdx < 0) continue;
      annId++;
      let bb = a.bbox || a.maskBbox;
      if (!bb && a.polygonPoints) bb = polygonBBox(a.polygonPoints);
      if (!bb) continue;
      const cocoAnn = {
        id: annId,
        image_id: cocoImgId,
        category_id: catIdx + 1,
        bbox: [bb.x, bb.y, bb.w, bb.h],
        area: a.maskArea || (bb.w * bb.h),
        iscrowd: 0,
        attributes: {
          severity: a.severity,
          confidence: a.confidence,
          shape: a.shape,
          notes: a.notes || '',
          uuid: a.id,
        },
      };
      if (a.shape === 'polygon' && a.polygonPoints) {
        // COCOのsegmentationは flat array list-of-list
        cocoAnn.segmentation = [a.polygonPoints.flat()];
      } else if (a.shape === 'rect') {
        // 矩形を polygon として segmentation 化
        cocoAnn.segmentation = [[
          bb.x, bb.y,
          bb.x + bb.w, bb.y,
          bb.x + bb.w, bb.y + bb.h,
          bb.x, bb.y + bb.h,
        ]];
      } else {
        cocoAnn.segmentation = [];
      }
      coco.annotations.push(cocoAnn);
    }
    return { coco, allImages, allAnnots };
  }

  function yoloFilename(img, idx) {
    // 元の拡張子を維持しつつ番号付き
    const ext = (img.filename.match(/\.(jpe?g|png|webp)$/i) || ['.jpg'])[0].toLowerCase();
    const base = `img_${String(idx + 1).padStart(4, '0')}`;
    return `${base}${ext}`;
  }

  // ============================================================
  // ZIPエクスポート
  // ============================================================
  async function exportZip() {
    if (typeof JSZip === 'undefined') {
      toast('JSZip ライブラリの読み込みに失敗しました', 'error');
      return;
    }
    try {
      toast('エクスポート中…', 'info', 2000);
      const { coco, allImages, allAnnots } = await buildCoco();
      const zip = new JSZip();

      const imagesFolder = zip.folder('images');
      const labelsFolder = zip.folder('labels');

      // images / labels
      for (let i = 0; i < allImages.length; i++) {
        const img = allImages[i];
        const fname = yoloFilename(img, i);
        const blob = dataUrlToBlob(img.dataUrl);
        if (blob) imagesFolder.file(fname, blob);
        const annots = allAnnots.filter(a => a.imageId === img.id);
        const yoloText = annotationsToYolo(img, annots);
        const labelName = fname.replace(/\.(jpe?g|png|webp)$/i, '.txt');
        labelsFolder.file(labelName, yoloText);
      }

      // annotations.json (COCO)
      zip.file('annotations.json', JSON.stringify(coco, null, 2));
      // data.yaml
      zip.file('data.yaml', yoloDataYaml(allImages.length));
      // README
      zip.file('README.txt', buildReadme(allImages.length, allAnnots.length));

      const blob = await zip.generateAsync({ type: 'blob' }, (meta) => {
        // 進捗 (省略)
      });
      downloadBlob(blob, `annotations-export-${fmtDateForFilename()}.zip`);
      toast('ZIPファイルをダウンロードしました', 'success');
    } catch (err) {
      console.error(err);
      toast(`エクスポート失敗: ${err.message}`, 'error');
    }
  }

  function buildReadme(imgCount, annotCount) {
    return [
      'カード損傷アノテーションデータセット',
      '======================================',
      `生成日: ${new Date().toISOString()}`,
      `画像数: ${imgCount}`,
      `アノテーション数: ${annotCount}`,
      '',
      '構成:',
      '  images/        - 元画像 (JPEG/PNG)',
      '  labels/        - YOLO形式ラベル (.txt) - 1画像1ファイル',
      '  annotations.json - COCO形式',
      '  data.yaml      - YOLO data config',
      '',
      `クラス数: ${DAMAGE_TYPES.length}`,
      'クラス一覧:',
      ...DAMAGE_TYPES.map((d, i) => `  ${i}: ${d.id} ${d.key} (${d.label})`),
      '',
      'YOLO形式:',
      '  <class_id> <x_center_norm> <y_center_norm> <width_norm> <height_norm>',
      '  すべて 0-1 正規化, ブラシマスクと多角形は外接矩形に変換',
      '',
      'COCO形式:',
      '  標準COCO format (segmentation: polygon, mask は外接矩形ポリゴン)',
      '  attributes に severity, confidence, shape, notes を含む',
    ].join('\n');
  }

  async function exportJsonOnly() {
    try {
      const { coco } = await buildCoco();
      const blob = new Blob([JSON.stringify(coco, null, 2)], { type: 'application/json' });
      downloadBlob(blob, `annotations-${fmtDateForFilename()}.json`);
      toast('JSONをダウンロードしました', 'success');
    } catch (err) {
      console.error(err);
      toast(`エクスポート失敗: ${err.message}`, 'error');
    }
  }

  async function exportYoloOnly() {
    if (typeof JSZip === 'undefined') {
      toast('JSZip ライブラリの読み込みに失敗しました', 'error');
      return;
    }
    try {
      const allImages = await DB.getAllImages();
      const allAnnots = await DB.getAllAnnotations();
      const zip = new JSZip();
      const imagesFolder = zip.folder('images');
      const labelsFolder = zip.folder('labels');
      for (let i = 0; i < allImages.length; i++) {
        const img = allImages[i];
        const fname = yoloFilename(img, i);
        const blob = dataUrlToBlob(img.dataUrl);
        if (blob) imagesFolder.file(fname, blob);
        const annots = allAnnots.filter(a => a.imageId === img.id);
        const yoloText = annotationsToYolo(img, annots);
        labelsFolder.file(fname.replace(/\.(jpe?g|png|webp)$/i, '.txt'), yoloText);
      }
      zip.file('data.yaml', yoloDataYaml(allImages.length));
      zip.file('classes.txt', DAMAGE_TYPES.map(d => d.key).join('\n'));
      const blob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(blob, `annotations-yolo-${fmtDateForFilename()}.zip`);
      toast('YOLO ZIPをダウンロードしました', 'success');
    } catch (err) {
      console.error(err);
      toast(`エクスポート失敗: ${err.message}`, 'error');
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 1000);
  }

  // ============================================================
  // インポート (ZIP / JSON マージ)
  // ============================================================
  async function importFromFile(file) {
    try {
      if (/\.json$/i.test(file.name) || file.type === 'application/json') {
        const text = await file.text();
        const data = JSON.parse(text);
        await importCocoJson(data);
      } else if (/\.zip$/i.test(file.name) || file.type === 'application/zip') {
        if (typeof JSZip === 'undefined') {
          toast('JSZip が利用できません', 'error');
          return;
        }
        const zip = await JSZip.loadAsync(file);
        await importZip(zip);
      } else {
        toast('対応形式: .json または .zip', 'warn');
      }
    } catch (err) {
      console.error(err);
      toast(`インポート失敗: ${err.message}`, 'error');
    }
  }

  async function importZip(zip) {
    // images/ 以下の画像と annotations.json を読む
    const imageFiles = {}; // filename -> Blob
    const folders = ['images/', 'images\\'];
    for (const path in zip.files) {
      const entry = zip.files[path];
      if (entry.dir) continue;
      if (folders.some(p => path.startsWith(p))) {
        const fname = path.replace(/^images[\/\\]/, '');
        const blob = await entry.async('blob');
        imageFiles[fname] = blob;
      }
    }
    // annotations.json
    const annotFile = zip.file('annotations.json') || zip.file(/annotations\.json$/i)?.[0];
    if (!annotFile) {
      toast('annotations.json が見つかりません。画像のみインポートします。', 'warn');
      // 画像のみインポート
      let added = 0;
      for (const fname in imageFiles) {
        const f = new File([imageFiles[fname]], fname, { type: imageFiles[fname].type || 'image/jpeg' });
        await addImageFiles([f]);
        added++;
      }
      toast(`${added} 件の画像をインポートしました`, 'success');
      return;
    }
    const data = JSON.parse(await annotFile.async('string'));
    await importCocoJson(data, imageFiles);
  }

  async function importCocoJson(coco, imageBlobs = null) {
    if (!coco || !Array.isArray(coco.images) || !Array.isArray(coco.annotations)) {
      throw new Error('COCO形式ではありません');
    }
    let imgAdded = 0, annAdded = 0;
    const cocoImgIdToOurId = {};
    for (const cimg of coco.images) {
      // 同じ filename + width + height のものは重複とみなしスキップ
      const dup = state.images.find(i => i.filename === cimg.file_name && i.width === cimg.width && i.height === cimg.height);
      if (dup) {
        cocoImgIdToOurId[cimg.id] = dup.id;
        continue;
      }
      let dataUrl = null, thumbnailDataUrl = null;
      if (imageBlobs && imageBlobs[cimg.file_name]) {
        dataUrl = await blobToDataUrl(imageBlobs[cimg.file_name]);
        // サムネ作成
        const i = await dataUrlToImg(dataUrl);
        thumbnailDataUrl = makeThumbnail(i);
      }
      if (!dataUrl) {
        // 画像ファイルが無い → スキップ (アノテーションのみは扱わない)
        continue;
      }
      const rec = {
        id: uuid(),
        filename: cimg.file_name,
        width: cimg.width,
        height: cimg.height,
        dataUrl,
        thumbnailDataUrl,
        uploadedAt: nowMs(),
        annotatedAt: null,
      };
      await DB.putImage(rec);
      state.images.push(rec);
      cocoImgIdToOurId[cimg.id] = rec.id;
      imgAdded++;
    }
    // categories: id -> key
    const catMap = {};
    for (const c of coco.categories || []) {
      catMap[c.id] = c.name;
    }
    for (const ca of coco.annotations) {
      const ourImgId = cocoImgIdToOurId[ca.image_id];
      if (!ourImgId) continue;
      const damageType = catMap[ca.category_id];
      if (!DAMAGE_TYPE_BY_KEY[damageType]) continue;
      const dt = DAMAGE_TYPE_BY_KEY[damageType];
      const imgRec = state.images.find(i => i.id === ourImgId);
      if (!imgRec) continue;
      const W = imgRec.width, H = imgRec.height;
      const [bx, by, bw, bh] = ca.bbox || [0, 0, 0, 0];
      const attrs = ca.attributes || {};
      const annot = {
        id: uuid(),
        imageId: ourImgId,
        damageType,
        damageTypeLabel: dt.label,
        severity: attrs.severity || 'moderate',
        confidence: attrs.confidence || 3,
        shape: attrs.shape || (ca.segmentation && ca.segmentation.length > 0 ? 'polygon' : 'rect'),
        notes: attrs.notes || '',
        bbox: { x: bx, y: by, w: bw, h: bh },
        bboxNormalized: { x: bx / W, y: by / H, w: bw / W, h: bh / H },
        createdAt: nowMs(),
        updatedAt: nowMs(),
      };
      if (annot.shape === 'polygon' && ca.segmentation && ca.segmentation[0]) {
        const flat = ca.segmentation[0];
        const pts = [];
        for (let i = 0; i < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
        annot.polygonPoints = pts;
      }
      await DB.putAnnotation(annot);
      annAdded++;
    }
    toast(`画像 ${imgAdded} 件、アノテーション ${annAdded} 件をインポートしました`, 'success');
    // 反映
    state.images = await DB.getAllImages();
    if (state.currentImageId) {
      state.annotations = await DB.getAnnotationsByImage(state.currentImageId);
    }
    renderImageList();
    renderStats();
    renderAnnotationList();
    renderAnnotationsLayer();
    updateEmptyState();
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }
  function dataUrlToImg(dataUrl) {
    return new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = dataUrl;
    });
  }

  // ============================================================
  // ダークモード (既存サイトと連動)
  // ============================================================
  function initTheme() {
    const stored = localStorage.getItem('theme');
    const theme = stored || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
    updateThemeBtn(theme);
    $('#theme-toggle')?.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme') || 'light';
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('theme', next);
      updateThemeBtn(next);
    });
  }
  function updateThemeBtn(theme) {
    const btn = $('#theme-toggle');
    if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
  }

  // ============================================================
  // キーボードショートカット
  // ============================================================
  function initKeyboard() {
    document.addEventListener('keydown', (e) => {
      // フォーム要素にフォーカス中は無視
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      // モーダル開いている時もスキップ
      if (!$('#label-modal').hidden || !$('#confirm-modal').hidden) {
        if (e.key === 'Escape') {
          // モーダルは別ハンドラで閉じる
        }
        return;
      }
      if (e.key.toLowerCase() === 'r') { setTool('rect'); e.preventDefault(); }
      else if (e.key.toLowerCase() === 'b') { setTool('brush'); e.preventDefault(); }
      else if (e.key.toLowerCase() === 'p') { setTool('polygon'); e.preventDefault(); }
      else if (e.key.toLowerCase() === 'e') { setTool('eraser'); e.preventDefault(); }
      else if (e.key === 'Escape') {
        if (state.tool === 'polygon' && state.drawing.polygonPoints.length > 0) {
          cancelPolygon();
          toast('多角形をキャンセルしました', 'info', 1500);
        }
      }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        undoLastAnnotation();
        e.preventDefault();
      }
      else if (e.key === 'Delete' && state.highlightedAnnotationId) {
        const a = state.annotations.find(x => x.id === state.highlightedAnnotationId);
        if (a) {
          (async () => {
            const ok = await confirmDialog('選択中のアノテーションを削除しますか？', { title: '削除', okLabel: '削除' });
            if (!ok) return;
            await DB.deleteAnnotation(a.id);
            state.annotations = state.annotations.filter(x => x.id !== a.id);
            state.highlightedAnnotationId = null;
            renderAnnotationsLayer();
            renderAnnotationList();
            renderStats();
          })();
        }
      }
      else if (/^[1-9]$/.test(e.key)) {
        const idx = parseInt(e.key, 10) - 1;
        if (idx < DAMAGE_TYPES.length) {
          state.selectedDamageKey = DAMAGE_TYPES[idx].key;
          $('#damage-type-select').value = state.selectedDamageKey;
          toast(`選択: ${DAMAGE_TYPES[idx].id} ${DAMAGE_TYPES[idx].label}`, 'info', 1500);
        }
      }
    });
  }

  // ============================================================
  // ドラッグ&ドロップで画像追加
  // ============================================================
  function initDragDrop() {
    const empty = $('#empty-state');
    const main = $('#annot-main');
    const handlers = (el) => {
      el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('dragover'); });
      el.addEventListener('dragleave', () => el.classList.remove('dragover'));
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        el.classList.remove('dragover');
        const files = Array.from(e.dataTransfer.files || []).filter(f => /^image\//.test(f.type));
        if (files.length > 0) addImageFiles(files);
      });
    };
    handlers(empty);
    handlers(main);
  }

  // ============================================================
  // モーダル閉じる共通
  // ============================================================
  function initModalClose() {
    $$('[data-close-modal]').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.closeModal;
        const m = document.getElementById(id);
        if (m) m.hidden = true;
        if (id === 'label-modal') {
          state.pendingAnnotation = null;
          editingAnnotationId = null;
        }
      });
    });
    // Esc キーで label-modal を閉じる (confirm-modal は confirmDialog 側で処理)
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const labelModal = $('#label-modal');
      if (labelModal && !labelModal.hidden) {
        labelModal.hidden = true;
        state.pendingAnnotation = null;
        editingAnnotationId = null;
        e.stopPropagation();
      }
    });
  }

  // ============================================================
  // ツールバーイベント
  // ============================================================
  function initToolbar() {
    $$('.tool-btn').forEach(btn => {
      btn.addEventListener('click', () => setTool(btn.dataset.tool));
    });
    $('#brush-size').addEventListener('input', (e) => {
      state.brushSize = parseInt(e.target.value, 10) || 20;
      $('#brush-size-val').textContent = state.brushSize;
    });
    $('#zoom-slider').addEventListener('input', (e) => {
      state.zoom = parseFloat(e.target.value) || 1;
      $('#zoom-val').textContent = `${Math.round(state.zoom * 100)}%`;
      renderCanvas();
      updateCanvasMeta();
    });
    $('#btn-fit').addEventListener('click', () => {
      fitZoomToView();
      renderCanvas();
      updateCanvasMeta();
    });
    $('#damage-type-select').addEventListener('change', (e) => {
      state.selectedDamageKey = e.target.value;
    });
    $('#btn-undo').addEventListener('click', undoLastAnnotation);
    $('#btn-clear-image').addEventListener('click', clearCurrentImageAnnotations);
  }

  // ============================================================
  // ラベルフォームイベント
  // ============================================================
  function initLabelForm() {
    $('#form-confidence').addEventListener('input', (e) => {
      $('#form-confidence-val').textContent = e.target.value;
    });
    $('#btn-save-label').addEventListener('click', saveAnnotationFromForm);
  }

  // ============================================================
  // メインボタン
  // ============================================================
  function initSidebar() {
    $('#btn-add-image').addEventListener('click', () => $('#file-input').click());
    $('#file-input').addEventListener('change', (e) => {
      addImageFiles(Array.from(e.target.files || []));
      e.target.value = '';
    });
    $('#btn-export-zip').addEventListener('click', exportZip);
    $('#btn-export-json').addEventListener('click', exportJsonOnly);
    $('#btn-export-yolo').addEventListener('click', exportYoloOnly);
    $('#btn-import').addEventListener('click', () => $('#import-input').click());
    $('#import-input').addEventListener('change', (e) => {
      const f = e.target.files?.[0];
      if (f) importFromFile(f);
      e.target.value = '';
    });
    $('#btn-clear-all').addEventListener('click', clearAllData);
    $('#sidebar-toggle')?.addEventListener('click', () => {
      $('#annot-sidebar').classList.toggle('open');
    });
  }

  // ============================================================
  // 起動
  // ============================================================
  async function init() {
    initTheme();
    populateDamageTypeSelects();
    initSidebar();
    initToolbar();
    initLabelForm();
    initModalClose();
    initKeyboard();
    initDragDrop();
    attachCanvasEvents();

    try {
      await DB.open();
      state.images = await DB.getAllImages();
      // ソート (新しい順)
      state.images.sort((a, b) => b.uploadedAt - a.uploadedAt);
      if (state.images.length > 0) {
        await selectImage(state.images[0].id);
      }
      renderImageList();
      renderStats();
      updateEmptyState();
    } catch (err) {
      console.error(err);
      toast('データベースの初期化に失敗しました: ' + err.message, 'error', 5000);
    }

    // ウィンドウリサイズで Fit 再適用 (現在画像がある場合のみ)
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (state.currentImage) {
          // 何もしない (ユーザーのズーム値を尊重)
        }
      }, 150);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
