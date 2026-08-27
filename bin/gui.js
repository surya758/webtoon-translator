#!/usr/bin/env node
import "dotenv/config";
import { exec } from "node:child_process";
import { startServer } from "../src/server.js";

const port = Number(process.env.PORT || 7860);
const { url } = await startServer({ port });
console.log(`webtoon-translator GUI → ${url}`);
if (!process.argv.includes("--no-open")) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${cmd} ${url}`);
}
