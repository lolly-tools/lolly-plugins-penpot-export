// SPDX-License-Identifier: MPL-2.0
/**
 * Panel UI. Talks to the sandbox side (src/plugin.ts) over postMessage,
 * renders the current selection, and drives the conversion pipeline.
 */
import type { PluginToUi, UiToPlugin, ShapeInfo, Theme } from '../messages.ts';
import { convert, installFontCss, type OutputFormat } from './convert.ts';
import { HDR_DIAL_DEFAULTS } from './raster.ts';
import { UNITS, parseDimension, toUnit, type Unit } from '@engine/units.ts';
import { isEmbedded, installDemoHost } from './demo.ts';
import {
  PRESS_CONDITIONS, DEFAULT_CONDITION, loadInkLocks, saveInkLocks, locksForPalette, isLocked,
  type ColorMode, type InkLock,
} from './cmyk.ts';
import { extractSvgPalette } from './protect.ts';

const app = document.getElementById('app')!;

// ─── state ────────────────────────────────────────────────────────────────────

let selection: ShapeInfo[] = [];
let targetId: string | null = null;
let busy = false;
let requestSeq = 0;
const pending = new Map<number, { resolve: (m: Extract<PluginToUi, { type: 'svg-data' }>) => void; reject: (e: Error) => void }>();

function sendToPlugin(msg: UiToPlugin): void {
  window.parent.postMessage(msg, '*');
}

function requestSvg(shapeId: string): Promise<Extract<PluginToUi, { type: 'svg-data' }>> {
  const requestId = ++requestSeq;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    sendToPlugin({ type: 'export-svg', requestId, shapeId });
    setTimeout(() => {
      if (pending.delete(requestId)) reject(new Error('Penpot did not answer in time — try re-selecting the board.'));
    }, 60_000);
  });
}

window.addEventListener('message', (event: MessageEvent<PluginToUi>) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object' || !('type' in msg)) return;
  switch (msg.type) {
    case 'init':
      applyTheme(msg.theme);
      selection = msg.selection;
      render();
      break;
    case 'selection':
      selection = msg.selection;
      render();
      break;
    case 'theme':
      applyTheme(msg.theme);
      break;
    case 'svg-data':
      pending.get(msg.requestId)?.resolve(msg);
      pending.delete(msg.requestId);
      break;
    case 'error': {
      pending.get(msg.requestId)?.reject(new Error(msg.message));
      pending.delete(msg.requestId);
      break;
    }
  }
});

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

// Theme arrives via the iframe URL before the first message round-trip.
applyTheme(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark');

// ─── formats ──────────────────────────────────────────────────────────────────

interface FormatDef {
  id: OutputFormat;
  label: string;
  hint: string;
}

const FORMATS: FormatDef[] = [
  { id: 'pdf', label: 'Print PDF', hint: 'CMYK, physical size, bleed, crop marks, PDF/X-4' },
  { id: 'pdf-screen', label: 'Screen PDF', hint: 'RGB, page = artwork — for sharing' },
  { id: 'svg', label: 'SVG', hint: 'Penpot vectors with the fonts embedded' },
  { id: 'eps', label: 'EPS', hint: 'PostScript for print + legacy tools' },
  { id: 'emf', label: 'EMF', hint: 'Windows metafile — pastes as vectors into Office' },
  { id: 'dxf', label: 'DXF', hint: 'CAD / laser-cutter outlines (paths only)' },
  { id: 'tiff', label: 'CMYK TIFF', hint: 'Flat DeviceCMYK raster for placement' },
  { id: 'png', label: 'PNG', hint: 'True DPI via pHYs chunk' },
  { id: 'jpeg', label: 'JPEG', hint: 'True DPI, white background' },
  { id: 'webp', label: 'WebP', hint: 'Small web raster' },
];

// ─── view ─────────────────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

function currentTarget(): ShapeInfo | null {
  return selection.find((s) => s.id === targetId) ?? selection[0] ?? null;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'board';
}

interface FormState {
  format: OutputFormat;
  unit: Unit;
  width: string;
  height: string;
  dpi: string;
  bleed: string;
  crop: boolean;
  registration: boolean;
  colorBars: boolean;
  pdfx: boolean;
  // colour management (pdf/eps/tiff) — the mode is remembered per format, so
  // choosing RGB for an EPS doesn't quietly change what a Print PDF exports.
  colorModes: Partial<Record<OutputFormat, ColorMode>>;
  condition: string;
  /** Uploaded destination ICC — press profiles can't ship with the plugin. */
  destProfile: Uint8Array | null;
  destProfileName: string;
  // content protection
  c2pa: boolean;
  imprint: boolean;
  creator: string;
  copyright: string;
  // HDR (png/jpeg)
  hdr: boolean;
  hdrPeak: string;
  hdrReach: string;
  hdrLift: string;
  hdrFocus: string;
}

const form: FormState = {
  format: 'pdf',
  unit: 'px',
  width: '',
  height: '',
  dpi: '300',
  bleed: '3',
  crop: true,
  registration: false,
  colorBars: false,
  pdfx: false,
  colorModes: {},
  condition: DEFAULT_CONDITION,
  destProfile: null,
  destProfileName: '',
  c2pa: true,
  imprint: true,
  creator: '',
  copyright: '',
  hdr: false,
  hdrPeak: String(HDR_DIAL_DEFAULTS.peakNits),
  hdrReach: String(HDR_DIAL_DEFAULTS.reach),
  hdrLift: String(HDR_DIAL_DEFAULTS.lift),
  hdrFocus: String(HDR_DIAL_DEFAULTS.richness),
};

/**
 * Ink locks persist across sessions (a brand's measured values don't change),
 * while the board's colour list is scanned on demand — extracting it needs the
 * board's SVG, which is a round-trip to Penpot we shouldn't spend on every
 * selection change.
 */
let inkLocks: InkLock[] = loadInkLocks();
let boardColors: string[] = [];
let scanning = false;

/** Merge an edited row back into the persisted set, keyed by hex. */
function updateLock(hex: string, patch: Partial<InkLock>): void {
  const i = inkLocks.findIndex((l) => (l.hex ?? '').toLowerCase() === hex.toLowerCase());
  const merged: InkLock = { ...(i >= 0 ? inkLocks[i] : { hex }), ...patch, hex };
  if (i >= 0) inkLocks[i] = merged;
  else inkLocks.push(merged);
  // Drop rows the user has cleared, so the store doesn't fill with empty hexes.
  inkLocks = inkLocks.filter(isLocked);
  saveInkLocks(inkLocks);
}

/**
 * Where each format starts. Print PDF is a press deliverable, so it opens in
 * CMYK — an RGB default quietly hands a printer the wrong file, and the failure
 * only shows up on press. CMYK TIFF is CMYK by definition. EPS stays RGB: it's
 * as often a vector interchange format as a press one, and its CMYK mode is one
 * click away. Screen PDF never shows the control at all.
 */
const DEFAULT_COLOR_MODE: Partial<Record<OutputFormat, ColorMode>> = {
  pdf: 'cmyk',
  tiff: 'cmyk',
  eps: 'rgb',
};

/** The colour mode in force for the selected format. */
function colorMode(): ColorMode {
  return form.colorModes[form.format] ?? DEFAULT_COLOR_MODE[form.format] ?? 'rgb';
}

let statusText = '';
let statusKind: 'idle' | 'busy' | 'error' | 'ok' = 'idle';

function setStatus(text: string, kind: typeof statusKind): void {
  statusText = text;
  statusKind = kind;
  render();
}

/** Re-derive width/height fields from the target's px size in `unit`. */
function syncSizeFields(): void {
  const t = currentTarget();
  if (!t) return;
  const w = parseDimension(t.width, 'px');
  const h = parseDimension(t.height, 'px');
  if (!w || !h) return;
  const round = (v: number): string => String(Math.round(v * 100) / 100);
  form.width = round(toUnit(w, form.unit));
  form.height = round(toUnit(h, form.unit));
}

let lastSyncedId: string | null = null;

function render(): void {
  const t = currentTarget();
  app.replaceChildren();
  if (t && t.id !== lastSyncedId) {
    lastSyncedId = t.id;
    syncSizeFields();
  }

  const list = el('div', { class: 'selection' });
  if (!selection.length) {
    list.append(el('p', { class: 'empty' }, 'Select a board (or any shape) in Penpot to export it.'));
  } else {
    for (const s of selection) {
      const btn = el(
        'button',
        { class: `shape${s.id === t?.id ? ' active' : ''}`, type: 'button' },
        el('span', { class: 'shape-name' }, s.name || s.type),
        el('span', { class: 'shape-dims' }, `${Math.round(s.width)} × ${Math.round(s.height)} px`),
      );
      btn.addEventListener('click', () => {
        targetId = s.id;
        syncSizeFields();
        render();
      });
      list.append(btn);
    }
  }
  app.append(list);

  if (!t) return;

  // format picker
  const fmt = el('div', { class: 'formats' });
  for (const f of FORMATS) {
    const btn = el('button', { class: `fmt${form.format === f.id ? ' active' : ''}`, type: 'button', title: f.hint }, f.label);
    btn.addEventListener('click', () => {
      form.format = f.id;
      render();
    });
    fmt.append(btn);
  }
  app.append(el('label', { class: 'section' }, 'Format'), fmt);
  const active = FORMATS.find((f) => f.id === form.format)!;
  app.append(el('p', { class: 'hint' }, active.hint));

  // size row — the two fields are LOCKED to the board's aspect ratio: editing
  // one re-derives the other, so the export can never crop or letterbox.
  if (!form.width) syncSizeFields();
  const aspect = t.width > 0 && t.height > 0 ? t.width / t.height : 1;
  const round2 = (v: number): string => String(Math.round(v * 100) / 100);
  const sizeRow = el('div', { class: 'row' });
  const wIn = el('input', { type: 'number', min: '0', step: 'any', value: form.width }) as HTMLInputElement;
  const hIn = el('input', { type: 'number', min: '0', step: 'any', value: form.height }) as HTMLInputElement;
  wIn.addEventListener('input', () => {
    form.width = wIn.value;
    const w = Number(wIn.value);
    if (w > 0) {
      form.height = round2(w / aspect);
      hIn.value = form.height;
    }
  });
  hIn.addEventListener('input', () => {
    form.height = hIn.value;
    const h = Number(hIn.value);
    if (h > 0) {
      form.width = round2(h * aspect);
      wIn.value = form.width;
    }
  });
  const unitSel = el('select', { class: 'unit' }) as HTMLSelectElement;
  for (const u of UNITS) unitSel.append(el('option', u === form.unit ? { value: u, selected: '' } : { value: u }, u));
  unitSel.addEventListener('change', () => {
    form.unit = unitSel.value as Unit;
    syncSizeFields();
    render();
  });
  sizeRow.append(wIn, el('span', { class: 'x' }, '×'), hIn, unitSel);
  app.append(el('label', { class: 'section' }, 'Size'), sizeRow);

  // dpi (raster + physical vector)
  const needsDpi = form.format !== 'svg' && form.format !== 'dxf';
  if (needsDpi) {
    const dpiIn = el('input', { type: 'number', min: '36', max: '1200', value: form.dpi }) as HTMLInputElement;
    dpiIn.addEventListener('input', () => (form.dpi = dpiIn.value));
    const dpiRow = el('div', { class: 'row' }, dpiIn, el('span', { class: 'suffix' }, 'dpi'));
    app.append(el('label', { class: 'section' }, 'Resolution'), dpiRow);
  }

  type BoolKey = 'crop' | 'registration' | 'colorBars' | 'pdfx' | 'c2pa' | 'imprint' | 'hdr';
  const check = (parent: HTMLElement, key: BoolKey, label: string, onchange?: () => void): void => {
    const input = el('input', form[key] ? { type: 'checkbox', checked: '' } : { type: 'checkbox' }) as HTMLInputElement;
    input.addEventListener('change', () => {
      form[key] = input.checked;
      onchange?.();
    });
    parent.append(el('label', { class: 'check' }, input, label));
  };

  // print options
  if (form.format === 'pdf') {
    const bleedIn = el('input', { type: 'number', min: '0', step: 'any', value: form.bleed }) as HTMLInputElement;
    bleedIn.addEventListener('input', () => (form.bleed = bleedIn.value));
    app.append(
      el('label', { class: 'section' }, 'Bleed'),
      el('div', { class: 'row' }, bleedIn, el('span', { class: 'suffix' }, 'mm')),
    );
    const checks = el('div', { class: 'checks' });
    check(checks, 'crop', 'Crop marks');
    check(checks, 'registration', 'Registration marks');
    check(checks, 'colorBars', 'Colour bars (uses the frame’s colours)');
    check(checks, 'pdfx', 'PDF/X-4 metadata');
    app.append(el('label', { class: 'section' }, 'Print marks'), checks);
  }

  // colour management — the formats that can carry ink
  if (form.format === 'pdf' || form.format === 'eps' || form.format === 'tiff') {
    // CMYK TIFF is CMYK by definition; the others are a choice.
    const forcedCmyk = form.format === 'tiff';
    const mode = colorMode();

    app.append(el('label', { class: 'section' }, 'Colour'));
    if (!forcedCmyk) {
      const modes = el('div', { class: 'formats' });
      for (const [id, label] of [['rgb', 'RGB'], ['cmyk', 'CMYK'] as const] as [ColorMode, string][]) {
        const btn = el('button', { class: `fmt${mode === id ? ' active' : ''}`, type: 'button' }, label);
        btn.addEventListener('click', () => {
          form.colorModes[form.format] = id;
          render();
        });
        modes.append(btn);
      }
      app.append(modes);
    }

    if (mode === 'cmyk') {
      const condSel = el('select') as HTMLSelectElement;
      for (const c of PRESS_CONDITIONS) {
        condSel.append(el('option', c.id === form.condition ? { value: c.id, selected: '' } : { value: c.id }, c.label));
      }
      condSel.addEventListener('change', () => {
        form.condition = condSel.value;
        render();
      });
      app.append(el('label', { class: 'section' }, 'Press condition'), el('div', { class: 'row' }, condSel));

      // The honest caveat, stated where the decision is made rather than buried
      // in a README: unlocked colours are converted, not colour-managed.
      app.append(
        el('p', { class: 'hint' },
          'Colours are converted to device CMYK — the press condition is declared for the RIP, not applied. ' +
          'Lock your brand inks below to get exact values.'),
      );

      if (form.format === 'pdf') {
        const iccIn = el('input', { type: 'file', accept: '.icc,.icm' }) as HTMLInputElement;
        iccIn.addEventListener('change', () => {
          const file = iccIn.files?.[0];
          if (!file) return;
          void file.arrayBuffer().then((buf) => {
            form.destProfile = new Uint8Array(buf);
            form.destProfileName = file.name;
            render();
          });
        });
        app.append(
          el('label', { class: 'section' }, 'Destination profile'),
          el('div', { class: 'row stack' }, iccIn),
          el('p', { class: 'hint' },
            form.destProfileName
              ? `Embedding ${form.destProfileName} — PDF/X-4 can be claimed.`
              : 'Optional. PDF/X-4 requires an embedded destination profile; without one the export stays valid but drops the conformance claim. Your printer can supply the .icc for their press.'),
        );
      }

      // ── ink locks ────────────────────────────────────────────────────────
      const rows = boardColors.length ? locksForPalette(boardColors, inkLocks) : inkLocks;
      const locksBox = el('div', { class: 'locks' });
      for (const lock of rows) {
        const hex = lock.hex!;
        const row = el('div', { class: 'lock' });
        row.append(el('span', { class: 'lock-chip', style: `background:${hex}` }));
        row.append(el('span', { class: 'lock-hex' }, hex));
        const vals = lock.cmyk?.length === 4 ? lock.cmyk : [null, null, null, null];
        (['C', 'M', 'Y', 'K'] as const).forEach((plate, i) => {
          const input = el('input', {
            class: 'lock-ink', type: 'number', min: '0', max: '100', step: 'any',
            placeholder: plate, ...(vals[i] != null ? { value: String(vals[i]) } : {}),
          }) as HTMLInputElement;
          input.addEventListener('input', () => {
            const next = [...(row.querySelectorAll('.lock-ink') as NodeListOf<HTMLInputElement>)]
              .map((el2) => Number(el2.value));
            // A partially-filled row isn't a lock — all four plates or nothing.
            const complete = next.every((v) => Number.isFinite(v) && v >= 0 && v <= 100)
              && [...(row.querySelectorAll('.lock-ink') as NodeListOf<HTMLInputElement>)].every((e) => e.value !== '');
            updateLock(hex, { cmyk: complete ? next : undefined });
          });
          row.append(input);
        });
        const spotIn = el('input', {
          class: 'lock-spot', type: 'text', placeholder: 'Spot name (optional)',
          ...(lock.spot?.name ? { value: lock.spot.name } : {}),
        }) as HTMLInputElement;
        spotIn.addEventListener('input', () => {
          const name = spotIn.value.trim();
          updateLock(hex, { spot: name ? { name } : null });
        });
        row.append(spotIn);
        locksBox.append(row);
      }
      if (!rows.length) {
        locksBox.append(el('p', { class: 'empty' }, 'No ink locks yet — scan the board to list its colours.'));
      }

      const scanBtn = el('button', { class: 'scan', type: 'button', ...(scanning || busy ? { disabled: '' } : {}) },
        scanning ? 'Scanning…' : 'Scan board colours');
      scanBtn.addEventListener('click', () => void scanColors());
      app.append(el('label', { class: 'section' }, 'Brand ink locks'), locksBox, scanBtn);
      app.append(
        el('p', { class: 'hint' },
          'Enter the CMYK your printer specified (0–100, all four). A spot name emits a true /Separation plate in PDF. Locks are saved on this machine.'),
      );
    }
  }

  // HDR (png/jpeg only — WebP has no viable HDR decode path)
  if (form.format === 'png' || form.format === 'jpeg') {
    const hdrBox = el('div', { class: 'checks' });
    check(hdrBox, 'hdr', 'HDR (Rec.2100 PQ)', render);
    app.append(el('label', { class: 'section' }, 'HDR'), hdrBox);
    if (form.hdr) {
      const dials = el('div', { class: 'dials' });
      // `step` matters most on White: 400–2000 nits across a ~224px track is
      // seven units per pixel at step 1, so the value jitters with the mouse and
      // never lands on a round number. Stepping in 25s makes it aimable.
      const dial = (key: 'hdrPeak' | 'hdrReach' | 'hdrLift' | 'hdrFocus', label: string, min: string, max: string, step = '1'): void => {
        const input = el('input', { type: 'range', min, max, step, value: form[key] }) as HTMLInputElement;
        const val = el('span', { class: 'dial-val' }, form[key]);
        input.addEventListener('input', () => {
          form[key] = input.value;
          val.textContent = input.value;
        });
        dials.append(el('label', { class: 'dial' }, el('span', { class: 'dial-name' }, label), input, val));
      };
      dial('hdrPeak', 'White', '400', '2000', '25');
      dial('hdrReach', 'Reach', '0', '100');
      dial('hdrLift', 'Dark lift', '0', '100');
      dial('hdrFocus', 'Focus', '0', '100');
      app.append(dials);
      app.append(el('p', { class: 'hint' }, 'Only use where the destination supports HDR — platforms that re-encode uploads destroy it.'));
    }
  }

  // content protection — formats that can carry credentials/metadata
  const isRaster = form.format === 'png' || form.format === 'jpeg' || form.format === 'webp';
  const protectable = isRaster || form.format === 'svg' || form.format === 'pdf' || form.format === 'pdf-screen';
  if (protectable) {
    const checks = el('div', { class: 'checks' });
    check(checks, 'c2pa', 'Content Credentials (C2PA)');
    if (isRaster) check(checks, 'imprint', 'Imprint invisible watermark');
    const creatorIn = el('input', { type: 'text', placeholder: 'Creator (optional)', value: form.creator }) as HTMLInputElement;
    creatorIn.addEventListener('input', () => (form.creator = creatorIn.value));
    const rightsIn = el('input', { type: 'text', placeholder: '© rights, e.g. CC BY 4.0 (optional)', value: form.copyright }) as HTMLInputElement;
    rightsIn.addEventListener('input', () => (form.copyright = rightsIn.value));
    app.append(
      el('label', { class: 'section' }, 'Content protection'),
      checks,
      el('div', { class: 'row stack' }, creatorIn),
      el('div', { class: 'row stack' }, rightsIn),
    );
  }

  // export button + status
  const exportBtn = el('button', { class: 'export', type: 'button', ...(busy ? { disabled: '' } : {}) }, busy ? 'Rendering…' : `Export ${active.label}`);
  exportBtn.addEventListener('click', () => void doExport());
  app.append(exportBtn);
  if (statusText) app.append(el('p', { class: `status ${statusKind}` }, statusText));
  app.append(
    el('p', { class: 'footnote' },
      'Runs entirely in your browser — nothing leaves your machine. Made with the ',
      el('a', { href: 'https://lolly.tools/info', target: '_blank', rel: 'noreferrer' }, 'Lolly'),
      ' engine.'),
  );
}

/**
 * Pull the board's SVG once and list the colours it actually uses, so ink locks
 * can be entered against real swatches instead of typed hexes.
 */
async function scanColors(): Promise<void> {
  const t = currentTarget();
  if (!t || scanning || busy) return;
  scanning = true;
  setStatus('Reading board colours…', 'busy');
  try {
    const data = await requestSvg(t.id);
    boardColors = extractSvgPalette(new TextDecoder().decode(data.bytes), 24);
    setStatus(
      boardColors.length ? `Found ${boardColors.length} colour(s).` : 'No flat colours found on this board.',
      boardColors.length ? 'ok' : 'error',
    );
  } catch (e) {
    setStatus((e as Error).message || String(e), 'error');
  } finally {
    scanning = false;
    render();
  }
}

async function doExport(): Promise<void> {
  const t = currentTarget();
  if (!t || busy) return;
  busy = true;
  setStatus('Fetching board from Penpot…', 'busy');
  try {
    const data = await requestSvg(t.id);
    installFontCss(data.fontCss);
    const svgText = new TextDecoder().decode(data.bytes);
    setStatus('Converting…', 'busy');
    const result = await convert(svgText, {
      format: form.format,
      fontCss: data.fontCss,
      width: Number(form.width) || undefined,
      height: Number(form.height) || undefined,
      unit: form.unit,
      dpi: Number(form.dpi) || 300,
      title: t.name,
      pdf: {
        bleed: `${Number(form.bleed) || 0}mm`,
        marks: {
          crop: form.crop,
          registration: form.registration,
          colorBars: form.colorBars,
          bleed: form.registration,
        },
        pdfx: form.pdfx,
      },
      color: {
        mode: colorMode(),
        condition: form.condition,
        inkLocks,
        destProfile: form.destProfile,
      },
      protect: {
        c2pa: form.c2pa,
        imprint: form.imprint,
        creator: form.creator.trim() || undefined,
        copyright: form.copyright.trim() || undefined,
      },
      hdr: {
        enabled: form.hdr,
        peakNits: Number(form.hdrPeak) || HDR_DIAL_DEFAULTS.peakNits,
        reach: Number(form.hdrReach),
        lift: Number(form.hdrLift),
        richness: Number(form.hdrFocus),
      },
    });
    download(result.bytes, `${slug(t.name)}.${result.ext}`, result.mime);
    const warn = result.warnings.length ? ` (${result.warnings.join(' ')})` : '';
    setStatus(`Saved ${slug(t.name)}.${result.ext}${warn}`, result.warnings.length ? 'error' : 'ok');
  } catch (e) {
    setStatus((e as Error).message || String(e), 'error');
  } finally {
    busy = false;
    render();
  }
}

function download(bytes: Uint8Array, filename: string, mime: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

if (!isEmbedded()) {
  // Opened directly in a browser tab: loop messages back through a fake
  // sandbox so the pipeline is testable without Penpot.
  installDemoHost((m) => window.postMessage(m, '*'));
}
render();
sendToPlugin({ type: 'ready' });
