// 목업 공용: 장면 그림, 직소 조각 생성, 조각 렌더, QR
(function () {
  function rng(seed) {
    let s = (seed >>> 0) || 1;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }

  // ---------- 장면 (600x400) ----------
  function starField() {
    const r = rng(7); let s = '';
    for (let i = 0; i < 70; i++) s += `<circle cx="${(r() * 600).toFixed(1)}" cy="${(r() * 400).toFixed(1)}" r="${(0.8 + r() * 1.8).toFixed(1)}" fill="#fff" opacity="${(0.4 + r() * 0.6).toFixed(2)}"/>`;
    return s;
  }
  function flowers() {
    const r = rng(11), cols = ['#FF6FA5', '#A78BFA', '#FF5A5F', '#FFC93C', '#FFFFFF', '#FF9F43'];
    let s = '';
    const spots = [[50, 260], [110, 300], [170, 250], [230, 320], [300, 270], [360, 330], [420, 260], [480, 310], [545, 265], [80, 350], [270, 360], [500, 365], [390, 380], [150, 375]];
    spots.forEach(([x, y], i) => {
      const c = cols[i % cols.length], k = 0.8 + r() * 0.5, h = 40 + r() * 30;
      s += `<path d="M${x} ${y} q ${(r() - 0.5) * 12} ${h / 2} 0 ${h}" stroke="#3E9A52" stroke-width="4" fill="none"/>`;
      s += `<ellipse cx="${x + 9}" cy="${y + h * 0.6}" rx="9" ry="4" fill="#4FAE5F" transform="rotate(-25 ${x + 9} ${y + h * 0.6})"/>`;
      for (let p = 0; p < 6; p++) {
        const a = p * Math.PI / 3;
        s += `<circle cx="${(x + Math.cos(a) * 11 * k).toFixed(1)}" cy="${(y + Math.sin(a) * 11 * k).toFixed(1)}" r="${(8 * k).toFixed(1)}" fill="${c}" stroke="rgba(0,0,0,.06)"/>`;
      }
      s += `<circle cx="${x}" cy="${y}" r="${(7 * k).toFixed(1)}" fill="${c === '#FFC93C' ? '#B4672B' : '#FFD23F'}"/>`;
    });
    return s;
  }

  const SCENES = {
    sea: { name: '바다 친구들', svg: `
<rect width="600" height="400" fill="#BFE7FF"/>
<circle cx="505" cy="72" r="42" fill="#FFD54F"/>
<g fill="#fff"><ellipse cx="120" cy="70" rx="55" ry="20"/><ellipse cx="160" cy="56" rx="38" ry="22"/><ellipse cx="330" cy="104" rx="45" ry="16"/><ellipse cx="362" cy="93" rx="30" ry="17"/></g>
<rect y="210" width="600" height="190" fill="#3BA3DE"/>
<path d="M0 210 Q30 200 60 210 T120 210 T180 210 T240 210 T300 210 T360 210 T420 210 T480 210 T540 210 T600 210 V226 H0Z" fill="#62BCEB"/>
<rect y="320" width="600" height="80" fill="#2E8DCB"/>
<path d="M0 372 Q80 352 160 368 T320 366 T480 362 T600 368 V400 H0Z" fill="#F2D28B"/>
<g stroke="#2FA36B" stroke-width="8" fill="none" stroke-linecap="round"><path d="M60 400 Q48 372 64 350 T58 300"/><path d="M88 400 Q100 376 86 354"/><path d="M548 400 Q536 370 552 346 T546 310"/></g>
<path d="M140 280 Q150 200 262 205 Q362 210 380 270 Q390 300 350 320 Q260 345 180 325 Q140 312 140 280Z" fill="#2F5FA8"/>
<path d="M160 300 Q250 330 360 300 Q340 332 262 336 Q190 336 160 300Z" fill="#D7E8F7"/>
<path d="M375 272 Q420 250 440 212 Q446 240 430 260 Q456 262 472 248 Q456 292 380 296Z" fill="#2F5FA8"/>
<circle cx="196" cy="268" r="8" fill="#fff"/><circle cx="198" cy="269" r="4" fill="#1d2433"/>
<circle cx="212" cy="292" r="8" fill="#F7A1B5" opacity=".8"/>
<path d="M168 298 Q190 311 216 302" stroke="#1d2433" stroke-width="3" fill="none" stroke-linecap="round"/>
<g stroke="#9ED8FF" stroke-width="6" fill="none" stroke-linecap="round"><path d="M256 202 Q250 172 230 162"/><path d="M256 202 Q260 168 282 156"/><path d="M256 202 V150"/></g>
<path d="M430 214 H542 L526 238 H446Z" fill="#E8553D"/><path d="M486 212 V138" stroke="#7A4B2A" stroke-width="4"/>
<path d="M490 210 V142 L532 204Z" fill="#fff"/><path d="M482 210 V152 L450 204Z" fill="#FFE08A"/>
<g fill="#FF9A3C"><ellipse cx="470" cy="300" rx="18" ry="10"/><path d="M486 300 L501 290 V310Z"/></g>
<g fill="#FFD23F"><ellipse cx="90" cy="258" rx="16" ry="9"/><path d="M104 258 L117 249 V267Z"/></g>
<g fill="#FF6F91"><ellipse cx="420" cy="350" rx="15" ry="8"/><path d="M433 350 L445 342 V358Z"/></g>
<g fill="none" stroke="#fff" stroke-width="2" opacity=".8"><circle cx="455" cy="280" r="4"/><circle cx="448" cy="266" r="3"/><circle cx="78" cy="240" r="3"/></g>` },
    village: { name: '숲속 마을', svg: `
<rect width="600" height="400" fill="#CDEBFF"/>
<circle cx="92" cy="78" r="38" fill="#FFCF4A"/>
<g fill="#fff"><ellipse cx="260" cy="70" rx="50" ry="18"/><ellipse cx="292" cy="60" rx="32" ry="18"/><ellipse cx="480" cy="96" rx="40" ry="14"/></g>
<g stroke="#39445a" stroke-width="2.5" fill="none" stroke-linecap="round"><path d="M180 60 q8 -8 16 0 q8 -8 16 0"/><path d="M215 82 q6 -6 12 0 q6 -6 12 0"/></g>
<path d="M0 250 Q150 168 300 228 T600 206 V400 H0Z" fill="#9AD67F"/>
<g fill="#2F7F45"><path d="M40 260 L62 200 L84 260Z"/><path d="M70 262 L90 214 L110 262Z"/><path d="M560 236 L578 186 L596 236Z"/></g>
<path d="M0 300 Q200 238 400 290 T600 280 V400 H0Z" fill="#62B566"/>
<path d="M300 400 Q322 340 292 302 Q272 282 300 262" stroke="#F3DCA8" stroke-width="34" fill="none" stroke-linecap="round"/>
<rect x="330" y="190" width="150" height="100" fill="#FFF2D4"/>
<rect x="446" y="138" width="18" height="40" fill="#B5523F"/>
<path d="M314 196 L405 128 L496 196Z" fill="#E4574B"/>
<rect x="390" y="236" width="32" height="54" rx="4" fill="#9A643F"/><circle cx="414" cy="264" r="2.5" fill="#FFD54F"/>
<g fill="#8FD0FF" stroke="#fff" stroke-width="4"><rect x="344" y="214" width="32" height="28"/><rect x="438" y="214" width="32" height="28"/></g>
<rect x="150" y="228" width="14" height="54" fill="#8A5A3C"/>
<circle cx="157" cy="212" r="34" fill="#3F9D58"/><circle cx="138" cy="232" r="22" fill="#348A4C"/><circle cx="178" cy="230" r="24" fill="#348A4C"/>
<rect x="525" y="262" width="10" height="36" fill="#8A5A3C"/><circle cx="530" cy="252" r="24" fill="#3F9D58"/>
<g fill="#FF6FA5"><circle cx="60" cy="340" r="5"/><circle cx="120" cy="360" r="5"/><circle cx="460" cy="340" r="5"/><circle cx="540" cy="360" r="5"/></g>
<g fill="#FFE14D"><circle cx="90" cy="330" r="5"/><circle cx="200" cy="350" r="5"/><circle cx="500" cy="330" r="5"/><circle cx="400" cy="372" r="5"/></g>` },
    space: { name: '우주 여행', svg: `
<rect width="600" height="400" fill="#1C2150"/>${starField()}
<circle cx="110" cy="95" r="36" fill="#7DD3FC"/><circle cx="98" cy="86" r="8" fill="#5BBDEB"/><circle cx="122" cy="108" r="6" fill="#5BBDEB"/>
<circle cx="318" cy="70" r="26" fill="#FFF3B0"/><circle cx="330" cy="62" r="24" fill="#1C2150"/>
<circle cx="470" cy="300" r="95" fill="#F49A5A"/>
<path d="M382 270 Q470 296 560 262" stroke="#E07B3F" stroke-width="14" fill="none"/><path d="M380 322 Q470 344 562 312" stroke="#E07B3F" stroke-width="10" fill="none"/>
<ellipse cx="470" cy="300" rx="152" ry="32" fill="none" stroke="#FFD98A" stroke-width="10" transform="rotate(-14 470 300)"/>
<g transform="rotate(32 250 210)">
<path d="M232 270 Q250 312 268 270Z" fill="#FBBF24"/><path d="M240 270 Q250 296 260 270Z" fill="#FB923C"/>
<path d="M226 238 L204 274 L230 266Z" fill="#EF4444"/><path d="M274 238 L296 274 L270 266Z" fill="#EF4444"/>
<path d="M226 270 V170 Q250 110 274 170 V270Z" fill="#F2F4F8"/>
<path d="M231 158 Q250 112 269 158Z" fill="#EF4444"/>
<circle cx="250" cy="200" r="14" fill="#60A5FA" stroke="#C9D3E3" stroke-width="5"/></g>
<path d="M60 300 L140 260" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".7"/><circle cx="142" cy="259" r="4" fill="#fff"/>` },
    garden: { name: '꽃밭', svg: `
<rect width="600" height="400" fill="#E3F5FF"/>
<circle cx="520" cy="72" r="40" fill="#FFD54F"/>
<g fill="#fff"><ellipse cx="150" cy="80" rx="46" ry="16"/><ellipse cx="178" cy="70" rx="30" ry="16"/></g>
<g fill="#F5E6C8" stroke="#E2CFA6" stroke-width="2">${Array.from({ length: 16 }, (_, i) => `<rect x="${i * 40 + 6}" y="170" width="18" height="70" rx="3"/>`).join('')}<rect x="0" y="190" width="600" height="10"/></g>
<path d="M0 232 Q300 196 600 232 V400 H0Z" fill="#9BD771"/>
<path d="M0 330 Q300 300 600 330 V400 H0Z" fill="#86C95E"/>
${flowers()}
<g transform="translate(300 120)"><ellipse cx="-14" cy="-6" rx="16" ry="12" fill="#FF9F43"/><ellipse cx="14" cy="-6" rx="16" ry="12" fill="#FF9F43"/><ellipse cx="-11" cy="10" rx="10" ry="8" fill="#7C5CFF"/><ellipse cx="11" cy="10" rx="10" ry="8" fill="#7C5CFF"/><rect x="-3" y="-14" width="6" height="30" rx="3" fill="#39445a"/></g>` },
    classroom: { name: '우리 반 교실', svg: `
<rect width="600" height="400" fill="#FFF1DC"/>
<rect y="300" width="600" height="100" fill="#E8C38F"/>
<g stroke="#D6AE77" stroke-width="2"><path d="M0 330 H600"/><path d="M0 365 H600"/></g>
<rect x="85" y="55" width="310" height="170" rx="6" fill="#A9733F"/>
<rect x="95" y="65" width="290" height="150" fill="#2E5E4E"/>
<text x="240" y="135" text-anchor="middle" font-size="38" fill="#fff" font-family="Pretendard, sans-serif" font-weight="700">함께 퍼즐</text>
<text x="240" y="178" text-anchor="middle" font-size="18" fill="#CFE8D9" font-family="Pretendard, sans-serif">3월 4일 · 우리 반 첫 활동</text>
<path d="M120 90 l6 12 13 2 -10 9 3 13 -12 -7 -12 7 3 -13 -10 -9 13 -2Z" fill="none" stroke="#FFE08A" stroke-width="2"/>
<rect x="430" y="60" width="130" height="150" fill="#BFE6FF" stroke="#fff" stroke-width="8"/><path d="M495 60 V210 M430 135 H560" stroke="#fff" stroke-width="6"/>
<circle cx="452" cy="92" r="14" fill="#FFD54F"/>
<circle cx="240" cy="32" r="16" fill="#fff" stroke="#39445a" stroke-width="3"/><path d="M240 32 V22 M240 32 H248" stroke="#39445a" stroke-width="2.5"/>
<g fill="#D29A5C">${[60, 190, 320, 450].map(x => `<rect x="${x}" y="262" width="100" height="16" rx="3"/><rect x="${x + 8}" y="278" width="8" height="40" fill="#A9733F"/><rect x="${x + 84}" y="278" width="8" height="40" fill="#A9733F"/>`).join('')}</g>
<g fill="#E0AC6C">${[20, 170, 330, 480].map(x => `<rect x="${x}" y="330" width="120" height="18" rx="3"/><rect x="${x + 10}" y="348" width="9" height="52" fill="#A9733F"/><rect x="${x + 101}" y="348" width="9" height="52" fill="#A9733F"/>`).join('')}</g>
<rect x="548" y="250" width="34" height="40" rx="4" fill="#E4574B"/><circle cx="565" cy="236" r="22" fill="#3F9D58"/><circle cx="552" cy="222" r="14" fill="#4FAE5F"/>` },
    group: { name: '학급 단체 사진', svg: `
<rect width="600" height="400" fill="#D9E7F2"/>
<rect y="250" width="600" height="150" fill="#B9C9A5"/>
<rect x="40" y="40" width="520" height="70" rx="6" fill="#F7F2E8"/><text x="300" y="86" text-anchor="middle" font-size="30" font-weight="700" fill="#5B6475" font-family="Pretendard, sans-serif">4학년 2반</text>
${(() => {
  const skins = ['#F2C9A0', '#E8B489', '#F5D2B0', '#DDA97D'], shirts = ['#F0544F', '#3B82F6', '#22A559', '#F2A20C', '#9B51E0', '#E64C9A', '#FFFFFF', '#4B5563'];
  let s = '';
  [[150, 8, 52, 0.9], [215, 9, 50, 1], [290, 8, 55, 1.1]].forEach(([y, n, gap, k], row) => {
    const x0 = 300 - (n - 1) * gap / 2;
    for (let i = 0; i < n; i++) {
      const x = x0 + i * gap, c = shirts[(i * 3 + row) % shirts.length];
      s += `<rect x="${x - 20 * k}" y="${y + 18 * k}" width="${40 * k}" height="${60 * k}" rx="${16 * k}" fill="${c}" stroke="rgba(0,0,0,.08)"/>`;
      s += `<circle cx="${x}" cy="${y}" r="${17 * k}" fill="${skins[(i + row) % 4]}"/>`;
      s += `<path d="M${x - 17 * k} ${y - 2 * k} Q${x} ${y - 26 * k} ${x + 17 * k} ${y - 2 * k}" fill="#2E2A28"/>`;
    }
  });
  return s;
})()}` },
  };

  function injectScenes() {
    const defs = Object.entries(SCENES).map(([k, v]) => `<g id="scene-${k}">${v.svg}</g>`).join('');
    const holder = document.createElement('div');
    holder.innerHTML = `<svg width="0" height="0" style="position:absolute"><defs>${defs}</defs></svg>`;
    document.body.prepend(holder.firstChild);
  }

  // ---------- 직소 조각 ----------
  // 변 하나를 3차 베지어 목록으로 (A→B). N: 혹이 나오는 쪽 단위 법선, s: +1/-1/0
  function edge(A, B, N, s, j) {
    const dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy);
    const m = ([u, v]) => [A[0] + u * dx + v * L * s * N[0], A[1] + u * dy + v * L * s * N[1]];
    if (!s) return [[A, m([1 / 3, 0]), m([2 / 3, 0]), B]];
    const c = 0.5 + j.cx, k = j.k;
    const uv = [
      [[0, 0], [(c - 0.15 * k) / 3, 0], [2 * (c - 0.15 * k) / 3, 0], [c - 0.15 * k, 0]],
      [[c - 0.15 * k, 0], [c - 0.06 * k, 0], [c - 0.04 * k, 0.04 * k], [c - 0.07 * k, 0.08 * k]],
      [[c - 0.07 * k, 0.08 * k], [c - 0.13 * k, 0.14 * k], [c - 0.13 * k, 0.27 * k], [c, 0.27 * k]],
      [[c, 0.27 * k], [c + 0.13 * k, 0.27 * k], [c + 0.13 * k, 0.14 * k], [c + 0.07 * k, 0.08 * k]],
      [[c + 0.07 * k, 0.08 * k], [c + 0.04 * k, 0.04 * k], [c + 0.06 * k, 0], [c + 0.15 * k, 0]],
      [[c + 0.15 * k, 0], [c + 0.15 * k + (1 - c - 0.15 * k) / 3, 0], [c + 0.15 * k + 2 * (1 - c - 0.15 * k) / 3, 0], [1, 0]],
    ];
    return uv.map(seg => seg.map(m));
  }
  const rev = segs => segs.slice().reverse().map(([a, b, c, d]) => [d, c, b, a]);
  const f = n => n.toFixed(1);
  function toPath(edges) {
    const all = edges.flat();
    let d = `M${f(all[0][0][0])} ${f(all[0][0][1])}`;
    for (const [, c1, c2, p] of all) d += `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p[0])} ${f(p[1])}`;
    return d + 'Z';
  }

  function makePuzzle(cols, rows, seed, W = 600, H = 400) {
    const r = rng(seed), pw = W / cols, ph = H / rows;
    const jit = () => ({ cx: (r() - 0.5) * 0.08, k: 0.92 + r() * 0.16 });
    const sg = () => (r() < 0.5 ? 1 : -1);
    const h = [], v = [];
    for (let y = 1; y < rows; y++) { h[y] = []; for (let x = 0; x < cols; x++) h[y][x] = edge([x * pw, y * ph], [(x + 1) * pw, y * ph], [0, 1], sg(), jit()); }
    for (let x = 1; x < cols; x++) { v[x] = []; for (let y = 0; y < rows; y++) v[x][y] = edge([x * pw, y * ph], [x * pw, (y + 1) * ph], [1, 0], sg(), jit()); }
    const pieces = [];
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const x0 = x * pw, y0 = y * ph, x1 = x0 + pw, y1 = y0 + ph;
      const top = y === 0 ? edge([x0, y0], [x1, y0], [0, 1], 0) : h[y][x];
      const right = x === cols - 1 ? edge([x1, y0], [x1, y1], [1, 0], 0) : v[x + 1][y];
      const bottom = y === rows - 1 ? edge([x1, y1], [x0, y1], [0, 1], 0) : rev(h[y + 1][x]);
      const left = x === 0 ? edge([x0, y1], [x0, y0], [1, 0], 0) : rev(v[x][y]);
      pieces.push({ i: pieces.length, col: x, row: y, x0, y0, d: toPath([top, right, bottom, left]) });
    }
    return { cols, rows, pw, ph, W, H, pieces, at: (c, rr) => pieces[rr * cols + c] };
  }

  let uid = 0;
  // items: [{i, x, y, hold}] x,y = 판에서 조각의 왼쪽 위 위치(완성 위치 기준 조각 칸)
  function piecesSVG(pz, scene, items, o = {}) {
    const u = o.unit || 1, seam = o.seam ?? 'rgba(30,25,20,.28)';
    let sh = '', body = '', top = '';
    for (const it of items) {
      const p = pz.pieces[it.i];
      const tx = it.x - p.x0, ty = it.y - p.y0, id = 'cp' + (uid++);
      if (o.shadow !== false) sh += `<path d="${p.d}" transform="translate(${f(tx + 1.5 * u)} ${f(ty + 2.5 * u)})" fill="rgba(60,40,20,.20)"/>`;
      body += `<g transform="translate(${f(tx)} ${f(ty)})"><clipPath id="${id}"><path d="${p.d}"/></clipPath><g clip-path="url(#${id})"><use href="#scene-${scene}"/></g><path d="${p.d}" fill="none" stroke="${seam}" stroke-width="${0.9 * u}" stroke-linejoin="round"/></g>`;
      if (it.hold) top += `<path d="${p.d}" transform="translate(${f(tx)} ${f(ty)})" fill="none" stroke="${it.hold}" stroke-width="${3.2 * u}" stroke-linejoin="round"/>`;
      if (it.tag) {
        const fs = 12 * u, w = fs * (it.tag.length * 1.05 + 1.3), cx = it.x + pz.pw / 2, cy = it.y - pz.ph * 0.3 - fs;
        top += `<g><rect x="${f(cx - w / 2)}" y="${f(cy - fs * 0.85)}" width="${f(w)}" height="${f(fs * 1.7)}" rx="${f(fs * 0.85)}" fill="${it.hold}"/><text x="${f(cx)}" y="${f(cy + fs * 0.36)}" text-anchor="middle" font-size="${f(fs)}" font-weight="700" fill="#fff" font-family="Pretendard, sans-serif">${it.tag}</text></g>`;
      }
    }
    return sh + body + top;
  }
  function tileSVG(pz, scene, i) {
    const p = pz.pieces[i], m = 0.3;
    const vb = `${f(p.x0 - pz.pw * m)} ${f(p.y0 - pz.ph * m)} ${f(pz.pw * (1 + 2 * m))} ${f(pz.ph * (1 + 2 * m))}`;
    return `<svg viewBox="${vb}" preserveAspectRatio="xMidYMid meet">${piecesSVG(pz, scene, [{ i, x: p.x0, y: p.y0 }], { unit: pz.pw / 60 })}</svg>`;
  }
  function sceneSVG(scene, extra = '') {
    return `<svg viewBox="0 0 600 400" preserveAspectRatio="xMidYMid slice"><use href="#scene-${scene}"/>${extra}</svg>`;
  }
  // 색칠한 조각 묶음 (로고·아이콘)
  function colorPieces(cols, rows, seed, colors, size = 100) {
    const pz = makePuzzle(cols, rows, seed, size * cols, size * rows), m = size * 0.3;
    return `<svg viewBox="${-m} ${-m} ${size * cols + 2 * m} ${size * rows + 2 * m}">` +
      pz.pieces.map((p, k) => `<path d="${p.d}" fill="${colors[k % colors.length]}" stroke="#fff" stroke-width="${size * 0.04}" stroke-linejoin="round"/>`).join('') + '</svg>';
  }
  function iconPiece(color, seed = 5) {
    const pz = makePuzzle(3, 3, seed, 300, 300), p = pz.at(1, 1);
    return `<svg viewBox="70 70 160 160"><path d="${p.d}" fill="${color}"/></svg>`;
  }
  // 상태 만들기: 덩어리(직사각형 블록) + 흩어진 조각
  function cluster(pz, c0, c1, r0, r1, X, Y, hold) {
    const out = [];
    for (let rr = r0; rr <= r1; rr++) for (let c = c0; c <= c1; c++) {
      const p = pz.at(c, rr); out.push({ i: p.i, x: X + (c - c0) * pz.pw, y: Y + (rr - r0) * pz.ph, hold });
    }
    return out;
  }
  function loose(pz, list) { return list.map(([c, rr, x, y, hold]) => ({ i: pz.at(c, rr).i, x, y, hold })); }

  function qrSVG(seed, n = 29) {
    const r = rng(seed); let s = '';
    const finder = (x, y) => (x >= 0 && x < 7 && y >= 0 && y < 7) ? ((x === 0 || x === 6 || y === 0 || y === 6) || (x >= 2 && x <= 4 && y >= 2 && y <= 4)) : null;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      let on = finder(x, y) ?? finder(x - (n - 7), y) ?? finder(x, y - (n - 7));
      const inF = (x < 8 && y < 8) || (x >= n - 8 && y < 8) || (x < 8 && y >= n - 8);
      if (on === null) on = inF ? false : r() < 0.48;
      if (on) s += `<rect x="${x}" y="${y}" width="1.02" height="1.02"/>`;
    }
    return `<svg viewBox="-2 -2 ${n + 4} ${n + 4}" shape-rendering="crispEdges"><rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" fill="#fff"/><g fill="#1E2433">${s}</g></svg>`;
  }

  const MC = ['#F0544F', '#22A559', '#3B82F6', '#9B51E0', '#F2A20C', '#E64C9A'];
  window.M = { rng, SCENES, injectScenes, makePuzzle, piecesSVG, tileSVG, sceneSVG, colorPieces, iconPiece, cluster, loose, qrSVG, MC };
})();
