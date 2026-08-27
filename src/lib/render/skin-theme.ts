import { Assets, Texture } from 'pixi.js';

/**
 * The active skin's textures, ready to draw with.
 *
 * Files are loaded through the `skin://` scheme rather than from disk: the renderer is
 * given a description of what to load and nothing more, and the main process decides what
 * it will serve.
 */

/**
 * Height every measurement in a layout is expressed against.
 *
 * A layout stores virtual units rather than pixels, so the same numbers describe the
 * stage at any window size: multiply by `screenHeight / VIRTUAL_HEIGHT` and the whole
 * playfield scales together.
 */
export const VIRTUAL_HEIGHT = 480;

/** Where the combo counter sits when the skin does not say, in virtual units. */
const DEFAULT_COMBO_POSITION = 111;

/** Where the judgement graphic sits when the skin does not say. */
const DEFAULT_SCORE_POSITION = 300;

export interface ColumnTextures {
  /** Lane width in virtual units. */
  width: number;
  note?: Texture;
  head?: Texture;
  /** Tiled down the note. Skins ship a short strip meant to repeat. */
  body?: Texture;
  tail?: Texture;
  /** Whether the tail must be drawn upside down, because it is really the head. */
  tailFlipped?: boolean;
  /** The receptor, drawn at the foot of the lane. */
  key?: Texture;
  keyPressed?: Texture;
  /**
   * Receptor height in virtual units.
   *
   * A receptor stretches across its lane but keeps its authored height, so unlike a note
   * its size is not recoverable from the texture and the lane alone.
   */
  keyHeight?: number;
  /** Lane tint as a Pixi colour, when the skin sets one. */
  colour?: number;
}

interface RawColumn {
  width: number;
  note?: string;
  head?: string;
  body?: string;
  tail?: string;
  tailFlipped?: boolean;
  key?: string;
  keyPressed?: string;
  keyHeight?: number;
  colour?: string;
}

interface RawStage {
  hint?: string;
  hintHeight?: number;
}

interface RawLayout {
  keys: number;
  hitPosition: number;
  lineWidths?: number[];
  columns: RawColumn[];
  comboPosition?: number;
  scorePosition?: number;
  keysUnderNotes?: boolean;
  judgementLine?: boolean;
  stage?: RawStage;
}

/** A key count's stage, in virtual units. */
export interface Layout {
  /** Where the judgement line sits, in virtual units from the top. */
  hitPosition: number;
  /** Separator widths, one per lane edge — one more than there are columns. */
  lineWidths: number[];
  columns: ColumnTextures[];
  /** Where the combo counter sits, in virtual units from the top. */
  comboPosition: number;
  /** Where the judgement graphic sits, in virtual units from the top. */
  scorePosition: number;
  /** Whether the receptors are drawn behind the notes instead of over them. */
  keysUnderNotes: boolean;
  /** Whether to draw a plain line across the hit position. Skins with their own turn it off. */
  judgementLine: boolean;
  /** The judgement line graphic, centred on the hit position. */
  hint?: Texture;
  /** Its drawn height in virtual units, which is not its texture height. */
  hintHeight?: number;
}

/** Bitmap digits `0` through `9`, with how far each is drawn over the one before it. */
export interface DigitFont {
  digits: Texture[];
  overlap: number;
}

interface RawFonts {
  combo?: string[];
  comboOverlap?: number;
}

interface RawTheme {
  judgements: Record<string, string>;
  layouts: RawLayout[];
  fonts?: RawFonts;
}

export class SkinTheme {
  readonly id: string;
  readonly name: string;
  /** The combo font, when the skin ships a full set of ten digits. */
  readonly comboFont: DigitFont | null;
  /** Judgement graphics, keyed by the game's own judgement names. */
  readonly judgements: ReadonlyMap<string, Texture>;
  private readonly layouts = new Map<number, Layout>();

  /** Every URL loaded for this skin, so they can be released when it is swapped out. */
  private readonly urls: readonly string[];

  private constructor(
    id: string,
    name: string,
    layouts: Map<number, Layout>,
    comboFont: DigitFont | null,
    judgements: Map<string, Texture>,
    urls: readonly string[],
  ) {
    this.id = id;
    this.name = name;
    this.urls = urls;
    this.layouts = layouts;
    this.comboFont = comboFont;
    this.judgements = judgements;
  }

  /**
   * Loads the active skin, or returns `null` when there is none.
   *
   * A missing skin is ordinary — the playfield falls back to flat colour — so this never
   * throws for the absence of one.
   */
  static async load(): Promise<SkinTheme | null> {
    const active = await window.electronAPI.skin.active();
    if (!active?.theme) return null;

    const theme = active.theme as unknown as RawTheme;
    // Taken from the skin rather than built here. It names one skin rather than "whichever
    // is active", which is what keeps Pixi's URL-keyed asset cache honest when the player
    // switches: a fixed host would hand back the previous skin's textures under the new
    // skin's names.
    const origin = active.origin;

    // Every distinct texture is loaded once, however many columns reference it.
    const paths = new Set<string>();
    for (const layout of theme.layouts) {
      for (const column of layout.columns) {
        for (const path of [
          column.note,
          column.head,
          column.body,
          column.tail,
          column.key,
          column.keyPressed,
        ]) {
          if (path) paths.add(path);
        }
      }
      if (layout.stage?.hint) paths.add(layout.stage.hint);
    }
    for (const path of theme.fonts?.combo ?? []) paths.add(path);
    for (const path of Object.values(theme.judgements ?? {})) paths.add(path);

    const textures = new Map<string, Texture>();
    await Promise.all(
      [...paths].map(async (path) => {
        try {
          textures.set(path, await Assets.load<Texture>(origin + path));
        } catch {
          // A skin naming a file it does not ship is the loader's problem, not a reason
          // to refuse the whole skin: that column simply falls back to flat colour.
        }
      }),
    );

    const layouts = new Map<number, Layout>();
    for (const layout of theme.layouts) {
      layouts.set(layout.keys, {
        hitPosition: layout.hitPosition,
        lineWidths: layout.lineWidths ?? [],
        comboPosition: layout.comboPosition ?? DEFAULT_COMBO_POSITION,
        scorePosition: layout.scorePosition ?? DEFAULT_SCORE_POSITION,
        keysUnderNotes: layout.keysUnderNotes ?? false,
        judgementLine: layout.judgementLine ?? true,
        hint: layout.stage?.hint ? textures.get(layout.stage.hint) : undefined,
        hintHeight: layout.stage?.hintHeight,
        columns: layout.columns.map((column) => ({
          width: column.width,
          note: column.note ? textures.get(column.note) : undefined,
          head: column.head ? textures.get(column.head) : undefined,
          body: column.body ? textures.get(column.body) : undefined,
          tail: column.tail ? textures.get(column.tail) : undefined,
          tailFlipped: column.tailFlipped ?? false,
          key: column.key ? textures.get(column.key) : undefined,
          keyPressed: column.keyPressed ? textures.get(column.keyPressed) : undefined,
          keyHeight: column.keyHeight,
          colour: parseColour(column.colour),
        })),
      });
    }

    // All ten or none: a partial set would draw some numbers and silently swallow others.
    const comboPaths = theme.fonts?.combo ?? [];
    const comboDigits = comboPaths.map((path) => textures.get(path));
    const comboFont =
      comboDigits.length === 10 && comboDigits.every((texture) => texture !== undefined)
        ? { digits: comboDigits as Texture[], overlap: theme.fonts?.comboOverlap ?? 0 }
        : null;

    const judgements = new Map<string, Texture>();
    for (const [name, path] of Object.entries(theme.judgements ?? {})) {
      const texture = textures.get(path);
      if (texture) judgements.set(name, texture);
    }

    return new SkinTheme(
      active.id,
      active.name,
      layouts,
      comboFont,
      judgements,
      [...paths].map((path) => origin + path),
    );
  }

  /**
   * Releases this skin's textures.
   *
   * Worth doing when swapping skins rather than leaving it to the cache: a session spent
   * comparing a folder full of skins would otherwise accumulate every texture of every
   * one of them, and skin artwork is not small.
   */
  async destroy(): Promise<void> {
    await Promise.all(
      this.urls.map((url) => Assets.unload(url).catch(() => {})),
    );
  }

  /** The stage for a key count, or `null` when the skin does not cover it. */
  layoutFor(keys: number): Layout | null {
    return this.layouts.get(keys) ?? null;
  }
}

/** `#rrggbbaa` to a Pixi colour. The alpha is dropped; Pixi tints and fades separately. */
function parseColour(value: string | undefined): number | undefined {
  if (!value?.startsWith('#') || value.length < 7) return undefined;

  const parsed = Number.parseInt(value.slice(1, 7), 16);
  return Number.isNaN(parsed) ? undefined : parsed;
}
