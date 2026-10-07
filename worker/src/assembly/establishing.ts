// The first assembly's establishing shot (Guy, Oct 1): the outside of the
// place where the scene happens, before going straight into the dialogue. An
// image model draws a still of the exterior (fal's Nano Banana Pro), matching
// frames from the scene's own takes (Guy, Oct 5: "The establishing shots
// should match the atmosphere and general feel of interiors"), then Seedance
// 2.5 brings it to life for 5 seconds, with its own street sound. Made once per
// shoot (the job keeps it), as it costs about $2.50.

import { writeFile } from "node:fs/promises";
import { dataUri, type FalClient } from "../ai/fal.js";
import { ffmpegPipe } from "./audio.js";
import type { SoundBrief } from "./music.js";

export const IMAGE_ENDPOINT = "fal-ai/nano-banana-pro";
/** The same model, drawing from pictures it's given as well as the words. */
export const IMAGE_EDIT_ENDPOINT = "fal-ai/nano-banana-pro/edit";
export const VIDEO_ENDPOINT = "bytedance/seedance-2.5/image-to-video";
export const ESTABLISHING_SECONDS = 5;

async function save(url: string, file: string, signal?: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`fal's file wouldn't download (${response.status}).`);
  await writeFile(file, Buffer.from(await response.arrayBuffer()));
}

/** A frame of a take (JPEG), `at` seconds in: what the scene looks like, as graded for the previews. */
export async function frameOf(ffmpeg: string, video: string, at: number, signal?: AbortSignal): Promise<Buffer> {
  return ffmpegPipe(ffmpeg, ["-v", "error", "-nostdin", "-ss", at.toFixed(3), "-i", video, "-frames:v", "1", "-vf", "scale=1280:-2", "-q:v", "3", "-f", "image2", "-c:v", "mjpeg", "-"], undefined, signal);
}

/**
 * Makes the establishing shot into `file` (an mp4 with sound). With `interiors`
 * (frames of the scene's takes), the still matches their time of day, light,
 * colour and mood, and the kind of building the room is in, so the exterior
 * cuts straight into them as the same moment (shoot 1007, Oct 5: a cold glass
 * tower at dusk, before a warm, sunlit, wood-panelled office). Throws if fal
 * can't.
 */
export async function makeEstablishing(fal: FalClient, exterior: NonNullable<SoundBrief["exterior"]>, file: string, signal?: AbortSignal, interiors: Buffer[] = []) {
  const look = "subtle film grain. No text, no logos, no watermark.";
  const still = await fal.run<{ images?: { url: string }[] }>(
    interiors.length ? IMAGE_EDIT_ENDPOINT : IMAGE_ENDPOINT,
    {
      prompt: interiors.length
        ? "These pictures are frames from inside the place where this scene was filmed. Draw the shot that opens it, of the outside: " +
          `${exterior.image} Match the frames' time of day, light (its direction, its warmth, the lamps that are on), colour palette, ` +
          "contrast and grain, and make it the kind of building this room would be in, so the exterior cuts straight into them as " +
          "the same moment; where the description and the frames disagree about the time of day, the weather or the building, " +
          `follow the frames. Show only the outside, never these people or this room. ` +
          `Photographic, cinematic establishing shot, 16:9, ${look}`
        : `${exterior.image} Photographic, cinematic establishing shot, 16:9, natural light, ${look}`,
      ...(interiors.length ? { image_urls: interiors.map((f) => dataUri(f, "image/jpeg")) } : {}),
      aspect_ratio: "16:9",
      resolution: "2K",
      output_format: "jpeg",
      num_images: 1,
      safety_tolerance: "2",
    },
    { signal, timeoutMs: 5 * 60_000 },
  );
  const image = still.images?.[0]?.url;
  if (!image) throw new Error("fal sent no still for the establishing shot.");
  const video = await fal.run<{ video?: { url: string } }>(
    VIDEO_ENDPOINT,
    {
      image_url: image,
      prompt: `${exterior.motion} Ambient exterior sound only: no music, no voices.`,
      duration: String(ESTABLISHING_SECONDS),
      resolution: "720p",
      generate_audio: true,
    },
    { signal, timeoutMs: 15 * 60_000 },
  );
  if (!video.video?.url) throw new Error("fal sent no establishing shot.");
  await save(video.video.url, file, signal);
}
