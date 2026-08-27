import { Application, Container, Graphics, Sprite, Text, Texture, TilingSprite } from 'pixi.js';

import { NoteState, type PlayableChart } from '../chart/playable-chart.ts';
import type { Ruleset } from '../gameplay/ruleset.ts';
import { VIRTUAL_HEIGHT, type Layout, type SkinTheme } from './skin-theme.ts';

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
}

/**
 * Stage used when no skin covers the chart's key count.
 *
 * Expressed in the same virtual units a skin uses, so the fallback scales with the window
 * exactly as a skin does rather than being a second set of rules.
 */
const FALLBACK = {
  hitPosition: 420,
  columnWidth: 50,
  comboPosition: 111,
  scorePosition: 300,
} as const;

const DEFAULTS = {
  travelMs: 700,
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

/**
 * Colour of a lane flash when the ruleset has not been set, or names a judgement it has no
 * style for. Neither should happen; drawing something neutral beats drawing nothing.
 */
const UNKNOWN_JUDGEMENT_COLOUR = 0xffffff;

/** How long a lane keeps glowing after a judgement, in milliseconds. */
const FLASH_MS = 140;

/** How far past the receptor a note is still drawn, as a fraction of the travel span. */
const OVERSHOOT = 0.35;

/** Height of an untextured note, in pixels. */
const PLAIN_NOTE_HEIGHT = 14;

/** Dimming applied to a note that was missed or a hold that was dropped. */
const DEAD_ALPHA = 0.55;

/**
 * Size of a combo digit relative to its texture, in the stage's virtual units.
 *
 * Skin digits are authored against the same 768-unit space as every other texture, so
 * this is the same conversion the importer applies to receptor heights — done here
 * because a digit's width matters too, and both come straight from the texture.
 */
const TEXTURE_SCALE = 480 / 768;

/** Size of the plain-text combo, in virtual units. */
const COMBO_TEXT_SIZE = 34;

/** Size of a plain-text judgement, for one the skin ships no graphic for. */
const JUDGEMENT_TEXT_SIZE = 26;

/** How a judgement graphic fades, in milliseconds. osu's own timings. */
const JUDGEMENT_FADE_IN_MS = 20;
const JUDGEMENT_FADE_OUT_MS = 40;
const JUDGEMENT_POP_MS = 100;
const JUDGEMENT_LIFE_MS = 220;

export class Playfield {
  private readonly app: Application;
  private readonly options: Required<PlayfieldOptions>;

  private readonly lanes = new Graphics();
  private readonly receptors = new Graphics();
  /** Bodies sit behind heads, so they get their own layer rather than a sort. */
  private readonly bodyLayer = new Container();
  private readonly noteLayer = new Container();
  /** The receptors. A separate layer because the skin decides whether it sits over notes. */
  private readonly keyLayer = new Container();
  private readonly comboLayer = new Container();
  private readonly view = new Container();

  /** Reused across frames: notes come and go constantly, sprites should not. */
  private readonly bodyPool: TilingSprite[] = [];
  private readonly notePool: Sprite[] = [];
  /** One per lane, rebuilt only when the stage is measured. */
  private keySprites: Sprite[] = [];
  private readonly comboPool: Sprite[] = [];
  private readonly comboText: Text;
  private readonly judgementSprite: Sprite;
  private readonly judgementText: Text;

  private skin: SkinTheme | null = null;
  private layout: Layout | null = null;

  /** Lane left edges and widths in pixels, derived from the layout and the canvas. */
  private laneX: number[] = [];
  private laneWidths: number[] = [];
  private receptorYPx = 0;

  /** What the geometry was last measured against, so a resize is noticed. */
  private measuredFor = { width: 0, height: 0, keys: 0 };

  /** Notes drawn on the most recent frame, for the diagnostics overlay. */
  drawnCount = 0;

  /** When each lane was last judged, and what it was, for the hit flash. */
  private readonly flashAt: Float64Array;
  private ruleset: Ruleset | null = null;
  private readonly flashJudgement: (string | null)[];

  constructor(app: Application, options: PlayfieldOptions = {}) {
    this.app = app;
    this.options = { ...DEFAULTS, ...options };

    this.comboText = new Text({
      text: '',
      style: { fill: 0xffffff, fontFamily: 'sans-serif', fontSize: COMBO_TEXT_SIZE, fontWeight: 'bold' },
    });
    this.comboText.anchor.set(0.5);
    this.comboText.visible = false;

    this.judgementSprite = new Sprite(Texture.WHITE);
    this.judgementSprite.anchor.set(0.5);
    this.judgementSprite.visible = false;

    this.judgementText = new Text({
      text: '',
      style: { fill: 0xffffff, fontFamily: 'sans-serif', fontSize: JUDGEMENT_TEXT_SIZE, fontWeight: 'bold' },
    });
    this.judgementText.anchor.set(0.5);
    this.judgementText.visible = false;

    this.comboLayer.addChild(this.comboText, this.judgementSprite, this.judgementText);

    this.view.addChild(
      this.lanes,
      this.receptors,
      this.bodyLayer,
      this.noteLayer,
      this.keyLayer,
      this.comboLayer,
    );
    app.stage.addChild(this.view);

    // Sized generously: the chart decides the lane count, and it can change on load.
    this.flashAt = new Float64Array(18);
    this.flashJudgement = new Array(18).fill(null);
  }

  /** Uses `theme` for charts whose key count it covers. Pass `null` for flat colour. */
  /**
   * The ruleset whose judgements are being drawn.
   *
   * The playfield knows nothing about what results exist or what they are called — it asks
   * for a label and a colour by name. That is what lets a second format ship its own scale
   * without touching this file.
   */
  setRuleset(ruleset: Ruleset | null): void {
    this.ruleset = ruleset;
  }

  private judgementColour(judgement: string): number {
    return this.ruleset?.styleFor(judgement).colour ?? UNKNOWN_JUDGEMENT_COLOUR;
  }

  setSkin(skin: SkinTheme | null): void {
    this.skin = skin;
  }

  /** Records a judgement so its lane flashes. `nowMs` is wall time, not song time. */
  notifyJudgement(column: number, judgement: string, nowMs: number): void {
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

  /** Pixels per virtual unit. Everything about the stage scales through this. */
  private get scale(): number {
    return this.app.screen.height / VIRTUAL_HEIGHT;
  }

  /** Pixels per reference millisecond of scroll distance. */
  private get pixelsPerUnit(): number {
    return this.receptorYPx / this.options.travelMs;
  }

  private get receptorY(): number {
    return this.receptorYPx;
  }

/**
   * Works out where each lane sits, for the current window size.
   *
   * Lane widths, separators and the judgement line all come from the layout in virtual
   * units and are scaled by the window height together, so the stage keeps its
   * proportions at any resolution rather than being laid out in fixed pixels.
   *
   * The stage is centred horizontally. Its horizontal position is deliberately not taken
   * from the skin: `ColumnStart` is an offset into osu's own 4:3 playfield and means
   * nothing at another aspect ratio.
   */
  private measureLanes(playable: PlayableChart): void {
    const count = playable.chart.columns.length;
    const scale = this.scale;

    const widths = this.layout
      ? this.layout.columns.map((column) => column.width * scale)
      : new Array(count).fill(FALLBACK.columnWidth * scale);
    const lines = this.lineWidthsPx(widths.length);

    this.laneWidths = widths;
    this.receptorYPx = (this.layout?.hitPosition ?? FALLBACK.hitPosition) * scale;

    const total =
      widths.reduce((sum, width) => sum + width, 0) + lines.reduce((sum, line) => sum + line, 0);

    let x = (this.app.screen.width - total) / 2;
    this.laneX = widths.map((width, index) => {
      x += lines[index];
      const left = x;
      x += width;
      return left;
    });

    this.measuredFor = {
      width: this.app.screen.width,
      height: this.app.screen.height,
      keys: count,
    };
  }

  /**
   * Separator widths in pixels, one per lane edge — so one more than there are columns.
   *
   * The count is passed in rather than read from `laneWidths`, which is still the
   * *previous* chart's at the point this is needed. Reading it there produced a list
   * sized for the old key count, so loading a wider chart left the extra lanes reading
   * past the end: `x += undefined` makes every following position NaN, and lanes that
   * were merely late in the array silently stopped being drawn at all.
   */
  private lineWidthsPx(count: number): number[] {
    const source = this.layout?.lineWidths ?? [];
    const scale = this.scale;

    return Array.from({ length: count + 1 }, (_, i) => (source[i] ?? 0) * scale);
  }

  /** Re-measures if the window or the chart changed since the last time. */
  private ensureMeasured(playable: PlayableChart): void {
    const { width, height } = this.app.screen;
    const keys = playable.chart.columns.length;

    if (
      this.measuredFor.width !== width ||
      this.measuredFor.height !== height ||
      this.measuredFor.keys !== keys
    ) {
      this.drawLanes(playable);
    }
  }

  /** Redraws the static lane background. Call on resize or when the chart changes. */
  drawLanes(playable: PlayableChart): void {
    this.layout = this.skin?.layoutFor(playable.chart.columns.length) ?? null;
    this.measureLanes(playable);

    const receptorY = this.receptorY;
    const height = this.app.screen.height;
    const lines = this.lineWidthsPx(this.laneWidths.length);

    this.lanes.clear();

    for (let column = 0; column < this.laneX.length; column++) {
      // A gentle alternation so lanes are tellable apart. This is the playfield's own
      // background, not a separator: skins ask for those explicitly and almost never do.
      this.lanes
        .rect(this.laneX[column], 0, this.laneWidths[column], height)
        .fill(column % 2 === 0 ? COLOURS.lane : COLOURS.laneAlt);
    }

    // Separators come from the skin and nowhere else. Skins overwhelmingly ask for none,
    // and drawing them anyway puts lines between notes that the author never wanted; the
    // one place they appear in the reference set is the split between hands of a 10-key
    // double-play stage.
    for (let edge = 0; edge < lines.length; edge++) {
      const lineWidth = lines[edge];
      if (lineWidth <= 0) continue;

      const x =
        edge < this.laneX.length
          ? this.laneX[edge] - lineWidth
          : this.laneX[edge - 1] + this.laneWidths[edge - 1];

      this.lanes.rect(x, 0, lineWidth, height).fill(COLOURS.laneEdge);
    }

    const left = this.laneX[0] ?? 0;
    const right =
      (this.laneX[this.laneX.length - 1] ?? 0) + (this.laneWidths[this.laneWidths.length - 1] ?? 0);

    // The line marking where a note has to be when its time arrives. A skin that draws
    // its own hit target says so and gets none: putting one across the stage anyway is
    // drawing something the author deliberately removed.
    if (this.layout?.judgementLine ?? true) {
      this.lanes
        .moveTo(left, receptorY)
        .lineTo(right, receptorY)
        .stroke({ width: Math.max(2, 3 * this.scale), color: COLOURS.receptor });
    }

    this.buildKeyArea(left, right - left);
  }

  /**
   * Rebuilds the hit position: the judgement line graphic and the receptors under it.
   *
   * Both are sized from the skin rather than invented. A receptor stretches across its
   * lane, keeps its authored height and stands on the foot of the stage; the judgement
   * line spans the whole stage and is centred on the hit position. Together they are what
   * makes the hit position somewhere the player can see rather than a hairline.
   */
  private buildKeyArea(stageLeft: number, stageWidth: number): void {
    const scale = this.scale;
    const receptorY = this.receptorY;
    const height = this.app.screen.height;

    this.keyLayer.removeChildren();
    this.keySprites = [];

    // The skin decides whether its receptors cover the notes. Most leave them on top,
    // which is where the layer already sits; the combo stays above either way.
    this.view.setChildIndex(
      this.keyLayer,
      this.layout?.keysUnderNotes
        ? this.view.getChildIndex(this.bodyLayer)
        : this.view.getChildIndex(this.comboLayer) - 1,
    );

    if (this.layout?.hint && this.layout.hintHeight) {
      const hint = new Sprite(this.layout.hint);
      hint.anchor.set(0, 0.5);
      hint.x = stageLeft;
      hint.width = stageWidth;
      hint.height = this.layout.hintHeight * scale;
      hint.y = receptorY;
      this.keyLayer.addChild(hint);
    }

    for (let column = 0; column < this.laneX.length; column++) {
      const style = this.layout?.columns[column];
      if (!style?.key || !style.keyHeight) continue;

      const sprite = new Sprite(style.key);
      sprite.anchor.set(0, 1);
      sprite.x = this.laneX[column];
      sprite.width = this.laneWidths[column];
      sprite.height = style.keyHeight * scale;
      sprite.y = height;
      this.keyLayer.addChild(sprite);
      this.keySprites[column] = sprite;
    }
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
    this.ensureMeasured(playable);

    const receptorY = this.receptorY;
    const lit = 26 * this.scale;
    const flashHeight = 70 * this.scale;
    this.receptors.clear();

    for (let column = 0; column < this.laneX.length; column++) {
      const x = this.laneX[column];
      const width = this.laneWidths[column];

      const held = isHeld(column);

      // A skinned receptor has its own pressed artwork, which is the feedback the player
      // is looking at. The glow is what stands in for it when the skin has none.
      const key = this.keySprites[column];
      const style = this.layout?.columns[column];
      if (key && style?.key) {
        key.texture = held && style.keyPressed ? style.keyPressed : style.key;
      }

      if (held && !style?.keyPressed) {
        this.receptors
          .rect(x, receptorY - lit, width, lit)
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
        .rect(x, receptorY - flashHeight * strength, width, flashHeight * strength)
        .fill({ color: this.judgementColour(judgement), alpha: 0.45 * strength });
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
    this.ensureMeasured(playable);

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
      const width = this.laneWidths[column] ?? FALLBACK.columnWidth * this.scale;
      const style = this.layout?.columns[column];

      // Where the note's *hit line* is: the y at which it is exactly on time. What rests
      // on that line is an edge, not the middle of the graphic — see `noteCentreY`.
      const headLineY = receptorY - (playable.notePositions[i] - scrollPosition) * pixelsPerUnit;

      if (isHold) {
        const dropped = playable.holdBroken[i] === 1;
        const holding = headState === NoteState.Hit && !dropped;
        const dead = headState === NoteState.Missed || dropped;

        // While it is being held the head stays pinned to the receptor and the body
        // shrinks into it, which is what makes holding feel like it is doing something.
        const headLine = holding ? receptorY : headLineY;
        const tailLineY = receptorY - (playable.noteEndPositions[i] - scrollPosition) * pixelsPerUnit;

        const headTexture = style?.head ?? style?.note;
        const headCentre = this.noteCentreY(headTexture, width, headLine, false);
        // The tail is the one piece that hangs the other way: osu anchors
        // `DrawableHoldNoteTail` TopCentre, so its cap drops into the hold from the end
        // rather than straddling it.
        const tailCentre = this.noteCentreY(style?.tail, width, tailLineY, true);

        // The body runs between the two centres, which is what puts it half-way under
        // each cap — lazer sizes `bodyPiece` that way so a rounded head or tail has no
        // seam. The tail can be enormously far away when velocity spikes, so the geometry
        // is clamped to the screen rather than handed to the rasteriser at full size.
        const top = Math.max(tailCentre, -screenHeight);
        const clampedBottom = Math.min(headCentre, screenHeight * 2);

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
          // The scale is the same on both axes because the strip is a picture of a
          // lane-wide slice of hold: scaling only across would squash its pattern, which
          // is invisible on a strip a few pixels tall and obvious on a detailed one.
          const bodyScale = style?.body ? width / texture.width : 1;
          body.tileScale.set(bodyScale, bodyScale);
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

        const holdTint = dead
          ? COLOURS.holdBodyDead
          : holding
            ? COLOURS.holdBodyActive
            : COLOURS.note;

        // The end cap, drawn only once the hold is actually on screen. Skins that ship no
        // tail reuse the head, which has to be turned over so the note reads as ending
        // rather than starting.
        if (style?.tail && tailCentre > -screenHeight && tailCentre < screenHeight * 2) {
          this.placeNote(heads++, style.tail, x, width, tailCentre, holdTint, dead, style.tailFlipped);
        }

        this.placeNote(heads++, headTexture, x, width, headCentre, holdTint, dead);
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
          this.noteCentreY(style?.note, width, headLineY, false),
          tint,
          headState === NoteState.Missed,
        );
      }
    }

    for (let i = bodies; i < this.bodyPool.length; i++) this.bodyPool[i].visible = false;
    for (let i = heads; i < this.notePool.length; i++) this.notePool[i].visible = false;

    this.drawnCount = heads;
  }

  /**
   * Draws the combo over the stage, in the skin's own digits when it ships them.
   *
   * Zero is drawn as nothing rather than as `0`: a broken combo should read as an absence,
   * which is also what osu does. Without a digit font this draws nothing at all and the
   * HUD's text stands in, rather than putting a mismatched typeface on the playfield.
   */
  drawCombo(combo: number): void {
    const font = this.skin?.comboFont;
    const digits = combo > 0 ? String(combo) : '';

    for (let i = digits.length; i < this.comboPool.length; i++) {
      this.comboPool[i].visible = false;
    }

    // A skin that ships no digits still needs a combo — most of the reference set has
    // none, so making this conditional on the font is making it conditional on nothing.
    if (!font) {
      this.drawComboText(digits);
      return;
    }
    this.comboText.visible = false;
    if (digits.length === 0) return;

    const scale = this.scale;
    const overlap = font.overlap * scale;

    // Laid out twice: once to measure, once to place, so the number is centred on the
    // stage rather than growing off to one side as it gains digits.
    let total = 0;
    const widths: number[] = [];
    for (const character of digits) {
      const texture = font.digits[Number(character)];
      const width = texture.width * scale * TEXTURE_SCALE;
      widths.push(width);
      total += width;
    }
    total -= overlap * (digits.length - 1);

    const stageLeft = this.laneX[0] ?? 0;
    const stageRight =
      (this.laneX[this.laneX.length - 1] ?? 0) + (this.laneWidths[this.laneWidths.length - 1] ?? 0);

    let x = (stageLeft + stageRight - total) / 2;
    const y = (this.layout?.comboPosition ?? FALLBACK.comboPosition) * scale;

    for (let i = 0; i < digits.length; i++) {
      const texture = font.digits[Number(digits[i])];
      const sprite = this.takeComboDigit(i);

      sprite.texture = texture;
      sprite.width = widths[i];
      sprite.height = texture.height * scale * TEXTURE_SCALE;
      sprite.x = x;
      sprite.y = y;
      sprite.visible = true;

      x += widths[i] - overlap;
    }
  }

  /** The combo in plain text, for skins with no digits of their own. */
  private drawComboText(digits: string): void {
    if (digits.length === 0) {
      this.comboText.visible = false;
      return;
    }

    const scale = this.scale;
    const stageLeft = this.laneX[0] ?? 0;
    const stageRight =
      (this.laneX[this.laneX.length - 1] ?? 0) + (this.laneWidths[this.laneWidths.length - 1] ?? 0);

    this.comboText.text = digits;
    // Assigning a style re-lays the text out, so only do it when the window has changed.
    const fontSize = COMBO_TEXT_SIZE * scale;
    if (this.comboText.style.fontSize !== fontSize) this.comboText.style.fontSize = fontSize;
    this.comboText.x = (stageLeft + stageRight) / 2;
    this.comboText.y = (this.layout?.comboPosition ?? FALLBACK.comboPosition) * scale;
    this.comboText.visible = true;
  }

  /**
   * Shows the judgement for a hit, and keeps showing it until it has faded.
   *
   * The graphic comes from the skin, which is where the wording lives: the same result
   * osu calls GREAT internally is labelled PERFECT on a mania skin, so drawing the skin's
   * own image is the only way the text on screen agrees with what the player expects.
   */
  drawJudgement(judgement: string | null, ageMs: number): void {
    if (judgement === null || ageMs > JUDGEMENT_LIFE_MS) {
      this.judgementSprite.visible = false;
      this.judgementText.visible = false;
      return;
    }

    const scale = this.scale;
    const stageLeft = this.laneX[0] ?? 0;
    const stageRight =
      (this.laneX[this.laneX.length - 1] ?? 0) + (this.laneWidths[this.laneWidths.length - 1] ?? 0);

    // osu's own timing: in fast, held, then out. The pop on the way in is what makes a
    // judgement register as an event rather than as text that appeared.
    const fadeIn = Math.min(1, ageMs / JUDGEMENT_FADE_IN_MS);
    const remaining = JUDGEMENT_LIFE_MS - ageMs;
    const fadeOut = Math.min(1, remaining / JUDGEMENT_FADE_OUT_MS);
    const pop = 0.8 + 0.2 * Math.min(1, ageMs / JUDGEMENT_POP_MS);

    const alpha = Math.min(fadeIn, fadeOut);
    const x = (stageLeft + stageRight) / 2;
    const y = (this.layout?.scorePosition ?? FALLBACK.scorePosition) * scale;

    // A skin need not ship every graphic — the reference skin has no MAX — and showing
    // nothing for the best judgement in the game is the worst place to go quiet. The
    // label is the name the skin prints on the graphics it does ship.
    const texture = this.skin?.judgements.get(judgement);
    if (!texture) {
      this.judgementSprite.visible = false;

      const fontSize = JUDGEMENT_TEXT_SIZE * scale * pop;
      const text = this.judgementText;
      text.text = (this.ruleset?.styleFor(judgement).label ?? judgement).toUpperCase();
      if (text.style.fontSize !== fontSize) text.style.fontSize = fontSize;
      text.x = x;
      text.y = y;
      text.alpha = alpha;
      text.visible = true;
      return;
    }

    this.judgementText.visible = false;

    const sprite = this.judgementSprite;
    sprite.texture = texture;
    sprite.width = texture.width * scale * TEXTURE_SCALE * pop;
    sprite.height = texture.height * scale * TEXTURE_SCALE * pop;
    sprite.x = x;
    sprite.y = y;
    sprite.alpha = alpha;
    sprite.visible = true;
  }

  private takeComboDigit(index: number): Sprite {
    let sprite = this.comboPool[index];
    if (!sprite) {
      sprite = new Sprite(Texture.WHITE);
      sprite.anchor.set(0, 0.5);
      this.comboPool[index] = sprite;
      this.comboLayer.addChild(sprite);
    }
    return sprite;
  }

  /** Positions one note sprite, centred on `centreY`. */
  /**
   * Drawn height of a note in a lane of `width` pixels.
   *
   * A textured note keeps its proportions against the lane, so its size follows the stage
   * at any resolution. An untextured one gets a slab scaled the same way.
   */
  private noteHeight(texture: Texture | undefined, width: number): number {
    return texture
      ? width * (texture.height / texture.width)
      : PLAIN_NOTE_HEIGHT * this.scale;
  }

  /**
   * Where to centre a note whose hit line is at `lineY`.
   *
   * osu rests an *edge* of the graphic on the line, never its middle. Every note anchors
   * BottomCentre on downscroll — `DrawableManiaHitObject` sets it, `DrawableNote` keeps it
   * for its head piece, and `LegacyNotePiece` gives its container the same origin — so a
   * note sits entirely above the line and only its bottom edge touches. The one exception
   * is the hold tail, which `DrawableHoldNoteTail` anchors TopCentre so the cap drops back
   * into the hold; pass `hangsDown` for it.
   *
   * Centring on the line instead, which is what this used to do, draws every note half its
   * own height too low. On a square note in a 70-unit lane at 700 ms of travel that is
   * 57 ms of apparent lateness — wider than a GREAT window, and it reads as the whole game
   * being late rather than as a drawing offset.
   */
  private noteCentreY(
    texture: Texture | undefined,
    width: number,
    lineY: number,
    hangsDown: boolean,
  ): number {
    const half = this.noteHeight(texture, width) / 2;
    return hangsDown ? lineY + half : lineY - half;
  }

  private placeNote(
    index: number,
    texture: Texture | undefined,
    x: number,
    width: number,
    centreY: number,
    tint: number,
    dead: boolean,
    flipped = false,
  ): void {
    const sprite = this.takeNote(index);
    const source = texture ?? Texture.WHITE;

    sprite.texture = source;
    sprite.width = width;
    sprite.height = this.noteHeight(texture, width);
    sprite.x = x;
    sprite.y = centreY;
    // Assigning `height` above always leaves a positive scale, so this both applies the
    // flip and clears one left on a sprite the pool handed back from an earlier note.
    if (flipped) sprite.scale.y = -sprite.scale.y;
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
