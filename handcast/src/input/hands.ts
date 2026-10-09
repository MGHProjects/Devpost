/**
 * Direct hand input from WebXR hand-tracking joints: pinch with hysteresis,
 * pinch point, and wrist "twist" around the board's up axis. This is what
 * makes pieces feel like physical objects you pick up and turn between
 * finger and thumb, rather than things you point at.
 */

import { Matrix4, Quaternion, Vector3 } from '@iwsdk/core';

const PINCH_ON = 0.018;
const PINCH_OFF = 0.032;

export interface HandState {
  handedness: 'left' | 'right';
  tracked: boolean;
  pinching: boolean;
  pinchStarted: boolean;
  pinchEnded: boolean;
  /** World-space midpoint between thumb and index tips. */
  point: Vector3;
  /** World-space index finger tip. */
  indexTip: Vector3;
  /** World-space wrist orientation. */
  wrist: Quaternion;
  /** How closed the pinch is, 0 (open) .. 1 (touching). */
  strength: number;
}

const makeState = (handedness: 'left' | 'right'): HandState => ({
  handedness,
  tracked: false,
  pinching: false,
  pinchStarted: false,
  pinchEnded: false,
  point: new Vector3(),
  indexTip: new Vector3(),
  wrist: new Quaternion(),
  strength: 0,
});

export class HandTracker {
  readonly left = makeState('left');
  readonly right = makeState('right');
  readonly hands = [this.left, this.right];

  private thumb = new Vector3();
  private wristPos = new Vector3();
  private m = new Matrix4();
  private q = new Quaternion();
  private s = new Vector3();

  /**
   * Sample joints for this frame. `origin` is the XR origin's world matrix,
   * because joint poses are reported in the session's reference space.
   */
  update(frame: XRFrame | null | undefined, refSpace: XRReferenceSpace | null, origin: Matrix4): void {
    for (const h of this.hands) {
      h.pinchStarted = false;
      h.pinchEnded = false;
    }
    const seen = { left: false, right: false };
    if (frame && refSpace && frame.session) {
      for (const source of frame.session.inputSources) {
        const hand = source.hand;
        if (!hand || (source.handedness !== 'left' && source.handedness !== 'right')) continue;
        if (seen[source.handedness]) continue;
        const state = source.handedness === 'left' ? this.left : this.right;
        if (this.sample(frame, refSpace, origin, hand, state)) seen[source.handedness] = true;
      }
    }
    for (const h of this.hands) {
      if (!seen[h.handedness]) {
        if (h.pinching) h.pinchEnded = true;
        h.pinching = false;
        h.tracked = false;
        h.strength = 0;
      }
    }
  }

  private jointPosition(
    frame: XRFrame,
    refSpace: XRReferenceSpace,
    origin: Matrix4,
    space: XRJointSpace | undefined,
    out: Vector3,
    outQuat?: Quaternion,
  ): boolean {
    if (!space || !frame.getJointPose) return false;
    const pose = frame.getJointPose(space, refSpace);
    if (!pose) return false;
    this.m.fromArray(pose.transform.matrix).premultiply(origin);
    this.m.decompose(out, outQuat ?? this.q, this.s);
    return true;
  }

  private sample(
    frame: XRFrame,
    refSpace: XRReferenceSpace,
    origin: Matrix4,
    hand: XRHand,
    h: HandState,
  ): boolean {
    const okIndex = this.jointPosition(frame, refSpace, origin, hand.get('index-finger-tip'), h.indexTip);
    const okThumb = this.jointPosition(frame, refSpace, origin, hand.get('thumb-tip'), this.thumb);
    const okWrist = this.jointPosition(frame, refSpace, origin, hand.get('wrist'), this.wristPos, h.wrist);
    if (!okIndex || !okThumb || !okWrist) return false;
    h.tracked = true;
    const d = h.indexTip.distanceTo(this.thumb);
    h.strength = Math.min(1, Math.max(0, (PINCH_OFF + 0.02 - d) / (PINCH_OFF + 0.02 - PINCH_ON)));
    h.point.addVectors(h.indexTip, this.thumb).multiplyScalar(0.5);
    if (!h.pinching && d < PINCH_ON) {
      h.pinching = true;
      h.pinchStarted = true;
    } else if (h.pinching && d > PINCH_OFF) {
      h.pinching = false;
      h.pinchEnded = true;
    }
    return true;
  }
}

const tmpAxis = new Vector3();
const tmpRel = new Quaternion();

/**
 * Signed rotation (radians) of `now` relative to `start` around `axis`
 * (swing-twist decomposition), i.e. how far the wrist has turned a knob.
 */
export function twistAngle(start: Quaternion, now: Quaternion, axis: Vector3): number {
  tmpRel.copy(start).invert().premultiply(now); // now * start^-1
  tmpAxis.set(tmpRel.x, tmpRel.y, tmpRel.z);
  const proj = tmpAxis.dot(axis);
  return 2 * Math.atan2(proj, tmpRel.w);
}
