import React from 'react';
import { Composition, continueRender, delayRender, registerRoot, staticFile } from 'remotion';
import { Trailer } from './Trailer';
import { DURATION_S, FPS, H, W } from './timing';

// Two faces only: Inter Display for display type, Inter for UI text (local OTF files).
const FONTS: [string, string, string][] = [
  ['InterDisplay', 'fonts/display-600.otf', '600'],
  ['InterDisplay', 'fonts/display-700.otf', '700'],
  ['InterUI', 'fonts/ui-500.otf', '500'],
  ['InterUI', 'fonts/ui-600.otf', '600'],
];
const fontHandle = delayRender('fonts');
Promise.all(
  FONTS.map(async ([family, file, weight]) => {
    const face = new FontFace(family, `url(${staticFile(file)})`, { weight });
    await face.load();
    (document.fonts as unknown as { add: (f: FontFace) => void }).add(face);
  }),
).then(() => continueRender(fontHandle));

const Root: React.FC = () => (
  <Composition id="Trailer" component={Trailer} durationInFrames={DURATION_S * FPS} fps={FPS} width={W} height={H} />
);

registerRoot(Root);
