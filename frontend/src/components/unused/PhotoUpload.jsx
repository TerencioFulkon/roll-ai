/**
 * UNUSED — moved out of the active upload flow.
 * To restore: re-add the "photo" step to the upload flow in App.jsx and
 * wire up the props listed below.
 */
import { cn } from "@/lib/utils";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Native file input hidden; dashed zone + filename. */
function FileDropZone({ id, accept, disabled, fileName, inputRef, labelledBy, onChange }) {
  return (
    <div className="flex flex-col gap-2">
      <input
        ref={inputRef}
        id={id}
        type="file"
        accept={accept}
        className="peer sr-only"
        disabled={disabled}
        aria-labelledby={labelledBy}
        onChange={onChange}
      />
      <label
        htmlFor={id}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border/70 bg-muted/15 px-8 py-12 shadow-sm transition-all duration-300 ease-out outline-none",
          "hover:-translate-y-0.5 hover:scale-[1.02] hover:border-muted-foreground/35 hover:bg-muted/30 hover:shadow-md",
          "peer-focus-visible:border-border peer-focus-visible:shadow-md peer-focus-visible:ring-1 peer-focus-visible:ring-primary/25",
          disabled && "pointer-events-none opacity-50"
        )}
      >
        <Upload className="size-6 shrink-0 text-muted-foreground" aria-hidden />
        <span className="text-base font-medium text-foreground">Tap to select</span>
      </label>
      {fileName ? (
        <p className="truncate text-center text-sm text-muted-foreground" title={fileName}>
          {fileName}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Photo upload step — previously step 3 of the upload flow.
 *
 * Props:
 *   isUploading:            boolean
 *   profilePhoto:           File | null
 *   profilePhotoInputRef:   React.RefObject
 *   onProfilePhotoChange:   (event: React.ChangeEvent<HTMLInputElement>) => void
 *   onBack:                 () => void
 *   onContinue:             () => void   — advances to next step (keeping photo)
 *   onSkip:                 () => void   — clears photo and advances
 */
export function PhotoUpload({
  isUploading,
  profilePhoto,
  profilePhotoInputRef,
  onProfilePhotoChange,
  onBack,
  onContinue,
  onSkip
}) {
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
        <p id="profile_photo_label" className="rollai-label m-0">
          Your photo{" "}
          <span className="rollai-label-optional">(optional — helps the AI identify you)</span>
        </p>
        <div className="mt-3">
          <FileDropZone
            id="profile_photo"
            accept="image/*"
            disabled={isUploading}
            fileName={profilePhoto?.name ?? null}
            inputRef={profilePhotoInputRef}
            labelledBy="profile_photo_label"
            onChange={onProfilePhotoChange}
          />
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <Button type="button" onClick={onContinue} className={stepPrimaryButtonClass}>
          Continue
        </Button>
        <button
          type="button"
          onClick={onSkip}
          className="mx-auto inline-flex w-fit items-center rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-primary/25"
        >
          Skip
        </button>
      </div>
    </div>
  );
}
