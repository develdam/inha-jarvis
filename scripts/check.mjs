import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const manifest = JSON.parse(fs.readFileSync("extension/manifest.json", "utf8"));
for (const relative of [manifest.background.service_worker, manifest.side_panel.default_path, "styles.css", ...Object.values(manifest.icons || {}), ...Object.values(manifest.action.default_icon || {})]) {
  if (!fs.existsSync(path.join("extension", relative))) throw new Error("Missing extension file: " + relative);
}
for (const file of fs.readdirSync("extension").filter((file) => file.endsWith(".js"))) {
  const checked = spawnSync(process.execPath, ["--check", path.join("extension", file)], { encoding: "utf8" });
  if (checked.status !== 0) throw new Error(checked.stderr);
}
console.log("Manifest, referenced assets and JavaScript syntax: OK");
