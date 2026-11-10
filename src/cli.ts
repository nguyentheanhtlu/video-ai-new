#!/usr/bin/env node
import { config } from "dotenv";
config({ path: ".env.local" });

import { readFile } from "node:fs/promises";
import { runTemplatePipeline } from "./render/template-pipeline.js";
import { runSlideshowPipeline } from "./render/slideshow/pipeline.js";
import { log } from "./utils/logger.js";
import { ensureFfmpegOnPath } from "./utils/ffmpeg-path.js";

async function main() {
  const scriptPath = process.argv[2];
  if (!scriptPath) {
    console.error("Usage: npm run pipeline -- <path/to/script.json>");
    process.exit(2);
  }
  ensureFfmpegOnPath();
  try {
    // "slideshow" = long-form 16:9 (ffmpeg); anything else = HyperFrames templates.
    const { renderer } = JSON.parse(await readFile(scriptPath, "utf8")) as { renderer?: string };
    if (renderer === "slideshow") await runSlideshowPipeline(scriptPath);
    else await runTemplatePipeline(scriptPath);
  } catch (e) {
    log.error("Pipeline failed", e);
    process.exit(1);
  }
}

main();
