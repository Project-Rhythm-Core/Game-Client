import { Application, Container, Graphics, Sprite, Texture, TilingSprite } from 'pixi.js';

import { NoteState, type PlayableChart } from '../chart/playable-chart.ts';
import type { Judgement } from '../gameplay/hit-windows.ts';
import type { ColumnTextures, SkinTheme } from './skin-theme.ts';

/**
 * Draws a vertically scrolling playfield.
 *
 * Notes fall towards a receptor line near the bottom. Where a note sits is entirely a
 * question of scroll distance — see `ScrollTimeline` — and never of its judgement time,
 * which is why a chart can legitimately draw a note that never becomes visible or one
 * that does not move at all.
 *
 * Everything is a sprite, skin or no skin. Without one the sprites carry `Texture.WHITE`
 * and a tint, which draws the same flat rectangles the playfield used to and keeps a
 * single path through the code rather than one for textures and one for shapes.
 */

export interface PlayfieldOptions {
  /**
   * How long a note takes to travel the playfield at unmodified velocity, in reference
   * milliseconds. Lower is faster. This is the player's scroll speed.
   */
  travelMs?: number;
  /** Distance from the bottom of the canvas to the receptor line, in pixels. */
  receptorOffset?: number;
  /** Width of one lane at weight 1.0, in pixels. */
  laneWidth?: number;
}

const DEFAULTS = {
  travelMs: 700,
  receptorOffset: 120,
  laneWidth: 68,
} satisfies Required<PlayfieldOptions>;

const COLOURS = {
  lane: 0x14141c,
  laneAlt: 0x101017,
  laneEdge: 0x24242f,
  receptor: 0x4a5a70,
  receptorLit: 0x6ea8ff,
  note: 0xd8e4f0,
  scratch: 0xffb454,
  holdBody: 0x6ea8ff,
  /** A hold being held. */
  holdBodyActive: 0xa8ccff,
  /** A hold that was missed or dropped: still there, visibly dead. */
  holdBodyDead: 0x2e3648,
  /** A note that went past unhit. It keeps falling so the mistake is visible. */
  missed: 0x4a3040,
} as const;

/** Colour of the flash a lane gives back when something is judged in it. */
const JUDGEMENT_FLASH: Readonly<Record<Judgement, number>> = {
  perfect: 0xffe08a,
  great: 0x8ad7ff,
  good: 0x8affa0,
  ok: 0xd3b8ff,
  meh: 0xffb454,
  miss: 0xff6b6b,
};

/** How long a lane keeps glowing after a judgement, in milliseconds. */
const FLASH_MS = 140;

/** How far past the receptor a note is still drawn, as a fraction of the travel span. */
const OVERSHOOT = 0.35;

/** Height of an untextured note, in pixels. */
const PLAIN_NOTE_HEIGHT = 14;

/** Dimming applied to a note that was missed or a hold that was dropped. */
const DEAD_ALPHA = 0.55;

export class Playfield {
  private readonly app: Application;
  private readonly options: Required<PlayfieldOptions>;

  private readonly lanes = new Graphics();
  private readonly receptors = new Graphics();
  /** Bodies sit behind heads, so they get their own layer rather than a sort. */
  private readonly bodyLayer = new Container();
  private readonly noteLayer = new Container();
  private readonly view = new Container();

  /** Reused across frames: notes come and go constantly, sprites should not. */
  private readonly bodyPool: TilingSprite[] = [];
  private readonly notePool: Sprite[] = [];

  private skin: SkinTheme | null = null;
  private columnStyles: ColumnTextures[] | null = null;

  /** Lane left edges and widths, recomputed when the chart or the canvas changes. */
  private laneX: number[] = [];
  private laneWidths: number[] = [];

  /** Notes drawn on the most recent frame, for the diagnostics overlay. */
  drawnCount = 0;

  /** When each lane was last judged, and what it was, for the hit flash. */
  private readonly flashAt: Float64Array;
  private readonly flashJudgement: (Judgement | null)[];

  constructor(app: Application, options: PlayfieldOptions = {}) {
    this.app = app;
    this.options = { ...DEFAULTS, ...options };

    this.view.addChild(this.lanes, this.receptors, this.bodyLayer, this.noteLayer);
    app.stage.addChild(this.view);

    // Sized generously: the chart decides the lane count, and it can change on load.
    this.flashAt = new Float64Array(18);
    this.flashJudgement = new Array(18).fill(null);
  }

  /** Uses `theme` for charts whose key count it covers. Pass `null` for flat colour. */
  setSkin(skin: SkinTheme | null): void {
    this.skin = skin;
  }

  /** Records a judgement so its lane flashes. `nowMs` is wall time, not song time. */
  notifyJudgement(column: number, judgement: Judgement, nowMs: number): void {
    if (column < 0 || column >= this.flashAt.length) return;
    this.flashAt[column] = nowMs;
    this.flashJudgement[column] = judgement;
  }

  /** Clears every lane's flash. */
  clearFlashes(): void {
    this.flashAt.fill(0);
    this.flashJudgement.fill(null);
  }

  /**
   * Changes the scroll speed in place.
   *
   * Rebuilding the playfield instead would leave the previous one's graphics attached to
   * the stage, still drawing whatever they last drew, so old notes would pile up on
   * screen as ghosts that no longer belong to any chart.
   */
  setTravelMs(travelMs: number): void {
    this.options.travelMs = travelMs;
  }

  /** Pixels per reference millisecond of scroll distance. */
  private get pixelsPerUnit(): number {
    return this.receptorY / this.options.travelMs;
  }

  private get receptorY(): number {
    return this.app.screen.height - this.options.receptorOffset;
  }

  /**
   * Works out where each lane sits.
   *
   * A skin may give lanes uneven widths — one reference skin narrows the outer columns of
   * its 9K layout — and that is design intent worth keeping. Its absolute coordinates are
   * not: those are pixels in osu's own fixed-size stage.
   */
  private measureLanes(playable: PlayableChart): void {
    const count = playable.chart.columns.length;
    const weights = this.columnStyles?.length === count
      ? this.columnStyles.map((style) => style.widthWeight)
      : new Array(count).fill(1);

    this.laneWidths = weights.map((weight) => this.options.laneWidth * weight);
    const total = this.laneWidths.reduce((sum, width) => sum + width, 0);

    let x = (this.app.screen.width - total) / 2;
    this.laneX = this.laneWidths.map((width) => {
      const left = x;
      x += width;
      return left;
    });
  }

  /** Redraws the static lane background. Call on resize or when the chart changes. */
  drawLanes(playable: PlayableChart): void {
    this.columnStyles = this.skin?.layoutFor(playable.chart.columns.length) ?? null;
    this.measureLanes(playable);

    const receptorY = this.receptorY;
    const height = this.app.screen.height;

    this.lanes.clear();

    for (let column = 0; column < this.laneX.length; column++) {
      const x = this.laneX[column];
      this.lanes
        .rect(x, 0, this.laneWidths[column], height)
        .fill(column % 2 === 0 ? COLOURS.lane : COLOURS.laneAlt);
      this.lanes.moveTo(x, 0).lineTo(x, height).stroke({ width: 1, color: COLOURS.laneEdge });
    }

    const right = this.laneX[this.laneX.length - 1] + this.laneWidths[this.laneWidths.length - 1];
    this.lanes.moveTo(right, 0).lineTo(right, height).stroke({ width: 1, color: COLOURS.laneEdge });

    // The receptor line: where a note has to be when its time arrives.
    this.lanes
      .moveTo(this.laneX[0], receptorY)
      .lineTo(right, receptorY)
      .stroke({ width: 3, color: COLOURS.receptor });
  }

  /**
   * Lights lanes that are held, and flashes lanes that were just judged.
   *
   * The flash is the immediate half of the feedback: it says *something happened here*
   * before the player has read the judgement text. Its colour is the judgement, so a miss
   * looks different from a perfect without anyone having to read anything.
   */
  drawReceptors(
    playable: PlayableChart,
    isHeld: (column: number) => boolean,
    nowMs: number,
  ): void {
    const receptorY = this.receptorY;
    this.receptors.clear();

    for (let column = 0; column < this.laneX.length; column++) {
      const x = this.laneX[column];
      const width = this.laneWidths[column];

      if (isHeld(column)) {
        this.receptors
          .rect(x, receptorY - 26, width, 26)
          .fill({ color: COLOURS.receptorLit, alpha: 0.3 });
      }

      const judgement = this.flashJudgement[column];
      if (judgement === null) continue;

      const age = nowMs - this.flashAt[column];
      if (age > FLASH_MS) {
        this.flashJudgement[column] = null;
        continue;
      }

      // Fades out over its lifetime, so the eye reads it as a hit rather than a state.
      const strength = 1 - age / FLASH_MS;
      this.receptors
        .rect(x, receptorY - 70 * strength, width, 70 * strength)
        .fill({ color: JUDGEMENT_FLASH[judgement], alpha: 0.45 * strength });
    }

    void playable;
  }

  /**
   * Draws the notes visible at `scrollPosition`.
   *
   * Only the window the chart says is on screen is touched, so cost tracks what is
   * actually visible rather than the size of the chart.
   */
  draw(playable: PlayableChart, scrollPosition: number): void {
    const columns = playable.chart.columns;
    const pixelsPerUnit = this.pixelsPerUnit;
    const receptorY = this.receptorY;
    const screenHeight = this.app.screen.height;

    const { start, end } = playable.visibleRange(
      scrollPosition,
      this.options.travelMs,
      this.options.travelMs * OVERSHOOT,
    );

    let bodies = 0;
    let heads = 0;

    for (let i = start; i < end; i++) {
      const note = playable.chart.notes[i];
      const headState = playable.headStates[i];
      const isHold = note.endMs !== undefined;

      // A note that was hit is gone. That absence is the feedback: the player sees the
      // note vanish under their finger. A note that was *missed* keeps falling instead,
      // so the mistake stays visible rather than looking identical to a hit.
      if (!isHold && headState === NoteState.Hit) continue;
      if (isHold && playable.tailStates[i] !== NoteState.Pending) continue;

      const column = note.column;
      const x = this.laneX[column] ?? 0;
      const width = this.laneWidths[column] ?? this.options.laneWidth;
      const style = this.columnStyles?.[column];
      const headY = receptorY - (playable.notePositions[i] - scrollPosition) * pixelsPerUnit;

      if (isHold) {
        const dropped = playable.holdBroken[i] === 1;
        const holding = headState === NoteState.Hit && !dropped;
        const dead = headState === NoteState.Missed || dropped;

        // While it is being held the head stays pinned to the receptor and the body
        // shrinks into it, which is what makes holding feel like it is doing something.
        const bottom = holding ? receptorY : headY;
        const tailY = receptorY - (playable.noteEndPositions[i] - scrollPosition) * pixelsPerUnit;

        // The tail can be enormously far away when velocity spikes, so the geometry is
        // clamped to the screen rather than handed to the rasteriser at full size.
        const top = Math.max(tailY, -screenHeight);
        const clampedBottom = Math.min(bottom, screenHeight * 2);

        if (clampedBottom > top) {
          const body = this.takeBody(bodies++);
          const texture = style?.body ?? Texture.WHITE;

          body.texture = texture;
          body.x = style?.body ? x : x + width * 0.2;
          body.y = top;
          body.width = style?.body ? width : width * 0.6;
          body.height = clampedBottom - top;
          // The strip is tiled down the note, so it is scaled to the lane rather than
          // stretched to the note's length: a long note repeats, it does not smear.
          body.tileScale.set(style?.body ? width / texture.width : 1, 1);
          body.tint = style?.body
            ? dead
              ? COLOURS.holdBodyDead
              : 0xffffff
            : dead
              ? COLOURS.holdBodyDead
              : holding
                ? COLOURS.holdBodyActive
                : COLOURS.holdBody;
          body.alpha = dead ? DEAD_ALPHA : 1;
          body.visible = true;
        }

        this.placeNote(
          heads++,
          style?.head ?? style?.note,
          x,
          width,
          bottom,
          dead ? COLOURS.holdBodyDead : holding ? COLOURS.holdBodyActive : COLOURS.note,
          dead,
        );
      } else {
        const tint =
          headState === NoteState.Missed
            ? COLOURS.missed
            : columns[column].role === 'scratch'
              ? COLOURS.scratch
              : COLOURS.note;

        this.placeNote(
          heads++,
          style?.note,
          x,
          width,
          headY,
          tint,
          headState === NoteState.Missed,
        );
      }
    }

    for (let i = bodies; i < this.bodyPool.length; i++) this.bodyPool[i].visible = false;
    for (let i = heads; i < this.notePool.length; i++) this.notePool[i].visible = false;

    this.drawnCount = heads;
  }

  /** Positions one note sprite, centred on `centreY`. */
  private placeNote(
    index: number,
    texture: Texture | undefined,
    x: number,
    width: number,
    centreY: number,
    tint: number,
    dead: boolean,
  ): void {
    const sprite = this.takeNote(index);
    const source = texture ?? Texture.WHITE;

    sprite.texture = source;
    sprite.width = width;
    // Textured notes keep their proportions; untextured ones are a fixed slab.
    sprite.height = texture ? width * (source.height / source.width) : PLAIN_NOTE_HEIGHT;
    sprite.x = x;
    sprite.y = centreY;
    sprite.tint = texture && !dead ? 0xffffff : tint;
    sprite.alpha = dead ? DEAD_ALPHA : 1;
    sprite.visible = true;
  }

  private takeNote(index: number): Sprite {
    let sprite = this.notePool[index];
    if (!sprite) {
      sprite = new Sprite(Texture.WHITE);
      sprite.anchor.set(0, 0.5);
      this.notePool[index] = sprite;
      this.noteLayer.addChild(sprite);
    }
    return sprite;
  }

  private takeBody(index: number): TilingSprite {
    let sprite = this.bodyPool[index];
    if (!sprite) {
      sprite = new TilingSprite({ texture: Texture.WHITE, width: 1, height: 1 });
      this.bodyPool[index] = sprite;
      this.bodyLayer.addChild(sprite);
    }
    return sprite;
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}
