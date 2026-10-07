// Self-made scenes for the built-in pictures (no outside artwork, no text, no real
// people or characters). Each scene is SVG markup for a viewBox of width x height:
// 600 x 400 (landscape 3:2) or 400 x 600 (portrait 2:3). Small shapes are spread over
// the whole picture so every puzzle piece has something to recognise.

// xorshift32, so the scattered details are the same on every run.
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

const f = (n) => Number(n.toFixed(1));

function scatter(seed, count, [x0, y0, x1, y1], draw) {
  const r = rng(seed);
  let out = '';
  for (let i = 0; i < count; i++) out += draw(f(x0 + r() * (x1 - x0)), f(y0 + r() * (y1 - y0)), i, r);
  return out;
}

const cloud = (x, y, s = 1, fill = '#fff') =>
  `<g fill="${fill}" transform="translate(${x} ${y}) scale(${s})"><ellipse rx="40" ry="15"/><ellipse cx="20" cy="-10" rx="25" ry="15"/><ellipse cx="-18" cy="-6" rx="19" ry="11"/></g>`;

const sun = (x, y, r, fill = '#FFD54F') => {
  let rays = '';
  for (let i = 0; i < 12; i++) {
    const a = (i * Math.PI) / 6;
    rays += `<path d="M${f(x + Math.cos(a) * (r + 6))} ${f(y + Math.sin(a) * (r + 6))} L${f(x + Math.cos(a) * (r + 16))} ${f(y + Math.sin(a) * (r + 16))}"/>`;
  }
  return `<g stroke="${fill}" stroke-width="4" stroke-linecap="round">${rays}</g><circle cx="${x}" cy="${y}" r="${r}" fill="${fill}"/>`;
};

const bird = (x, y, s = 1) =>
  `<path d="M${x - 8 * s} ${y} q${4 * s} ${-6 * s} ${8 * s} 0 q${4 * s} ${-6 * s} ${8 * s} 0" stroke="#39445a" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;

const tree = (x, y, s = 1, leaf = '#3E9B4F', trunk = '#8A5A35', light = '#5DB86A') =>
  `<rect x="${f(x - 6 * s)}" y="${f(y - 34 * s)}" width="${f(12 * s)}" height="${f(34 * s)}" fill="${trunk}"/>` +
  `<circle cx="${x}" cy="${f(y - 52 * s)}" r="${f(26 * s)}" fill="${leaf}"/><circle cx="${f(x - 20 * s)}" cy="${f(y - 38 * s)}" r="${f(18 * s)}" fill="${leaf}"/>` +
  `<circle cx="${f(x + 20 * s)}" cy="${f(y - 38 * s)}" r="${f(18 * s)}" fill="${leaf}"/><circle cx="${f(x - 8 * s)}" cy="${f(y - 60 * s)}" r="${f(9 * s)}" fill="${light}"/>`;

const pine = (x, y, s = 1, fill = '#2F7F45', snow = null) =>
  `<rect x="${f(x - 4 * s)}" y="${f(y - 12 * s)}" width="${f(8 * s)}" height="${f(12 * s)}" fill="#7A4B2A"/>` +
  `<path d="M${f(x - 26 * s)} ${f(y - 10 * s)} L${x} ${f(y - 46 * s)} L${f(x + 26 * s)} ${f(y - 10 * s)}Z M${f(x - 20 * s)} ${f(y - 34 * s)} L${x} ${f(y - 66 * s)} L${f(x + 20 * s)} ${f(y - 34 * s)}Z" fill="${fill}"/>` +
  (snow ? `<path d="M${f(x - 8 * s)} ${f(y - 56 * s)} L${x} ${f(y - 66 * s)} L${f(x + 8 * s)} ${f(y - 56 * s)}Z M${f(x - 12 * s)} ${f(y - 34 * s)} L${f(x - 6 * s)} ${f(y - 40 * s)} L${f(x + 10 * s)} ${f(y - 36 * s)}Z" fill="${snow}"/>` : '');

const flower = (x, y, s = 1, petal = '#FF7FA8', centre = '#FFD23F') => {
  let p = '';
  for (let i = 0; i < 5; i++) {
    const a = (i * 2 * Math.PI) / 5;
    p += `<circle cx="${f(x + Math.cos(a) * 5 * s)}" cy="${f(y + Math.sin(a) * 5 * s)}" r="${f(4 * s)}"/>`;
  }
  return `<path d="M${x} ${y} v${f(14 * s)}" stroke="#3E9B4F" stroke-width="2"/><g fill="${petal}">${p}</g><circle cx="${x}" cy="${y}" r="${f(3 * s)}" fill="${centre}"/>`;
};

const grass = (x, y, s = 1, fill = '#4CAF50') =>
  `<path d="M${f(x - 6 * s)} ${y} q${f(2 * s)} ${f(-10 * s)} ${f(4 * s)} ${f(-12 * s)} q0 ${f(8 * s)} ${f(2 * s)} ${f(12 * s)} q${f(2 * s)} ${f(-10 * s)} ${f(6 * s)} ${f(-14 * s)} q-${f(2 * s)} ${f(10 * s)} 0 ${f(14 * s)}Z" fill="${fill}"/>`;

const SKINS = ['#F6D3B3', '#E9B98F', '#D79E74', '#F3C9A4'];
const HAIR = ['#2E2A28', '#5A3A22', '#3B2E2A', '#7A4B2A'];

// A child, drawn simply: round face with dots for eyes and a smile. pose: 'down' | 'up' | 'wave'.
function kid(x, y, { shirt = '#3B82F6', pants = '#36435C', skin = 0, hair = 0, pose = 'down', s = 1, long = false } = {}) {
  const k = (n) => f(n * s);
  const sk = SKINS[skin % SKINS.length];
  const hr = HAIR[hair % HAIR.length];
  const arm = {
    down: [`M${x - k(13)} ${y + k(26)} l${k(-8)} ${k(20)}`, `M${x + k(13)} ${y + k(26)} l${k(8)} ${k(20)}`],
    up: [`M${x - k(13)} ${y + k(24)} l${k(-12)} ${k(-20)}`, `M${x + k(13)} ${y + k(24)} l${k(12)} ${k(-20)}`],
    wave: [`M${x - k(13)} ${y + k(26)} l${k(-8)} ${k(20)}`, `M${x + k(13)} ${y + k(24)} l${k(14)} ${k(-18)}`],
  }[pose];
  return (
    `<g stroke="${sk}" stroke-width="${k(6)}" stroke-linecap="round" fill="none"><path d="${arm[0]}"/><path d="${arm[1]}"/></g>` +
    `<g stroke="${pants}" stroke-width="${k(8)}" stroke-linecap="round"><path d="M${x - k(6)} ${y + k(52)} v${k(20)}"/><path d="M${x + k(6)} ${y + k(52)} v${k(20)}"/></g>` +
    `<rect x="${x - k(14)}" y="${y + k(18)}" width="${k(28)}" height="${k(38)}" rx="${k(9)}" fill="${shirt}"/>` +
    (long ? `<rect x="${x - k(17)}" y="${y - k(4)}" width="${k(34)}" height="${k(26)}" rx="${k(10)}" fill="${hr}"/>` : '') +
    `<circle cx="${x}" cy="${y}" r="${k(15)}" fill="${sk}"/>` +
    `<path d="M${x - k(15)} ${y - k(1)} Q${x} ${y - k(26)} ${x + k(15)} ${y - k(1)} Q${x + k(6)} ${y - k(9)} ${x} ${y - k(8)} Q${x - k(8)} ${y - k(9)} ${x - k(15)} ${y - k(1)}Z" fill="${hr}"/>` +
    `<circle cx="${x - k(5)}" cy="${y + k(1)}" r="${k(1.8)}" fill="#1d2433"/><circle cx="${x + k(5)}" cy="${y + k(1)}" r="${k(1.8)}" fill="#1d2433"/>` +
    `<path d="M${x - k(5)} ${y + k(6)} Q${x} ${y + k(10)} ${x + k(5)} ${y + k(6)}" stroke="#1d2433" stroke-width="${k(1.6)}" fill="none" stroke-linecap="round"/>` +
    `<circle cx="${x - k(9)}" cy="${y + k(5)}" r="${k(2.6)}" fill="#F7A1B5" opacity=".7"/><circle cx="${x + k(9)}" cy="${y + k(5)}" r="${k(2.6)}" fill="#F7A1B5" opacity=".7"/>`
  );
}

const house = (x, y, w, h, wall, roof, door = '#8A5A35') =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${wall}"/>` +
  `<path d="M${x - 8} ${y} L${x + w / 2} ${y - h * 0.6} L${x + w + 8} ${y}Z" fill="${roof}"/>` +
  `<rect x="${x + w * 0.4}" y="${y + h * 0.45}" width="${w * 0.2}" height="${h * 0.55}" fill="${door}"/>` +
  `<rect x="${x + w * 0.1}" y="${y + h * 0.2}" width="${w * 0.2}" height="${w * 0.18}" fill="#BFE7FF" stroke="#fff" stroke-width="2"/>` +
  `<rect x="${x + w * 0.7}" y="${y + h * 0.2}" width="${w * 0.2}" height="${w * 0.18}" fill="#BFE7FF" stroke="#fff" stroke-width="2"/>`;

const star = (x, y, r, fill = '#FFE38A') => {
  let d = '';
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.45 : r;
    d += `${i ? 'L' : 'M'}${f(x + Math.cos(a) * rr)} ${f(y + Math.sin(a) * rr)}`;
  }
  return `<path d="${d}Z" fill="${fill}"/>`;
};

const SHIRTS = ['#F0544F', '#22A559', '#3B82F6', '#9B51E0', '#F2A20C', '#E64C9A', '#14B8A6'];

// ---------- scenes ----------

const picnic = () => `
<rect width="600" height="400" fill="#D9F1FF"/>
${sun(530, 64, 30)}
${cloud(120, 60, 1)}${cloud(320, 90, 0.8)}${bird(230, 50)}${bird(260, 64, 0.8)}
<path d="M0 200 Q160 150 320 190 T600 170 V400 H0Z" fill="#A6DD8B"/>
<path d="M0 260 Q200 230 400 262 T600 250 V400 H0Z" fill="#8ACF6E"/>
${scatter(31, 14, [0, 300, 600, 400], (x, y) => flower(x, y, 0.8, ['#FF7FA8', '#FFD23F', '#9B8CFF', '#fff'][Math.floor(x) % 4]))}
${scatter(32, 22, [0, 230, 600, 400], (x, y) => grass(x, y, 0.8, '#5DB84F'))}
${[60, 160, 470, 560].map((x, i) => `<rect x="${x - 6}" y="${150 + (i % 2) * 20}" width="12" height="50" fill="#8A5A35"/>` +
  scatter(10 + i, 14, [x - 40, 100 + (i % 2) * 20, x + 40, 160 + (i % 2) * 20], (cx, cy) => `<circle cx="${cx}" cy="${cy}" r="13" fill="${(cx + cy) % 3 < 1.5 ? '#FFC1D6' : '#FFD9E6'}"/>`)).join('')}
${scatter(21, 26, [0, 120, 600, 400], (x, y) => `<ellipse cx="${x}" cy="${y}" rx="3" ry="2" fill="#FF8FB3" transform="rotate(${Math.round(x) % 90} ${x} ${y})"/>`)}
<path d="M190 300 L420 300 L450 370 L160 370Z" fill="#F0544F"/>
<g stroke="#fff" stroke-width="5" opacity=".75"><path d="M230 300 L215 370"/><path d="M275 300 L270 370"/><path d="M320 300 L325 370"/><path d="M365 300 L380 370"/><path d="M178 330 L432 330"/></g>
<rect x="250" y="322" width="44" height="26" rx="4" fill="#C47A3C"/><path d="M252 322 Q272 300 292 322" stroke="#8A5A35" stroke-width="4" fill="none"/>
<circle cx="330" cy="334" r="12" fill="#FF6B6B"/><circle cx="352" cy="340" r="10" fill="#FFD23F"/><ellipse cx="390" cy="346" rx="16" ry="8" fill="#fff"/><ellipse cx="390" cy="344" rx="10" ry="4" fill="#F2A20C"/>
${kid(130, 262, { shirt: '#3B82F6', skin: 0, hair: 0, pose: 'wave' })}
${kid(480, 262, { shirt: '#F2A20C', skin: 2, hair: 1, long: true })}
${kid(300, 232, { shirt: '#22A559', skin: 1, hair: 2, pose: 'up', s: 0.85 })}
<path d="M520 190 L560 150 L570 200Z" fill="#9B51E0"/><path d="M545 175 Q520 230 540 290" stroke="#5a4a6a" stroke-width="1.5" fill="none"/>`;

const waterPlay = () => `
<rect width="600" height="400" fill="#BFE9FF"/>
${sun(80, 64, 32, '#FFC93C')}
${cloud(260, 54, 1)}${cloud(470, 80, 0.9)}
<path d="M0 150 L80 90 L160 140 L250 70 L340 140 L430 96 L520 150 L600 110 V200 H0Z" fill="#6CBF6A"/>
<path d="M0 170 L100 130 L200 170 L300 120 L420 170 L520 140 L600 170 V220 H0Z" fill="#4FA65A"/>
${scatter(41, 9, [0, 140, 600, 190], (x, y) => pine(x, y + 20, 0.6, '#2F7F45'))}
<path d="M0 210 H600 V400 H0Z" fill="#4FB8E8"/>
<g stroke="#9EDCF7" stroke-width="4" fill="none" stroke-linecap="round">${scatter(42, 18, [0, 220, 600, 390], (x, y) => `<path d="M${x} ${y} q8 -6 16 0 q8 6 16 0"/>`)}</g>
<path d="M0 360 Q120 340 240 362 T480 356 T600 362 V400 H0Z" fill="#F2D28B"/>
${scatter(43, 12, [0, 368, 600, 398], (x, y) => `<ellipse cx="${x}" cy="${y}" rx="7" ry="4" fill="#C9A86A"/>`)}
<circle cx="180" cy="300" r="34" fill="#F0544F"/><circle cx="180" cy="300" r="20" fill="#4FB8E8"/><path d="M146 300 A34 34 0 0 1 180 266 V280 A20 20 0 0 0 160 300Z" fill="#fff"/><path d="M214 300 A34 34 0 0 1 180 334 V320 A20 20 0 0 0 200 300Z" fill="#fff"/>
${kid(180, 262, { shirt: '#F2A20C', skin: 1, hair: 0, pose: 'up' }).replace(/<g stroke="#36435C"[^]*?<\/g>/, '')}
${kid(400, 250, { shirt: '#E64C9A', skin: 3, hair: 1, pose: 'wave', long: true }).replace(/<g stroke="#36435C"[^]*?<\/g>/, '')}
<path d="M366 300 Q400 290 434 300" stroke="#9EDCF7" stroke-width="5" fill="none"/>
<g><path d="M480 230 H570 L556 250 H494Z" fill="#FFD23F"/><path d="M500 230 Q525 200 550 230" fill="#22A559"/></g>
<g fill="#FF9A3C"><ellipse cx="300" cy="340" rx="14" ry="7"/><path d="M312 340 L324 332 V348Z"/></g>
<g fill="#9B51E0"><ellipse cx="90" cy="320" rx="12" ry="6"/><path d="M100 320 L110 313 V327Z"/></g>
<rect x="520" y="300" width="40" height="46" rx="6" fill="#3B82F6"/><path d="M526 300 Q540 280 554 300" stroke="#1d4ed8" stroke-width="4" fill="none"/>
<path d="M40 395 L60 370 L80 395Z" fill="#FF6F91"/><circle cx="560" cy="385" r="10" fill="#F0544F"/><path d="M552 380 L568 390" stroke="#fff" stroke-width="3"/>`;

const autumn = () => `
<rect width="600" height="400" fill="#FFE9C7"/>
${sun(510, 70, 30, '#FFB347')}
${cloud(150, 60, 0.9, '#FFF7EA')}${cloud(340, 84, 0.7, '#FFF7EA')}
<g stroke="#5a4a3a" stroke-width="2" fill="none">${scatter(51, 5, [180, 40, 420, 130], (x, y) => `<path d="M${x - 9} ${y} h18 M${x} ${y} l-6 -6 M${x} ${y} l6 -6"/>`)}</g>
<path d="M0 200 Q150 160 300 190 T600 180 V400 H0Z" fill="#E8B04B"/>
${Array.from({ length: 9 }, (_, i) => `<path d="M0 ${220 + i * 22} Q300 ${206 + i * 22} 600 ${220 + i * 22}" stroke="${i % 2 ? '#D99A2B' : '#F2C15A'}" stroke-width="7" fill="none"/>`).join('')}
${scatter(52, 40, [0, 210, 600, 400], (x, y) => `<path d="M${x} ${y} q3 -12 0 -20" stroke="#B9791B" stroke-width="2" fill="none"/><ellipse cx="${x + 2}" cy="${y - 20}" rx="3" ry="6" fill="#F7D36B"/>`)}
${scatter(57, 18, [0, 300, 600, 400], (x, y) => `<path d="M${x} ${y} l5 -8 l5 8 l-5 4Z" fill="${['#E8553D', '#F2A20C', '#B9541B'][Math.floor(y) % 3]}"/>`)}
<rect x="96" y="120" width="16" height="110" fill="#7A4B2A"/>
${scatter(53, 22, [40, 60, 170, 150], (x, y) => `<circle cx="${x}" cy="${y}" r="16" fill="${['#E8553D', '#F2A20C', '#D9472B'][Math.floor(x) % 3]}"/>`)}
${scatter(54, 10, [50, 80, 160, 150], (x, y) => `<circle cx="${x}" cy="${y}" r="6" fill="#FF7A1A"/><path d="M${x - 2} ${y - 6} h4" stroke="#3E7B2F" stroke-width="2"/>`)}
<g transform="translate(410 190)"><path d="M0 0 V110" stroke="#7A4B2A" stroke-width="6"/><path d="M-40 34 H40" stroke="#7A4B2A" stroke-width="6"/>
<path d="M-28 30 H28 L22 90 H-22Z" fill="#3B82F6"/><path d="M-20 52 H20" stroke="#F2C15A" stroke-width="3"/><circle cx="0" cy="8" r="20" fill="#F2D28B"/>
<path d="M-30 -6 H30 L18 -26 H-18Z" fill="#C47A3C"/><circle cx="-7" cy="8" r="2.5" fill="#1d2433"/><circle cx="7" cy="8" r="2.5" fill="#1d2433"/><path d="M-6 16 Q0 20 6 16" stroke="#1d2433" stroke-width="2" fill="none"/>
<g stroke="#F7D36B" stroke-width="3"><path d="M-40 34 l-8 6 M-40 34 l-8 -4 M40 34 l8 6 M40 34 l8 -4"/></g></g>
${scatter(55, 6, [230, 120, 580, 200], (x, y) => `<g transform="translate(${x} ${y})"><path d="M-14 0 H14" stroke="#C0392B" stroke-width="3"/><ellipse cx="-5" cy="-4" rx="8" ry="3" fill="#BFE7FF" opacity=".9"/><ellipse cx="5" cy="-4" rx="8" ry="3" fill="#BFE7FF" opacity=".9"/></g>`)}
${kid(250, 262, { shirt: '#9B51E0', skin: 0, hair: 1, pose: 'wave' })}
<path d="M520 320 Q540 300 560 320 L556 360 H524Z" fill="#8A5A35"/><g fill="#E8553D">${scatter(56, 5, [526, 300, 556, 322], (x, y) => `<circle cx="${x}" cy="${y}" r="7"/>`)}</g>`;

const winter = () => `
<rect width="600" height="400" fill="#CFE3F5"/>
${cloud(120, 70, 1, '#F4F8FC')}${cloud(400, 56, 1.1, '#F4F8FC')}
<path d="M0 190 Q120 120 260 170 T600 140 V400 H0Z" fill="#EAF2FA"/>
${scatter(61, 7, [0, 140, 600, 190], (x, y) => pine(x, y + 30, 0.7, '#3F7D5A', '#fff'))}
${house(380, 190, 90, 60, '#F2C17D', '#C0392B')}<path d="M372 190 L425 154 L478 190" stroke="#fff" stroke-width="7" fill="none"/>
<rect x="446" y="146" width="12" height="26" fill="#8A5A35"/><g fill="#E6EDF4">${scatter(62, 4, [446, 100, 470, 140], (x, y) => `<circle cx="${x}" cy="${y}" r="${6 + (y % 4)}"/>`)}</g>
${house(500, 206, 70, 46, '#BFD7EA', '#3B82F6')}<path d="M494 206 L535 178 L576 206" stroke="#fff" stroke-width="6" fill="none"/>
<path d="M0 250 Q300 220 600 256 V400 H0Z" fill="#fff"/>
${scatter(64, 10, [0, 330, 600, 400], (x, y) => `<ellipse cx="${x}" cy="${y}" rx="14" ry="4" fill="#DCE6F0"/>`)}
<circle cx="200" cy="320" r="44" fill="#fff" stroke="#DCE6F0" stroke-width="3"/><circle cx="200" cy="252" r="30" fill="#fff" stroke="#DCE6F0" stroke-width="3"/>
<circle cx="190" cy="246" r="3.5" fill="#1d2433"/><circle cx="210" cy="246" r="3.5" fill="#1d2433"/><path d="M200 254 L220 258 L200 260Z" fill="#FF7A1A"/>
<path d="M190 264 Q200 270 210 264" stroke="#1d2433" stroke-width="2" fill="none"/><g fill="#1d2433"><circle cx="200" cy="300" r="4"/><circle cx="200" cy="318" r="4"/><circle cx="200" cy="336" r="4"/></g>
<path d="M172 276 Q200 290 228 276 L230 288 Q200 300 170 288Z" fill="#F0544F"/><path d="M214 284 l8 30 h8 l-6 -32Z" fill="#F0544F"/>
<path d="M176 230 H224 L216 210 H184Z" fill="#36435C"/><path d="M168 230 H232" stroke="#36435C" stroke-width="6"/>
<path d="M158 300 L118 270 M242 300 L282 274" stroke="#8A5A35" stroke-width="5" stroke-linecap="round"/>
${kid(380, 278, { shirt: '#22A559', skin: 2, hair: 0, pose: 'up' })}<path d="M366 262 Q380 240 394 262" fill="#F0544F"/><circle cx="380" cy="244" r="5" fill="#fff"/>
<g transform="translate(470 320) rotate(-8)"><rect x="0" y="0" width="80" height="16" rx="6" fill="#C0392B"/><path d="M-6 22 H90 Q100 22 100 12" stroke="#7A4B2A" stroke-width="5" fill="none"/></g>
${kid(500, 286, { shirt: '#3B82F6', skin: 1, hair: 3, pose: 'down', s: 0.8, long: true })}
${scatter(63, 70, [0, 0, 600, 400], (x, y) => `<circle cx="${x}" cy="${y}" r="${2 + (Math.floor(x + y) % 3)}" fill="#fff" opacity=".9"/>`)}`;

const sportsDay = () => `
<rect width="600" height="400" fill="#D6F0FF"/>
${cloud(90, 50, 0.8)}${cloud(520, 40, 0.9)}
<path d="M0 40 Q150 80 300 40 T600 40" stroke="#7A8AA0" stroke-width="1.5" fill="none"/>
${Array.from({ length: 16 }, (_, i) => { const x = 18 + i * 37; const y = 40 + Math.sin((i / 15) * Math.PI * 2) * -18 + 8; return `<path d="M${x - 10} ${f(y - 6)} L${x + 10} ${f(y - 6)} L${x} ${f(y + 14)}Z" fill="${SHIRTS[i % SHIRTS.length]}"/>`; }).join('')}
<rect x="0" y="120" width="600" height="60" fill="#F2E3C6"/><g fill="#E0CDA6">${scatter(71, 30, [0, 125, 600, 175], (x, y) => `<rect x="${x}" y="${y}" width="10" height="10" rx="2"/>`)}</g>
${scatter(72, 18, [10, 110, 590, 140], (x, y, i) => `<circle cx="${x}" cy="${y}" r="7" fill="${SKINS[i % 4]}"/><rect x="${x - 7}" y="${y + 6}" width="14" height="14" rx="4" fill="${SHIRTS[i % SHIRTS.length]}"/>`)}
<rect x="0" y="180" width="600" height="220" fill="#C98A4B"/>
${scatter(74, 14, [0, 190, 600, 400], (x, y) => `<circle cx="${x}" cy="${y}" r="2" fill="#B07A40"/>`)}
<path d="M-40 400 Q300 160 640 400" stroke="#fff" stroke-width="5" fill="none"/><path d="M20 400 Q300 220 580 400" stroke="#fff" stroke-width="5" fill="none"/><path d="M80 400 Q300 280 520 400" stroke="#fff" stroke-width="5" fill="none"/>
<path d="M300 180 V400" stroke="#fff" stroke-width="4" stroke-dasharray="10 10"/>
<path d="M110 300 Q300 280 490 304" stroke="#D9B98A" stroke-width="9" fill="none"/>
${kid(130, 252, { shirt: '#F0544F', skin: 0, hair: 0, pose: 'up' })}${kid(200, 256, { shirt: '#F0544F', skin: 2, hair: 1, long: true })}
${kid(400, 256, { shirt: '#3B82F6', skin: 1, hair: 2 })}${kid(470, 252, { shirt: '#3B82F6', skin: 3, hair: 0, pose: 'up' })}
<rect x="294" y="282" width="12" height="18" fill="#F0544F"/>
<g transform="translate(70 196)"><path d="M0 0 V60" stroke="#7A4B2A" stroke-width="4"/><path d="M0 2 H34 L28 14 L34 26 H0Z" fill="#F0544F"/></g>
<g transform="translate(540 196)"><path d="M0 0 V60" stroke="#7A4B2A" stroke-width="4"/><path d="M0 2 H-34 L-28 14 L-34 26 H0Z" fill="#3B82F6"/></g>
${scatter(73, 6, [20, 340, 580, 390], (x, y, i) => `<circle cx="${x}" cy="${y}" r="12" fill="${i % 2 ? '#F0544F' : '#fff'}" stroke="#7a5a3a" stroke-width="1"/>`)}`;

const farm = () => `
<rect width="600" height="400" fill="#D5EEFF"/>
${sun(70, 60, 26)}${cloud(250, 60, 0.9)}${cloud(470, 46, 0.7)}${bird(360, 40)}
<path d="M0 170 Q140 120 300 160 T600 140 V400 H0Z" fill="#9BD47F"/>
${scatter(83, 20, [0, 180, 600, 400], (x, y) => grass(x, y, 0.8, '#6DBF57'))}
${scatter(84, 10, [0, 330, 600, 400], (x, y) => flower(x, y, 0.7, '#FFD23F', '#F2A20C'))}
${[[30, 160], [120, 150], [560, 150]].map(([x, y]) => tree(x, y, 0.8)).join('')}
<rect x="340" y="120" width="150" height="110" fill="#D9472B"/><path d="M330 122 L415 60 L500 122Z" fill="#8A2A1E"/>
<rect x="390" y="160" width="50" height="70" fill="#fff"/><path d="M390 160 L440 230 M440 160 L390 230" stroke="#D9472B" stroke-width="5"/>
<rect x="400" y="90" width="30" height="22" fill="#fff"/><path d="M400 90 L430 112 M430 90 L400 112" stroke="#8A2A1E" stroke-width="3"/>
<rect x="500" y="110" width="40" height="120" rx="18" fill="#C7CDD6"/><path d="M500 130 H540 M500 160 H540 M500 190 H540" stroke="#A9B1BC" stroke-width="3"/>
<g stroke="#C9A06A" stroke-width="5"><path d="M0 250 H330 M0 280 H330"/>${Array.from({ length: 12 }, (_, i) => `<path d="M${10 + i * 28} 238 V292"/>`).join('')}</g>
<g transform="translate(120 300)"><ellipse rx="56" ry="32" fill="#fff"/><g fill="#1d2433"><ellipse cx="-20" cy="-10" rx="16" ry="10"/><ellipse cx="22" cy="10" rx="14" ry="9"/></g>
<g stroke="#fff" stroke-width="10" stroke-linecap="round"><path d="M-36 20 V54 M-12 24 V56 M18 24 V56 M40 20 V54"/></g>
<ellipse cx="66" cy="-14" rx="24" ry="20" fill="#fff"/><ellipse cx="82" cy="-4" rx="12" ry="9" fill="#F7B6C2"/><circle cx="62" cy="-20" r="3" fill="#1d2433"/><path d="M56 -32 l-8 -10 M74 -32 l8 -10" stroke="#C9A06A" stroke-width="4"/></g>
<g transform="translate(300 330)"><ellipse rx="36" ry="24" fill="#F7B6C2"/><circle cx="34" cy="-8" r="16" fill="#F7B6C2"/><ellipse cx="44" cy="-6" rx="7" ry="5" fill="#EE8FA3"/><circle cx="30" cy="-14" r="2.5" fill="#1d2433"/><path d="M-36 -4 q-10 -6 -6 -14" stroke="#EE8FA3" stroke-width="3" fill="none"/><g stroke="#EE8FA3" stroke-width="7" stroke-linecap="round"><path d="M-18 18 V32 M16 18 V32"/></g></g>
${scatter(81, 5, [380, 270, 580, 390], (x, y, i) => `<g transform="translate(${x} ${y})"><ellipse rx="14" ry="11" fill="${i % 2 ? '#fff' : '#C47A3C'}"/><circle cx="12" cy="-8" r="7" fill="${i % 2 ? '#fff' : '#C47A3C'}"/><path d="M18 -8 l6 2 l-6 2Z" fill="#F2A20C"/><path d="M10 -15 q2 -5 5 0" fill="#F0544F"/><circle cx="13" cy="-9" r="1.5" fill="#1d2433"/></g>`)}
${scatter(82, 8, [380, 300, 590, 395], (x, y) => `<ellipse cx="${x}" cy="${y}" rx="4" ry="3" fill="#F2D28B"/>`)}`;

// Portrait 400 x 600.
const giraffe = () => `
<rect width="400" height="600" fill="#FFE7B8"/>
${sun(80, 90, 34, '#FFB347')}${cloud(220, 70, 0.9, '#FFF7EA')}${cloud(150, 190, 0.7, '#FFF7EA')}${bird(160, 40)}${bird(190, 56, 0.8)}
<path d="M0 360 Q200 320 400 350 V600 H0Z" fill="#E8C46A"/>
${scatter(93, 22, [0, 360, 400, 600], (x, y) => grass(x, y, 0.9, '#C9A24A'))}
${scatter(94, 8, [0, 520, 400, 600], (x, y) => `<ellipse cx="${x}" cy="${y}" rx="9" ry="5" fill="#C9A86A"/>`)}
<g transform="translate(60 330)"><path d="M0 0 V50" stroke="#8A5A35" stroke-width="10"/><path d="M-70 0 Q0 -40 70 0 Q0 -16 -70 0Z" fill="#6E9B3A"/><path d="M-50 -6 Q0 -30 50 -6" stroke="#557A2C" stroke-width="4" fill="none"/></g>
<g fill="#F2B640" stroke="#C88A1E" stroke-width="2">
<path d="M196 470 L188 560 H204 L210 470Z"/><path d="M256 470 L260 560 H276 L272 470Z"/><path d="M168 460 L156 560 H172 L184 470Z"/><path d="M286 460 L296 560 H312 L300 466Z"/>
<ellipse cx="236" cy="440" rx="80" ry="44"/><path d="M270 420 L300 170 Q304 150 318 150 L330 156 L304 430Z"/></g>
<g fill="#B5651D">${scatter(91, 14, [170, 410, 310, 470], (x, y) => `<rect x="${x - 9}" y="${y - 7}" width="${16 + (x % 5)}" height="${12 + (y % 4)}" rx="5"/>`)}${scatter(92, 10, [286, 180, 316, 410], (x, y) => `<rect x="${x - 6}" y="${y - 6}" width="12" height="12" rx="4"/>`)}</g>
<ellipse cx="330" cy="150" rx="34" ry="22" fill="#F2B640" stroke="#C88A1E" stroke-width="2"/><ellipse cx="356" cy="160" rx="14" ry="10" fill="#E8A86A"/>
<circle cx="326" cy="142" r="4" fill="#1d2433"/><path d="M344 162 Q352 168 360 162" stroke="#1d2433" stroke-width="2" fill="none"/>
<g stroke="#B5651D" stroke-width="5" stroke-linecap="round"><path d="M314 130 V112 M330 128 V110"/></g><circle cx="314" cy="110" r="5" fill="#B5651D"/><circle cx="330" cy="108" r="5" fill="#B5651D"/><ellipse cx="300" cy="136" rx="12" ry="6" fill="#F2B640"/>
<path d="M160 446 q-20 30 -14 60" stroke="#C88A1E" stroke-width="4" fill="none"/>
<g transform="translate(90 480)"><ellipse rx="54" ry="34" fill="#9AA5B1"/><circle cx="-50" cy="-16" r="28" fill="#9AA5B1"/><ellipse cx="-36" cy="-18" rx="18" ry="24" fill="#B9C2CC"/>
<path d="M-74 -6 Q-90 30 -78 54" stroke="#9AA5B1" stroke-width="12" fill="none" stroke-linecap="round"/><circle cx="-58" cy="-22" r="3" fill="#1d2433"/>
<g stroke="#9AA5B1" stroke-width="16" stroke-linecap="round"><path d="M-30 26 V58 M30 26 V58"/></g></g>
${kid(330, 500, { shirt: '#22A559', skin: 1, hair: 0, pose: 'wave', s: 0.9 })}
${[[150, 352], [235, 344], [370, 350]].map(([x, y]) => `<g transform="translate(${x} ${y}) scale(.35)"><path d="M0 0 V50" stroke="#8A5A35" stroke-width="10"/><path d="M-70 0 Q0 -40 70 0 Q0 -16 -70 0Z" fill="#8DAA55"/></g>`).join('')}`;

const train = () => `
<rect width="600" height="400" fill="#CDEBFF"/>
${sun(520, 60, 28)}${cloud(110, 56, 1)}${cloud(330, 80, 0.8)}
<path d="M0 200 L90 110 L170 180 L260 90 L360 190 L450 120 L540 180 L600 140 V260 H0Z" fill="#8FB7D9"/>
<path d="M240 110 L260 90 L282 112 L270 108 L260 118 L250 108Z" fill="#fff"/><path d="M75 126 L90 110 L106 128 L95 124 L90 132 L83 124Z" fill="#fff"/>
<path d="M0 230 Q150 190 300 220 T600 210 V400 H0Z" fill="#8ACF6E"/>
${scatter(101, 10, [0, 210, 600, 250], (x, y) => tree(x, y + 10, 0.55))}
<path d="M470 236 Q520 170 600 190 V290 H470Z" fill="#6E8B5E"/><path d="M500 290 V250 Q530 220 560 250 V290Z" fill="#2E3A2E"/>
<path d="M0 300 H600" stroke="#7A5A3A" stroke-width="5"/><path d="M0 312 H600" stroke="#7A5A3A" stroke-width="5"/>
<g fill="#A57A4E">${Array.from({ length: 30 }, (_, i) => `<rect x="${i * 20}" y="296" width="8" height="22"/>`).join('')}</g>
${scatter(103, 16, [0, 320, 600, 400], (x, y) => flower(x, y, 0.8, ['#FF7FA8', '#FFD23F', '#fff'][Math.floor(x) % 3]))}
${scatter(104, 18, [0, 330, 600, 400], (x, y) => grass(x, y, 0.8, '#5DB84F'))}
<g transform="translate(60 230)"><rect x="0" y="10" width="110" height="60" rx="8" fill="#F0544F"/><rect x="80" y="-20" width="40" height="90" rx="6" fill="#D9472B"/><rect x="88" y="-10" width="24" height="22" fill="#BFE7FF"/>
<rect x="18" y="-14" width="18" height="26" fill="#36435C"/><path d="M10 -14 H44" stroke="#36435C" stroke-width="6"/><rect x="-14" y="44" width="20" height="16" fill="#36435C"/>
<g fill="#36435C"><circle cx="24" cy="72" r="13"/><circle cx="62" cy="72" r="13"/><circle cx="100" cy="72" r="13"/></g><g fill="#C7CDD6"><circle cx="24" cy="72" r="5"/><circle cx="62" cy="72" r="5"/><circle cx="100" cy="72" r="5"/></g>
<circle cx="100" cy="1" r="9" fill="${SKINS[1]}"/><path d="M91 -1 Q100 -12 109 -1" fill="#36435C"/></g>
${[[190, '#3B82F6'], [300, '#F2A20C'], [410, '#22A559']].map(([x, c], i) => `<g transform="translate(${x} 240)"><rect width="100" height="56" rx="8" fill="${c}"/>
<rect x="10" y="10" width="34" height="22" rx="4" fill="#BFE7FF"/><rect x="56" y="10" width="34" height="22" rx="4" fill="#BFE7FF"/>
<circle cx="27" cy="26" r="7" fill="${SKINS[i]}"/><circle cx="73" cy="26" r="7" fill="${SKINS[i + 1]}"/><path d="M20 24 Q27 15 34 24" fill="${HAIR[i]}"/><path d="M66 24 Q73 15 80 24" fill="${HAIR[i + 1]}"/>
<g fill="#36435C"><circle cx="22" cy="60" r="10"/><circle cx="78" cy="60" r="10"/></g><path d="M-10 40 H0" stroke="#36435C" stroke-width="4"/></g>`).join('')}
${scatter(102, 6, [20, 120, 160, 200], (x, y) => `<circle cx="${x}" cy="${y}" r="${10 + (x % 8)}" fill="#E6EDF4" opacity=".9"/>`)}
<g fill="#F0544F"><path d="M560 330 V380" stroke="#7A5A3A" stroke-width="4"/><circle cx="560" cy="326" r="12"/><circle cx="560" cy="326" r="5" fill="#fff"/></g>`;

const balloons = () => `
<rect width="400" height="600" fill="#BEE3FF"/>
<rect y="380" width="400" height="220" fill="#CDEBFF"/>
${cloud(80, 90, 1)}${cloud(300, 220, 0.9)}${cloud(120, 330, 0.8)}${bird(250, 60)}${bird(280, 76, 0.8)}
${[[120, 170, 1.15, ['#F0544F', '#FFD23F']], [290, 110, 0.9, ['#3B82F6', '#fff']], [260, 330, 1, ['#22A559', '#F2A20C']], [80, 400, 0.7, ['#9B51E0', '#FF7FA8']]].map(([x, y, s, [a, b]], i) => `<g transform="translate(${x} ${y}) scale(${s})">
<path d="M0 -70 C50 -70 64 -20 40 20 L14 50 H-14 L-40 20 C-64 -20 -50 -70 0 -70Z" fill="${a}"/>
<path d="M0 -70 C22 -70 26 -20 16 20 L8 50 H-8 L-16 20 C-26 -20 -22 -70 0 -70Z" fill="${b}"/><path d="M-46 -20 H46" stroke="${b}" stroke-width="5" opacity=".7"/>
<path d="M-12 50 L-12 72 M12 50 L12 72" stroke="#7A5A3A" stroke-width="2"/><rect x="-16" y="70" width="32" height="22" rx="4" fill="#C47A3C"/><path d="M-16 78 H16" stroke="#8A5A35" stroke-width="2"/>
${i < 3 ? `<circle cx="0" cy="62" r="8" fill="${SKINS[i]}"/><path d="M-8 60 Q0 50 8 60" fill="${HAIR[i]}"/><circle cx="-3" cy="62" r="1.2" fill="#1d2433"/><circle cx="3" cy="62" r="1.2" fill="#1d2433"/>` : ''}</g>`).join('')}
<path d="M0 470 L60 420 L120 460 L190 400 L260 450 L330 410 L400 450 V600 H0Z" fill="#7FBF6B"/>
<path d="M0 510 Q100 480 200 505 T400 495 V600 H0Z" fill="#9BD47F"/>
${house(40, 520, 50, 36, '#F2C17D', '#C0392B')}${house(300, 516, 54, 38, '#fff', '#3B82F6')}
${scatter(111, 8, [100, 500, 290, 560], (x, y) => tree(x, y + 30, 0.5))}
<path d="M0 580 Q200 560 400 584" stroke="#E8D3A2" stroke-width="10" fill="none"/>
${scatter(112, 14, [0, 560, 400, 600], (x, y) => flower(x, y, 0.7, ['#FF7FA8', '#FFD23F', '#fff'][Math.floor(x) % 3]))}
${scatter(113, 6, [10, 20, 390, 260], (x, y) => `<circle cx="${x}" cy="${y}" r="3" fill="#fff" opacity=".8"/>`)}`;

const dinosaurs = () => `
<rect width="600" height="400" fill="#FFE2C2"/>
${sun(90, 60, 26, '#FFB347')}
<path d="M360 210 L430 60 H470 L540 210Z" fill="#8A6A55"/><path d="M430 60 Q450 40 470 60 L460 90 L450 74 L440 92Z" fill="#F0544F"/>
<g fill="#C9BBB0" opacity=".9">${cloud(450, 34, 0.7, '#C9BBB0')}</g>
<g fill="#F2A20C">${scatter(121, 5, [430, 70, 470, 110], (x, y) => `<circle cx="${x}" cy="${y}" r="4"/>`)}</g>
<path d="M0 200 Q160 170 300 210 T600 190 V400 H0Z" fill="#9CCB6B"/>
${scatter(124, 14, [0, 340, 600, 400], (x, y) => `<ellipse cx="${x}" cy="${y}" rx="${8 + (x % 6)}" ry="5" fill="#A88B6B"/>`)}
${scatter(125, 18, [0, 220, 600, 400], (x, y) => grass(x, y, 0.9, '#6DAE47'))}
${[[60, 210], [290, 220], [580, 200]].map(([x, y]) => `<g transform="translate(${x} ${y})"><path d="M0 0 Q-6 -50 4 -90" stroke="#8A5A35" stroke-width="8" fill="none"/>
${[-60, -20, 20, 60, 100, 140].map((a) => `<path d="M4 -90 q${f(Math.cos((a * Math.PI) / 180) * 40)} ${f(Math.sin((a * Math.PI) / 180) * 20 - 20)} ${f(Math.cos((a * Math.PI) / 180) * 56)} ${f(Math.sin((a * Math.PI) / 180) * 30)}" stroke="#3E9B4F" stroke-width="9" fill="none" stroke-linecap="round"/>`).join('')}</g>`).join('')}
<g transform="translate(200 300)"><ellipse rx="90" ry="44" fill="#4FA65A"/><path d="M60 -20 Q120 -150 150 -150 Q170 -150 168 -134 Q150 -130 120 -40Z" fill="#4FA65A"/><ellipse cx="160" cy="-142" rx="22" ry="14" fill="#4FA65A"/>
<circle cx="164" cy="-146" r="3" fill="#1d2433"/><path d="M168 -136 Q174 -132 178 -136" stroke="#1d2433" stroke-width="2" fill="none"/>
<path d="M-86 0 Q-150 10 -180 40 Q-130 30 -84 20Z" fill="#4FA65A"/><g fill="#8FD18F">${scatter(122, 8, [-70, -30, 70, 20], (x, y) => `<circle cx="${x}" cy="${y}" r="7"/>`)}</g>
<g stroke="#3E8A48" stroke-width="20" stroke-linecap="round"><path d="M-50 30 V62 M-14 34 V64 M30 34 V64 M60 30 V62"/></g></g>
<g transform="translate(470 310)"><ellipse rx="54" ry="30" fill="#F2A20C"/><path d="M-50 -10 L-40 -40 L-26 -16 L-14 -46 L0 -18 L14 -46 L26 -16 L40 -40 L50 -10Z" fill="#D9472B"/>
<path d="M44 -6 Q80 -26 96 -10 Q90 10 54 12Z" fill="#F2A20C"/><circle cx="80" cy="-12" r="3" fill="#1d2433"/><path d="M-52 4 Q-90 0 -100 20 Q-76 16 -50 16Z" fill="#F2A20C"/>
<g stroke="#C88A1E" stroke-width="12" stroke-linecap="round"><path d="M-30 22 V44 M28 22 V44"/></g></g>
<g transform="translate(360 360)"><ellipse rx="18" ry="22" fill="#fff" stroke="#E0D2BC" stroke-width="2"/><path d="M-18 0 l6 -6 l6 6 l6 -6 l6 6 l6 -6 l6 6" stroke="#E0D2BC" stroke-width="2" fill="none"/></g>
${scatter(123, 4, [100, 60, 300, 140], (x, y) => `<g transform="translate(${x} ${y})"><path d="M-22 4 Q0 -16 22 4 Q0 -4 -22 4Z" fill="#9B51E0"/><path d="M0 -2 l10 -6 l-2 6Z" fill="#9B51E0"/></g>`)}`;

const chuseok = () => `
<rect width="600" height="400" fill="#1F2A55"/>
${scatter(131, 40, [0, 0, 600, 220], (x, y) => `<circle cx="${x}" cy="${y}" r="${1 + (Math.floor(x) % 2)}" fill="#fff" opacity=".8"/>`)}
<circle cx="450" cy="110" r="70" fill="#FFE9A8"/><circle cx="450" cy="110" r="70" fill="none" stroke="#FFF4CF" stroke-width="10" opacity=".5"/>
<g fill="#E8D08A" opacity=".8"><ellipse cx="430" cy="100" rx="10" ry="18"/><ellipse cx="444" cy="94" rx="6" ry="16"/><circle cx="436" cy="120" r="12"/><ellipse cx="470" cy="124" rx="16" ry="8"/></g>
${cloud(160, 90, 0.9, '#3A4A7A')}${cloud(300, 150, 0.7, '#3A4A7A')}
<path d="M0 250 Q150 200 300 240 T600 230 V400 H0Z" fill="#2E4A3A"/>
<g transform="translate(60 230)"><rect x="0" y="0" width="220" height="70" fill="#E8D3B0"/><g fill="#8A5A35">${Array.from({ length: 6 }, (_, i) => `<rect x="${12 + i * 36}" y="0" width="6" height="70"/>`).join('')}</g>
<rect x="30" y="18" width="40" height="34" fill="#FFF3D6"/><rect x="150" y="18" width="40" height="34" fill="#FFF3D6"/><path d="M30 35 H70 M50 18 V52 M150 35 H190 M170 18 V52" stroke="#C9A06A" stroke-width="2"/>
<path d="M-40 4 Q110 -30 260 4 L240 -40 Q110 -64 -20 -40Z" fill="#3A3A44"/><path d="M-40 4 Q-50 -8 -56 -18 M260 4 Q270 -8 276 -18" stroke="#3A3A44" stroke-width="8" stroke-linecap="round"/>
<g stroke="#55555F" stroke-width="2">${Array.from({ length: 12 }, (_, i) => `<path d="M${-20 + i * 23} -36 L${-30 + i * 25} 0"/>`).join('')}</g></g>
<rect x="0" y="300" width="600" height="100" fill="#4A6B4A"/>
${scatter(133, 16, [0, 300, 600, 400], (x, y) => grass(x, y, 0.8, '#5E8A5A'))}
<ellipse cx="420" cy="350" rx="110" ry="28" fill="#C47A3C"/><ellipse cx="420" cy="344" rx="100" ry="22" fill="#D9955A"/>
${scatter(132, 12, [340, 330, 500, 356], (x, y, i) => `<path d="M${x - 9} ${y + 4} Q${x} ${y - 10} ${x + 9} ${y + 4}Z" fill="${['#fff', '#F7B6C2', '#A6DD8B', '#FFE08A'][i % 4]}"/>`)}
<circle cx="350" cy="336" r="10" fill="#E8553D"/><circle cx="372" cy="330" r="9" fill="#F2A20C"/><circle cx="494" cy="336" r="10" fill="#E8553D"/>
${kid(250, 300, { shirt: '#E64C9A', skin: 0, hair: 0, pose: 'up', long: true })}${kid(150, 306, { shirt: '#14B8A6', skin: 1, hair: 1, pose: 'wave' })}
<g transform="translate(550 330)"><ellipse rx="14" ry="10" fill="#fff"/><ellipse cx="0" cy="-16" rx="4" ry="12" fill="#fff"/><ellipse cx="8" cy="-14" rx="4" ry="11" fill="#fff"/><circle cx="6" cy="-2" r="1.6" fill="#1d2433"/></g>
${scatter(134, 8, [20, 260, 590, 300], (x, y) => `<circle cx="${x}" cy="${y}" r="3" fill="#FFE38A"/>`)}`;

const seollal = () => `
<rect width="600" height="400" fill="#DDF0FF"/>
${cloud(100, 70, 0.9)}${cloud(470, 110, 0.8)}
${[[180, 90, '#F0544F'], [320, 60, '#3B82F6'], [440, 150, '#22A559']].map(([x, y, c], i) => `<g transform="translate(${x} ${y}) rotate(${(i - 1) * 10})"><rect x="-28" y="-36" width="56" height="72" fill="#fff" stroke="${c}" stroke-width="5"/>
<circle r="12" fill="${c}"/><path d="M-28 -36 L28 36 M28 -36 L-28 36" stroke="${c}" stroke-width="2"/><path d="M0 36 q-10 30 4 60 q12 30 -6 60" stroke="${c}" stroke-width="2" fill="none"/>
<path d="M-28 36 q-10 14 0 24 M28 36 q10 14 0 24" stroke="${c}" stroke-width="5" fill="none"/></g>`).join('')}
<path d="M180 125 Q200 220 230 272 M320 96 Q300 200 270 270 M440 186 Q420 240 380 272" stroke="#7A8AA0" stroke-width="1.5" fill="none"/>
<path d="M0 260 Q150 230 300 252 T600 246 V400 H0Z" fill="#fff"/>
<path d="M0 280 Q300 262 600 284 V400 H0Z" fill="#EAF2FA"/>
${kid(230, 270, { shirt: '#F0544F', pants: '#FFD23F', skin: 0, hair: 0, pose: 'up' })}<path d="M216 290 H244 L250 326 H210Z" fill="#FFD23F"/><path d="M216 292 L230 306 L244 292" stroke="#22A559" stroke-width="5" fill="none"/>
${kid(380, 270, { shirt: '#E64C9A', pants: '#3B82F6', skin: 3, hair: 1, pose: 'up', long: true })}<path d="M362 300 Q380 296 398 300 L412 344 H348Z" fill="#3B82F6"/><path d="M366 292 L380 306 L394 292" stroke="#FFD23F" stroke-width="5" fill="none"/>
<g transform="translate(110 330)"><path d="M-20 0 Q-26 30 0 34 Q26 30 20 0Z" fill="#F0544F"/><path d="M-20 0 Q0 -10 20 0" stroke="#FFD23F" stroke-width="4" fill="none"/><circle cy="16" r="6" fill="#FFD23F"/></g>
<g transform="translate(500 330)"><path d="M-20 0 Q-26 30 0 34 Q26 30 20 0Z" fill="#9B51E0"/><path d="M-20 0 Q0 -10 20 0" stroke="#FFD23F" stroke-width="4" fill="none"/><circle cy="16" r="6" fill="#FFD23F"/></g>
<g transform="translate(300 360)"><rect x="-60" y="-8" width="120" height="16" rx="3" fill="#C47A3C"/><path d="M-50 -8 V-30 M50 -8 V-30" stroke="#C47A3C" stroke-width="4"/>
<ellipse cx="-20" cy="-16" rx="14" ry="6" fill="#fff"/><ellipse cx="20" cy="-16" rx="14" ry="6" fill="#fff"/><g fill="#E8D08A"><circle cx="-24" cy="-18" r="2"/><circle cx="16" cy="-18" r="2"/></g></g>
${scatter(141, 6, [0, 290, 600, 400], (x, y) => `<ellipse cx="${x}" cy="${y}" rx="18" ry="5" fill="#DCE6F0"/>`)}
${scatter(142, 30, [0, 0, 600, 250], (x, y) => `<circle cx="${x}" cy="${y}" r="2" fill="#fff"/>`)}
${pine(40, 270, 0.9, '#3F7D5A', '#fff')}${pine(570, 266, 0.8, '#3F7D5A', '#fff')}`;

const playground = () => `
<rect width="600" height="400" fill="#D3EEFF"/>
${sun(530, 56, 26)}${cloud(100, 60, 0.9)}${cloud(320, 46, 0.7)}
<path d="M0 180 H600 V400 H0Z" fill="#9BD47F"/>
${scatter(152, 22, [0, 200, 600, 400], (x, y) => grass(x, y, 0.8, '#6DBF57'))}
${scatter(153, 12, [0, 360, 600, 400], (x, y) => flower(x, y, 0.7, ['#FFD23F', '#FF7FA8', '#fff'][Math.floor(x) % 3]))}${bird(230, 90)}${bird(256, 104, 0.8)}
${[[30, 190], [580, 186]].map(([x, y]) => tree(x, y, 0.9)).join('')}
<rect x="0" y="176" width="600" height="8" fill="#C9A06A"/>${Array.from({ length: 20 }, (_, i) => `<rect x="${i * 32}" y="150" width="6" height="34" fill="#C9A06A"/>`).join('')}
<g transform="translate(90 180)"><rect x="0" y="0" width="70" height="90" fill="#F2A20C"/><path d="M0 0 L35 -30 L70 0Z" fill="#F0544F"/>
<path d="M70 20 Q140 40 170 120 H140 Q120 60 70 50Z" fill="#3B82F6"/><g stroke="#7A4B2A" stroke-width="4">${Array.from({ length: 5 }, (_, i) => `<path d="M-6 ${20 + i * 16} H6"/>`).join('')}</g><path d="M-6 10 V100" stroke="#7A4B2A" stroke-width="4"/></g>
${kid(210, 250, { shirt: '#E64C9A', skin: 2, hair: 1, pose: 'up', s: 0.8, long: true })}
<g transform="translate(330 150)"><path d="M0 0 L-30 130 M0 0 L30 130 M140 0 L110 130 M140 0 L170 130 M0 0 H140" stroke="#F0544F" stroke-width="7" fill="none"/>
<path d="M40 0 V86 M64 0 V86 M96 0 V70 M120 0 V70" stroke="#7A8AA0" stroke-width="2"/><rect x="34" y="84" width="36" height="8" rx="3" fill="#36435C"/><rect x="90" y="68" width="36" height="8" rx="3" fill="#36435C"/></g>
${kid(382, 214, { shirt: '#22A559', skin: 0, hair: 0, pose: 'up', s: 0.75 })}
<rect x="400" y="300" width="160" height="70" rx="8" fill="#F2D28B" stroke="#C9A06A" stroke-width="5"/>
${scatter(151, 10, [410, 310, 550, 360], (x, y) => `<circle cx="${x}" cy="${y}" r="3" fill="#D9B270"/>`)}
<path d="M430 330 Q450 310 470 330Z" fill="#E8B04B"/><rect x="490" y="320" width="22" height="18" fill="#F0544F"/><path d="M512 320 L530 300" stroke="#7A4B2A" stroke-width="4"/>
${kid(470, 286, { shirt: '#F2A20C', skin: 1, hair: 2, s: 0.75 })}
<g transform="translate(150 330)"><path d="M-60 10 L60 -10" stroke="#9B51E0" stroke-width="9" stroke-linecap="round"/><path d="M0 0 L-10 30 H10Z" fill="#7A4B2A"/></g>
<circle cx="300" cy="350" r="16" fill="#F0544F"/><path d="M286 344 Q300 350 314 344 M300 334 V366" stroke="#fff" stroke-width="3" fill="none"/>`;

// Portrait 400 x 600.
const lighthouse = () => `
<rect width="400" height="600" fill="#20305E"/>
<rect y="200" width="400" height="200" fill="#2B4178"/>
${scatter(161, 50, [0, 0, 400, 300], (x, y) => `<circle cx="${x}" cy="${y}" r="${1 + (Math.floor(x + y) % 2)}" fill="#fff" opacity=".85"/>`)}
${star(70, 70, 10)}${star(330, 50, 8)}${star(260, 140, 7)}
<path d="M300 90 a40 40 0 1 0 30 66 a32 32 0 1 1 -30 -66Z" fill="#FFE9A8"/>
<path d="M200 170 L0 110 V230Z" fill="#FFF4CF" opacity=".25"/><path d="M200 170 L400 120 V220Z" fill="#FFF4CF" opacity=".18"/>
<path d="M0 400 Q200 380 400 400 V600 H0Z" fill="#1E5E8E"/>
<g stroke="#4F8FC0" stroke-width="3" fill="none" stroke-linecap="round">${scatter(162, 16, [0, 410, 400, 590], (x, y) => `<path d="M${x} ${y} q8 -5 16 0 q8 5 16 0"/>`)}</g>
<path d="M90 470 Q160 400 260 420 Q320 440 330 470 Z" fill="#5A5A66"/><path d="M110 470 Q170 430 240 436" stroke="#6E6E7A" stroke-width="6" fill="none"/>
<path d="M170 430 L182 190 H218 L230 430Z" fill="#fff"/>
<g fill="#F0544F"><path d="M176 330 H224 L227 380 H173Z"/><path d="M180 250 H220 L222 290 H178Z"/></g>
<rect x="172" y="168" width="56" height="22" fill="#36435C"/><rect x="178" y="146" width="44" height="22" fill="#FFE08A"/><path d="M174 146 L200 120 L226 146Z" fill="#F0544F"/>
<rect x="192" y="400" width="16" height="30" rx="6" fill="#8A5A35"/><rect x="190" y="300" width="20" height="16" rx="4" fill="#BFE7FF"/>
<g transform="translate(300 500)"><path d="M-46 0 H46 L34 22 H-34Z" fill="#F2A20C"/><path d="M0 0 V-60" stroke="#7A4B2A" stroke-width="3"/><path d="M4 -4 V-56 L36 -8Z" fill="#fff"/><path d="M-4 -4 V-46 L-28 -8Z" fill="#FFE08A"/></g>
<g transform="translate(80 520)"><ellipse rx="26" ry="10" fill="#36435C"/><path d="M-14 -4 Q0 -20 14 -4" fill="#9AA5B1"/></g>
${scatter(163, 4, [20, 230, 380, 300], (x, y) => `<path d="M${x - 9} ${y} q4 -6 9 0 q4 -6 9 0" stroke="#E6EDF4" stroke-width="2" fill="none"/>`)}
${scatter(164, 10, [100, 440, 340, 475], (x, y) => `<circle cx="${x}" cy="${y}" r="5" fill="#4A4A55"/>`)}`;

export const SCENES = [
  { key: 'picnic', title: '봄 소풍', category: '계절', width: 600, height: 400, svg: picnic },
  { key: 'water-play', title: '여름 물놀이', category: '계절', width: 600, height: 400, svg: waterPlay },
  { key: 'autumn-field', title: '가을 들판', category: '계절', width: 600, height: 400, svg: autumn },
  { key: 'snowman', title: '겨울 눈사람', category: '계절', width: 600, height: 400, svg: winter },
  { key: 'sports-day', title: '운동회', category: '학교', width: 600, height: 400, svg: sportsDay },
  { key: 'playground', title: '놀이터', category: '학교', width: 600, height: 400, svg: playground },
  { key: 'farm', title: '농장 동물', category: '동물', width: 600, height: 400, svg: farm },
  { key: 'giraffe', title: '기린과 코끼리', category: '동물', width: 400, height: 600, svg: giraffe },
  { key: 'dinosaurs', title: '공룡 계곡', category: '동물', width: 600, height: 400, svg: dinosaurs },
  { key: 'train', title: '기차 여행', category: '탈것', width: 600, height: 400, svg: train },
  { key: 'balloons', title: '열기구', category: '탈것', width: 400, height: 600, svg: balloons },
  { key: 'lighthouse', title: '밤바다 등대', category: '자연', width: 400, height: 600, svg: lighthouse },
  { key: 'chuseok', title: '추석 보름달', category: '명절', width: 600, height: 400, svg: chuseok },
  { key: 'seollal', title: '설날 연날리기', category: '명절', width: 600, height: 400, svg: seollal },
].map((scene) => ({ ...scene, svg: scene.svg() }));
