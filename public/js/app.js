// メルカリ写真 — たくさんの写真を、正方形・明るく整えて、まとめ写真も使って10枚に収める
// すべてiPhoneの中で処理する（写真はどこにも送らない）

const SIZE = 1080;            // メルカリ向けの出力サイズ
const OUT_COUNT = 10;         // 収める枚数
const JPEG_QUALITY = 0.92;
const MAX_PHOTOS = 80;
const SRC_LONG = 1440;        // 読み込んだ写真はこの大きさに縮めて持っておく（メモリ節約）
const GAP = 14;               // まとめ写真のすき間
const RADIUS = 14;            // まとめ写真の角の丸み

const state = {
  items: [],                  // { name, src: Blob, w, h, params }
  outputs: [],                // { blob, url, name, count }
  singles: null,              // 1枚で見せる写真の数（null = おまかせ）
  bright: 50,
  pink: 50,
  mode: 'pink',               // 'pink' = ピンクベージュ / 'black' = 黒い商品 / 'natural' = 色そのまま
  busy: false,
  runId: 0,
};

const $ = (s) => document.querySelector(s);
const els = {};

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('mp-settings') || '{}');
    if (typeof s.bright === 'number') state.bright = s.bright;
    if (typeof s.pink === 'number') state.pink = s.pink;
    if (['pink', 'black', 'natural'].includes(s.mode)) state.mode = s.mode;
  } catch (_) {}
}
function saveSettings() {
  try {
    localStorage.setItem('mp-settings', JSON.stringify({ bright: state.bright, pink: state.pink, mode: state.mode }));
  } catch (_) {}
}

// ---------- 分け方（10枚に収める） ----------

// 1枚で見せる写真の数の範囲
function singlesRange(n) {
  if (n <= OUT_COUNT) return { min: n, max: n, auto: n };
  // まとめ写真は1枚に2〜9枚。収まる「1枚で見せる数」の範囲を調べる
  let min = OUT_COUNT, max = 0;
  for (let s = 1; s < OUT_COUNT; s++) {
    const c = OUT_COUNT - s, r = n - s;
    if (r >= c * 2 && r <= c * 9) { min = Math.min(min, s); max = Math.max(max, s); }
  }
  if (!max) return { min: 1, max: 1, auto: 1 };
  // おまかせ：まとめ写真1枚に入れる数を 4 → 6 → 9 の順で増やして、1枚の写真をなるべく多く残す
  let auto = min;
  for (const cap of [4, 6, 9]) {
    const a = Math.floor((OUT_COUNT * cap - n) / (cap - 1));
    if (a >= 1) { auto = a; break; }
  }
  return { min, max, auto: Math.min(max, Math.max(min, auto)) };
}

// 写真の番号を、10枚ぶんのグループに分ける
function makeGroups(n, singles) {
  if (n <= OUT_COUNT) return Array.from({ length: n }, (_, i) => [i]);
  const groups = [];
  for (let i = 0; i < singles; i++) groups.push([i]);
  const c = OUT_COUNT - singles;
  const r = n - singles;
  const base = Math.floor(r / c), extra = r % c;
  let idx = singles;
  for (let k = 0; k < c; k++) {
    const size = base + (k >= c - extra ? 1 : 0);   // 多いほうを後ろに
    const g = [];
    for (let j = 0; j < size; j++) g.push(idx++);
    groups.push(g);
  }
  return groups;
}

// まとめ写真のレイアウト（縦の列に分けて、列の中を上下に分ける）
function columnsFor(n) {
  const cols = n <= 5 ? Math.min(n, 2) : 3;
  const per = Array(cols).fill(Math.floor(n / cols));
  for (let i = 0; i < n % cols; i++) per[cols - 1 - i]++;   // 左の列を少なく（大きく見せる）
  return per;
}

function panelRects(n) {
  const per = columnsFor(n);
  const cols = per.length;
  const cw = (SIZE - GAP * (cols + 1)) / cols;
  const rects = [];
  per.forEach((rows, ci) => {
    const rh = (SIZE - GAP * (rows + 1)) / rows;
    for (let ri = 0; ri < rows; ri++) {
      rects.push({ x: GAP + ci * (cw + GAP), y: GAP + ri * (rh + GAP), w: cw, h: rh });
    }
  });
  return rects;
}

// ---------- 画像処理 ----------

function percentile95(d, gr = 1, gg = 1, gb = 1) {
  const hist = new Uint32Array(1024);
  let n = 0;
  for (let i = 0; i < d.length; i += 16) {
    const m = (d[i] * gr + d[i + 1] * gg + d[i + 2] * gb) / 3;
    hist[Math.min(1023, Math.max(0, Math.round(m * 4)))]++;
    n++;
  }
  const target = n * 0.95;
  let acc = 0;
  for (let k = 0; k < 1024; k++) {
    acc += hist[k];
    if (acc >= target) return k / 4 / 255;
  }
  return 1;
}

// 写真1枚まるごとを見て、白の基準と明るさを決める
function analyze(d) {
  const thr = percentile95(d);
  let sr = 0, sg = 0, sb = 0, cnt = 0;
  for (let i = 0; i < d.length; i += 16) {
    const m = (d[i] + d[i + 1] + d[i + 2]) / 3 / 255;
    if (m >= thr) { sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; cnt++; }
  }
  let gr = 1, gg = 1, gb = 1, hasWhite = false;
  if (cnt > 0) {
    const r = sr / cnt, g = sg / cnt, b = sb / cnt, mean = (r + g + b) / 3;
    const chroma = (Math.max(r, g, b) - Math.min(r, g, b)) / mean;
    // 明るくて色の薄い背景があるときだけ、それを白の基準にする（アップ写真で商品の色を消さない）
    if (mean / 255 > 0.7 && chroma < 0.15) {
      hasWhite = true;
      gr = 1 + 0.8 * (mean / r - 1);
      gg = 1 + 0.8 * (mean / g - 1);
      gb = 1 + 0.8 * (mean / b - 1);
    }
  }
  const bright = percentile95(d, gr, gg, gb) || 1;
  const expo = Math.min(0.985 / bright, hasWhite ? 1.2 : 1.1);
  return { gr: gr * expo / 255, gg: gg * expo / 255, gb: gb * expo / 255 };
}

function apply(d, w, h, params, brightV, pinkV, mode) {
  const { gr, gg, gb } = params;
  const gamma = 1 - 0.4 * (brightV / 100);
  const isBlack = mode === 'black';
  const LUT_N = 4096;
  const lut = new Float32Array(LUT_N + 1);
  for (let k = 0; k <= LUT_N; k++) {
    const x = k / LUT_N;
    if (isBlack) {
      // 黒い商品：暗いところは持ち上げず、明るい背景だけ白く。黒は少し締める
      let t = (x - 0.35) / 0.45; t = t < 0 ? 0 : t > 1 ? 1 : t; t = t * t * (3 - 2 * t);
      const y = Math.pow(x, 1 + (gamma - 1) * t);
      lut[k] = Math.max(0, (y - 0.025) / 0.975);
    } else {
      lut[k] = Math.pow(x, gamma);
    }
  }
  const p = mode === 'pink' ? pinkV / 100 : 0;
  const tr = 1 + 0.07 * p, tg = 1 - 0.03 * p, tb = 1 + 0.04 * p;
  const s = isBlack ? 0.08 : 0.05;
  const curve = (v) => {
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    v = lut[(v * LUT_N) | 0];
    return v + s * (v - 0.5) * (1 - Math.abs(2 * v - 1));
  };

  for (let i = 0; i < d.length; i += 4) {
    let r = curve(d[i] * gr), g = curve(d[i + 1] * gg), b = curve(d[i + 2] * gb);
    if (isBlack) {
      const m = (r + g + b) / 3;
      if (m < 0.4) { const k = 0.35 * (1 - m / 0.4); r += (m - r) * k; g += (m - g) * k; b += (m - b) * k; }
    }
    if (p > 0) {
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      let wt = (mx - mn - 0.04) / 0.15;
      wt = wt < 0 ? 0 : wt > 1 ? 1 : wt;
      if (wt > 0) {
        r += (Math.min(1, r * tr) - r) * wt;
        g += (Math.min(1, g * tg) - g) * wt;
        b += (Math.min(1, b * tb) - b) * wt;
      }
    }
    d[i] = r * 255 + 0.5; d[i + 1] = g * 255 + 0.5; d[i + 2] = b * 255 + 0.5;
  }
  sharpen(d, w, h, 0.4);
}

function sharpen(d, w, h, amount) {
  const src = new Uint8ClampedArray(d);
  const row = w * 4;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * row + x * 4;
      for (let c = 0; c < 3; c++) {
        const k = i + c;
        const blur = (src[k - 4] + src[k + 4] + src[k - row] + src[k + row]) / 4;
        const diff = src[k] - blur;
        if (diff > 3 || diff < -3) d[k] = src[k] + diff * amount;
      }
    }
  }
}

// 写真を w×h の枠いっぱいに（真ん中で切り抜いて）描いて、仕上げをかける
async function renderPanel(item, w, h) {
  w = Math.round(w); h = Math.round(h);
  const bmp = await createImageBitmap(item.src);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const scale = Math.max(w / bmp.width, h / bmp.height);
  const sw = w / scale, sh = h / scale;
  ctx.drawImage(bmp, (bmp.width - sw) / 2, (bmp.height - sh) / 2, sw, sh, 0, 0, w, h);
  try { bmp.close(); } catch (_) {}
  const img = ctx.getImageData(0, 0, w, h);
  apply(img.data, w, h, item.params, state.bright, state.pink, state.mode);
  ctx.putImageData(img, 0, 0);
  return c;
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

async function composeGroup(group) {
  const out = document.createElement('canvas');
  out.width = out.height = SIZE;
  const ctx = out.getContext('2d');
  if (group.length === 1) {
    ctx.drawImage(await renderPanel(state.items[group[0]], SIZE, SIZE), 0, 0);
  } else {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, SIZE, SIZE);
    const rects = panelRects(group.length);
    for (let i = 0; i < group.length; i++) {
      const r = rects[i];
      const x = Math.round(r.x), y = Math.round(r.y);
      const panel = await renderPanel(state.items[group[i]], r.w, r.h);
      ctx.save();
      roundRectPath(ctx, x, y, panel.width, panel.height, RADIUS);
      ctx.clip();
      ctx.drawImage(panel, x, y);
      ctx.restore();
    }
  }
  return new Promise((res) => out.toBlob(res, 'image/jpeg', JPEG_QUALITY));
}

const nextFrame = () => new Promise((r) => setTimeout(r, 0));

function currentSingles() {
  const n = state.items.length;
  const rg = singlesRange(n);
  if (state.singles == null) return rg.auto;
  return Math.min(rg.max, Math.max(rg.min, state.singles));
}

async function processAll() {
  const n = state.items.length;
  if (!n) return;
  const run = ++state.runId;
  state.busy = true;
  const groups = makeGroups(n, currentSingles());
  clearOutputs();
  state.outputs = groups.map((g, i) => ({ blob: null, url: null, name: `mercari_${i + 1}.jpg`, count: g.length }));
  render();
  renderGrid();
  for (let i = 0; i < groups.length; i++) {
    setStatus(`仕上げ中… ${i + 1} / ${groups.length}`);
    await nextFrame();
    let blob = null;
    try { blob = await composeGroup(groups[i]); } catch (e) { console.error(e); }
    if (run !== state.runId) return;            // 途中で設定が変わったらやり直し
    const o = state.outputs[i];
    o.blob = blob;
    o.url = blob ? URL.createObjectURL(blob) : null;
    renderGrid();
  }
  state.busy = false;
  setStatus(n > groups.length
    ? `${n}枚の写真を${groups.length}枚に収めました`
    : `${groups.length}枚できました`);
  render();
}

// ---------- 読み込み ----------

async function loadFiles(fileList) {
  const files = Array.from(fileList).filter((f) => f.type.startsWith('image/') || /\.(heic|heif|jpe?g|png)$/i.test(f.name));
  if (!files.length) return;
  state.runId++;
  clearOutputs();
  state.items = [];
  state.singles = null;
  const picked = files.slice(0, MAX_PHOTOS);
  els.empty.hidden = true; els.work.hidden = false;
  for (const [idx, f] of picked.entries()) {
    setStatus(`読み込み中… ${idx + 1} / ${picked.length}`);
    await nextFrame();
    try {
      const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(f));
      const s = Math.min(1, SRC_LONG / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      try { bmp.close(); } catch (_) {}
      const params = analyze(ctx.getImageData(0, 0, c.width, c.height).data);
      const src = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.95));
      state.items.push({ name: f.name, src, w: c.width, h: c.height, params });
    } catch (e) {
      console.error('読み込めない画像', f.name, e);
    }
  }
  await processAll();
  if (files.length > MAX_PHOTOS) setStatus(`多すぎるので、最初の${MAX_PHOTOS}枚だけ使いました`);
}

function clearOutputs() {
  for (const o of state.outputs) if (o.url) URL.revokeObjectURL(o.url);
  state.outputs = [];
}

// ---------- 保存 ----------

async function saveAll() {
  const ready = state.outputs.filter((o) => o.blob);
  if (!ready.length) return;
  const files = ready.map((o) => new File([o.blob], o.name, { type: 'image/jpeg' }));

  if (navigator.canShare && navigator.canShare({ files })) {
    try {
      await navigator.share({ files });
      setStatus('共有画面で「画像を保存」を選ぶと写真アプリに入ります');
    } catch (e) {
      if (e && e.name === 'AbortError') setStatus('キャンセルしました');
      else setStatus('保存できませんでした。もう一度押してください');
    }
    return;
  }

  // 共有に対応していないブラウザ（パソコンなど）はダウンロード
  for (const o of ready) {
    const a = document.createElement('a');
    a.href = o.url; a.download = o.name;
    document.body.appendChild(a); a.click(); a.remove();
    await new Promise((r) => setTimeout(r, 250));
  }
  setStatus('ダウンロードしました');
}

// ---------- 画面 ----------

function setStatus(t) { if (els.status) els.status.textContent = t; }

function renderGrid() {
  els.grid.innerHTML = '';
  state.outputs.forEach((o, i) => {
    const b = document.createElement('div');
    b.className = 'thumb';
    if (o.url) {
      const img = document.createElement('img');
      img.src = o.url; img.alt = `${i + 1}枚目`;
      b.appendChild(img);
    } else {
      b.classList.add('pending');
    }
    const n = document.createElement('span');
    n.className = 'num';
    n.textContent = o.count > 1 ? `${i + 1}（${o.count}枚まとめ）` : `${i + 1}`;
    b.appendChild(n);
    els.grid.appendChild(b);
  });
}

function render() {
  const n = state.items.length;
  const has = n > 0;
  els.empty.hidden = has;
  els.work.hidden = !has;
  const outN = state.outputs.length;
  els.saveAll.disabled = state.busy || !outN;
  els.saveAll.textContent = outN ? `${outN}枚まとめて保存` : 'まとめて保存';
  els.bright.value = state.bright;
  els.pink.value = state.pink;
  els.brightVal.textContent = state.bright;
  els.pinkVal.textContent = state.pink;
  els.pinkWrap.hidden = state.mode !== 'pink';
  document.querySelectorAll('[name="mode"]').forEach((r) => { r.checked = r.value === state.mode; });

  const rg = singlesRange(n);
  const s = currentSingles();
  els.singlesWrap.hidden = n <= OUT_COUNT;
  els.singlesVal.textContent = s;
  els.singlesMinus.disabled = s <= rg.min;
  els.singlesPlus.disabled = s >= rg.max;
  els.summary.textContent = n > OUT_COUNT
    ? `写真${n}枚 → 1枚ずつ${s}枚 ＋ まとめ写真${OUT_COUNT - s}枚`
    : `写真${n}枚`;
}

let reTimer = null;
function scheduleReprocess() {
  saveSettings();
  render();
  clearTimeout(reTimer);
  reTimer = setTimeout(processAll, 350);
}

function init() {
  loadSettings();
  Object.assign(els, {
    empty: $('#empty'), work: $('#work'), grid: $('#grid'), status: $('#status'),
    input: $('#file'), saveAll: $('#save-all'),
    bright: $('#bright'), pink: $('#pink'), brightVal: $('#bright-val'), pinkVal: $('#pink-val'), pinkWrap: $('#pink-wrap'),
    singlesWrap: $('#singles-wrap'), singlesVal: $('#singles-val'), singlesMinus: $('#singles-minus'), singlesPlus: $('#singles-plus'),
    summary: $('#summary'),
  });

  els.input.addEventListener('change', (e) => { loadFiles(e.target.files); e.target.value = ''; });
  document.querySelectorAll('.pick').forEach((b) => b.addEventListener('click', () => els.input.click()));
  els.saveAll.addEventListener('click', saveAll);

  els.bright.addEventListener('input', (e) => { state.bright = +e.target.value; scheduleReprocess(); });
  els.pink.addEventListener('input', (e) => { state.pink = +e.target.value; scheduleReprocess(); });
  document.querySelectorAll('[name="mode"]').forEach((r) =>
    r.addEventListener('change', (e) => { state.mode = e.target.value; scheduleReprocess(); }));
  els.singlesMinus.addEventListener('click', () => { state.singles = currentSingles() - 1; scheduleReprocess(); });
  els.singlesPlus.addEventListener('click', () => { state.singles = currentSingles() + 1; scheduleReprocess(); });

  render();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
