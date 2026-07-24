// SPDX-License-Identifier: MPL-2.0
/**
 * Colour management for the print formats — the single answer to "what ink does
 * this RGB become", shared by the PDF, EPS and TIFF emitters so all three agree
 * plate-for-plate on the same artwork.
 *
 * Two layers, in priority order:
 *
 *  1. **Ink locks.** A brand swatch whose measured CMYK (and optionally a named
 *     spot) the user has entered. Exact, authoritative, and the whole reason a
 *     print shop can trust the file. Locks reuse the Lolly web shell's palette
 *     machinery verbatim (buildCmykPaletteMap / assignSpotResourceNames), so a
 *     lock set here behaves identically to one set in Lolly itself.
 *  2. **Device conversion.** Anything unlocked falls through to the engine's
 *     rgbToCmyk — a naïve, GCR-free device separation.
 *
 * What this is NOT: a colour-managed transform. rgbToCmyk does not consult the
 * selected press condition, does no black generation, no gamut mapping, and no
 * ICC maths. The condition is *declared* in the PDF's OutputIntent (telling a RIP
 * what the numbers are meant to mean) but never *applied*. Locked swatches are
 * exact because the user measured them; everything else is an approximation, and
 * the UI says so. A real CMM (littleCMS/wasm) would slot in behind `resolve()`
 * without any emitter changing — that is the point of this seam.
 */
import { rgbToCmyk, CMYK_CONDITIONS, DEFAULT_CMYK_CONDITION } from '@engine/color.ts';
import {
  buildCmykPaletteMap,
  assignSpotResourceNames,
  cmykKey,
  paletteHitKey,
  type BrandPaletteEntry,
  type PaletteHit,
} from '@bridge/export-pdf-vector.ts';

export type ColorMode = 'rgb' | 'cmyk';
export type Cmyk4 = [number, number, number, number];

/**
 * A user-entered brand ink lock. `cmyk` is 0–100 (the numbers a print shop
 * quotes); `spot` names a separation plate. The two are independent: a swatch
 * may lock process values, a spot, or both — a spot with no explicit process
 * build derives one from its own hex for the tint transform's alternate space.
 */
export type InkLock = BrandPaletteEntry;

/** Press conditions offered in the UI (the engine's registered set). */
export const PRESS_CONDITIONS: ReadonlyArray<{ id: string; label: string }> =
  Object.entries(CMYK_CONDITIONS).map(([id, c]) => ({ id, label: c.info }));

export const DEFAULT_CONDITION = DEFAULT_CMYK_CONDITION;

/**
 * All four plates at full ink. Crop, bleed and registration marks print in this
 * so they appear on every separation — the whole point of a registration mark.
 * The RGB path can only approximate it as black (see pdf-emit's markOps).
 */
export const REGISTRATION: Cmyk4 = [1, 1, 1, 1];

/** Black-only ink, for rules and provenance text that must not print 4-colour. */
export const BLACK_ONLY: Cmyk4 = [0, 0, 0, 1];

/** A resolved ink: process values always, plus a spot plate name when locked. */
export interface ResolvedInk {
  cmyk: Cmyk4;
  /** Set only when this colour is locked to a named separation. */
  spot?: string;
}

/**
 * Resolves RGB to ink for one export. Stateful on purpose: it records which
 * locks and which spot plates were actually hit, so the PDF only materialises
 * /Separation objects for spots the artwork really uses and the verification
 * colour bar only shows swatches that genuinely substituted.
 */
export class Separator {
  readonly mode: ColorMode;
  readonly paletteMap: Map<string, PaletteHit>;
  readonly spotNames: Map<string, string>;
  /** Spot plate names referenced by the emitted content. */
  readonly usedSpots = new Set<string>();
  /** Quantised palette keys that matched, for filtering the colour bar. */
  readonly usedKeys = new Set<string>();

  constructor(mode: ColorMode, locks: readonly InkLock[] = []) {
    this.mode = mode;
    this.paletteMap = buildCmykPaletteMap(locks as InkLock[]);
    this.spotNames = assignSpotResourceNames(this.paletteMap);
  }

  /** True when emitters should write ink operators rather than RGB. */
  get cmyk(): boolean {
    return this.mode === 'cmyk';
  }

  /** Whether any lock in this run carries a spot plate. */
  get hasSpots(): boolean {
    return this.spotNames.size > 0;
  }

  /**
   * RGB (0–1) → ink. A locked swatch returns its measured values (and spot, if
   * any); everything else falls through to the engine's device conversion.
   */
  resolve(r: number, g: number, b: number): ResolvedInk {
    const key = cmykKey(r, g, b);
    const hit = this.paletteMap.get(key);
    if (!hit) return { cmyk: rgbToCmyk(r, g, b) };
    this.usedKeys.add(key);
    if (hit.spot) {
      this.usedSpots.add(hit.spot.name);
      return { cmyk: hit.cmyk, spot: hit.spot.name };
    }
    return { cmyk: hit.cmyk };
  }

  /** The PDF resource name (/CS1, /CS2, …) for a spot plate. */
  spotResource(name: string): string | undefined {
    return this.spotNames.get(name);
  }

  /** The CMYK equivalent a spot's tint transform ramps to at full tint. */
  spotCmyk(name: string): Cmyk4 | undefined {
    for (const hit of this.paletteMap.values()) {
      if (hit.spot?.name === name) return hit.spot.cmyk;
    }
    return undefined;
  }

  /** The subset of `locks` that actually substituted during this export. */
  usedLocks(locks: readonly InkLock[]): InkLock[] {
    return locks.filter((l) => {
      const k = paletteHitKey(l);
      return k != null && this.usedKeys.has(k);
    });
  }
}

// ─── ink-lock persistence ─────────────────────────────────────────────────────

const STORE_KEY = 'lolly-penpot-export:ink-locks:v1';

/**
 * Ink locks are per-machine, not per-document: Penpot's library colours carry a
 * hex and nothing else, so the measured values have to live somewhere the plugin
 * owns. Keyed by hex so a lock follows the colour across boards and files.
 */
export function loadInkLocks(): InkLock[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is InkLock => !!e && typeof (e as InkLock).hex === 'string');
  } catch {
    return []; // corrupt or storage-denied — locks are an enhancement, never fatal
  }
}

export function saveInkLocks(locks: readonly InkLock[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(locks));
  } catch {
    /* private mode / quota — the export still works, the locks just don't persist */
  }
}

/**
 * Merge stored locks onto the colours found in this board, preserving board
 * order so the editor lists what the user is actually looking at. Colours with
 * no stored lock appear unlocked (hex only), ready to be filled in.
 */
export function locksForPalette(hexes: readonly string[], stored: readonly InkLock[]): InkLock[] {
  const byHex = new Map(stored.map((l) => [(l.hex ?? '').toLowerCase(), l]));
  return hexes.map((hex) => byHex.get(hex.toLowerCase()) ?? { hex });
}

/** True when a lock carries something worth persisting (values or a spot). */
export function isLocked(l: InkLock): boolean {
  return (Array.isArray(l.cmyk) && l.cmyk.length === 4) || !!l.spot?.name;
}
