import { env } from "@/lib/constants";
import type { socialMediaResult } from "@/lib/types";
import { exec } from "child_process";
import { promisify } from "util";
import sharp from "sharp";
import emojiStrip from "emoji-strip";
import fs from "fs/promises";
import os from "os";
import path from "path";

const execPromise = promisify(exec);

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function getBase64(url: string): Promise<string> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const resizedBuffer = await sharp(buffer)
        .resize(500, 500, {
            fit: "inside",
            withoutEnlargement: true,
        })
        .jpeg({ quality: 80 })
        .toBuffer();

    return `data:image/jpeg;base64,${resizedBuffer.toString("base64")}`;
}

async function getGalleryData(url: string): Promise<any[]> {
    const { stdout } = await execPromise(
        `gallery-dl -j --cookies cookies.txt ${shellQuote(url)}`,
        { maxBuffer: 50 * 1024 * 1024 }
    );

    return JSON.parse(emojiStrip(stdout));
}

async function findVideoFile(directory: string): Promise<string | null> {
    const entries = await fs.readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);

        if (entry.isDirectory()) {
            const nested = await findVideoFile(fullPath);
            if (nested) return nested;
            continue;
        }

        const ext = path.extname(entry.name).toLowerCase();
        if ([".mp4", ".webm", ".mkv", ".mov", ".m4v"].includes(ext)) {
            return fullPath;
        }
    }

    return null;
}

async function downloadVideoAsWav(url: string): Promise<Blob> {
    const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "social-to-mealie-gallery-")
    );

    try {
        await execPromise(
            `gallery-dl -D ${shellQuote(tempDir)} ${shellQuote(url)}`,
            { maxBuffer: 50 * 1024 * 1024 }
        );

        const videoPath = await findVideoFile(tempDir);

        if (!videoPath) {
            throw new Error("gallery-dl downloaded no video file");
        }

        const wavPath = path.join(tempDir, "audio.wav");

        await execPromise(
            `${shellQuote(env.FFMPEG_PATH)} -y -i ${shellQuote(videoPath)} ` +
            `-acodec pcm_s16le -ac 1 -ar 16000 -f wav ${shellQuote(wavPath)}`,
            { maxBuffer: 50 * 1024 * 1024 }
        );

        const wavBuffer = await fs.readFile(wavPath);

        if (
            wavBuffer.length < 44 ||
            wavBuffer.subarray(0, 4).toString() !== "RIFF"
        ) {
            throw new Error("Generated WAV file is invalid");
        }

        return new Blob(
            [new Uint8Array(wavBuffer)],
            { type: "audio/wav" }
        );
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
}

export async function downloadMediaWithGalleryDl(
    url: string
): Promise<socialMediaResult> {
    const result: socialMediaResult = {
        blob: null,
        thumbnail: "notfound",
        description: "No description found",
        title: "not found",
        images: [],
    };

    try {
        let resolvedUrl = url;
        let rawData = await getGalleryData(resolvedUrl);

        // vm.tiktok.com and similar short links are returned by gallery-dl
        // as a type-6 redirect. Resolve that URL and run extraction again.
        const redirectItem = rawData.find(
            (item) =>
                Array.isArray(item) &&
                item[0] === 6 &&
                typeof item[1] === "string"
        );

        if (redirectItem) {
            resolvedUrl = redirectItem[1];

            console.log(
                `gallery-dl resolved redirect: ${url} -> ${resolvedUrl}`
            );

            rawData = await getGalleryData(resolvedUrl);
        }

        let videoDetected = false;

        for (const item of rawData) {
            if (!Array.isArray(item)) continue;

            const type = item[0];

            if (type === 2 && item[1]) {
                const meta = item[1];

                result.description =
                    meta.description ||
                    meta.desc ||
                    result.description;

                result.title =
                    meta.fullname ||
                    meta.username ||
                    meta.title ||
                    meta.user?.nickname ||
                    result.title;

                const cover =
                    meta.video?.cover ||
                    meta.video?.originCover ||
                    meta.cover;

                if (
                    result.thumbnail === "notfound" &&
                    typeof cover === "string" &&
                    cover.startsWith("http")
                ) {
                    result.thumbnail = cover;

                    // Video covers are used as recipe thumbnails only.
                    // Do not send them as AI vision input; some OpenRouter
                    // providers reject base64 image content.
                }
            }

            if (type === 3 && typeof item[1] === "string") {
                const mediaUrl = item[1];
                const meta = item[2] || {};

                const extension =
                    typeof meta.extension === "string"
                        ? meta.extension.toLowerCase()
                        : "";

                const mediaType =
                    typeof meta.type === "string"
                        ? meta.type.toLowerCase()
                        : "";

                const isVideo =
                    mediaType === "video" ||
                    ["mp4", "webm", "mkv", "mov", "m4v"].includes(extension);

                if (isVideo) {
                    videoDetected = true;

                    result.description =
                        meta.description ||
                        meta.desc ||
                        result.description;

                    result.title =
                        meta.title ||
                        result.title;

                    continue;
                }

                result.thumbnail = mediaUrl;

                if (mediaUrl.startsWith("http")) {
                    try {
                        const base64 = await getBase64(mediaUrl);
                        result.images.push(base64);
                    } catch (imgErr) {
                        console.error(
                            `Error processing image ${mediaUrl}:`,
                            imgErr
                        );
                    }
                }
            }
        }

        if (videoDetected) {
            console.log(
                `gallery-dl video detected, extracting audio from ${resolvedUrl}`
            );

            try {
                result.blob = await downloadVideoAsWav(resolvedUrl);
            } catch (error) {
                const description = result.description.trim();

                const hasUsefulDescription =
                    description !== "No description found" &&
                    description.length >= 80;

                if (!hasUsefulDescription) {
                    throw error;
                }

                console.warn(
                    "Audio extraction failed; using video description instead:",
                    error instanceof Error
                        ? error.message.split("\n")[0]
                        : String(error)
                );
            }
        }

        result.description = result.description.trim();

        if (
            !result.blob &&
            result.images.length === 0 &&
            result.thumbnail === "notfound" &&
            result.description === "No description found"
        ) {
            throw new Error("gallery-dl returned no usable media or metadata");
        }

        console.log(result);
        return result;
    } catch (error) {
        console.error(
            "Critical error in downloadMediaWithGalleryDl:",
            error
        );

        throw error;
    }
}
