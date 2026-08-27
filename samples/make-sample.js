import sharp from "sharp";
const W = 800, H = 2400;
const bubble = (cx, cy, rx, ry, lines, fs = 30) => `
  <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="#fff" stroke="#000" stroke-width="4"/>
  <text x="${cx}" y="${cy - ((lines.length - 1) * fs * 1.2) / 2 + fs * 0.35}" font-size="${fs}" font-family="Apple SD Gothic Neo, AppleGothic, sans-serif" text-anchor="middle" fill="#000">
    ${lines.map((l, i) => `<tspan x="${cx}" dy="${i ? fs * 1.2 : 0}">${l}</tspan>`).join("")}
  </text>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#e8d9c5"/>
  <rect x="40" y="40" width="720" height="700" fill="#8fb3d9" stroke="#000" stroke-width="6"/>
  <rect x="40" y="800" width="720" height="700" fill="#c9a0dc" stroke="#000" stroke-width="6"/>
  <rect x="40" y="1560" width="720" height="780" fill="#a3d9a5" stroke="#000" stroke-width="6"/>
  ${bubble(260, 200, 190, 90, ["안녕? 오랜만이야.", "잘 지냈어?"])}
  ${bubble(520, 560, 200, 100, ["응, 나야 뭐.", "너는 어떻게 지냈어?"])}
  <rect x="80" y="840" width="400" height="90" fill="#222"/>
  <text x="280" y="895" font-size="30" font-family="Apple SD Gothic Neo, AppleGothic, sans-serif" text-anchor="middle" fill="#fff">3년 후...</text>
  ${bubble(400, 1250, 260, 110, ["이게 정말 마지막", "기회라고 생각해."], 32)}
  ${bubble(300, 1800, 220, 90, ["도망치지 마!"], 40)}
  ${bubble(520, 2150, 210, 100, ["...미안해.", "나도 무서웠어."], 30)}
</svg>`;
await sharp(Buffer.from(svg)).png().toFile("samples/strip.png");
console.log("wrote samples/strip.png");
