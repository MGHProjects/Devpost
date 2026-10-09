/**
 * Persistent spatial anchor for the puzzle table. On Quest the board stays
 * where you last put it in your room across sessions; elsewhere (or if the
 * runtime refuses) everything silently falls back to head-relative placement.
 */

import { Matrix4, Quaternion, Vector3 } from '@iwsdk/core';

const KEY = 'handcast/anchor/v1';

export class TableAnchor {
  private anchor: XRAnchor | null = null;
  private pendingCreate: { pos: Vector3; quat: Quaternion } | null = null;
  private busy = false;
  private m = new Matrix4();
  private inv = new Matrix4();
  private s = new Vector3();

  /** Try to restore last session's anchor. Resolves true when found. */
  async restore(session: XRSession | undefined): Promise<boolean> {
    let uuid: string | null = null;
    try {
      uuid = localStorage.getItem(KEY);
    } catch {
      return false;
    }
    if (!uuid || !session?.restorePersistentAnchor) return false;
    try {
      this.anchor = await session.restorePersistentAnchor(uuid);
      return true;
    } catch {
      return false;
    }
  }

  /** Queue a new anchor at a world pose; created on the next XR frame. */
  requestAt(pos: Vector3, quat: Quaternion): void {
    this.pendingCreate = { pos: pos.clone(), quat: quat.clone() };
  }

  /**
   * Per-frame: create queued anchors, and write the tracked anchor pose into
   * `outPos`/`outQuat` (world space). Returns true when a pose was written.
   */
  update(
    frame: XRFrame | null | undefined,
    refSpace: XRReferenceSpace | null,
    origin: Matrix4,
    outPos: Vector3,
    outQuat: Quaternion,
  ): boolean {
    if (!frame || !refSpace) return false;
    if (this.pendingCreate && !this.busy && frame.createAnchor) {
      const { pos, quat } = this.pendingCreate;
      this.pendingCreate = null;
      // World -> reference space.
      this.inv.copy(origin).invert();
      this.m.compose(pos, quat, this.s.set(1, 1, 1)).premultiply(this.inv);
      const lp = new Vector3();
      const lq = new Quaternion();
      this.m.decompose(lp, lq, this.s);
      const transform = new XRRigidTransform(
        { x: lp.x, y: lp.y, z: lp.z },
        { x: lq.x, y: lq.y, z: lq.z, w: lq.w },
      );
      this.busy = true;
      const previous = this.anchor;
      frame
        .createAnchor(transform, refSpace)
        ?.then(async (anchor) => {
          this.anchor = anchor;
          previous?.delete?.();
          if (anchor.requestPersistentHandle) {
            const uuid = await anchor.requestPersistentHandle();
            try {
              const old = localStorage.getItem(KEY);
              if (old && old !== uuid) void frame.session.deletePersistentAnchor?.(old).catch(() => {});
              localStorage.setItem(KEY, uuid);
            } catch {
              // Storage unavailable: the anchor still works for this session.
            }
          }
        })
        .catch(() => {})
        .finally(() => {
          this.busy = false;
        });
    }
    if (!this.anchor) return false;
    let pose: XRPose | undefined;
    try {
      pose = frame.getPose(this.anchor.anchorSpace, refSpace);
    } catch {
      return false;
    }
    if (!pose) return false;
    this.m.fromArray(pose.transform.matrix).premultiply(origin);
    this.m.decompose(outPos, outQuat, this.s);
    return true;
  }

  /** Forget the current anchor (e.g. after the session ends). */
  reset(): void {
    this.anchor = null;
    this.pendingCreate = null;
  }
}
