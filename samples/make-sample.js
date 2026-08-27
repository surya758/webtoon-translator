// Generates samples/strip.png — a synthetic Korean webtoon strip that exercises
// every case the pipeline handles: short/long dialogue, a shout burst, a thought
// cloud, a two-lobed bubble, a dark caption, a chat bubble with a name label,
// coloured SFX over artwork, and a translucent site watermark.
//   node samples/make-sample.js
import sharp from "sharp";

const W = 720, H = 2700;
const KFONT = "Apple SD Gothic Neo, AppleGothic, Noto Sans KR, sans-serif";

const text = (x, y, lines, { fs = 28, fill = "#000", weight = 400, anchor = "middle", extra = "" } = {}) =>
  `<text x="${x}" y="${y - ((lines.length - 1) * fs * 1.2) / 2 + fs * 0.35}" font-size="${fs}" font-family="${KFONT}" font-weight="${weight}" text-anchor="${anchor}" fill="${fill}" ${extra}>
    ${lines.map((l, i) => `<tspan x="${x}" dy="${i ? fs * 1.2 : 0}">${l}</tspan>`).join("")}
  </text>`;

const ellipse = (cx, cy, rx, ry, lines, o = {}) =>
  `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${o.fill ?? "#fff"}" stroke="#000" stroke-width="4"/>${text(cx, cy, lines, o)}`;

// spiky shout burst
const burst = (cx, cy, r, lines, o = {}) => {
  const pts = [];
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2;
    const rr = i % 2 ? r : r * 1.28;
    pts.push(`${(cx + Math.cos(a) * rr * 1.5).toFixed(1)},${(cy + Math.sin(a) * rr).toFixed(1)}`);
  }
  return `<polygon points="${pts.join(" ")}" fill="#fff" stroke="#000" stroke-width="4"/>${text(cx, cy, lines, { weight: 700, ...o })}`;
};

// cloud-ish thought bubble
const thought = (cx, cy, rx, ry, lines, o = {}) => {
  let s = "";
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    s += `<circle cx="${(cx + Math.cos(a) * rx).toFixed(1)}" cy="${(cy + Math.sin(a) * ry).toFixed(1)}" r="${Math.min(rx, ry) * 0.42}" fill="#fff" stroke="#000" stroke-width="4"/>`;
  }
  s += `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="#fff"/>`;
  s += `<circle cx="${cx - rx * 0.9}" cy="${cy + ry * 1.5}" r="12" fill="#fff" stroke="#000" stroke-width="3"/><circle cx="${cx - rx * 1.1}" cy="${cy + ry * 1.9}" r="7" fill="#fff" stroke="#000" stroke-width="3"/>`;
  return s + text(cx, cy, lines, o);
};

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<defs>
  <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1d2b53"/><stop offset="1" stop-color="#7e5ba8"/></linearGradient>
  <linearGradient id="room" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f3d9b1"/><stop offset="1" stop-color="#c98f5a"/></linearGradient>
  <linearGradient id="street" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e8eef5"/><stop offset="1" stop-color="#8fa3b8"/></linearGradient>
  <radialGradient id="glow"><stop offset="0" stop-color="#fff7c2"/><stop offset="1" stop-color="#f29e4c"/></radialGradient>
</defs>
<rect width="${W}" height="${H}" fill="#111"/>

<!-- panel 1: night sky, short + long dialogue -->
<rect x="0" y="0" width="${W}" height="820" fill="url(#sky)"/>
<circle cx="600" cy="130" r="60" fill="#fdf6d8"/>
<g fill="#fff"><circle cx="90" cy="80" r="2"/><circle cx="210" cy="160" r="2.5"/><circle cx="330" cy="60" r="1.8"/><circle cx="480" cy="240" r="2"/><circle cx="150" cy="300" r="1.5"/></g>
<path d="M0 620 Q120 520 260 600 T520 580 T720 640 V820 H0Z" fill="#0d1526"/>
<rect x="140" y="470" width="40" height="150" fill="#0a0f1c"/><rect x="150" y="490" width="8" height="10" fill="#ffd97a"/><rect x="164" y="520" width="8" height="10" fill="#ffd97a"/>
${ellipse(170, 160, 110, 60, ["뭐야?"], { fs: 34, weight: 700 })}
${ellipse(400, 420, 250, 125, ["오늘 밤 안에 끝내지 못하면", "우리 둘 다 여기서", "빠져나갈 방법이 없어.", "알아들었지?"], { fs: 27 })}

<!-- caption box -->
<rect x="40" y="700" width="330" height="70" fill="#1a1a1a" stroke="#fff" stroke-width="2"/>
${text(205, 735, ["다음 날 아침, 경찰서."], { fs: 24, fill: "#fff" })}

<!-- panel 2: warm room, shout burst + thought cloud + SFX + name label chat -->
<rect x="0" y="840" width="${W}" height="900" fill="url(#room)"/>
<rect x="60" y="1300" width="600" height="420" fill="#7a4f2b"/><rect x="80" y="1320" width="560" height="380" fill="#9a6a3c"/>
<circle cx="560" cy="1000" r="70" fill="url(#glow)"/>
${burst(230, 1010, 95, ["나가!!"], { fs: 44 })}
${thought(500, 1230, 120, 60, ["...진짜 화났나 보다.", "어쩌지."], { fs: 22 })}
<g transform="rotate(-18 150 1230)">${text(150, 1230, ["쾅!!"], { fs: 64, fill: "#e63946", weight: 900, extra: 'stroke="#fff" stroke-width="6" paint-order="stroke"' })}</g>
<g transform="rotate(12 600 1600)">${text(600, 1600, ["두근"], { fs: 44, fill: "#ff7b9c", weight: 900, extra: 'stroke="#fff" stroke-width="5" paint-order="stroke"' })}</g>
<!-- chat bubble with sender name -->
<circle cx="130" cy="1420" r="34" fill="#c084fc" stroke="#000" stroke-width="3"/>
${text(230, 1395, ["김민수"], { fs: 22, fill: "#111", anchor: "start", weight: 700 })}
<rect x="180" y="1415" width="380" height="88" rx="22" fill="#fff" stroke="#000" stroke-width="3"/>
${text(370, 1459, ["지금 어디야? 빨리 와."], { fs: 24 })}

<!-- panel 3: street, two-lobed bubble + tiny bubble + big bubble -->
<rect x="0" y="1760" width="${W}" height="940" fill="url(#street)"/>
<rect x="0" y="2450" width="${W}" height="250" fill="#5b6b7c"/>
<rect x="420" y="2050" width="160" height="400" fill="#3b4a5a"/><rect x="440" y="2080" width="30" height="40" fill="#dfe8f0"/><rect x="500" y="2080" width="30" height="40" fill="#dfe8f0"/><rect x="440" y="2150" width="30" height="40" fill="#dfe8f0"/>
<g>
  <ellipse cx="200" cy="1900" rx="150" ry="80" fill="#fff" stroke="#000" stroke-width="4"/>
  <ellipse cx="330" cy="2010" rx="170" ry="85" fill="#fff" stroke="#000" stroke-width="4"/>
  <ellipse cx="270" cy="1960" rx="90" ry="60" fill="#fff"/>
  ${text(200, 1890, ["저기, 잠깐만."], { fs: 26 })}
  ${text(340, 2015, ["할 얘기가 있어."], { fs: 26 })}
</g>
${ellipse(600, 1880, 70, 40, ["응?"], { fs: 30 })}
${ellipse(360, 2280, 290, 120, ["솔직히 말하면 처음부터 네가 거짓말하고", "있다는 걸 알고 있었어. 그래도 믿고 싶었던", "거야. 우리가 여기까지 온 게 아까워서."], { fs: 22 })}

<!-- translucent site watermark, vertical -->
<g transform="translate(690 2100) rotate(90)" opacity="0.55">${text(0, 0, ["FREEWEBTOONS.EXAMPLE"], { fs: 30, fill: "#ff4d6d", weight: 700 })}</g>
<g opacity="0.5">${text(120, 2650, ["freewebtoons.example"], { fs: 22, fill: "#fff" })}</g>
</svg>`;

await sharp(Buffer.from(svg)).png().toFile(new URL("./strip.png", import.meta.url).pathname);
console.log("wrote samples/strip.png");
