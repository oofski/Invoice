import { useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useFlow } from "../lib/flow";
import { AppHeader } from "../components/AppHeader";
import { OfflineBanner } from "../components/OfflineBanner";
import { Button } from "../components/Button";

/**
 * Camera capture (`/capture`). A hidden `<input type="file" accept="image/*"
 * capture="environment">` opens the rear camera on device (falls back to a file
 * picker on desktop). Preview the chosen image, then Retake / Use photo.
 */
export function CaptureScreen() {
  const navigate = useNavigate();
  const { file, previewUrl, setFile } = useFlow();
  const inputRef = useRef<HTMLInputElement>(null);

  function openCamera() {
    inputRef.current?.click();
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0];
    if (picked) setFile(picked);
    // Allow re-selecting the same file (Retake of an identical shot).
    e.target.value = "";
  }

  return (
    <div className="screen">
      <OfflineBanner />
      <AppHeader subtitle="Snap a receipt" />

      <main className="capture-main">
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={onPick}
          className="visually-hidden"
        />

        {previewUrl ? (
          <figure className="preview">
            <img src={previewUrl} alt="Receipt preview" className="preview-img" />
          </figure>
        ) : (
          <button type="button" className="capture-target" onClick={openCamera}>
            <span className="capture-icon" aria-hidden="true">📷</span>
            <span className="capture-text">Tap to take a photo</span>
            <span className="capture-hint">
              Point at the receipt — make sure the total is readable.
            </span>
          </button>
        )}
      </main>

      <div className="bottom-bar bottom-bar-stack">
        {previewUrl ? (
          <>
            <Button onClick={() => navigate("/review")} disabled={!file}>
              Use photo
            </Button>
            <Button variant="secondary" onClick={openCamera}>
              Retake
            </Button>
          </>
        ) : (
          <>
            <Button onClick={openCamera}>Open camera</Button>
            <Button variant="ghost" onClick={() => navigate("/home")}>
              Cancel
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
