/**
 * UNUSED — moved out of the active upload flow.
 * To restore: re-add the "voice" step to the upload flow in App.jsx and
 * wire up the props listed below.
 */
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { fetchVoices } from "@/api";

const DEFAULT_VOICE_KEY = "jordan";
const FALLBACK_VOICES = [{ key: DEFAULT_VOICE_KEY, name: "Jordan", gender: "male" }];

/**
 * Voice selector step — previously step 4 of the upload flow.
 * Manages its own voice-fetching state internally.
 *
 * Props:
 *   file:                   File | null
 *   participantDescriptor:  string
 *   isUploading:            boolean
 *   onBack:                 () => void
 *   onUpload:               (voiceKey: string) => void
 */
export function VoiceSelector({ file, participantDescriptor, isUploading, onBack, onUpload }) {
  const [voiceKey, setVoiceKey] = useState(DEFAULT_VOICE_KEY);
  const [voicesStatus, setVoicesStatus] = useState("loading");
  const [voices, setVoices] = useState([]);

  useEffect(() => {
    let cancelled = false;

    const loadVoices = async () => {
      setVoicesStatus("loading");
      try {
        const list = await fetchVoices();
        if (!cancelled) {
          if (Array.isArray(list) && list.length > 0) {
            setVoices(list);
            setVoicesStatus("ready");
          } else {
            setVoicesStatus("error");
          }
        }
      } catch {
        if (!cancelled) setVoicesStatus("error");
      }
    };

    loadVoices();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (voicesStatus !== "ready" || !voices.length) return;
    if (!voices.some((v) => v.key === voiceKey)) {
      setVoiceKey(voices[0].key);
    }
  }, [voicesStatus, voices, voiceKey]);

  const maleVoices = useMemo(
    () =>
      [...voices]
        .filter((v) => v.gender?.toLowerCase() === "male")
        .sort((a, b) => a.name.localeCompare(b.name)),
    [voices]
  );

  const femaleVoices = useMemo(
    () =>
      [...voices]
        .filter((v) => v.gender?.toLowerCase() === "female")
        .sort((a, b) => a.name.localeCompare(b.name)),
    [voices]
  );

  const stepPrimaryButtonClass =
    "h-auto w-full rounded-lg bg-primary px-6 py-3 text-base font-semibold text-primary-foreground shadow-sm transition-all duration-300 hover:scale-[1.02] hover:bg-primary/92 hover:shadow-md focus-visible:ring-1 focus-visible:ring-primary/25 disabled:opacity-50 disabled:hover:scale-100";

  return (
    <div className="flex flex-col gap-6">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex w-fit items-center gap-1 rounded-lg text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-primary/25"
      >
        Back
      </button>
      <div>
        <label htmlFor="voice_key" className="rollai-label">
          Voice
        </label>
        <select
          id="voice_key"
          className={cn("rollai-voice-select mt-3 rounded-lg")}
          aria-busy={voicesStatus === "loading"}
          value={voicesStatus === "loading" ? "__loading__" : voiceKey}
          onChange={(event) => setVoiceKey(event.target.value)}
          disabled={voicesStatus === "loading"}
        >
          {voicesStatus === "loading" ? (
            <option disabled value="__loading__">
              Loading voices...
            </option>
          ) : null}
          {voicesStatus === "error" ? (
            <>
              <option disabled value="">
                Failed to load voices
              </option>
              {FALLBACK_VOICES.map((v) => (
                <option key={v.key} value={v.key}>
                  {v.name}
                </option>
              ))}
            </>
          ) : null}
          {voicesStatus === "ready" ? (
            <>
              {maleVoices.length > 0 ? (
                <optgroup label="Male Voices">
                  {maleVoices.map((v) => (
                    <option key={v.key} value={v.key}>
                      {v.name}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {femaleVoices.length > 0 ? (
                <optgroup label="Female Voices">
                  {femaleVoices.map((v) => (
                    <option key={v.key} value={v.key}>
                      {v.name}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </>
          ) : null}
        </select>
      </div>
      <Button
        type="button"
        onClick={() => onUpload(voiceKey)}
        disabled={!file || !participantDescriptor.trim() || isUploading}
        className={stepPrimaryButtonClass}
      >
        {isUploading ? "Uploading..." : "Upload roll"}
      </Button>
    </div>
  );
}
