// Render one template clip in its own process (so the web server stays responsive
// and the job can be cancelled): tsx web/tasks/render-template.ts <jobfile.json>
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { readFileSync } from "node:fs";
import { buildBrand } from "../../src/render/brand.js";
import { composeTemplate, type Aspect } from "../../src/render/template-composer.js";
import { ensureFfmpegOnPath } from "../../src/utils/ffmpeg-path.js";

ensureFfmpegOnPath();

const spec = JSON.parse(readFileSync(process.argv[2], "utf8")) as {
  templateId: string;
  inputs: Record<string, unknown>;
  aspect: Aspect;
  outputPath: string;
  /** Project folder that image paths resolve against. */
  baseDir?: string;
  /** script.metadata — source domain + publish date for the brand frame. */
  meta?: { source?: { domain?: string }; date?: string };
  durationSec?: number;
  extraVars?: Record<string, unknown>;
};

composeTemplate({
  templateId: spec.templateId,
  inputs: spec.inputs,
  aspect: spec.aspect,
  outputPath: spec.outputPath,
  baseDir: spec.baseDir,
  brand: buildBrand(spec.meta),
  durationSec: spec.durationSec,
  extraVars: spec.extraVars,
  fps: 30,
}).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
