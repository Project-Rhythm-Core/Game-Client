import { Application, Container, Graphics } from 'pixi.js';

import { NoteState, type PlayableChart } from '../chart/playable-chart.ts';
import type { Judgement } from '../gameplay/hit-windows.ts';

/**
 * Draws a vertically scrolling playfield.
 *
 * Notes fall towards a receptor line near the bottom. Where a note sits is entirely a
 * question of scroll distance — see `ScrollTimeline` — and never of its judgement time,
 * which is why a chart can legitimately draw a note that never becomes visible or one
 * that does not move at all.
 */

export interface PlayfieldOptions {
  /**
   * How long a note takes to travel the playfield at unmodified velocity, in reference
   * milliseconds. Lower is faster. This is the player's scroll speed.
   */
  travelMs?: number;
  /** Distance from the bottom of the canvas to the receptor line, in pixels. */
  receptorOffset?: number;
  /** Width of one lane, in pixels. */
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

export class Playfield {
  private readonly app: Application;
  private readonly options: Required<PlayfieldOptions>;

  private readonly lanes = new Graphics();
  private readonly receptors = new Graphics();
  private readonly notes = new Graphics();
  private readonly view = new Container();

  /** Notes drawn on the most recent frame, for the diagnostics overlay. */
  drawnCount = 0;

  /** When each lane was last judged, and what it was, for the hit flash. */
  private readonly flashAt: Float64Array;
  private readonly flashJudgement: (Judgement | null)[];

  constructor(app: Application, options: PlayfieldOptions = {}) {
    this.app = app;
    this.options = { ...DEFAULTS, ...options };

    this.view.addChild(this.lanes, this.receptors, this.notes);
    app.stage.addChild(this.view);

    // Sized generously: the chart decides the lane count, and it can change on load.
    this.flashAt = new Float64Array(18);
    this.flashJudgement = new Array(18).fill(null);
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
    return this.travelHeight / this.options.travelMs;
  }

  private get receptorY(): number {
    return this.app.screen.height - this.options.receptorOffset;
  }

  /** Vertical distance a note covers from spawning to reaching the receptor. */
  private get travelHeight(): number {
    return this.receptorY;
  }

  private laneX(column: number, columnCount: number): number {
    const totalWidth = columnCount * this.options.laneWidth;
    return (this.app.screen.width - totalWidth) / 2 + column * this.options.laneWidth;
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
    const { laneWidth } = this.options;
    const columns = playable.chart.columns;
    const receptorY = this.receptorY;

    this.receptors.clear();

    for (let column = 0; column < columns.length; column++) {
      const x = this.laneX(column, columns.length);

      if (isHeld(column)) {
        this.receptors
          .rect(x, receptorY - 26, laneWidth, 26)
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
        .rect(x, receptorY - 70 * strength, laneWidth, 70 * strength)
        .fill({ color: JUDGEMENT_FLASH[judgement], alpha: 0.45 * strength });
    }
  }

  /** Redraws the static lane background. Call on resize or when the chart changes. */
  drawLanes(playable: PlayableChart): void {
    const { laneWidth } = this.options;
    const columns = playable.chart.columns;
    const receptorY = this.receptorY;

    this.lanes.clear();

    for (let column = 0; column < columns.length; column++) {
      const x = this.laneX(column, columns.length);
      this.lanes
        .rect(x, 0, laneWidth, this.app.screen.height)
        .fill(column % 2 === 0 ? COLOURS.lane : COLOURS.laneAlt);
      this.lanes.moveTo(x, 0).lineTo(x, this.app.screen.height).stroke({ width: 1, color: COLOURS.laneEdge });
    }

    const right = this.laneX(columns.length, columns.length);
    this.lanes.moveTo(right, 0).lineTo(right, this.app.screen.height).stroke({ width: 1, color: COLOURS.laneEdge });

    // The receptor line: where a note has to be when its time arrives.
    this.lanes
      .moveTo(this.laneX(0, columns.length), receptorY)
      .lineTo(right, receptorY)
      .stroke({ width: 3, color: COLOURS.receptor });
  }

  /**
   * Draws the notes visible at `scrollPosition`.
   *
   * Only the window the chart says is on screen is touched, so cost tracks what is
   * actually visible rather than the size of the chart.
   */
  draw(playable: PlayableChart, scrollPosition: number): void {
    const { laneWidth } = this.options;
    const columns = playable.chart.columns;
    const pixelsPerUnit = this.pixelsPerUnit;
    const receptorY = this.receptorY;

    const unitsAhead = this.options.travelMs;
    const unitsBehind = this.options.travelMs * OVERSHOOT;
    const { start, end } = playable.visibleRange(scrollPosition, unitsAhead, unitsBehind);

    this.notes.clear();
    let drawn = 0;

    for (let i = start; i < end; i++) {
      const note = playable.chart.notes[i];
      const headState = playable.headStates[i];
      const isHold = note.endMs !== undefined;

      // A note that was hit is gone. That absence is the feedback: the player sees the
      // note vanish under their finger. A note that was *missed* keeps falling instead,
      // so the mistake stays visible rather than looking identical to a hit.
      if (!isHold && headState === NoteState.Hit) continue;
      if (isHold && playable.tailStates[i] !== NoteState.Pending) continue;

      const x = this.laneX(note.column, columns.length) + 3;
      const width = laneWidth - 6;
      const headY = receptorY - (playable.notePositions[i] - scrollPosition) * pixelsPerUnit;
      drawn++;

      if (!isHold) {
        const colour =
          headState === NoteState.Missed
            ? COLOURS.missed
            : columns[note.column].role === 'scratch'
              ? COLOURS.scratch
              : COLOURS.note;

        this.notes.rect(x, headY - 7, width, 14).fill(colour);
        continue;
      }

      // --- hold notes ----------------------------------------------------
      const dropped = playable.holdBroken[i] === 1;
      const holding = headState === NoteState.Hit && !dropped;
      const dead = headState === NoteState.Missed || dropped;

      // While it is being held the head stays pinned to the receptor and the body
      // shrinks into it, which is what makes holding feel like it is doing something.
      const bodyBottom = holding ? receptorY : headY;

      // The tail can be enormously far away when velocity spikes, so the geometry is
      // clamped to the screen rather than handed to the rasteriser at full size.
      const tailY = receptorY - (playable.noteEndPositions[i] - scrollPosition) * pixelsPerUnit;
      const top = Math.max(tailY, -this.app.screen.height);
      const bottom = Math.min(bodyBottom, this.app.screen.height * 2);

      if (bottom > top) {
        this.notes
          .rect(x + width * 0.2, top, width * 0.6, bottom - top)
          .fill(dead ? COLOURS.holdBodyDead : holding ? COLOURS.holdBodyActive : COLOURS.holdBody);
      }

      // The head is only worth drawing where it actually is: pinned at the receptor
      // while held, still falling otherwise.
      this.notes
        .rect(x, bodyBottom - 7, width, 14)
        .fill(dead ? COLOURS.holdBodyDead : holding ? COLOURS.holdBodyActive : COLOURS.note);
    }

    this.drawnCount = drawn;
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}
