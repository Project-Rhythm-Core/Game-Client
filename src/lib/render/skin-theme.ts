import { Assets, Texture } from 'pixi.js';

/**
 * The active skin's textures, ready to draw with.
 *
 * Files are loaded through the `skin://` scheme rather than from disk: the renderer is
 * given a description of what to load and nothing more, and the main process decides what
 * it will serve.
 */

/** Base of every skin asset URL. One host for now, meaning "whichever skin is active". */
const SKIN_ORIGIN = 'skin://active/';

export interface ColumnTextures {
  /** Width relative to the mean lane of this layout. `1.0` is even. */
  widthWeight: number;
  note?: Texture;
  head?: Texture;
  /** Tiled down the note. Skins ship a short strip meant to repeat. */
  body?: Texture;
  tail?: Texture;
  /** Lane tint as a Pixi colour, when the skin sets one. */
  colour?: number;
}

interface RawColumn {
  widthWeight: number;
  note?: string;
  head?: string;
  body?: string;
  tail?: string;
  colour?: string;
}

interface RawLayout {
  keys: number;
  columns: RawColumn[];
}

interface RawTheme {
  judgements: Record<string, string>;
  layouts: RawLayout[];
}

export class SkinTheme {
  readonly name: string;
  private readonly layouts = new Map<number, ColumnTextures[]>();

  private constructor(name: string, layouts: Map<number, ColumnTextures[]>) {
    this.name = name;
    this.layouts = layouts;
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

    // Every distinct texture is loaded once, however many columns reference it.
    const paths = new Set<string>();
    for (const layout of theme.layouts) {
      for (const column of layout.columns) {
        for (const path of [column.note, column.head, column.body, column.tail]) {
          if (path) paths.add(path);
        }
      }
    }

    const textures = new Map<string, Texture>();
    await Promise.all(
      [...paths].map(async (path) => {
        try {
          textures.set(path, await Assets.load<Texture>(SKIN_ORIGIN + path));
        } catch {
          // A skin naming a file it does not ship is the loader's problem, not a reason
          // to refuse the whole skin: that column simply falls back to flat colour.
        }
      }),
    );

    const layouts = new Map<number, ColumnTextures[]>();
    for (const layout of theme.layouts) {
      layouts.set(
        layout.keys,
        layout.columns.map((column) => ({
          widthWeight: column.widthWeight || 1,
          note: column.note ? textures.get(column.note) : undefined,
          head: column.head ? textures.get(column.head) : undefined,
          body: column.body ? textures.get(column.body) : undefined,
          tail: column.tail ? textures.get(column.tail) : undefined,
          colour: parseColour(column.colour),
        })),
      );
    }

    return new SkinTheme(active.name, layouts);
  }

  /** Styling for a key count, or `null` when the skin does not cover it. */
  layoutFor(keys: number): ColumnTextures[] | null {
    return this.layouts.get(keys) ?? null;
  }
}

/** `#rrggbbaa` to a Pixi colour. The alpha is dropped; Pixi tints and fades separately. */
function parseColour(value: string | undefined): number | undefined {
  if (!value?.startsWith('#') || value.length < 7) return undefined;

  const parsed = Number.parseInt(value.slice(1, 7), 16);
  return Number.isNaN(parsed) ? undefined : parsed;
}
