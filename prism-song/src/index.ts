/**
 * Prism Song: a hands-first mixed-reality light puzzle where every solved
 * board plays a chord. See README.md for the design.
 */

import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { GameSystem } from './game-system.js';

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  world.registerSystem(GameSystem);
});
