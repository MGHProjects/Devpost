/**
 * `?capture`: settings for filming on a headset. The panel stays out of the
 * shot unless the player looks straight at it (so boards can still be picked
 * with the headset on), `board=<id>` or `tour=<1-6>` opens a board directly,
 * and the game's own sound is kept so it can be saved as a WAV afterwards (a
 * headset recording may not capture browser audio).
 */

export interface CaptureOptions {
  board: string | null;
  tour: number | null;
}

export function captureOptions(): CaptureOptions | null {
  if (typeof window === 'undefined') return null;
  const q = new URLSearchParams(window.location.search);
  if (!q.has('capture')) return null;
  const tour = Number(q.get('tour'));
  return {
    board: q.get('board'),
    tour: Number.isInteger(tour) && tour >= 1 && tour <= 6 ? tour - 1 : null,
  };
}

/** Looking within this angle of the panel's centre brings it into view. */
export const CAPTURE_LOOK_DEG = 14;
/** Longest session audio kept for the WAV (s). */
export const CAPTURE_MAX_AUDIO = 600;

/** Offers the session's game audio as a WAV download on the 2D page. */
export function offerAudioDownload(wav: ArrayBuffer, seconds: number): void {
  document.getElementById('hc-capture-audio')?.remove();
  const box = document.createElement('div');
  box.id = 'hc-capture-audio';
  box.style.cssText =
    'position:fixed;left:50%;bottom:110px;transform:translateX(-50%);z-index:30;display:flex;gap:8px;align-items:center;' +
    'background:rgba(6,8,14,0.94);color:#e8ecf5;border:1px solid rgba(143,208,255,0.5);border-radius:999px;padding:8px 10px 8px 16px;' +
    'font:14px system-ui,sans-serif;';
  const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
  const label = document.createElement('span');
  label.textContent = `Game audio, ${Math.round(seconds)} s`;
  const a = document.createElement('a');
  a.href = url;
  a.download = `handcast-audio-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.wav`;
  a.textContent = 'Download .wav';
  a.style.cssText = 'padding:8px 16px;border-radius:999px;border:1px solid #8fd0ff;background:#0c1220;color:#f3f5fa;text-decoration:none;';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close';
  close.style.cssText = 'padding:8px 14px;border-radius:999px;border:1px solid #556;background:transparent;color:#c9d2e3;';
  close.addEventListener('click', () => {
    URL.revokeObjectURL(url);
    box.remove();
  });
  box.append(label, a, close);
  document.body.append(box);
}
