/**
 * The 2D page's way in: a clear "Enter XR" button over the attract demo
 * (IWSDK's offerSession only works in browsers that support it), or a plain
 * note to open the page on a Quest when this browser cannot start an
 * immersive-ar session. Hidden while immersive.
 */

export interface EnterXRButton {
  setImmersive(on: boolean): void;
  dispose(): void;
}

const CSS = `
.hc-enter { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 20;
  display: flex; flex-direction: column; align-items: center; gap: 10px; pointer-events: none;
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; }
.hc-enter button { pointer-events: auto; cursor: pointer; border: 1px solid rgba(201, 214, 242, 0.45);
  background: rgba(10, 14, 24, 0.78); color: #f3f5fa; border-radius: 999px; padding: 14px 34px;
  font-size: 17px; letter-spacing: 0.22em; text-transform: uppercase;
  box-shadow: 0 0 24px rgba(143, 208, 255, 0.25); backdrop-filter: blur(6px); }
.hc-enter button:hover, .hc-enter button:focus-visible { border-color: #8fd0ff; outline: none;
  box-shadow: 0 0 32px rgba(143, 208, 255, 0.45); }
.hc-enter p { margin: 0; padding: 6px 14px; border-radius: 8px; background: rgba(10, 14, 24, 0.6);
  color: #b9c2d6; font-size: 13px; letter-spacing: 0.06em; text-align: center; max-width: 92vw; }
`;

export function createEnterXRButton(launch: () => void): EnterXRButton {
  const style = document.createElement('style');
  style.textContent = CSS;
  const box = document.createElement('div');
  box.className = 'hc-enter';
  const note = document.createElement('p');
  note.textContent = 'Demo. Play seated at a table on Meta Quest, with your hands.';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Enter XR';
  button.addEventListener('click', () => launch());
  box.append(button, note);
  document.head.append(style);
  document.body.append(box);

  const xr = (navigator as Navigator & { xr?: { isSessionSupported(mode: string): Promise<boolean> } }).xr;
  const unsupported = () => {
    button.remove();
    note.textContent = 'Open this page in the Meta Quest Browser to play. Below: a demo of the boards.';
  };
  if (!xr) unsupported();
  else void xr.isSessionSupported('immersive-ar').then((ok) => !ok && unsupported(), unsupported);

  return {
    setImmersive(on) {
      box.style.display = on ? 'none' : 'flex';
    },
    dispose() {
      box.remove();
      style.remove();
    },
  };
}
