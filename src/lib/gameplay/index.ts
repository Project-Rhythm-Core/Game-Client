export { ColumnInput, defaultLayout } from './input.ts';
export type { ColumnInputHandlers } from './input.ts';
export { meanError, unstableRate } from './stats.ts';
export {
  registerRuleset,
  rulesetFor,
  rulesets,
  type Judge,
  type JudgementEvent,
  type JudgementStyle,
  type Ruleset,
} from './ruleset.ts';

// Importing a ruleset is what registers it. Until there is a settings screen that lists
// them, this is the only place that decides which formats the build can play.
import './osu-mania/index.ts';
