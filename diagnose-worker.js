/* OpenCV-backed diagnosis worker. Runs heavy CV off the UI thread. */
/* global cv, Module */

(() => {
  'use strict';

  const RECT_W = 750;
  const RECT_H = 1050;
  const OPENCV_CDN_URLS = [
    'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js',
    'https://docs.opencv.org/4.10.0/opencv.js',
    'https://docs.opencv.org/4.x/opencv.js',
    'https://unpkg.com/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js',
  ];

  const DETECT_PARAMS = {
    textZones: [
      { name: 'top_text', y1: 0.00, y2: 0.16, strength: 0.10 },
      { name: 'art_caption', y1: 0.46, y2: 0.56, strength: 0.08 },
      { name: 'attack_text', y1: 0.56, y2: 0.83, strength: 0.10 },
      { name: 'bottom_rules', y1: 0.82, y2: 0.93, strength: 0.08 },
      { name: 'footer', y1: 0.91, y2: 1.00, strength: 0.08 },
    ],
    confidenceFloor: 0.12,
    confidenceFloorByType: {
      corner_damage: 0.18,
      stain: 0.18,
      indent: 0.15,
    },
    nmsIoU: 0.5,
  };

  let cvReady = false;
  let loadPromise = null;

  self.onmessage = async (event) => {
    const msg = event.data || {};
    try {
      if (msg.type === 'load') {
        await loadOpenCV(msg.requestId);
        self.postMessage({ type: 'ready', requestId: msg.requestId });
        return;
      }
      if (msg.type === 'analyze') {
        await loadOpenCV(msg.requestId);
        const result = analyzeImageData(msg);
        self.postMessage({ type: 'result', requestId: msg.requestId, result });
      }
    } catch (err) {
      self.postMessage({
        type: 'error',
        requestId: msg.requestId,
        message: err && err.message ? err.message : String(err),
      });
    }
  };

  function loadOpenCV(requestId) {
    if (cvReady && self.cv && typeof self.cv.Mat === 'function') return Promise.resolve();
    if (loadPromise) return loadPromise;

    loadPromise = new Promise((resolve, reject) => {
      let idx = 0;
      const tryNext = () => {
        if (idx >= OPENCV_CDN_URLS.length) {
          reject(new Error('OpenCV.js の読み込みに失敗しました'));
          return;
        }
        const url = OPENCV_CDN_URLS[idx++];
        progress(requestId, 18, `OpenCV.js を読み込み中 (${new URL(url).hostname})`, 2);
        try {
          self.Module = {
            onRuntimeInitialized: () => {
              if (self.cv && typeof self.cv.Mat === 'function') {
                cvReady = true;
                resolve();
              }
            },
          };
          importScripts(url);
          pollReady(0, resolve, reject, tryNext);
        } catch (err) {
          tryNext();
        }
      };
      tryNext();
    });
    return loadPromise;
  }

  function pollReady(count, resolve, reject, tryNext) {
    if (self.cv && typeof self.cv.Mat === 'function') {
      cvReady = true;
      resolve();
      return;
    }
    if (count > 300) {
      // A downloaded script with a stalled runtime cannot be safely unloaded; fail loudly.
      reject(new Error('OpenCV.js の初期化がタイムアウトしました'));
      return;
    }
    setTimeout(() => pollReady(count + 1, resolve, reject, tryNext), 100);
  }

  function analyzeImageData(msg) {
    const { width, height, buffer, requestId } = msg;
    if (!width || !height || !buffer) throw new Error('画像データが不正です');

    const src = new cv.Mat(height, width, cv.CV_8UC4);
    src.data.set(new Uint8ClampedArray(buffer));
    let rect = null;

    try {
      progress(requestId, 45, '撮影品質を評価中', 2);
      const imageQuality = safeCall(() => assessImageQuality(src), 'assessImageQuality') || { warnings: [], metrics: {} };

      progress(requestId, 50, 'カード境界を検出中', 2);
      const warpResult = safeCall(() => detectWarp(src), 'detectWarp');
      const r = safeCall(() => rectifyCard(src), 'rectifyCard');
      if (!r) return { error: 'card_not_detected' };
      rect = r.rect;

      progress(requestId, 56, '照明を正規化中', 2);
      safeCall(() => normalizeIllumination(rect), 'normalizeIllumination');

      progress(requestId, 60, 'センタリングを採点中', 2);
      const holoInfo = safeCall(() => detectHolographic(rect), 'detectHolographic') || { is_holographic: false, score: 0 };
      const innerFrame = safeCall(() => detectInnerFrame(rect), 'detectInnerFrame');
      const centering = innerFrame ? safeCall(() => computeCentering(innerFrame), 'computeCentering') : null;

      progress(requestId, 66, '折れ目を検出中', 3);
      const creases = safeCall(() => detectCreases(rect), 'detectCreases') || [];
      progress(requestId, 72, '凹みを検出中', 3);
      const indents = safeCall(() => detectIndents(rect), 'detectIndents') || [];
      progress(requestId, 78, '角の損傷を検出中', 3);
      const corners = safeCall(() => detectCornerDamage(rect), 'detectCornerDamage') || [];
      progress(requestId, 82, 'シミを検出中', 3);
      const stains = safeCall(() => detectStains(rect), 'detectStains') || [];

      let detections = [...creases, ...indents, ...corners, ...stains];
      if (warpResult && warpResult.severity) detections.push(warpResult);

      detections.forEach(d => applyLayoutMask(d, holoInfo));
      if (imageQuality.warnings && imageQuality.warnings.includes('motion_blur')) {
        detections.forEach(d => { d.confidence = (d.confidence || 0) * 0.8; });
      }
      if (imageQuality.warnings && imageQuality.warnings.includes('low_contrast')) {
        detections.forEach(d => { d.confidence = (d.confidence || 0) * 0.9; });
      }
      detections = detections
        .filter(d => (d.confidence || 0) >= detectionFloor(d))
        .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
      detections = applyNMS(detections, DETECT_PARAMS.nmsIoU).slice(0, 20);

      progress(requestId, 86, '結果を統合中', 4);
      if (r.method === 'center_fallback') {
        imageQuality.warnings = (imageQuality.warnings || []).concat(['estimated_boundary']);
      }

      return {
        engine: { name: 'opencv-worker', version: '0.3.0' },
        detections,
        imageQuality,
        holoInfo,
        centering,
        cardQuad: r.quad || null,
        boundary: { method: r.method, confidence: r.boundary_confidence },
      };
    } finally {
      try { if (rect) rect.delete(); } catch (_) {}
      try { src.delete(); } catch (_) {}
    }
  }

  function progress(requestId, pct, label, step) {
    self.postMessage({ type: 'progress', requestId, pct, label, step });
  }

  function safeCall(fn, name) {
    try { return fn(); }
    catch (err) {
      self.postMessage({ type: 'log', level: 'warn', message: `${name}: ${err.message || err}` });
      return null;
    }
  }

  function rectifyCard(srcMat) {
    const gray = new cv.Mat();
    const edges = new cv.Mat();
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    const candidates = [];

    try {
      cv.cvtColor(srcMat, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
      cv.Canny(gray, edges, 45, 140);
      cv.dilate(edges, edges, kernel, new cv.Point(-1, -1), 2);
      cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

      const imageArea = srcMat.cols * srcMat.rows;
      for (let i = 0; i < contours.size(); i++) {
        const contour = contours.get(i);
        const area = cv.contourArea(contour);
        if (area >= imageArea * 0.025) candidates.push({ contour, area });
        else contour.delete();
      }
      candidates.sort((a, b) => b.area - a.area);

      // 境界の定義:
      // 物理カードの「外周四辺」をカード境界とする。ポケモンカード標準比率は約 63:88。
      // アートワーク枠、テキスト枠、スリーブ内側の反射線はカード境界ではないため、
      // 面積・比率・画像中心からの距離で候補をスコアリングして外周らしいものを選ぶ。
      let best = null;
      for (const cand of candidates.slice(0, 12)) {
        const peri = cv.arcLength(cand.contour, true);
        for (const eps of [0.015, 0.02, 0.03, 0.045]) {
          const approx = new cv.Mat();
          cv.approxPolyDP(cand.contour, approx, eps * peri, true);
          if (approx.rows === 4) {
            const pts = [];
            for (let j = 0; j < 4; j++) {
              pts.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
            }
            const sorted = sortQuadCorners(pts);
            best = chooseBetterCardQuad(best, sorted, srcMat.cols, srcMat.rows, 'quad');
          }
          approx.delete();
        }

        const rotated = rotatedRectToQuad(cv.minAreaRect(cand.contour));
        best = chooseBetterCardQuad(best, rotated, srcMat.cols, srcMat.rows, 'rotated_rect');

        const br = cv.boundingRect(cand.contour);
        best = chooseBetterCardQuad(best, rectToCardQuad(br, srcMat.cols, srcMat.rows), srcMat.cols, srcMat.rows, 'bounding_rect');
      }
      const cardQuad = best ? best.quad : centralCardQuad(srcMat.cols, srcMat.rows);

      const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
        cardQuad[0].x, cardQuad[0].y,
        cardQuad[1].x, cardQuad[1].y,
        cardQuad[2].x, cardQuad[2].y,
        cardQuad[3].x, cardQuad[3].y,
      ]);
      const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, RECT_W - 1, 0, RECT_W - 1, RECT_H - 1, 0, RECT_H - 1]);
      const M = cv.getPerspectiveTransform(srcPts, dstPts);
      const rect = new cv.Mat();
      cv.warpPerspective(srcMat, rect, M, new cv.Size(RECT_W, RECT_H));
      srcPts.delete(); dstPts.delete(); M.delete();
      return { rect, quad: cardQuad, method: best ? best.method : 'center_fallback', boundary_confidence: best ? clamp01(best.score / 3.5) : 0.25 };
    } finally {
      candidates.forEach(c => { try { c.contour.delete(); } catch (_) {} });
      gray.delete(); edges.delete(); kernel.delete(); contours.delete(); hierarchy.delete();
    }
  }

  function chooseBetterCardQuad(current, quad, imageW, imageH, method) {
    const scored = scoreCardQuad(quad, imageW, imageH, method);
    if (!scored) return current;
    if (!current || scored.score > current.score) return scored;
    return current;
  }

  function scoreCardQuad(quad, imageW, imageH, method) {
    if (!quad || quad.length !== 4) return null;
    const sorted = sortQuadCorners(quad.map(p => ({
      x: clamp(p.x, 0, imageW - 1),
      y: clamp(p.y, 0, imageH - 1),
    })));
    const topW = dist(sorted[0], sorted[1]);
    const bottomW = dist(sorted[3], sorted[2]);
    const leftH = dist(sorted[0], sorted[3]);
    const rightH = dist(sorted[1], sorted[2]);
    const w = (topW + bottomW) / 2;
    const h = (leftH + rightH) / 2;
    const shortSide = Math.min(w, h);
    if (shortSide < Math.min(imageW, imageH) * 0.12 || shortSide < 60) return null;

    const area = polygonArea(sorted);
    const areaRatio = area / (imageW * imageH);
    if (areaRatio < 0.04 || areaRatio > 0.98) return null;

    const cardRatio = 63 / 88;
    const ratio = Math.min(w, h) / Math.max(w, h);
    const ratioPenalty = Math.min(1, Math.abs(ratio - cardRatio) / 0.35);
    if (ratioPenalty >= 1) return null;

    const cx = sorted.reduce((sum, p) => sum + p.x, 0) / 4;
    const cy = sorted.reduce((sum, p) => sum + p.y, 0) / 4;
    const centerDist = Math.hypot((cx - imageW / 2) / imageW, (cy - imageH / 2) / imageH);
    const methodBonus = method === 'quad' ? 0.35 : method === 'rotated_rect' ? 0.18 : 0.02;
    const score = areaRatio * 2.4 + (1 - ratioPenalty) * 1.4 + methodBonus - centerDist * 0.8;
    return { quad: sorted, score, method };
  }

  function rotatedRectToQuad(rr) {
    const cx = rr.center.x;
    const cy = rr.center.y;
    const w = rr.size.width;
    const h = rr.size.height;
    const angle = (rr.angle || 0) * Math.PI / 180;
    const ux = { x: Math.cos(angle), y: Math.sin(angle) };
    const uy = { x: -Math.sin(angle), y: Math.cos(angle) };
    const hw = w / 2;
    const hh = h / 2;
    return [
      { x: cx - ux.x * hw - uy.x * hh, y: cy - ux.y * hw - uy.y * hh },
      { x: cx + ux.x * hw - uy.x * hh, y: cy + ux.y * hw - uy.y * hh },
      { x: cx + ux.x * hw + uy.x * hh, y: cy + ux.y * hw + uy.y * hh },
      { x: cx - ux.x * hw + uy.x * hh, y: cy - ux.y * hw + uy.y * hh },
    ];
  }

  function rectToCardQuad(rect, imageW, imageH) {
    const cardRatio = 63 / 88;
    let x = rect.x;
    let y = rect.y;
    let w = rect.width;
    let h = rect.height;
    const ratio = Math.min(w, h) / Math.max(w, h);
    if (Math.abs(ratio - cardRatio) > 0.18) {
      const cx = x + w / 2;
      const cy = y + h / 2;
      if (h >= w) {
        h = Math.min(h, w / cardRatio);
        w = Math.min(w, h * cardRatio);
      } else {
        w = Math.min(w, h / cardRatio);
        h = Math.min(h, w * cardRatio);
      }
      x = cx - w / 2;
      y = cy - h / 2;
    }
    x = clamp(x, 0, imageW - w);
    y = clamp(y, 0, imageH - h);
    return [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ];
  }

  function centralCardQuad(imageW, imageH) {
    const cardRatio = 63 / 88;
    const imageRatio = imageW / imageH;
    let w, h;
    if (imageRatio >= cardRatio) {
      h = imageH * 0.92;
      w = h * cardRatio;
    } else {
      w = imageW * 0.92;
      h = w / cardRatio;
    }
    const x = (imageW - w) / 2;
    const y = (imageH - h) / 2;
    return [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ];
  }

  function normalizeIllumination(rectMat) {
    const lab = new cv.Mat();
    const channels = new cv.MatVector();
    let L = null;
    try {
      cv.cvtColor(rectMat, lab, cv.COLOR_RGBA2RGB);
      cv.cvtColor(lab, lab, cv.COLOR_RGB2Lab);
      cv.split(lab, channels);
      L = channels.get(0);
      if (typeof cv.CLAHE === 'function') {
        const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
        clahe.apply(L, L);
        clahe.delete();
      } else {
        cv.equalizeHist(L, L);
      }
      channels.set(0, L);
      cv.merge(channels, lab);
      cv.cvtColor(lab, lab, cv.COLOR_Lab2RGB);
      cv.cvtColor(lab, rectMat, cv.COLOR_RGB2RGBA);
    } finally {
      if (L) L.delete();
      channels.delete(); lab.delete();
    }
  }

  function detectCreases(rectMat) {
    const gray = new cv.Mat();
    const filtered = new cv.Mat();
    const edges = new cv.Mat();
    const lines = new cv.Mat();
    try {
      cv.cvtColor(rectMat, gray, cv.COLOR_RGBA2GRAY);
      cv.bilateralFilter(gray, filtered, 9, 75, 75);
      const cannyTh = computeAdaptiveCannyThresholds(filtered);
      cv.Canny(filtered, edges, cannyTh.low, cannyTh.high);
      cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 48, 60, 10);

      const W = rectMat.cols, H = rectMat.rows;
      const PX_TO_MM = 63.0 / W;
      const results = [];
      for (let i = 0; i < lines.rows; i++) {
        const x1 = lines.data32S[i * 4 + 0];
        const y1 = lines.data32S[i * 4 + 1];
        const x2 = lines.data32S[i * 4 + 2];
        const y2 = lines.data32S[i * 4 + 3];
        const lengthPx = Math.hypot(x2 - x1, y2 - y1);
        const lengthMm = lengthPx * PX_TO_MM;
        const yMid = (y1 + y2) / 2 / H;
        if (yMid < 0.07 || yMid > 0.93 || lengthMm < 6) continue;

        const features = computeCreaseFeatures(filtered, x1, y1, x2, y2);
        features.continuity = clamp01(lengthMm / 60);
        const mfConf = combineConfidences({
          straightness: features.straightness,
          brightness_diff: features.brightness_diff,
          side_balance: features.side_balance,
          continuity: features.continuity,
        });
        if (mfConf <= 0) continue;

        let severity = 'light';
        if (lengthMm >= 30) severity = 'severe';
        else if (lengthMm >= 10) severity = 'moderate';

        const confidence = Math.sqrt(Math.min(1, lengthMm / 60) * mfConf);
        results.push({
          type: 'crease',
          severity,
          confidence,
          length_mm: lengthMm,
          metrics: { length_mm: lengthMm, mean_intensity_diff: features.mean_intensity_diff, side_contrast: features.mean_side_contrast },
          geom: { kind: 'polyline', points_norm: [[x1 / W, y1 / H], [x2 / W, y2 / H]] },
        });
      }
      return mergeNearbyLines(results).slice(0, 10);
    } finally {
      gray.delete(); filtered.delete(); edges.delete(); lines.delete();
    }
  }

  function detectIndents(rectMat) {
    const lab = new cv.Mat();
    const channels = new cv.MatVector();
    const Lf = new cv.Mat();
    const bg = new cv.Mat();
    const diff = new cv.Mat();
    const mask0 = new cv.Mat();
    const dark = new cv.Mat();
    const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
    const stats = new cv.Mat();
    const centroids = new cv.Mat();
    const labels = new cv.Mat();
    let L = null;
    try {
      cv.cvtColor(rectMat, lab, cv.COLOR_RGBA2RGB);
      cv.cvtColor(lab, lab, cv.COLOR_RGB2Lab);
      cv.split(lab, channels);
      L = channels.get(0);
      cv.bilateralFilter(L, Lf, 7, 50, 50);
      cv.GaussianBlur(Lf, bg, new cv.Size(51, 51), 0);
      cv.subtract(Lf, bg, diff, mask0, cv.CV_16S);
      cv.threshold(diff, dark, -8, 255, cv.THRESH_BINARY_INV);
      dark.convertTo(dark, cv.CV_8U);
      cv.morphologyEx(dark, dark, cv.MORPH_OPEN, k);
      const num = cv.connectedComponentsWithStats(dark, labels, stats, centroids);

      const W = rectMat.cols, H = rectMat.rows;
      const PX_TO_MM = 63.0 / W;
      const cardAreaMm2 = 63 * 88;
      const results = [];
      for (let i = 1; i < num; i++) {
        const x = stats.intAt(i, cv.CC_STAT_LEFT);
        const y = stats.intAt(i, cv.CC_STAT_TOP);
        const w = stats.intAt(i, cv.CC_STAT_WIDTH);
        const h = stats.intAt(i, cv.CC_STAT_HEIGHT);
        const area = stats.intAt(i, cv.CC_STAT_AREA);
        const areaMm2 = area * PX_TO_MM * PX_TO_MM;
        if (areaMm2 < 2 || areaMm2 > cardAreaMm2 * 0.3) continue;

        let darkSum = 0, count = 0;
        for (let yy = y; yy < y + h; yy++) {
          for (let xx = x; xx < x + w; xx++) {
            if (labels.intAt(yy, xx) === i) {
              darkSum += -diff.shortAt(yy, xx);
              count++;
            }
          }
        }
        const avgDark = count ? darkSum / count : 0;
        const aspect = w > 0 && h > 0 ? Math.min(w, h) / Math.max(w, h) : 0;
        const fillRatio = w * h ? area / (w * h) : 0;
        const features = {
          intensity_drop: clamp01(avgDark / 35),
          compactness: clamp01(aspect),
          convexity: clamp01(fillRatio * 1.3),
        };
        const mfConf = combineConfidences(features);
        if (mfConf <= 0) continue;

        let severity = 'light';
        if (avgDark >= 30 || areaMm2 >= 150) severity = 'severe';
        else if (avgDark >= 15 || areaMm2 >= 30) severity = 'moderate';
        results.push({
          type: 'indent',
          severity,
          confidence: Math.sqrt(Math.min(1, avgDark / 40) * mfConf),
          metrics: { area_mm2: areaMm2, avg_intensity: avgDark, fill_ratio: fillRatio, aspect },
          geom: { kind: 'bbox', norm: [x / W, y / H, (x + w) / W, (y + h) / H] },
        });
      }
      return results.sort((a, b) => b.confidence - a.confidence).slice(0, 8);
    } finally {
      if (L) L.delete();
      lab.delete(); channels.delete(); Lf.delete(); bg.delete(); diff.delete(); mask0.delete();
      dark.delete(); k.delete(); stats.delete(); centroids.delete(); labels.delete();
    }
  }

  function detectCornerDamage(rectMat) {
    const W = rectMat.cols, H = rectMat.rows;
    const ROI = 80;
    const corners = [
      { name: 'TL', x: 0, y: 0 },
      { name: 'TR', x: W - ROI, y: 0 },
      { name: 'BR', x: W - ROI, y: H - ROI },
      { name: 'BL', x: 0, y: H - ROI },
    ];
    const results = [];
    for (const c of corners) {
      const roi = rectMat.roi(new cv.Rect(c.x, c.y, ROI, ROI));
      const gray = new cv.Mat();
      const fg = new cv.Mat();
      const ideal = cv.Mat.zeros(ROI, ROI, cv.CV_8U);
      const xor = new cv.Mat();
      try {
        cv.cvtColor(roi, gray, cv.COLOR_RGBA2GRAY);
        cv.threshold(gray, fg, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
        ideal.setTo(new cv.Scalar(255));
        cv.bitwise_xor(fg, ideal, xor);
        const missingRatio = cv.countNonZero(xor) / (ROI * ROI);
        let severity = null;
        if (missingRatio > 0.15) severity = 'severe';
        else if (missingRatio > 0.05) severity = 'moderate';
        else if (missingRatio > 0.01) severity = 'light';
        if (severity) {
          results.push({
            type: 'corner_damage',
            corner: c.name,
            severity,
            confidence: Math.min(1, missingRatio * 5),
            metrics: { missing_ratio: missingRatio },
            geom: { kind: 'bbox', norm: [c.x / W, c.y / H, (c.x + ROI) / W, (c.y + ROI) / H] },
          });
        }
      } finally {
        roi.delete(); gray.delete(); fg.delete(); ideal.delete(); xor.delete();
      }
    }
    return results;
  }

  function detectStains(rectMat) {
    const hsv = new cv.Mat();
    const ch = new cv.MatVector();
    const lower = new cv.Mat(rectMat.rows, rectMat.cols, cv.CV_8UC3, new cv.Scalar(10, 40, 100));
    const upper = new cv.Mat(rectMat.rows, rectMat.cols, cv.CV_8UC3, new cv.Scalar(30, 180, 230));
    const mask = new cv.Mat();
    const Sf = new cv.Mat();
    const dullMask = new cv.Mat();
    const combined = new cv.Mat();
    const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    let S = null;
    try {
      cv.cvtColor(rectMat, hsv, cv.COLOR_RGBA2RGB);
      cv.cvtColor(hsv, hsv, cv.COLOR_RGB2HSV);
      cv.split(hsv, ch);
      S = ch.get(1);
      cv.inRange(hsv, lower, upper, mask);
      cv.GaussianBlur(S, Sf, new cv.Size(31, 31), 0);
      cv.compare(S, Sf, dullMask, cv.CMP_LT);
      cv.bitwise_and(mask, dullMask, combined);
      cv.morphologyEx(combined, combined, cv.MORPH_OPEN, k);
      cv.findContours(combined, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      const W = rectMat.cols, H = rectMat.rows;
      const PX_TO_MM = 63.0 / W;
      const results = [];
      for (let i = 0; i < contours.size(); i++) {
        const contour = contours.get(i);
        const area = cv.contourArea(contour);
        if (area < 50) { contour.delete(); continue; }
        const r = cv.boundingRect(contour);
        contour.delete();
        const areaMm2 = area * PX_TO_MM * PX_TO_MM;
        const fillRatio = r.width * r.height ? area / (r.width * r.height) : 0;
        const aspect = r.width && r.height ? Math.min(r.width, r.height) / Math.max(r.width, r.height) : 0;
        const mfConf = combineConfidences({
          area: clamp01(areaMm2 / 80),
          connectedness: clamp01(fillRatio * 1.4),
          compactness: clamp01(aspect * 1.5),
        });
        if (mfConf <= 0) continue;
        let severity = 'light';
        if (areaMm2 > 50) severity = 'severe';
        else if (areaMm2 > 15) severity = 'moderate';
        results.push({
          type: 'stain',
          severity,
          confidence: Math.sqrt(Math.min(1, areaMm2 / 100) * mfConf),
          metrics: { area_mm2: areaMm2, fill_ratio: fillRatio, aspect },
          geom: { kind: 'bbox', norm: [r.x / W, r.y / H, (r.x + r.width) / W, (r.y + r.height) / H] },
        });
      }
      return results.sort((a, b) => b.confidence - a.confidence).slice(0, 5);
    } finally {
      if (S) S.delete();
      hsv.delete(); ch.delete(); lower.delete(); upper.delete(); mask.delete(); Sf.delete();
      dullMask.delete(); combined.delete(); k.delete(); contours.delete(); hierarchy.delete();
    }
  }

  function detectWarp(srcMat) {
    const gray = new cv.Mat();
    const edges = new cv.Mat();
    const contours = new cv.MatVector();
    const hier = new cv.Mat();
    try {
      cv.cvtColor(srcMat, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
      cv.Canny(gray, edges, 50, 150);
      cv.findContours(edges, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
      let maxArea = 0, idx = -1;
      for (let i = 0; i < contours.size(); i++) {
        const contour = contours.get(i);
        const area = cv.contourArea(contour);
        contour.delete();
        if (area > maxArea) { maxArea = area; idx = i; }
      }
      if (idx < 0) return null;
      const cnt = contours.get(idx);
      const hull = new cv.Mat();
      try {
        cv.convexHull(cnt, hull);
        const hullArea = cv.contourArea(hull);
        const minRect = cv.minAreaRect(cnt);
        const rectArea = minRect.size.width * minRect.size.height;
        const fillRatio = rectArea > 0 ? hullArea / rectArea : 1;
        if (fillRatio > 0.94) return null;
        const maxDevPx = Math.max(0, (1 - fillRatio) * minRect.size.width);
        const warpMm = maxDevPx * (63.0 / RECT_W);
        let severity = null;
        if (warpMm >= 5.0) severity = 'severe';
        else if (warpMm >= 3.5) severity = 'moderate';
        else if (warpMm >= 2.0) severity = 'light';
        return severity ? {
          type: 'warp',
          severity,
          confidence: Math.min(1, (warpMm - 1.5) / 4),
          metrics: { max_deviation_mm: warpMm, contour_fill_ratio: fillRatio },
          geom: { kind: 'card_global' },
        } : null;
      } finally {
        cnt.delete(); hull.delete();
      }
    } finally {
      gray.delete(); edges.delete(); contours.delete(); hier.delete();
    }
  }

  function assessImageQuality(srcMat) {
    const gray = new cv.Mat();
    const meanMat = new cv.Mat();
    const stdMat = new cv.Mat();
    const lap = new cv.Mat();
    const lapMean = new cv.Mat();
    const lapStd = new cv.Mat();
    try {
      cv.cvtColor(srcMat, gray, cv.COLOR_RGBA2GRAY);
      const meanVal = cv.mean(gray)[0];
      cv.meanStdDev(gray, meanMat, stdMat);
      const stdVal = stdMat.doubleAt(0, 0);
      cv.Laplacian(gray, lap, cv.CV_64F);
      cv.meanStdDev(lap, lapMean, lapStd);
      const lapVar = Math.pow(lapStd.doubleAt(0, 0), 2);
      const warnings = [];
      if (meanVal < 50) warnings.push('too_dark');
      if (meanVal > 220) warnings.push('too_bright');
      if (stdVal < 30) warnings.push('low_contrast');
      if (lapVar < 80) warnings.push('motion_blur');
      return { warnings, metrics: { mean_brightness: meanVal, contrast_std: stdVal, laplacian_variance: lapVar } };
    } finally {
      gray.delete(); meanMat.delete(); stdMat.delete(); lap.delete(); lapMean.delete(); lapStd.delete();
    }
  }

  function detectHolographic(rectMat) {
    const W = rectMat.cols, H = rectMat.rows;
    const ax = Math.round(W * 0.15), ay = Math.round(H * 0.18);
    const aw = Math.round(W * 0.70), ah = Math.round(H * 0.37);
    const roi = rectMat.roi(new cv.Rect(ax, ay, aw, ah));
    const hsv = new cv.Mat();
    const ch = new cv.MatVector();
    const sMean = new cv.Mat();
    const sStd = new cv.Mat();
    let Hch = null, Sch = null;
    try {
      cv.cvtColor(roi, hsv, cv.COLOR_RGBA2RGB);
      cv.cvtColor(hsv, hsv, cv.COLOR_RGB2HSV);
      cv.split(hsv, ch);
      Hch = ch.get(0);
      Sch = ch.get(1);
      cv.meanStdDev(Sch, sMean, sStd);
      const satStd = sStd.doubleAt(0, 0);
      const sample = [];
      for (let yy = 0; yy < Hch.rows; yy += 4) {
        for (let xx = 0; xx < Hch.cols; xx += 4) {
          if (Sch.ucharAt(yy, xx) > 30) sample.push(Hch.ucharAt(yy, xx));
        }
      }
      let hueRange = 0;
      if (sample.length > 50) {
        sample.sort((a, b) => a - b);
        hueRange = sample[Math.floor(sample.length * 0.9)] - sample[Math.floor(sample.length * 0.1)];
      }
      const score = clamp01((satStd - 25) / 60) * 0.6 + clamp01((hueRange - 20) / 80) * 0.4;
      return {
        is_holographic: score >= 0.45,
        score,
        area_norm: [ax / W, ay / H, (ax + aw) / W, (ay + ah) / H],
        metrics: { saturation_std: satStd, hue_range: hueRange },
      };
    } finally {
      if (Hch) Hch.delete();
      if (Sch) Sch.delete();
      roi.delete(); hsv.delete(); ch.delete(); sMean.delete(); sStd.delete();
    }
  }

  function detectInnerFrame(rectMat) {
    const rgb = new cv.Mat();
    const gray = new cv.Mat();
    const hsv = new cv.Mat();
    try {
      const W = rectMat.cols, H = rectMat.rows;
      cv.cvtColor(rectMat, rgb, cv.COLOR_RGBA2RGB);
      cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
      cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
      const projected = detectProjectedInnerFrame(gray, hsv, W, H);
      const projectedStable = projected ? stabilizeCenteringFrame(projected, W, H) : null;
      if (projectedStable && isPlausibleFrame(projectedStable, W, H)) return projectedStable;
      const scanned = detectScannedInnerFrame(gray, hsv, W, H);
      const scannedStable = scanned ? stabilizeCenteringFrame(scanned, W, H) : null;
      return scannedStable && isPlausibleFrame(scannedStable, W, H) ? scannedStable : null;
    } finally {
      rgb.delete(); gray.delete(); hsv.delete();
    }
  }

  function detectProjectedInnerFrame(gray, hsv, W, H) {
    const left = findBoundaryByProjection(gray, hsv, 'x',
      Math.round(W * 0.025), Math.round(W * 0.25),
      Math.round(H * 0.10), Math.round(H * 0.90), false);
    const right = findBoundaryByProjection(gray, hsv, 'x',
      Math.round(W * 0.75), Math.round(W * 0.975),
      Math.round(H * 0.10), Math.round(H * 0.90), true);
    const top = findBoundaryByProjection(gray, hsv, 'y',
      Math.round(H * 0.025), Math.round(H * 0.24),
      Math.round(W * 0.12), Math.round(W * 0.88), false);
    const bottom = findBoundaryByProjection(gray, hsv, 'y',
      Math.round(H * 0.76), Math.round(H * 0.975),
      Math.round(W * 0.12), Math.round(W * 0.88), true);

    if (!left || !right || !top || !bottom) return null;
    const frame = {
      top: top.pos,
      bottom: H - bottom.pos,
      left: left.pos,
      right: W - right.pos,
      outer: [0, 0, W, H],
      inner: [Math.round(left.pos), Math.round(top.pos), Math.round(right.pos), Math.round(bottom.pos)],
      confidence: clamp01((left.confidence + right.confidence + top.confidence + bottom.confidence) / 4),
      method: 'projection',
    };
    return frame;
  }

  function detectScannedInnerFrame(gray, hsv, W, H) {
    const SAMPLES = 21;
    const topVals = [], bottomVals = [], leftVals = [], rightVals = [];
    for (let i = 1; i < SAMPLES - 1; i++) {
      const x = Math.round((i / SAMPLES) * W);
      const y = Math.round((i / SAMPLES) * H);
      const t = scanForFrameBoundary(gray, hsv, x, 0, 0, 1, Math.floor(H * 0.2), Math.floor(H * 0.005));
      const b = scanForFrameBoundary(gray, hsv, x, H - 1, 0, -1, Math.floor(H * 0.2), Math.floor(H * 0.005));
      const l = scanForFrameBoundary(gray, hsv, 0, y, 1, 0, Math.floor(W * 0.2), Math.floor(W * 0.005));
      const r = scanForFrameBoundary(gray, hsv, W - 1, y, -1, 0, Math.floor(W * 0.2), Math.floor(W * 0.005));
      if (t != null) topVals.push(t);
      if (b != null) bottomVals.push(b);
      if (l != null) leftVals.push(l);
      if (r != null) rightVals.push(r);
    }
    const top = robustMedian(topVals), bottom = robustMedian(bottomVals);
    const left = robustMedian(leftVals), right = robustMedian(rightVals);
    if (top == null || bottom == null || left == null || right == null) return null;
    const variances = [stdOf(topVals), stdOf(bottomVals), stdOf(leftVals), stdOf(rightVals)].filter(v => v != null);
    const avgStd = variances.length ? variances.reduce((a, b) => a + b, 0) / variances.length : 30;
    return {
      top, bottom, left, right,
      outer: [0, 0, W, H],
      inner: [Math.round(left), Math.round(top), Math.round(W - right), Math.round(H - bottom)],
      confidence: clamp01(1 - avgStd / 30),
      method: 'scan',
    };
  }

  function findBoundaryByProjection(gray, hsv, axis, start, end, bandStart, bandEnd, reverse) {
    const step = 2;
    const positions = [];
    if (reverse) {
      for (let p = end; p >= start; p -= step) positions.push(p);
    } else {
      for (let p = start; p <= end; p += step) positions.push(p);
    }
    if (!positions.length) return null;

    const raw = positions.map(pos => projectionScoreAt(gray, hsv, axis, pos, bandStart, bandEnd));
    const scores = smoothScores(raw, 2);
    const median = percentile(scores, 0.5);
    const p90 = percentile(scores, 0.9);
    const maxScore = Math.max(...scores);
    const threshold = Math.max(7, median + 4, median + (p90 - median) * 0.55);
    if (maxScore < threshold) return null;

    let best = -1;
    for (let i = 0; i < scores.length; i++) {
      if (scores[i] < threshold) continue;
      best = i;
      const limit = Math.min(scores.length - 1, i + 8);
      for (let j = i + 1; j <= limit; j++) {
        if (scores[j] < threshold * 0.82) break;
        if (scores[j] > scores[best]) best = j;
      }
      break;
    }
    if (best < 0) best = scores.indexOf(maxScore);
    return {
      pos: positions[best],
      score: scores[best],
      confidence: clamp01(0.4 + (scores[best] - threshold) / 26),
    };
  }

  function projectionScoreAt(gray, hsv, axis, pos, bandStart, bandEnd) {
    const W = gray.cols, H = gray.rows;
    const vals = [];
    const step = 4;
    if (axis === 'x') {
      const x1 = clamp(Math.round(pos - 1), 0, W - 1);
      const x2 = clamp(Math.round(pos + 1), 0, W - 1);
      for (let y = bandStart; y <= bandEnd; y += step) {
        vals.push(pixelEdgeScore(gray, hsv, x1, y, x2, y));
      }
    } else {
      const y1 = clamp(Math.round(pos - 1), 0, H - 1);
      const y2 = clamp(Math.round(pos + 1), 0, H - 1);
      for (let x = bandStart; x <= bandEnd; x += step) {
        vals.push(pixelEdgeScore(gray, hsv, x, y1, x, y2));
      }
    }
    return percentile(vals, 0.65);
  }

  function pixelEdgeScore(gray, hsv, x1, y1, x2, y2) {
    const W = gray.cols;
    const idx1 = (y1 * W + x1) * 3;
    const idx2 = (y2 * W + x2) * 3;
    const dG = Math.abs(gray.ucharAt(y1, x1) - gray.ucharAt(y2, x2));
    let dH = Math.abs(hsv.data[idx1] - hsv.data[idx2]);
    dH = Math.min(dH, 180 - dH);
    const dS = Math.abs(hsv.data[idx1 + 1] - hsv.data[idx2 + 1]);
    return dG + dS * 0.45 + dH * 0.25;
  }

  function smoothScores(values, radius) {
    return values.map((_, i) => {
      let sum = 0, count = 0;
      for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j++) {
        sum += values[j];
        count++;
      }
      return count ? sum / count : values[i];
    });
  }

  function isPlausibleFrame(frame, W, H) {
    if (!frame) return false;
    const { top, bottom, left, right } = frame;
    if ([top, bottom, left, right].some(v => !isFinite(v) || v <= 0)) return false;
    const innerW = W - left - right;
    const innerH = H - top - bottom;
    if (innerW < W * 0.55 || innerW > W * 0.96) return false;
    if (innerH < H * 0.55 || innerH > H * 0.96) return false;
    if (left < W * 0.015 || right < W * 0.015 || top < H * 0.015 || bottom < H * 0.015) return false;
    const lrRatio = Math.max(left, right) / Math.max(1, Math.min(left, right));
    const tbRatio = Math.max(top, bottom) / Math.max(1, Math.min(top, bottom));
    return frame.confidence >= 0.45 && lrRatio <= 6 && tbRatio <= 4.5;
  }

  function stabilizeCenteringFrame(frame, W, H) {
    const h = constrainMarginPair(frame.left, frame.right, W * 0.025, W * 0.13);
    const v = constrainMarginPair(frame.top, frame.bottom, H * 0.018, H * 0.13);
    if (!h || !v) return null;
    const stabilized = h.stabilized || v.stabilized;
    const left = h.a;
    const right = h.b;
    const top = v.a;
    const bottom = v.b;
    return {
      ...frame,
      top,
      bottom,
      left,
      right,
      inner: [Math.round(left), Math.round(top), Math.round(W - right), Math.round(H - bottom)],
      confidence: clamp01((frame.confidence || 0) * (stabilized ? 0.82 : 1)),
      stabilized,
    };
  }

  function constrainMarginPair(a, b, minMargin, maxMargin) {
    if (!isFinite(a) || !isFinite(b) || a <= 0 || b <= 0) return null;
    let x = clamp(a, minMargin, maxMargin);
    let y = clamp(b, minMargin, maxMargin);
    let stabilized = Math.abs(x - a) > 1 || Math.abs(y - b) > 1;
    const maxRatio = 1.22; // 約55/45。センタリング線が内部テキスト線へ飛ぶのを防ぐ。
    const lo = Math.min(x, y);
    const hi = Math.max(x, y);
    if (lo > 0 && hi / lo > maxRatio) {
      if (x > y) x = y * maxRatio;
      else y = x * maxRatio;
      stabilized = true;
    }
    return { a: x, b: y, stabilized };
  }

  function computeCentering(frame) {
    const { top, bottom, left, right } = frame;
    const horizSum = left + right;
    const vertSum = top + bottom;
    if (horizSum <= 0 || vertSum <= 0) return null;
    const leftPct = (left / horizSum) * 100;
    const rightPct = (right / horizSum) * 100;
    const topPct = (top / vertSum) * 100;
    const bottomPct = (bottom / vertSum) * 100;
    const horizDev = Math.abs(left - right) / horizSum * 100;
    const vertDev = Math.abs(top - bottom) / vertSum * 100;
    const worstRatio = Math.max(leftPct, rightPct, topPct, bottomPct);
    let estimatedGrade;
    if (worstRatio <= 55) estimatedGrade = 'GEM MINT 10';
    else if (worstRatio <= 60) estimatedGrade = 'MINT 9';
    else if (worstRatio <= 65) estimatedGrade = 'NM-MT 8';
    else if (worstRatio <= 70) estimatedGrade = 'NM 7';
    else if (worstRatio <= 80) estimatedGrade = 'EX-MT 6';
    else if (worstRatio <= 85) estimatedGrade = 'EX 5/4';
    else if (worstRatio <= 90) estimatedGrade = 'VG or lower';
    else estimatedGrade = 'OC';
    return {
      horizontal: { leftPx: left, rightPx: right, leftPercent: leftPct, rightPercent: rightPct, deviation: horizDev, label: `${Math.round(leftPct)}/${Math.round(rightPct)}` },
      vertical: { topPx: top, bottomPx: bottom, topPercent: topPct, bottomPercent: bottomPct, deviation: vertDev, label: `${Math.round(topPct)}/${Math.round(bottomPct)}` },
      estimatedGrade,
      overallScore: Math.max(0, Math.round(100 - (worstRatio - 50) * 2)),
      worstDeviation: Math.max(horizDev, vertDev),
      worstRatio,
      annotation: { outer_rect: frame.outer, inner_rect: frame.inner },
      detection_confidence: frame.confidence,
      method: frame.method,
      stabilized: !!frame.stabilized,
    };
  }

  function computeAdaptiveCannyThresholds(grayMat) {
    const data = grayMat.data;
    const step = Math.max(1, Math.floor(data.length / 10000));
    const sample = [];
    for (let i = 0; i < data.length; i += step) sample.push(data[i]);
    sample.sort((a, b) => a - b);
    const median = sample[Math.floor(sample.length / 2)] || 128;
    const low = Math.max(20, Math.floor(0.67 * median));
    const high = Math.min(220, Math.max(low + 30, Math.floor(1.33 * median)));
    return { low, high };
  }

  function computeCreaseFeatures(grayMat, x1, y1, x2, y2) {
    const W = grayMat.cols, H = grayMat.rows;
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    let validDiff = 0, sideContrast = 0, samples = 0;
    for (let i = 1; i < 23; i++) {
      const t = i / 24;
      const px = x1 + dx * t, py = y1 + dy * t;
      const lx = Math.round(px - nx * 4), ly = Math.round(py - ny * 4);
      const rx = Math.round(px + nx * 4), ry = Math.round(py + ny * 4);
      const cx = Math.round(px), cy = Math.round(py);
      if (lx < 0 || lx >= W || ly < 0 || ly >= H || rx < 0 || rx >= W || ry < 0 || ry >= H || cx < 0 || cx >= W || cy < 0 || cy >= H) continue;
      const sideMean = (grayMat.ucharAt(ly, lx) + grayMat.ucharAt(ry, rx)) / 2;
      sideContrast += Math.abs(grayMat.ucharAt(ly, lx) - grayMat.ucharAt(ry, rx));
      validDiff += Math.abs(grayMat.ucharAt(cy, cx) - sideMean);
      samples++;
    }
    if (samples < 4) return { straightness: 0, brightness_diff: 0, side_balance: 0, mean_intensity_diff: 0, mean_side_contrast: 0 };
    const meanDiff = validDiff / samples;
    const meanSideContrast = sideContrast / samples;
    return {
      straightness: 0.85,
      brightness_diff: clamp01((meanDiff - 4) / 25),
      side_balance: clamp01(1 - Math.max(0, meanSideContrast - 10) / 45),
      mean_intensity_diff: meanDiff,
      mean_side_contrast: meanSideContrast,
    };
  }

  function combineConfidences(features, weights) {
    const keys = Object.keys(features);
    if (!keys.length) return 0;
    if (keys.some(k => features[k] < 0.18)) return 0;
    let sum = 0, wsum = 0;
    keys.forEach(k => {
      const w = (weights && weights[k]) || 1;
      sum += features[k] * w;
      wsum += w;
    });
    return clamp01(sum / wsum);
  }

  function mergeNearbyLines(lines) {
    const merged = [];
    const used = new Set();
    for (let i = 0; i < lines.length; i++) {
      if (used.has(i)) continue;
      let cur = { ...lines[i] };
      for (let j = i + 1; j < lines.length; j++) {
        if (!used.has(j) && areLinesSimilar(cur, lines[j])) {
          cur = mergeLinePair(cur, lines[j]);
          used.add(j);
        }
      }
      used.add(i);
      merged.push(cur);
    }
    return merged;
  }

  function areLinesSimilar(a, b) {
    const ang = l => Math.atan2(l.geom.points_norm[1][1] - l.geom.points_norm[0][1], l.geom.points_norm[1][0] - l.geom.points_norm[0][0]);
    const dAng = Math.abs(ang(a) - ang(b)) % Math.PI;
    if (dAng > 0.087 && dAng < Math.PI - 0.087) return false;
    const ax1 = a.geom.points_norm[0][0] * RECT_W, ay1 = a.geom.points_norm[0][1] * RECT_H;
    const ax2 = a.geom.points_norm[1][0] * RECT_W, ay2 = a.geom.points_norm[1][1] * RECT_H;
    const bx1 = b.geom.points_norm[0][0] * RECT_W, by1 = b.geom.points_norm[0][1] * RECT_H;
    const bx2 = b.geom.points_norm[1][0] * RECT_W, by2 = b.geom.points_norm[1][1] * RECT_H;
    return Math.min(
      Math.hypot(ax2 - bx1, ay2 - by1),
      Math.hypot(ax1 - bx2, ay1 - by2),
      Math.hypot(ax1 - bx1, ay1 - by1),
      Math.hypot(ax2 - bx2, ay2 - by2),
    ) < 15;
  }

  function mergeLinePair(a, b) {
    const pts = [
      { x: a.geom.points_norm[0][0] * RECT_W, y: a.geom.points_norm[0][1] * RECT_H },
      { x: a.geom.points_norm[1][0] * RECT_W, y: a.geom.points_norm[1][1] * RECT_H },
      { x: b.geom.points_norm[0][0] * RECT_W, y: b.geom.points_norm[0][1] * RECT_H },
      { x: b.geom.points_norm[1][0] * RECT_W, y: b.geom.points_norm[1][1] * RECT_H },
    ];
    let maxD = 0, p1 = pts[0], p2 = pts[1];
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
      if (d > maxD) { maxD = d; p1 = pts[i]; p2 = pts[j]; }
    }
    return {
      ...a,
      length_mm: maxD * (63.0 / RECT_W),
      geom: { kind: 'polyline', points_norm: [[p1.x / RECT_W, p1.y / RECT_H], [p2.x / RECT_W, p2.y / RECT_H]] },
    };
  }

  function scanForFrameBoundary(grayMat, hsvMat, sx, sy, dx, dy, maxScan, minBorder) {
    const W = grayMat.cols, H = grayMat.rows;
    let prevGray = null, prevHue = null, edgeAccum = 0;
    for (let s = 0; s < maxScan; s++) {
      const x = sx + dx * s, y = sy + dy * s;
      if (x < 0 || x >= W || y < 0 || y >= H) break;
      const g = grayMat.ucharAt(y, x);
      const h = hsvMat.data[(y * W + x) * 3];
      if (s >= minBorder && prevGray != null) {
        const dG = Math.abs(g - prevGray);
        let dH = Math.abs(h - prevHue);
        dH = Math.min(dH, 180 - dH);
        if (dG > 22 || dH > 12) {
          edgeAccum++;
          if (edgeAccum >= 2) return s;
        } else {
          edgeAccum = 0;
        }
      }
      prevGray = g;
      prevHue = h;
    }
    return null;
  }

  function applyLayoutMask(d, holoInfo) {
    const bbox = bboxNormOf(d);
    if (!bbox) return;
    const [nx1, ny1, nx2, ny2] = bbox;
    const cy = (ny1 + ny2) / 2;
    const bw = Math.max(0, nx2 - nx1);
    const bh = Math.max(0, ny2 - ny1);
    const area = bw * bh;
    for (const z of DETECT_PARAMS.textZones) {
      const overlap = overlapRatio1D(ny1, ny2, z.y1, z.y2);
      if (cy >= z.y1 && cy <= z.y2 || overlap >= 0.35) {
        if (d.type === 'indent') {
          const areaMm2 = d.metrics && Number.isFinite(d.metrics.area_mm2) ? d.metrics.area_mm2 : 0;
          const smallTextBlob = areaMm2 < 30 && (area < 0.018 || bh < 0.055);
          d.confidence = (d.confidence || 0) * (smallTextBlob ? z.strength : 0.9);
          d.metrics = { ...(d.metrics || {}), layout_suppressed: z.name };
        } else if (d.type === 'crease') {
          d.confidence = (d.confidence || 0) * (isPrintedRuleLine(d) ? 0.35 : 0.75);
          d.metrics = { ...(d.metrics || {}), layout_suppressed: z.name };
        } else {
          d.confidence = (d.confidence || 0) * 0.55;
        }
        break;
      }
    }
    if (holoInfo && holoInfo.is_holographic && holoInfo.area_norm && d.type !== 'crease') {
      const cx = (nx1 + nx2) / 2;
      const cy2 = (ny1 + ny2) / 2;
      const [hx1, hy1, hx2, hy2] = holoInfo.area_norm;
      if (cx >= hx1 && cx <= hx2 && cy2 >= hy1 && cy2 <= hy2) d.confidence = (d.confidence || 0) * 0.7;
    }
  }

  function isPrintedRuleLine(d) {
    if (!d.geom || d.geom.kind !== 'polyline' || !d.geom.points_norm) return false;
    const [[x1, y1], [x2, y2]] = d.geom.points_norm;
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    const length = Math.hypot(dx, dy);
    return length > 0.08 && (dy / (dx || 1e-9)) < 0.16;
  }

  function overlapRatio1D(a1, a2, b1, b2) {
    const inter = Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
    return inter / Math.max(1e-9, a2 - a1);
  }

  function detectionFloor(d) {
    return DETECT_PARAMS.confidenceFloorByType[d.type] || DETECT_PARAMS.confidenceFloor;
  }

  function bboxNormOf(d) {
    if (!d.geom) return null;
    if (d.geom.kind === 'bbox' && d.geom.norm) return d.geom.norm;
    if (d.geom.kind === 'polyline' && d.geom.points_norm) {
      const xs = d.geom.points_norm.map(p => p[0]);
      const ys = d.geom.points_norm.map(p => p[1]);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }
    return null;
  }

  function applyNMS(detections, iouThresh) {
    const byType = {};
    detections.forEach(d => { (byType[d.type] ||= []).push(d); });
    const out = [];
    for (const t of Object.keys(byType)) {
      const keep = [];
      for (const d of byType[t].sort((a, b) => (b.confidence || 0) - (a.confidence || 0))) {
        const db = bboxNormOf(d);
        if (!db || keep.every(k => !bboxNormOf(k) || computeIoU(db, bboxNormOf(k)) <= iouThresh)) keep.push(d);
      }
      out.push(...keep);
    }
    return out;
  }

  function computeIoU(a, b) {
    const ix1 = Math.max(a[0], b[0]), iy1 = Math.max(a[1], b[1]);
    const ix2 = Math.min(a[2], b[2]), iy2 = Math.min(a[3], b[3]);
    const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
    const ua = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
    const ub = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
    const uni = ua + ub - inter;
    return uni > 0 ? inter / uni : 0;
  }

  function sortQuadCorners(pts) {
    const sums = pts.map(p => p.x + p.y);
    const diffs = pts.map(p => p.x - p.y);
    return [
      pts[sums.indexOf(Math.min(...sums))],
      pts[diffs.indexOf(Math.max(...diffs))],
      pts[sums.indexOf(Math.max(...sums))],
      pts[diffs.indexOf(Math.min(...diffs))],
    ];
  }

  function robustMedian(values) {
    if (!values || !values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const trim = Math.floor(sorted.length * 0.1);
    const trimmed = sorted.slice(trim, sorted.length - trim);
    return (trimmed.length ? trimmed : sorted)[Math.floor((trimmed.length ? trimmed : sorted).length / 2)];
  }

  function percentile(values, p) {
    if (!values || !values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const idx = clamp(Math.round((sorted.length - 1) * p), 0, sorted.length - 1);
    return sorted[idx];
  }

  function polygonArea(points) {
    let area = 0;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      area += (points[j].x + points[i].x) * (points[j].y - points[i].y);
    }
    return Math.abs(area / 2);
  }

  function stdOf(values) {
    if (!values || values.length < 2) return null;
    const m = values.reduce((a, b) => a + b, 0) / values.length;
    return Math.sqrt(values.reduce((a, b) => a + (b - m) * (b - m), 0) / values.length);
  }

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function clamp01(v) { return Math.max(0, Math.min(1, v)); }
})();
