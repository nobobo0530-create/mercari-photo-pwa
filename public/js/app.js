// メルカリ写真 — 写真をまとめて正方形・明るく・ピンクベージュに整えて、まとめて保存する
// すべてiPhoneの中で処理する（写真はどこにも送らない）

const SIZE = 1080;            // メルカリ向けの出力サイズ
const JPEG_QUALITY = 0.92;
const MAX_PHOTOS = 20;        // メルカリの上限

const state = {
  items: [],                  // { file, name, bitmap, blob, url }
  bright: 50,                 // 0-100（50 = 前回OKをもらった明るさ）
  pink: 50,                   // 0-100（50 = 前回OKをもらったピンク）
  mode: 'pink',               // 'pink' = ピンクベージュ / 'black' = 黒い商品 / 'natural' = 色そのまま
  fit: 'crop',                // 'crop' = 真ん中で切り抜き / 'pad' = 白い余白で正方形
  busy: false,
};

const $ = (s) => document.querySelector(s);
const els = {};

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('mp-settings') || '{}');
    if (typeof s.bright === 'number') state.bright = s.bright;
    if (typeof s.pink === 'number') state.pink = s.pink;
    if (['pink', 'black', 'natural'].includes(s.mode)) state.mode = s.mode;
    if (s.fit === 'crop' || s.fit === 'pad') state.fit = s.fit;
  } catch (_) {}
}
function saveSettings() {
  try {
    localStorage.setItem('mp-settings', JSON.stringify({ bright: state.bright, pink: state.pink, mode: state.mode, fit: state.fit }));
  } catch (_) {}
}

// ---------- 画像処理 ----------

// 元画像を 1080x1080 のキャンバスに描く
function drawSquare(bitmap, fit) {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const w = bitmap.width, h = bitmap.height;
  if (fit === 'pad') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, SIZE, SIZE);
    const s = SIZE / Math.max(w, h);
    const dw = w * s, dh = h * s;
    ctx.drawImage(bitmap, (SIZE - dw) / 2, (SIZE - dh) / 2, dw, dh);
  } else {
    const s = Math.min(w, h);
    ctx.drawImage(bitmap, (w - s) / 2, (h - s) / 2, s, s, 0, 0, SIZE, SIZE);
  }
  return { c, ctx };
}

// 平均輝度の上位5%のしきい値（ヒストグラムで計算）
function percentile95(d, gr = 1, gg = 1, gb = 1) {
  const hist = new Uint32Array(1024);
  let n = 0;
  for (let i = 0; i < d.length; i += 16) {        // 4画素に1つサンプル
    const m = (d[i] * gr + d[i + 1] * gg + d[i + 2] * gb) / 3;
    hist[Math.min(1023, Math.round(m * 4))]++;
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

function enhance(ctx, brightV, pinkV, mode) {
  const img = ctx.getImageData(0, 0, SIZE, SIZE);
  const d = img.data;

  // 1) ホワイトバランス：明るい背景（上位5%）をもとに、色かぶりを8割だけ補正
  const thr = percentile95(d);
  let sr = 0, sg = 0, sb = 0, cnt = 0;
  for (let i = 0; i < d.length; i += 16) {
    const m = (d[i] + d[i + 1] + d[i + 2]) / 3 / 255;
    if (m >= thr) { sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; cnt++; }
  }
  let gr = 1, gg = 1, gb = 1;
  if (cnt > 0) {
    const r = sr / cnt, g = sg / cnt, b = sb / cnt, mean = (r + g + b) / 3;
    gr = 1 + 0.8 * (mean / r - 1);
    gg = 1 + 0.8 * (mean / g - 1);
    gb = 1 + 0.8 * (mean / b - 1);
  }

  // 2) 露出：背景がほぼ白になるところまで（最大1.2倍）
  const bright = percentile95(d, gr, gg, gb) || 1;
  const expo = Math.min(0.985 / bright, 1.2);
  gr *= expo / 255; gg *= expo / 255; gb *= expo / 255;

  // 3) 中間の明るさ（スライダー）：50 → 0.80
  const gamma = 1 - 0.4 * (brightV / 100);
  const LUT_N = 4096;
  const lut = new Float32Array(LUT_N + 1);
  const isBlack = mode === 'black';
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

  // 4) ピンクベージュ（スライダー）：色のある部分（バッグ）だけ。白い背景はそのまま
  const p = mode === 'pink' ? pinkV / 100 : 0;
  const tr = 1 + 0.07 * p, tg = 1 - 0.03 * p, tb = 1 + 0.04 * p;

  const curve = (v) => {
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    v = lut[(v * LUT_N) | 0];
    return v + (isBlack ? 0.08 : 0.05) * (v - 0.5) * (1 - Math.abs(2 * v - 1));   // 軽いメリハリ
  };

  for (let i = 0; i < d.length; i += 4) {
    let r = curve(d[i] * gr), g = curve(d[i + 1] * gg), b = curve(d[i + 2] * gb);
    if (isBlack) {
      // 暗い部分の色かぶりを少しだけ取って、黒を黒らしく
      const m = (r + g + b) / 3;
      if (m < 0.4) { const k = 0.35 * (1 - m / 0.4); r += (m - r) * k; g += (m - g) * k; b += (m - b) * k; }
    }
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    let w = (mx - mn - 0.04) / 0.15;
    w = w < 0 ? 0 : w > 1 ? 1 : w;
    if (w > 0 && p > 0) {
      r += (Math.min(1, r * tr) - r) * w;
      g += (Math.min(1, g * tg) - g) * w;
      b += (Math.min(1, b * tb) - b) * w;
    }
    d[i] = r * 255 + 0.5; d[i + 1] = g * 255 + 0.5; d[i + 2] = b * 255 + 0.5;
  }

  sharpen(d, SIZE, SIZE, 0.4);
  ctx.putImageData(img, 0, 0);
}

// 軽いシャープ（模様がくっきり見える程度）
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

function toBlob(canvas) {
  return new Promise((res) => canvas.toBlob(res, 'image/jpeg', JPEG_QUALITY));
}

async function processItem(item) {
  const { c, ctx } = drawSquare(item.bitmap, state.fit);
  enhance(ctx, state.bright, state.pink, state.mode);
  const blob = await toBlob(c);
  if (item.url) URL.revokeObjectURL(item.url);
  item.blob = blob;
  item.url = URL.createObjectURL(blob);
}

const nextFrame = () => new Promise((r) => setTimeout(r, 0));

async function processAll() {
  if (!state.items.length) return;
  state.busy = true;
  render();
  for (let i = 0; i < state.items.length; i++) {
    setStatus(`仕上げ中… ${i + 1} / ${state.items.length}`);
    await nextFrame();
    try { await processItem(state.items[i]); } catch (e) { console.error(e); }
    renderGrid();
  }
  state.busy = false;
  setStatus(`${state.items.length}枚できました`);
  render();
}

// ---------- 読み込み ----------

async function loadFiles(fileList) {
  const files = Array.from(fileList).filter((f) => f.type.startsWith('image/') || /\.(heic|heif|jpe?g|png)$/i.test(f.name));
  if (!files.length) return;
  clearItems();
  const picked = files.slice(0, MAX_PHOTOS);
  for (const [idx, f] of picked.entries()) {
    try {
      const bitmap = await createImageBitmap(f, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(f));
      state.items.push({ file: f, name: `mercari_${idx + 1}.jpg`, bitmap, blob: null, url: null });
    } catch (e) {
      console.error('読み込めない画像', f.name, e);
    }
  }
  if (files.length > MAX_PHOTOS) setStatus(`メルカリの上限に合わせて最初の${MAX_PHOTOS}枚だけ使います`);
  await processAll();
}

function clearItems() {
  for (const it of state.items) {
    if (it.url) URL.revokeObjectURL(it.url);
    try { it.bitmap.close(); } catch (_) {}
  }
  state.items = [];
}

// ---------- 保存 ----------

async function saveAll() {
  const ready = state.items.filter((it) => it.blob);
  if (!ready.length) return;
  const files = ready.map((it) => new File([it.blob], it.name, { type: 'image/jpeg' }));

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
  for (const it of ready) {
    const a = document.createElement('a');
    a.href = it.url; a.download = it.name;
    document.body.appendChild(a); a.click(); a.remove();
    await new Promise((r) => setTimeout(r, 250));
  }
  setStatus('ダウンロードしました');
}

async function saveOne(idx) {
  const it = state.items[idx];
  if (!it || !it.blob) return;
  const file = new File([it.blob], it.name, { type: 'image/jpeg' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); } catch (_) {}
  } else {
    const a = document.createElement('a');
    a.href = it.url; a.download = it.name; a.click();
  }
}

// ---------- 画面 ----------

function setStatus(t) { if (els.status) els.status.textContent = t; }

function renderGrid() {
  els.grid.innerHTML = '';
  state.items.forEach((it, i) => {
    const b = document.createElement('button');
    b.className = 'thumb';
    b.type = 'button';
    b.setAttribute('aria-label', `${i + 1}枚目だけ保存`);
    if (it.url) {
      const img = document.createElement('img');
      img.src = it.url; img.alt = `${i + 1}枚目`;
      b.appendChild(img);
    } else {
      b.classList.add('pending');
    }
    const n = document.createElement('span');
    n.className = 'num'; n.textContent = i + 1;
    b.appendChild(n);
    b.addEventListener('click', () => saveOne(i));
    els.grid.appendChild(b);
  });
}

function render() {
  const has = state.items.length > 0;
  els.empty.hidden = has;
  els.work.hidden = !has;
  els.saveAll.disabled = state.busy || !has;
  els.saveAll.textContent = has ? `${state.items.length}枚まとめて保存` : 'まとめて保存';
  els.bright.value = state.bright;
  els.pink.value = state.pink;
  els.brightVal.textContent = state.bright;
  els.pinkVal.textContent = state.pink;
  els.pinkWrap.hidden = state.mode !== 'pink';
  document.querySelectorAll('[name="mode"]').forEach((r) => { r.checked = r.value === state.mode; });
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
  });

  els.input.addEventListener('change', (e) => { loadFiles(e.target.files); e.target.value = ''; });
  document.querySelectorAll('.pick').forEach((b) => b.addEventListener('click', () => els.input.click()));
  els.saveAll.addEventListener('click', saveAll);

  els.bright.addEventListener('input', (e) => { state.bright = +e.target.value; scheduleReprocess(); });
  els.pink.addEventListener('input', (e) => { state.pink = +e.target.value; scheduleReprocess(); });
  document.querySelectorAll('[name="mode"]').forEach((r) =>
    r.addEventListener('change', (e) => { state.mode = e.target.value; scheduleReprocess(); }));


  render();
}

document.addEventListener('DOMContentLoaded', init);
