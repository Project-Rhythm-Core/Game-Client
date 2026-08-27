import type { PlayableChart } from '../../chart/playable-chart.ts';
import { registerRuleset, type Judge, type JudgementStyle, type Ruleset } from '../ruleset.ts';
import { ManiaJudge } from './judge.ts';
import {
  JUDGEMENTS,
  JUDGEMENT_BREAKS_COMBO,
  JUDGEMENT_COLOURS,
  JUDGEMENT_LABELS,
  type Judgement,
} from './judgements.ts';

/**
 * osu!mania, as lazer plays it.
 *
 * The whole of osu's presence in the game is reachable from this directory: the windows,
 * the scale, and the fact that only a miss ends a combo. Nothing outside it names osu.
 */

/** Overall difficulty for a chart whose origin does not carry one. */
const DEFAULT_OVERALL_DIFFICULTY = 5;

class ManiaRuleset implements Ruleset {
  readonly id = 'osu-mania';

  /**
   * `osu` is what this game's importer writes into `origin.format` for a `.osu` file.
   * A converted chart would arrive under its own name and still be judged by these rules,
   * which is why this is a list.
   */
  readonly formats = ['osu'] as const;

  readonly judgements = JUDGEMENTS;

  styleFor(judgement: string): JudgementStyle {
    const name = judgement as Judgement;
    return {
      label: JUDGEMENT_LABELS[name] ?? judgement,
      colour: JUDGEMENT_COLOURS[name] ?? 0xffffff,
      breaksCombo: JUDGEMENT_BREAKS_COMBO[name] ?? true,
    };
  }

  createJudge(playable: PlayableChart): Judge {
    // Overall difficulty lives in the chart's provenance rather than in the model proper:
    // it is an osu concept, and a format that has no equivalent should not carry a field
    // for one. Reading it here is what keeps that knowledge inside this directory.
    const overallDifficulty =
      playable.chart.origin.values.overallDifficulty ?? DEFAULT_OVERALL_DIFFICULTY;

    return new ManiaJudge(playable, overallDifficulty);
  }
}

export const maniaRuleset = new ManiaRuleset();

registerRuleset(maniaRuleset);

export { ManiaJudge } from './judge.ts';
export { ManiaHitWindows, RELEASE_WINDOW_LENIENCE, difficultyRange } from './hit-windows.ts';
export { JUDGEMENTS, JUDGEMENT_LABELS, JUDGEMENT_WEIGHT } from './judgements.ts';
export type { Judgement } from './judgements.ts';
