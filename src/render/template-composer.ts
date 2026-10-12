import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { log } from "../utils/logger.js";
import type { Brand } from "./brand.js";
import { inlineImages } from "./inline-assets.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Repo-root/templates — where vendored HyperFrames templates live. */
const TEMPLATES_DIR = join(__dirname, "..", "..", "templates");

/** Pinned version → deterministic renders. */
const HYPERFRAMES_VERSION = "0.6.94";

export type Aspect = "16:9" | "9:16" | "1:1";

let hfCached = false;
/**
 * True once `npx` has the pinned HyperFrames in its cache. Until then renders
 * must not start in parallel: concurrent first-run installs corrupt the cache.
 * Unknown cache layout → false, which only costs one sequential render.
 */
export function hyperframesCached(): boolean {
    if (hfCached) return true;
    const cache =
        process.env.npm_config_cache ??
        (process.platform === "win32" && process.env.LOCALAPPDATA
            ? join(process.env.LOCALAPPDATA, "npm-cache")
            : join(homedir(), ".npm"));
    const npxDir = join(cache, "_npx");
    try {
        hfCached = readdirSync(npxDir).some((d) => {
            const pkg = join(npxDir, d, "node_modules", "hyperframes", "package.json");
            return existsSync(pkg) && JSON.parse(readFileSync(pkg, "utf8")).version === HYPERFRAMES_VERSION;
        });
    } catch {
        /* no npx cache yet */
    }
    return hfCached;
}

/**
 * Each aspect renders a dedicated composition file authored at that native
 * canvas (these templates use absolute-px layouts, so we re-lay-out per aspect
 * rather than scale a single composition). Missing file → fall back to index.html.
 */
const ASPECT_ENTRY: Record<Aspect, string> = {
    "16:9": "index.html",
    "9:16": "compositions/portrait.html",
    "1:1": "compositions/square.html",
};

export interface ComposeArgs {
    /** Folder name under templates/, e.g. "frame-bold-poster". */
    templateId: string;
    /** Content slots, matching the template's data-composition-variables schema. */
    inputs: Record<string, unknown>;
    /** Absolute or repo-relative output .mp4 path. */
    outputPath: string;
    /** Force an output aspect. Omit to render the template's native canvas. */
    aspect?: Aspect;
    fps?: number;
    quality?: "draft" | "standard" | "high";
    /** Folder that relative image paths in `inputs` resolve against (the project dir). */
    baseDir?: string;
    /** Channel identity, passed to every template as `__brand`. */
    brand?: Brand;
    /**
     * Clip length in seconds. Only honoured by templates whose meta.json sets
     * "dynamicDuration": true (their motion is a function of t, so rendering the
     * full narration length beats freezing the last frame).
     */
    durationSec?: number;
    /** Extra template variables set by the pipeline (e.g. __title, __intro, __offset, __total). */
    extraVars?: Record<string, unknown>;
    /** Chrome workers for this render. Omit to let HyperFrames pick ("auto" = grab the whole machine). */
    workers?: number;
}

export interface TemplateMeta {
    id: string;
    name?: string;
    dynamicDuration?: boolean;
}

/** Content hash of a template's compositions — changes whenever its design changes. */
export function templateFingerprint(templateId: string): string {
    const h = createHash("md5");
    for (const f of ["index.html", "compositions/portrait.html", "meta.json"]) {
        const p = join(TEMPLATES_DIR, templateId, f);
        if (existsSync(p)) h.update(readFileSync(p));
    }
    return h.digest("hex").slice(0, 12);
}

export function readTemplateMeta(templateId: string): TemplateMeta {
    try {
        return JSON.parse(readFileSync(join(TEMPLATES_DIR, templateId, "meta.json"), "utf8"));
    } catch {
        return { id: templateId };
    }
}

/**
 * Render one vendored HyperFrames template into an MP4, injecting `inputs`
 * as composition variables. This is the deterministic "fill the slots" step:
 * the agent only supplies text, the template owns all the visual design.
 */
export async function composeTemplate(args: ComposeArgs): Promise<string> {
    const { templateId, inputs, fps = 30, quality = "standard", aspect } = args;
    const templateDir = join(TEMPLATES_DIR, templateId);
    if (!existsSync(join(templateDir, "index.html"))) {
        throw new Error(`Template not found: ${templateDir}/index.html`);
    }

    // Pick the composition file for the requested aspect (fall back to index.html).
    const entry = aspect ? ASPECT_ENTRY[aspect] : "index.html";
    const entryFile = existsSync(join(templateDir, entry))
        ? entry
        : "index.html";

    const outputPath = isAbsolute(args.outputPath)
        ? args.outputPath
        : resolve(process.cwd(), args.outputPath);

    // Pass variables via a temp file, NOT --variables: a JSON arg through
    // npx + shell:true on Windows mangles quotes/Unicode (em-dash, Vietnamese)
    // and the render silently no-ops. A file is shell-safe and UTF-8 clean.
    const varsFile = join(
        mkdtempSync(join(tmpdir(), "hf-vars-")),
        "variables.json",
    );
    const variables: Record<string, unknown> = args.baseDir
        ? (inlineImages(inputs, args.baseDir) as Record<string, unknown>)
        : { ...inputs };
    if (args.brand) variables.__brand = args.brand;
    Object.assign(variables, args.extraVars ?? {});
    writeFileSync(varsFile, JSON.stringify(variables), "utf8");

    // HyperFrames reads data-duration straight from the HTML (setting it from a
    // script has no effect), so dynamic-length templates render from a temp copy
    // with the attribute rewritten.
    let renderDir = templateDir;
    const meta = readTemplateMeta(templateId);
    if (meta.dynamicDuration && args.durationSec && args.durationSec > 0) {
        renderDir = mkdtempSync(join(tmpdir(), `hf-${templateId}-`));
        cpSync(templateDir, renderDir, { recursive: true });
        const file = join(renderDir, entryFile);
        const html = readFileSync(file, "utf8").replace(
            /data-duration="[\d.]+"/,
            `data-duration="${args.durationSec.toFixed(2)}"`,
        );
        writeFileSync(file, html, "utf8");
    }

    const spawnArgs = [
        // -y: never prompt to install.
        "-y",
        `hyperframes@${HYPERFRAMES_VERSION}`,
        "render",
        renderDir,
        "--composition",
        entryFile,
        "--output",
        outputPath,
        "--fps",
        String(fps),
        "--quality",
        quality,
        "--variables-file",
        varsFile,
    ];
    if (args.workers) spawnArgs.push("--workers", String(args.workers));

    log.info(`Compose ${templateId} (${entryFile}) → ${outputPath}`);

    await new Promise<void>((resolve, reject) => {
        // shell:true joins args verbatim — quote paths with spaces ("video ai/…")
        // or the shell splits them and hyperframes sees a truncated path.
        const quoted = spawnArgs.map((a) => (/\s/.test(a) ? `"${a}"` : a));
        const proc = spawn("npx", quoted, {
            stdio: ["ignore", "inherit", "inherit"],
            shell: true,
        });
        proc.on("close", (code) =>
            code === 0
                ? resolve()
                : reject(new Error(`hyperframes render failed (exit ${code})`)),
        );
        proc.on("error", reject);
    }).finally(() => {
        if (renderDir !== templateDir) rmSync(renderDir, { recursive: true, force: true });
    });

    log.info(`Rendered: ${outputPath}`);
    return outputPath;
}

/** POC entry: `tsx src/render/template-composer.ts` renders sample clips. */
// pathToFileURL handles Windows backslash paths (a raw `file://${argv[1]}`
// never matches import.meta.url on win32, silently skipping this block).
if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    const inputs = {
        kicker: "AI Coding",
        date: "12 · 06 · 2026",
        figure: "5.5",
        headline: ["GPT 5.5", "ra mắt.", "Mạnh nhất."],
        standfirst:
            "OpenAI vừa công bố mô hình mạnh nhất từ trước tới nay — nhanh hơn, rẻ hơn, hiểu tiếng Việt tốt hơn.",
        footer_left: "AI Coding",
        footer_right: "https://aicodingvn.vercel.app/",
    };
    (async () => {
        await composeTemplate({
            templateId: "frame-bold-poster",
            inputs,
            aspect: "16:9",
            outputPath: "output/poc-bold-poster-16x9.mp4",
        });
        await composeTemplate({
            templateId: "frame-bold-poster",
            inputs,
            aspect: "9:16",
            outputPath: "output/poc-bold-poster-9x16.mp4",
        });
    })().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
