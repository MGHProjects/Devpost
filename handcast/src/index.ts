/**
 * HANDCAST: a hands-first mixed-reality puzzle where your own hand, frozen
 * into glass, is the only optic. See README.md for the design.
 */

import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { HandcastSystem } from './hc/game-system.js';

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  world.registerSystem(HandcastSystem);
});
