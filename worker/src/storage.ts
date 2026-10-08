import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Config } from "./config.js";

// B2 through its S3 API, with the worker's own key (read and write, no delete).

export type Storage = ReturnType<typeof createStorage>;

export function createStorage(config: Config["b2"]) {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.keyId, secretAccessKey: config.appKey },
    forcePathStyle: true,
    // B2 rejects the checksum headers newer AWS SDKs add by default.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  const Bucket = config.bucket;

  return {
    async download(key: string, file: string, signal: AbortSignal) {
      const response = await client.send(new GetObjectCommand({ Bucket, Key: key }), { abortSignal: signal });
      if (!response.Body) throw new Error("B2 sent an empty response.");
      await pipeline(response.Body as Readable, createWriteStream(file), { signal });
    },

    async upload(key: string, file: string, contentType: string, signal: AbortSignal, cacheControl?: string) {
      const upload = new Upload({
        client,
        params: { Bucket, Key: key, Body: createReadStream(file), ContentType: contentType, CacheControl: cacheControl },
        partSize: 16 * 1024 * 1024,
        queueSize: 4,
        // Never ask B2 to delete anything, not even unfinished parts; the
        // bucket's lifecycle rule tidies those up by itself.
        leavePartsOnError: true,
      });
      const abort = () => void upload.abort();
      signal.addEventListener("abort", abort, { once: true });
      try {
        await upload.done();
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },

    /** A link that reads one file for a while (fal fetching a final to make it 4K). Read only. */
    signGet(key: string, seconds: number): Promise<string> {
      return getSignedUrl(client, new GetObjectCommand({ Bucket, Key: key }), { expiresIn: seconds });
    },

    async size(key: string): Promise<number | null> {
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return head.ContentLength ?? null;
      } catch (error) {
        if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
        throw error;
      }
    },
  };
}
