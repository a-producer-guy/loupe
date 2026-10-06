import "server-only";
import {
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "@/lib/env";

// Backblaze B2 through its S3-compatible API. The browser never sees the key:
// it asks the app to sign one request at a time (one part of one file), and
// each signed link expires within the hour.

let client: S3Client | undefined;

function s3(): S3Client {
  const { endpoint, region, keyId, appKey } = env.b2;
  return (client ??= new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId: keyId, secretAccessKey: appKey },
    forcePathStyle: true,
    // Newer AWS SDKs add CRC32 checksum headers to every upload, which B2
    // rejects. Only send checksums where S3 itself requires them.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  }));
}

const UPLOAD_LINK_SECONDS = 60 * 60;
// Each download link is made the moment its file starts, and a download already under way isn't
// cut off when its link expires, so an hour is plenty (a leaked link is only good for that hour).
const DOWNLOAD_LINK_SECONDS = 60 * 60;

/** The upload steps a browser may ask us to sign. There is deliberately no delete. */
export type UploadRequest =
  | { method: "PUT"; key: string; uploadId?: undefined; partNumber?: undefined } // whole small file
  | { method: "POST"; key: string; uploadId?: undefined } // start a multipart upload
  | { method: "PUT"; key: string; uploadId: string; partNumber: number } // one part
  | { method: "GET"; key: string; uploadId: string } // list parts already sent, to resume
  | { method: "POST"; key: string; uploadId: string }; // finish a multipart upload

export function signUploadRequest(request: UploadRequest): Promise<string> {
  const Bucket = env.b2.bucket;
  const Key = request.key;
  const options = { expiresIn: UPLOAD_LINK_SECONDS };
  if (request.method === "PUT" && request.uploadId) {
    return getSignedUrl(s3(), new UploadPartCommand({ Bucket, Key, UploadId: request.uploadId, PartNumber: request.partNumber }), options);
  }
  if (request.method === "PUT") return getSignedUrl(s3(), new PutObjectCommand({ Bucket, Key }), options);
  if (request.method === "GET") {
    return getSignedUrl(s3(), new ListPartsCommand({ Bucket, Key, UploadId: request.uploadId, MaxParts: 1000 }), options);
  }
  if (request.uploadId) {
    return getSignedUrl(s3(), new CompleteMultipartUploadCommand({ Bucket, Key, UploadId: request.uploadId }), options);
  }
  return getSignedUrl(s3(), new CreateMultipartUploadCommand({ Bucket, Key }), options);
}

/**
 * A link for showing a still on screen. Signed as of the start of the hour,
 * so the link stays identical for that hour and the browser can cache it.
 * `version` changes the link when the still itself changes (a proxy re-made
 * with a new LUT), so the browser doesn't keep showing the old one.
 */
export function signView(key: string, version?: string): Promise<string> {
  const hour = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
  const disposition = version ? { ResponseContentDisposition: `inline; filename="${version}.jpg"` } : {};
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: env.b2.bucket, Key: key, ...disposition }), {
    expiresIn: 2 * 60 * 60,
    signingDate: hour,
  });
}

export function signDownload(key: string): Promise<string> {
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: env.b2.bucket, Key: key }), {
    expiresIn: DOWNLOAD_LINK_SECONDS,
  });
}

/** Copies a file within the bucket (a LUT into a shoot's folder), unless an identical-size copy is already there. */
export async function copyObject(fromKey: string, toKey: string): Promise<void> {
  const [from, to] = await Promise.all([storedSize(fromKey), storedSize(toKey)]);
  if (from === null || to === from) return;
  const Bucket = env.b2.bucket;
  const source = `${Bucket}/${fromKey.split("/").map(encodeURIComponent).join("/")}`;
  await s3().send(new CopyObjectCommand({ Bucket, Key: toKey, CopySource: source }));
}

/** A small file's contents as text (a LUT being checked), or null if it's missing or too big. */
export async function readText(key: string, maxBytes: number): Promise<string | null> {
  try {
    const response = await s3().send(new GetObjectCommand({ Bucket: env.b2.bucket, Key: key }));
    if (!response.Body || (response.ContentLength ?? 0) > maxBytes) return null;
    return await response.Body.transformToString("utf-8");
  } catch (error) {
    if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}

/** Size of the object in B2, or null if nothing is stored at that key. */
export async function storedSize(key: string): Promise<number | null> {
  try {
    const head = await s3().send(new HeadObjectCommand({ Bucket: env.b2.bucket, Key: key }));
    return head.ContentLength ?? null;
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404) return null;
    throw error;
  }
}
