import { Application, Container, Graphics } from 'pixi.js';

import { NoteState, type PlayableChart } from '../chart/playable-chart.ts';

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
  note: 0xd8e4f0,
  scratch: 0xffb454,
  holdBody: 0x6ea8ff,
  holdBodyDim: 0x37527f,
  judged: 0x3a3a48,
} as const;

/** How far past the receptor a note is still drawn, as a fraction of the travel span. */
const OVERSHOOT = 0.15;

export class Playfield {
  private readonly app: Application;
  private readonly options: Required<PlayfieldOptions>;

  private readonly lanes = new Graphics();
  private readonly notes = new Graphics();
  private readonly view = new Container();

  /** Notes drawn on the most recent frame, for the diagnostics overlay. */
  drawnCount = 0;

  constructor(app: Application, options: PlayfieldOptions = {}) {
    this.app = app;
    this.options = { ...DEFAULTS, ...options };

    this.view.addChild(this.lanes, this.notes);
    app.stage.addChild(this.view);
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
    this.drawnCount = end - start;

    for (let i = start; i < end; i++) {
      const note = playable.chart.notes[i];
      const x = this.laneX(note.column, columns.length) + 3;
      const width = laneWidth - 6;

      const headY = receptorY - (playable.notePositions[i] - scrollPosition) * pixelsPerUnit;
      const judged = playable.noteStates[i] !== NoteState.Pending;

      if (note.endMs !== undefined) {
        // A hold is drawn as a body between head and tail. The tail can be enormously
        // far away when velocity spikes, so it is clamped to keep the geometry sane.
        const tailY = receptorY - (playable.noteEndPositions[i] - scrollPosition) * pixelsPerUnit;
        const top = Math.max(tailY, -this.app.screen.height);
        const bottom = Math.min(headY, this.app.screen.height * 2);

        if (bottom > top) {
          this.notes
            .rect(x + width * 0.2, top, width * 0.6, bottom - top)
            .fill(judged ? COLOURS.holdBodyDim : COLOURS.holdBody);
        }
      }

      this.notes
        .rect(x, headY - 7, width, 14)
        .fill(judged ? COLOURS.judged : columns[note.column].role === 'scratch' ? COLOURS.scratch : COLOURS.note);
    }
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}
