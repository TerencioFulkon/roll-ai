import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl as awsPresignUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../config/index.js";

function assertR2Configured() {
  const missing = [];
  if (!(config.R2_ACCOUNT_ID || "").trim()) {
    missing.push("R2_ACCOUNT_ID");
  }
  if (!(config.R2_ACCESS_KEY_ID || "").trim()) {
    missing.push("R2_ACCESS_KEY_ID");
  }
  if (!(config.R2_SECRET_ACCESS_KEY || "").trim()) {
    missing.push("R2_SECRET_ACCESS_KEY");
  }
  if (!(config.R2_BUCKET_NAME || "").trim()) {
    missing.push("R2_BUCKET_NAME");
  }
  if (missing.length > 0) {
    throw new Error(`R2 storage is not configured. Set: ${missing.join(", ")}`);
  }
}

function createClient() {
  return new S3Client({
    region: "auto",
    endpoint: `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.R2_ACCESS_KEY_ID,
      secretAccessKey: config.R2_SECRET_ACCESS_KEY
    }
  });
}

/**
 * @param {string} key Object key within the bucket
 * @param {Buffer} buffer
 * @param {string} contentType MIME type
 */
export async function uploadFile(key, buffer, contentType) {
  assertR2Configured();
  const client = createClient();
  await client.send(
    new PutObjectCommand({
      Bucket: config.R2_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: contentType
    })
  );
}

/**
 * @param {string} key Object key within the bucket
 * @returns {Promise<Buffer>}
 */
export async function downloadFile(key) {
  assertR2Configured();
  const client = createClient();
  const result = await client.send(
    new GetObjectCommand({
      Bucket: config.R2_BUCKET_NAME,
      Key: key
    })
  );
  const body = result.Body;
  if (!body) {
    throw new Error(`R2 getObject returned empty body for key ${key}`);
  }
  return Buffer.from(await body.transformToByteArray());
}

/**
 * Presigned GET URL (same role as Supabase signed URLs for private objects).
 * @param {string} key Object key within the bucket
 * @param {number} expiresInSeconds
 */
export async function getSignedUrl(key, expiresInSeconds) {
  assertR2Configured();
  const client = createClient();
  const command = new GetObjectCommand({
    Bucket: config.R2_BUCKET_NAME,
    Key: key
  });
  return awsPresignUrl(client, command, { expiresIn: expiresInSeconds });
}
