import { getRecipe, postRecipe, uploadRecipeImage } from "@/lib/mealie";
import type { progressType, socialMediaResult } from "@/lib/types";
import { generateRecipeFromAI, getTranscription } from "@/lib/ai";
import { env } from "@/lib/constants";
import { downloadMediaWithYtDlp, downloadThumbnailWithYtDlp } from "@/lib/yt-dlp";

interface RequestBody {
    url: string;
    tags: string[];
}
async function handleRequest(
    url: string,
    tags: string[],
    isSse: boolean,
    controller?: ReadableStreamDefaultController
) {
    const encoder = new TextEncoder();
    let socialMediaResult: socialMediaResult;
    let transcription = "";

    const progress: progressType = {
        videoDownloaded: null,
        audioTranscribed: null,
        recipeCreated: null,
    };

    try {
        if (isSse && controller) {
            controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ progress })}\n\n`)
            );
        }
        socialMediaResult = await downloadMediaWithYtDlp(url);

        const hasUsableDescription =
            socialMediaResult.description.trim() !== "No description found" &&
            socialMediaResult.description.trim().length >= 80;

        const hasUsableContent =
            Boolean(socialMediaResult.blob) ||
            socialMediaResult.images.length > 0 ||
            hasUsableDescription ||
            Boolean(
                socialMediaResult.thumbnail &&
                socialMediaResult.thumbnail !== "notfound"
            );

        if (!hasUsableContent) {
            throw new Error("Could not extract any media or metadata from the provided URL");
        }

        progress.videoDownloaded = true;

        if (isSse && controller) {
            controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ progress })}\n\n`)
            );
        }
        if (socialMediaResult.blob) {
            transcription = await getTranscription(socialMediaResult.blob);
            progress.audioTranscribed = true;
            if (isSse && controller) {
                controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify({progress})}\n\n`)
                );
            }
        } else {
            progress.audioTranscribed = "skipped";

            if (isSse && controller) {
                controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify({ progress })}\n\n`)
                );
            }
        }

        // Generate recipe JSON using AI
        const recipe = await generateRecipeFromAI(
            transcription,
            socialMediaResult.description,
            url,
            socialMediaResult.thumbnail,
            env.EXTRA_PROMPT || "",
            tags,
            socialMediaResult.images
        );

        console.log("Posting recipe to Mealie", recipe);
        const mealieResponse = await postRecipe(recipe);
        const recipeSlug = await mealieResponse;

        // Instagram CDN image URLs can return HTTP 403 when Mealie
        // tries to fetch them itself. Download the thumbnail through
        // yt-dlp's Instagram session and upload it directly to Mealie.
        try {
            const hostname = new URL(url).hostname.toLowerCase();

            const isInstagram =
                hostname === "instagram.com" ||
                hostname === "www.instagram.com" ||
                hostname.endsWith(".instagram.com");

            if (isInstagram) {
                console.log(
                    "Instagram URL detected, downloading thumbnail locally"
                );

                const thumbnail =
                    await downloadThumbnailWithYtDlp(url);

                if (thumbnail) {
                    await uploadRecipeImage(
                        recipeSlug,
                        thumbnail.blob,
                        thumbnail.extension
                    );
                }
            }
        } catch (imageError) {
            console.warn(
                "Recipe was created, but direct image upload failed:",
                imageError
            );
        }

        const createdRecipe = await getRecipe(recipeSlug);
        console.log("Recipe created");
        progress.recipeCreated = true;
        if (isSse && controller) {
            controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ progress })}\n\n`)
            );
            controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(createdRecipe)}\n\n`)
            );
            controller.close();
            return;
        }
        return new Response(JSON.stringify({ createdRecipe, progress }), {
            status: 200,
        });
    } catch (error: any) {
        if (isSse && controller) {
            progress.recipeCreated = false;
            controller.enqueue(
                encoder.encode(
                    `data: ${JSON.stringify({
                        error: error.message,
                        progress,
                    })}\n\n`
                )
            );
            controller.close();
            return;
        }
        return new Response(
            JSON.stringify({ error: error.message, progress }),
            { status: 500 }
        );
    }
}

export async function POST(req: Request) {
    const body: RequestBody = await req.json();
    const url = body.url;
    const tags = body.tags;
    const contentType = req.headers.get("Content-Type");

    if (contentType === "text/event-stream") {
        const stream = new ReadableStream({
            async start(controller) {
                await handleRequest(url, tags, true, controller);
            },
        });

        return new Response(stream, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
            },
        });
    }
    return handleRequest(url, tags, false);
}
