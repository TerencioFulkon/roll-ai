import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import ffprobePath from "ffprobe-static";
import express from "express";
import multer from "multer";
import mime from "mime-types";
import { v4 as uuidv4, validate as uuidValidate } from "uuid";
import { config } from "../config/index.js";
import { uploadFile } from "../providers/r2.js";
import { supabase } from "../supabase.js";
import { DEFAULT_VOICE_KEY, isValidVoiceKey, normalizeVoiceKey } from "../services/ttsService.js";
import { SERVICE_UNAVAILABLE_MESSAGE } from "../lib/errorMessages.js";

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath.path);

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsDir = path.resolve(__dirname, "../tmp-uploads");

const upload = multer({
  dest: uploadsDir,
  limits: {
    fileSize: config.MAX_FILE_SIZE_BYTES
  }
});

router.post("/", (req, res) => {
  fs.mkdir(uploadsDir, { recursive: true })
    .then(() => {
      upload.fields([
        { name: "video", maxCount: 1 },
        { name: "profile_photo", maxCount: 1 }
      ])(req, res, async (uploadError) => {
        if (uploadError?.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({ error: "File is too large. Maximum size is 500MB." });
        }
        if (uploadError) {
          console.error("[upload] multer error:", uploadError);
          return res.status(500).json({ error: SERVICE_UNAVAILABLE_MESSAGE });
        }

        const videoFile = req.files?.video?.[0];
        const profilePhotoFile = req.files?.profile_photo?.[0];
        const participantDescriptor = (req.body?.participant_descriptor || "").trim();
        const rawVoiceKey = (req.body?.voice_key || req.body?.tts_voice_key || DEFAULT_VOICE_KEY || "").trim().toLowerCase();
        const ttsVoiceKey = isValidVoiceKey(rawVoiceKey) ? normalizeVoiceKey(rawVoiceKey) : DEFAULT_VOICE_KEY;

        const rawSessionId = (req.body?.session_id || "").trim();
        /** Optional anonymous correlation token — omit unless valid UUID */
        const sessionId = rawSessionId && uuidValidate(rawSessionId) ? rawSessionId : null;

        let videoTempPath = videoFile?.path || "";
        let photoTempPath = profilePhotoFile?.path || "";

        try {
          if (!videoFile) {
            return res.status(400).json({ error: "No video file uploaded." });
          }

          if (!videoFile.mimetype.startsWith("video/")) {
            return res.status(400).json({ error: "Unsupported file format. Please upload a video." });
          }

          if (profilePhotoFile && !profilePhotoFile.mimetype.startsWith("image/")) {
            return res.status(400).json({ error: "Profile photo must be an image file." });
          }

          if (!participantDescriptor) {
            return res.status(400).json({ error: "Please describe what you are wearing." });
          }

          try {
            const duration = await getVideoDurationSeconds(videoTempPath);
            if (duration > config.MAX_VIDEO_DURATION_SECONDS) {
              return res.status(400).json({
                error: `Video is too long. Maximum duration is ${config.MAX_VIDEO_DURATION_SECONDS} seconds.`
              });
            }
          } catch (durationError) {
            console.error("Duration validation failed, skipping at upload stage:", durationError);
          }

          const jobId = uuidv4();
          const extension = mime.extension(videoFile.mimetype) || "mp4";

          const videoBuffer = await fs.readFile(videoTempPath);
          await fs.rm(videoTempPath, { force: true });
          videoTempPath = "";

          const inputKey = `${jobId}/input.${extension}`;
          await uploadFile(inputKey, videoBuffer, videoFile.mimetype);
          console.log(
            `[upload] job sqlid=${jobId} — input_url stored in DB (R2 object key, must match worker download): ${JSON.stringify(inputKey)}`
          );

          let profilePhotoUrl = null;
          let profilePhotoMimeType = null;

          if (profilePhotoFile) {
            try {
              const photoExt = mime.extension(profilePhotoFile.mimetype) || "jpg";
              const photoKey = `${jobId}/profile.${photoExt}`;
              const photoBuffer = await fs.readFile(photoTempPath);
              await uploadFile(photoKey, photoBuffer, profilePhotoFile.mimetype);
              profilePhotoUrl = photoKey;
              profilePhotoMimeType = profilePhotoFile.mimetype;
            } catch (photoErr) {
              console.error("Profile photo upload failed, continuing without it:", photoErr.message);
            }
          }

          const rawVisionProvider = (req.body?.vision_provider || "").trim().toLowerCase();
          const visionProviderMeta =
            rawVisionProvider === "gemini" || rawVisionProvider === "openai"
              ? { vision_provider: rawVisionProvider }
              : {};

          const insertPayload = {
            sqlid: jobId,
            status: "pending",
            progress: "Queued for processing",
            input_url: inputKey,
            ...(sessionId ? { session_id: sessionId } : {}),
            ...(req.user?.id ? { user_id: req.user.id } : {}),
            metadata: {
              file_name: videoFile.originalname,
              mime_type: videoFile.mimetype,
              file_size: videoFile.size,
              participant_description: participantDescriptor,
              participant_descriptor: participantDescriptor,
              tts_voice_key: ttsVoiceKey,
              ...(profilePhotoUrl && { profile_photo_url: profilePhotoUrl, profile_photo_mime_type: profilePhotoMimeType }),
              ...visionProviderMeta
            }
          };

          const { error: insertError } = await supabase.from("jobs").insert(insertPayload);

          if (insertError) {
            throw new Error(insertError.message);
          }

          return res.status(202).json({ job_id: jobId });
        } catch (error) {
          console.error("[upload] request failed:", error);
          return res.status(500).json({ error: SERVICE_UNAVAILABLE_MESSAGE });
        } finally {
          if (videoTempPath) await fs.rm(videoTempPath, { force: true });
          if (photoTempPath) await fs.rm(photoTempPath, { force: true });
        }
      });
    })
    .catch((error) => {
      console.error("[upload] failed to prepare tmp-uploads directory:", error);
      res.status(500).json({ error: SERVICE_UNAVAILABLE_MESSAGE });
    });
});

function getVideoDurationSeconds(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (error, metadata) => {
      if (error) {
        console.error("ffprobe error while reading video duration:", error);
        reject(error);
        return;
      }

      const duration = metadata?.format?.duration;
      if (typeof duration !== "number" || Number.isNaN(duration)) {
        reject(new Error("Could not read video duration"));
        return;
      }

      resolve(duration);
    });
  });
}

export default router;
