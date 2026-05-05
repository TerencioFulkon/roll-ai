import { useEffect, useState } from "react";

/**
 * Generate a client-side thumbnail from a video `File`.
 *
 * Renders a single frame at 5 seconds (or the midpoint for clips shorter
 * than that) onto a `<canvas>` and returns the result as a JPEG blob URL
 * suitable for an `<img src=>`. Mirrors the server-side thumbnail logic in
 * `backend/jobs/processVideo.js` so the uploader preview and the final
 * roll card show the same frame.
 *
 * Returns `null` while loading or if extraction fails (codec unsupported,
 * seek timeout, canvas taint, etc.) — the caller should render nothing
 * in that case rather than a placeholder.
 *
 * @param {File | null | undefined} file
 * @returns {string | null}
 */
export function useVideoThumbnail(file) {
  const [thumbnailUrl, setThumbnailUrl] = useState(/** @type {string | null} */ (null));

  useEffect(() => {
    setThumbnailUrl(null);
    if (!file) return undefined;

    let cancelled = false;
    let createdBlobUrl = /** @type {string | null} */ (null);

    const videoObjectUrl = URL.createObjectURL(file);
    const video = document.createElement("video");
    // `preload="auto"` is required on Safari to actually buffer frames;
    // `"metadata"` alone won't let `drawImage` paint anything.
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;

    const releaseVideo = () => {
      video.removeAttribute("src");
      try {
        video.load();
      } catch {
        // noop — element may already be detached
      }
      URL.revokeObjectURL(videoObjectUrl);
    };

    // Bail out if the browser never fires `seeked` (happens on some mobile
    // Safari builds with large files). Without this, the effect leaks an
    // attached <video> until the component unmounts.
    const timeoutId = setTimeout(() => {
      if (!cancelled) releaseVideo();
    }, 8000);

    const capture = () => {
      clearTimeout(timeoutId);
      if (cancelled) return;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx || !canvas.width || !canvas.height) {
          releaseVideo();
          return;
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(
          (blob) => {
            if (cancelled || !blob) {
              releaseVideo();
              return;
            }
            createdBlobUrl = URL.createObjectURL(blob);
            setThumbnailUrl(createdBlobUrl);
            releaseVideo();
          },
          "image/jpeg",
          0.85
        );
      } catch {
        releaseVideo();
      }
    };

    const handleLoadedMetadata = () => {
      if (cancelled) return;
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      video.currentTime = duration >= 5 ? 5 : Math.max(0, duration * 0.5);
    };

    const handleError = () => {
      clearTimeout(timeoutId);
      releaseVideo();
    };

    video.addEventListener("loadedmetadata", handleLoadedMetadata);
    video.addEventListener("seeked", capture, { once: true });
    video.addEventListener("error", handleError);

    video.src = videoObjectUrl;

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
      video.removeEventListener("loadedmetadata", handleLoadedMetadata);
      video.removeEventListener("error", handleError);
      releaseVideo();
      if (createdBlobUrl) URL.revokeObjectURL(createdBlobUrl);
    };
  }, [file]);

  return thumbnailUrl;
}
