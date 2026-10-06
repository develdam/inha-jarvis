import fs from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.JARVIS_PLAYWRIGHT_PATH || "playwright");
const source = await fs.readFile(new URL("../inha.svg", import.meta.url), "utf8");
const destination = new URL("../extension/icons/", import.meta.url);
await fs.mkdir(destination, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.JARVIS_CHROMIUM_PATH, headless: true });
try {
  const page = await browser.newPage();
  for (const size of [16, 32, 48, 128]) {
    const png = await page.evaluate(async ({ source, size }) => {
      const mark = new Image();
      mark.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(source);
      await mark.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const context = canvas.getContext("2d");
      const ratio = Math.min(size / mark.naturalWidth, size / mark.naturalHeight);
      const width = mark.naturalWidth * ratio;
      const height = mark.naturalHeight * ratio;
      context.drawImage(mark, (size - width) / 2, (size - height) / 2, width, height);
      return canvas.toDataURL("image/png").split(",")[1];
    }, { source, size });
    await fs.writeFile(new URL(`inha-${size}.png`, destination), Buffer.from(png, "base64"));
  }
  console.log("Created Inha icons at 16, 32, 48 and 128px from inha.svg.");
} finally {
  await browser.close();
}
