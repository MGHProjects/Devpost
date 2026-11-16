/**
 * Asset manifest. HANDCAST's bench, light and sound are generated in code and
 * the glass hands are baked from public/models/{left,right}.glb at runtime,
 * so the only manifest asset is the HUD panel.
 */

import { AssetType, defineAssets } from '@iwsdk/core';

const publicAssetUrl = (filePath: string): string =>
  `${import.meta.env.BASE_URL}${filePath.replace(/^\/+/u, '')}`;

export default defineAssets({
  'hud-panel': {
    url: publicAssetUrl('ui/hud.uikitml'),
    type: AssetType.UIKitML,
    name: 'HUD Panel',
  },
});
