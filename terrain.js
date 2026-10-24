// 国土地理院の標高タイル（dem_png）から、起伏を強調した地形図をブラウザで描く。
// 色別標高＋多方向の陰影＋谷の暗さ・尾根の明るさを重ね、「強調」で傾きを何倍にも見せる。

(function () {
  const DEM_URL = "https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png";
  const NATIVE_MAX = 14;
  const SEA = [168, 205, 230];

  // 標高(m) → 色。低地の緑から高地の赤茶へ
  const STOPS = [
    [0, [126, 184, 132]], [60, [150, 198, 134]], [180, [192, 214, 142]], [350, [226, 224, 152]],
    [550, [236, 206, 140]], [800, [228, 176, 122]], [1100, [210, 138, 104]], [1500, [178, 112, 94]],
    [2000, [156, 124, 114]], [2300, [238, 236, 232]],
  ];
  const RAMP = new Uint8ClampedArray(2400 * 3);
  for (let h = 0; h < 2400; h++) {
    let i = 0;
    while (i < STOPS.length - 2 && h > STOPS[i + 1][0]) i++;
    const [h0, c0] = STOPS[i], [h1, c1] = STOPS[i + 1];
    const t = Math.min(1, Math.max(0, (h - h0) / (h1 - h0)));
    for (let k = 0; k < 3; k++) RAMP[h * 3 + k] = c0[k] + (c1[k] - c0[k]) * t;
  }

  const cache = new Map();
  function loadDem(z, x, y) {
    const n = 1 << z;
    if (y < 0 || y >= n) return Promise.resolve(null);
    x = ((x % n) + n) % n;
    const key = `${z}/${x}/${y}`;
    if (cache.has(key)) return cache.get(key);
    const p = new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = c.height = 256;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, 256, 256).data;
        const h = new Float32Array(256 * 256);
        for (let i = 0; i < h.length; i++) {
          const v = (d[i * 4] << 16) | (d[i * 4 + 1] << 8) | d[i * 4 + 2];
          h[i] = v === 0x800000 ? NaN : (v < 0x800000 ? v : v - 0x1000000) * 0.01;
        }
        resolve(h);
      };
      img.onerror = () => resolve(null);
      img.src = DEM_URL.replace("{z}", z).replace("{x}", x).replace("{y}", y);
    });
    cache.set(key, p);
    if (cache.size > 600) cache.delete(cache.keys().next().value);
    return p;
  }

  // 中央タイルの周囲 B 画素まで含めた (256+2B)² の標高
  const B = 24;
  async function loadGrid(z, x, y) {
    const tiles = await Promise.all(
      [-1, 0, 1].flatMap((dy) => [-1, 0, 1].map((dx) => loadDem(z, x + dx, y + dy))));
    const center = tiles[4];
    const W = 256 + 2 * B, g = new Float32Array(W * W);
    for (let j = 0; j < W; j++) {
      for (let i = 0; i < W; i++) {
        let tx = 1, ty = 1, px = i - B, py = j - B;
        if (px < 0) { tx = 0; px += 256; } else if (px > 255) { tx = 2; px -= 256; }
        if (py < 0) { ty = 0; py += 256; } else if (py > 255) { ty = 2; py -= 256; }
        let t = tiles[ty * 3 + tx];
        if (!t) { t = center; px = Math.min(255, Math.max(0, i - B)); py = Math.min(255, Math.max(0, j - B)); }
        g[j * W + i] = t ? t[py * 256 + px] : NaN;
      }
    }
    return center ? g : null;
  }

  // 周囲 B 画素の平均標高（海は除く）。谷底は平均より低くなる
  function localMean(grid) {
    const W = 256 + 2 * B, S = new Float64Array((W + 1) * (W + 1)), N = new Float64Array((W + 1) * (W + 1));
    for (let j = 0; j < W; j++) {
      let s = 0, n = 0;
      for (let i = 0; i < W; i++) {
        const v = grid[j * W + i];
        if (!Number.isNaN(v)) { s += v; n++; }
        S[(j + 1) * (W + 1) + i + 1] = S[j * (W + 1) + i + 1] + s;
        N[(j + 1) * (W + 1) + i + 1] = N[j * (W + 1) + i + 1] + n;
      }
    }
    const out = new Float32Array(256 * 256);
    const box = (A, i0, j0, i1, j1) => A[j1 * (W + 1) + i1] - A[j0 * (W + 1) + i1] - A[j1 * (W + 1) + i0] + A[j0 * (W + 1) + i0];
    for (let j = 0; j < 256; j++) {
      for (let i = 0; i < 256; i++) {
        const n = box(N, i, j, i + 2 * B + 1, j + 2 * B + 1);
        out[j * 256 + i] = n ? box(S, i, j, i + 2 * B + 1, j + 2 * B + 1) / n : NaN;
      }
    }
    return out;
  }
  const VALLEY = [92, 178, 228];

  const LIGHTS = [[315, 0.45], [270, 0.2], [0, 0.2], [225, 0.15]].map(([az, w]) => {
    const a = (az * Math.PI) / 180, alt = (40 * Math.PI) / 180;
    return [Math.sin(a) * Math.cos(alt), Math.cos(a) * Math.cos(alt), Math.sin(alt), w];
  });

  function paint(grid, z, y, out, opt) {
    const W = 256 + 2 * B;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / (1 << z))));
    const cell = (40075016.686 * Math.cos(lat)) / ((1 << z) * 256);
    // 縮小表示ほど起伏が平らに見えるので、ズームが小さいほど強める
    const ex = opt.exaggeration * (1 + Math.max(0, 13 - z) * 0.12);
    // 広く見るときは細かな尾根・谷のギザギザを抑えて、大きな山と谷だけを見せる
    const fine = Math.min(1, Math.max(0.35, (z - 8) / 5));
    const H = (i, j) => {
      const v = grid[(j + B - 1) * W + i + B - 1];
      return Number.isNaN(v) ? 0 : v;
    };
    const mean = opt.valley ? localMean(grid) : null;
    // 谷とみなす深さ(m)。広い範囲を見るときほど深い谷だけを拾う
    const deep = Math.max(14, Math.min(60, cell * B * 0.065));
    const fade = opt.fade || 0;
    for (let j = 0; j < 256; j++) {
      for (let i = 0; i < 256; i++) {
        const o = (j * 256 + i) * 4;
        const c = grid[(j + B) * W + i + B];
        if (Number.isNaN(c)) {
          out[o] = SEA[0]; out[o + 1] = SEA[1]; out[o + 2] = SEA[2]; out[o + 3] = 255;
          continue;
        }
        const a = H(i, j), b = H(i + 1, j), cc = H(i + 2, j);
        const d = H(i, j + 1), f = H(i + 2, j + 1);
        const g = H(i, j + 2), hh = H(i + 1, j + 2), k = H(i + 2, j + 2);
        const p = (((cc + 2 * f + k) - (a + 2 * d + g)) / (8 * cell)) * ex;  // 東向きの傾き
        const q = (((a + 2 * b + cc) - (g + 2 * hh + k)) / (8 * cell)) * ex; // 北向きの傾き
        const len = Math.sqrt(p * p + q * q + 1);
        let shade = 0;
        for (const [lx, ly, lz, w] of LIGHTS) shade += w * Math.max(0, (-p * lx - q * ly + lz) / len);
        // 尾根(+)・谷(-)：周囲より高いか低いか
        const curv = ((c * 4 - b - d - f - hh) / cell) * ex * 0.9;
        const rv = Math.max(-1, Math.min(1, curv));
        const slope = 1 - 1 / len;

        let r, gr, bl;
        if (opt.mode === "gray") {
          r = gr = bl = 235;
        } else {
          const hi = Math.max(0, Math.min(2399, Math.round(c))) * 3;
          r = RAMP[hi]; gr = RAMP[hi + 1]; bl = RAMP[hi + 2];
        }
        let m = 0.46 + 0.74 * shade;
        m *= 1 - 0.2 * slope;
        if (rv < 0) m *= 1 + 0.32 * fine * rv; else m += 0.12 * fine * rv;
        r *= m; gr *= m; bl *= m;
        if (mean) {
          // 谷底：周りより低く、しかも傾きがゆるい所
          const grad = Math.sqrt(p * p + q * q) / ex;
          const v = Math.max(0, Math.min(1, ((mean[j * 256 + i] - c) / deep - 0.15) * 2.5)) * Math.max(0, 1 - grad / 0.35);
          if (v > 0) { const t = 0.78 * v; r += (VALLEY[0] - r) * t; gr += (VALLEY[1] - gr) * t; bl += (VALLEY[2] - bl) * t; }
        }
        if (fade) { r += (250 - r) * fade; gr += (250 - gr) * fade; bl += (247 - bl) * fade; }
        out[o] = r; out[o + 1] = gr; out[o + 2] = bl; out[o + 3] = 255;
      }
    }
  }

  L.TerrainLayer = L.GridLayer.extend({
    options: { exaggeration: 2.5, mode: "color", maxNativeZoom: NATIVE_MAX, tileSize: 256 },
    createTile(coords, done) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 256;
      loadGrid(coords.z, coords.x, coords.y).then((grid) => {
        const ctx = canvas.getContext("2d");
        const img = ctx.createImageData(256, 256);
        if (grid) paint(grid, coords.z, coords.y, img.data, this.options);
        else for (let i = 0; i < img.data.length; i += 4) img.data.set([...SEA, 255], i);
        ctx.putImageData(img, 0, 0);
        done(null, canvas);
      });
      return canvas;
    },
    setStyle(opt) {
      Object.assign(this.options, opt);
      if (!this._map) return;
      // Leaflet の redraw() は小数のズーム（9.5 など）をそのままタイル番号に使い、全面が海になるため、整数に丸めて描き直す
      this._removeAllTiles();
      const z = this._clampZoom(Math.round(this._map.getZoom()));
      if (z !== this._tileZoom) { this._tileZoom = z; this._updateLevels(); }
      this._update();
    },
  });
})();
