<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { Application, type Ticker } from 'pixi.js';

  import { AudioClock, SystemClock, type PlaybackClock } from './lib/audio/index.ts';
  import type { AvailableSkin, BundledChart, ImportedChart } from './lib/audio/types.ts';
  import { PlayableChart } from './lib/chart/playable-chart.ts';
  import {
    ColumnInput,
    defaultLayout,
    rulesetFor,
    unstableRate,
  } from './lib/gameplay/index.ts';
  import type { Judge, Ruleset } from './lib/gameplay/index.ts';
  import { FrameCounter, Playfield, SkinTheme } from './lib/render/index.ts';

  /** How long a judgement stays on screen. */
  const JUDGEMENT_FLASH_MS = 500;

  let stage: HTMLDivElement;
  let app: Application | null = null;
  let playfield: Playfield | null = null;

  const audioClock = new AudioClock();

  /**
   * Drives a chart that has no background track.
   *
   * A fully keysounded chart has nothing to follow, and the engine cannot yet mix its
   * samples, so time has to come from somewhere or nothing on screen moves at all.
   */
  const systemClock = new SystemClock();

  /** Whichever of the two is timing the chart currently loaded. */
  let clock: PlaybackClock = $state(audioClock);

  /** True while the loaded chart is being timed with no audio to follow. */
  let silent = $state(false);

  const frames = new FrameCounter();

  /**
   * Raw rather than deep state, and not only for speed.
   *
   * `$state` proxies plain objects all the way down, so a chart's thousands of notes
   * would each be wrapped — and, worse, anything reached through the proxy is a `Proxy`
   * rather than the array it looks like. Structured clone refuses those, so sending one
   * across IPC fails with nothing more helpful than "an object could not be cloned".
   * Nothing here is mutated in place; these are replaced wholesale, which raw state
   * still reacts to.
   */
  let skinTheme = $state.raw<SkinTheme | null>(null);

  /** Whose rules the loaded chart is played by, chosen from its own origin format. */
  let ruleset = $state.raw<Ruleset | null>(null);
  let judge = $state.raw<Judge | null>(null);
  const input = new ColumnInput(audioClock, {
    onPress: (column, songTimeMs) => {
      const event = judge?.press(column, songTimeMs);
      if (!event) return;

      // A keysounded chart's melody *is* the notes: this is the sound, not an effect on
      // top of one. It fires even on a miss, because in those charts a missed note is a
      // note the player still played, just badly.
      playNoteSamples(event.noteIndex);
      flash(event.judgement, event.errorMs, event.column);
    },
    onRelease: (column, songTimeMs) => {
      const event = judge?.release(column, songTimeMs);
      if (event) flash(event.judgement, event.errorMs, event.column);
    },
  });

  let lastJudgement = $state<{ judgement: string; errorMs: number | null } | null>(null);
  let lastJudgementAt = 0;

  /** Fires whatever sounds a note carries. Silent for charts that have none. */
  function playNoteSamples(noteIndex: number) {
    const note = playable?.chart.notes[noteIndex];
    if (!note?.samples?.length) return;

    for (const sample of note.samples) {
      window.electronAPI.audio.playSample(sample, note.volume ?? 100);
    }
  }

  /** How long a chart runs, for charts with no music to measure. */
  function chartLengthMs(chart: ImportedChart['chart']): number {
    let last = 0;
    for (const note of chart.notes) last = Math.max(last, note.endMs ?? note.timeMs);
    for (const event of chart.bgmEvents) last = Math.max(last, event.timeMs);
    // A little tail so the final sounds are not cut off by the end of the timeline.
    return last + 5000;
  }

  /**
   * A judgement's colour as CSS.
   *
   * The ruleset stores colours as Pixi numbers because that is what the playfield draws
   * with; the HUD is the one place that needs them as text.
   */
  function colourOf(judgement: string): string {
    const colour = ruleset?.styleFor(judgement).colour ?? 0xffffff;
    return `#${colour.toString(16).padStart(6, '0')}`;
  }

  function flash(judgement: string, errorMs: number | null, column: number) {
    lastJudgement = { judgement, errorMs };
    lastJudgementAt = performance.now();
    playfield?.notifyJudgement(column, judgement, lastJudgementAt);
  }
  // Replaced wholesale on load, never mutated in place: see the note on `judge`.
  let playable = $state.raw<PlayableChart | null>(null);
  let imported = $state.raw<ImportedChart | null>(null);

  let available = $state<BundledChart[]>([]);
  let selected = $state('');

  let skins = $state<AvailableSkin[]>([]);
  let selectedSkin = $state('');
  /** True while a skin is being imported, which is slow enough to be worth showing. */
  let switchingSkin = $state(false);
  let status = $state('starting up');
  let error = $state<string | null>(null);
  let ready = $state(false);
  let playing = $state(false);
  let constantVelocity = $state(false);
  let travelMs = $state(700);

  /**
   * Player calibration, in milliseconds. Positive means the audio is heard late, so the
   * clock is pulled back to match.
   *
   * Every rhythm game has one of these and none of them can engineer it away — osu ships
   * a hard-coded 15 ms platform offset on Windows with a comment saying they do not know
   * why it is needed.
   */
  let audioOffsetMs = $state(0);

  /**
   * How far ahead of the clock to draw, in frames.
   *
   * A frame computed now is presented at the next vsync, so drawing at the current audio
   * position puts every note one refresh period behind the sound — 7 ms at 144 Hz, 17 ms
   * at 60 Hz. Judgement must not be shifted with it: it is about when a sound happened,
   * not about when a picture appeared.
   */
  let visualLeadFrames = $state(1);

  /**
   * Time the chart against the wall clock instead of the audio device.
   *
   * A diagnostic, not a mode. beatoraja runs its whole game on `System.nanoTime()` and
   * nothing else, which it gets away with because BMS is keysounded: there is no long
   * track to drift against. If a chart feels the same either way here, the audio anchor
   * is not what is off; if the wall clock feels better, the anchor is out by a constant
   * and the fix is calibration rather than engineering.
   */
  let useWallClock = $state(false);

  // Diagnostics, refreshed from the render loop.
  let hud = $state({
    positionMs: 0, scroll: 0, velocity: 1, drawn: 0,
    combo: 0, maxCombo: 0, accuracy: 1, unstableRate: 0,
    counts: {} as Record<string, number>,
    fps: 0, frameMs: 0, worstMs: 0, updateMs: 0, worstUpdateMs: 0, load: 0, longFrames: 0,
  });

  onMount(async () => {
    app = new Application();
    await app.init({
      resizeTo: stage,
      backgroundColor: 0x0d0d12,
      antialias: true,
      preference: 'webgpu',
    });
    stage.appendChild(app.canvas);
    playfield = new Playfield(app, { travelMs });

    // The skin is optional: without one the playfield draws flat colour, so a failure
    // here costs appearance and nothing else.
    try {
      skinTheme = await SkinTheme.load();
      playfield.setSkin(skinTheme);
      skins = await window.electronAPI.skin.list();
      selectedSkin = skins.find((s) => s.id === skinTheme?.id)?.folder ?? '';
    } catch (e) {
      console.warn('could not load the skin:', e);
    }

    app.ticker.add(tick);
    window.addEventListener('resize', onResize);

    available = await window.electronAPI.chart.listBundled();
    selected = available[0]?.path ?? '';
    status = available.length ? 'pick a chart' : 'no charts found under rust-core/assets';
  });

  onDestroy(() => {
    window.removeEventListener('resize', onResize);
    playfield?.destroy();
    app?.destroy(true);
    systemClock.stop();
    void audioClock.unload();
  });

  function onResize() {
    if (playable && playfield) playfield.drawLanes(playable);
  }

  /**
   * Switches to another skin without restarting.
   *
   * The point of this screen is comparing skins, so a failure has to be visible and
   * survivable: a skin the core cannot read leaves the playfield on flat colour and says
   * why, rather than taking the session down.
   */
  async function useSkin() {
    if (!selectedSkin) return;

    switchingSkin = true;
    error = null;

    const previous = skinTheme;

    try {
      await window.electronAPI.skin.use(selectedSkin);
      skinTheme = await SkinTheme.load();
      playfield?.setSkin(skinTheme);

      // Only once the replacement is in place. Releasing first would leave the playfield
      // pointing at destroyed textures for as long as the new skin took to load.
      if (previous && previous.id !== skinTheme?.id) void previous.destroy();

      // Lane widths and the hit position come from the skin, so the stage has to be
      // measured again — the new skin almost certainly disagrees about both.
      if (playable) playfield?.drawLanes(playable);

      status = skinTheme ? `skin: ${skinTheme.name}` : 'that skin has no theme — flat colour';
    } catch (e) {
      skinTheme = null;
      playfield?.setSkin(null);
      if (playable) playfield?.drawLanes(playable);
      error = `skin '${selectedSkin}': ${e instanceof Error ? e.message : String(e)}`;
      status = 'skin failed';
    } finally {
      switchingSkin = false;
    }
  }

  async function load() {
    error = null;
    ready = false;
    playing = false;
    status = 'converting…';

    try {
      imported = await window.electronAPI.chart.import(selected);

      // Which rules to play by is the chart's own business: it says where it came from,
      // and a ruleset claims that format. Refusing beats guessing — judging a chart by
      // rules its charter never had in mind would be wrong, and silently so.
      ruleset = rulesetFor(imported.chart.origin.format);
      if (!ruleset) {
        throw new Error(`no ruleset plays '${imported.chart.origin.format}' charts`);
      }

      playable = new PlayableChart(imported.chart, { constantVelocity });
      judge = ruleset.createJudge(playable);
      input.setLayout(defaultLayout(imported.chart.columns.length));
      playfield?.setRuleset(ruleset);
      playfield?.drawLanes(playable);

      clock = audioClock;
      input.clock = audioClock;
      silent = false;

      status = imported.samplePaths.length
        ? `decoding audio and ${imported.samplePaths.length} samples…`
        : 'decoding audio…';

      // Music and sample bank are loaded together so they share one stream, and so a
      // keysounded chart gets a real clock rather than the free-running fallback.
      await audioClock.loadChart({
        musicPath: imported.audioPath ?? undefined,
        samplePaths: imported.samplePaths,
        scheduled: imported.chart.bgmEvents.map((event) => ({
          timeMs: event.timeMs,
          sample: event.sample,
          volume: event.volume ?? 100,
        })),
        durationMs: chartLengthMs(imported.chart),
      });

      status = 'waiting for the device…';
      if (!(await audioClock.waitUntilReady())) {
        // No usable device. The chart is still playable, just silent, which beats
        // refusing to start at all.
        clock = systemClock;
        input.clock = systemClock;
        silent = true;
        ready = true;
        status = 'no audio device — playable but silent';
        return;
      }

      ready = true;
      status = 'ready';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      status = 'failed';
    }
  }

  async function start() {
    if (!ready || !playable) return;
    error = null;

    try {
      judge?.reset();
      input.releaseAll();
      lastJudgement = null;
      playfield?.clearFlashes();
      // The tally is per attempt: hitches from loading say nothing about this run.
      frames.reset();

      if (useWallClock) {
        // The audio still plays; only what the game is timed against changes. Starting
        // from the audio's own position matters: `play()` does not return until the
        // first sample is audible, so starting from zero would put the wall clock
        // behind by however long that took and pass it off as drift.
        if (playing) await audioClock.restart();
        else await audioClock.play();
        systemClock.start(audioClock.positionMs());
      } else if (silent) {
        systemClock.start();
      } else if (playing) {
        await audioClock.restart();
      } else {
        await audioClock.play();
      }

      playing = true;
      status = silent ? 'playing (silent)' : 'playing';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function rebuild() {
    if (!imported) return;
    playable = new PlayableChart(imported.chart, { constantVelocity });
    judge = ruleset?.createJudge(playable) ?? null;
    playfield?.drawLanes(playable);
    playing = false;
  }

  function tick(ticker: Ticker) {
    // The frame period comes from the presentation clock, so scheduler jitter is not
    // mistaken for a dropped frame. The work timer below uses the wall clock, because
    // that is what actually elapses around the code being measured.
    frames.update(ticker.lastTime);
    const workStart = performance.now();

    if (playable && playfield) {
      // Judgement runs on audio time; drawing runs on the time this frame will be seen.
      // Sharing one value between them builds a mismatch into the game whose size is the
      // player's refresh rate.
      const source = useWallClock && !silent ? systemClock : clock;
      const positionMs = source.isRunning ? source.positionMs() : 0;
      const visualMs = positionMs + visualLeadFrames * frames.displayPeriodMs;
      const scroll = playable.scroll.positionAt(visualMs);

      if (playing && judge) {
        // Writing off expired notes runs on time, never on screen position: a chart can
        // hide notes entirely or freeze them in place, and both still have to be judged.
        for (const event of judge.update(positionMs)) flash(event.judgement, event.errorMs, event.column);

        hud.combo = judge.combo;
        hud.maxCombo = judge.maxCombo;
        hud.accuracy = judge.accuracy;
        hud.unstableRate = unstableRate(judge.errors);
        for (const judgement of ruleset?.judgements ?? []) {
          hud.counts[judgement] = judge.counts[judgement] ?? 0;
        }
      }

      playfield.drawReceptors(playable, (column) => input.isHeld(column), workStart);
      playfield.draw(playable, scroll);
      playfield.drawCombo(judge?.combo ?? 0);
      playfield.drawJudgement(
        lastJudgement?.judgement ?? null,
        lastJudgement ? workStart - lastJudgementAt : Infinity,
      );

      hud.positionMs = positionMs;
      hud.scroll = scroll;
      hud.velocity = playable.scroll.velocityAt(visualMs);
      hud.drawn = playfield.drawnCount;

      if (lastJudgement && performance.now() - lastJudgementAt > JUDGEMENT_FLASH_MS) {
        lastJudgement = null;
      }
    }

    frames.recordUpdate(performance.now() - workStart);

    hud.fps = frames.fps;
    hud.frameMs = frames.frameMs;
    hud.worstMs = frames.worstMs;
    hud.updateMs = frames.updateMs;
    hud.worstUpdateMs = frames.worstUpdateMs;
    hud.load = frames.load;
    hud.longFrames = frames.longFrames;
  }

  function onKeyDown(event: KeyboardEvent) {
    // Lane keys take precedence, so a layout that uses Space still plays.
    if (input.handleKeyDown(event)) return;

    if (event.code === 'Enter') {
      event.preventDefault();
      void start();
    }
  }

  function onKeyUp(event: KeyboardEvent) {
    input.handleKeyUp(event);
  }
</script>

<svelte:window on:keydown={onKeyDown} on:keyup={onKeyUp} />

<div class="stage" bind:this={stage}></div>

<div class="panel">
  <select bind:value={selected} disabled={!available.length}>
    {#each available as chart (chart.path)}
      <option value={chart.path}>{chart.name}</option>
    {/each}
  </select>

  <button onclick={load} disabled={!selected}>Load</button>
  <button onclick={start} disabled={!ready}>{playing ? 'Restart' : 'Play'}</button>

  <select bind:value={selectedSkin} onchange={useSkin} disabled={switchingSkin || !skins.length}
    title="Skin to draw with. Source skins are re-imported on selection, so edits show up.">
    {#each skins as skin (skin.id)}
      <option value={skin.folder}>
        {skin.folder}{skin.converted ? ' ·pkg' : ''}{skin.readable ? '' : ' ·?'}
      </option>
    {/each}
  </select>

  <label>
    <input type="checkbox" bind:checked={constantVelocity} onchange={rebuild} />
    no SV
  </label>

  <label title="Time the chart against the wall clock instead of the audio device">
    <input type="checkbox" bind:checked={useWallClock} />
    wall clock
  </label>

  <label class="speed">
    offset
    <input type="range" min="-100" max="100" step="1" bind:value={audioOffsetMs}
      oninput={() => void window.electronAPI.audio.setOffsetMs(audioOffsetMs)} />
    {audioOffsetMs > 0 ? '+' : ''}{audioOffsetMs} ms
  </label>

  <label class="speed">
    lead
    <input type="range" min="0" max="3" step="1" bind:value={visualLeadFrames} />
    {visualLeadFrames}f
  </label>

  <label class="speed">
    speed
    <input type="range" min="250" max="1500" step="50" bind:value={travelMs}
      oninput={() => playfield?.setTravelMs(travelMs)} />
    {travelMs} ms
  </label>

  <span class="keys">
    {imported ? defaultLayout(imported.chart.columns.length).map((k) => k.replace(/^Key/, '')).join(' ') : ''}
  </span>
  <span class="status">{switchingSkin ? 'importing skin…' : status}</span>
</div>

{#if playable}
  <div class="hud">
    <div>{imported?.summary.artist} — {imported?.summary.title}</div>
    <div class="dim">[{imported?.summary.difficultyName}] · {playable.chart.columns.length}K · {playable.chart.notes.length} notes</div>
    <div>pos {hud.positionMs.toFixed(0)} ms</div>
    <div>scroll {hud.scroll.toFixed(0)}</div>
    <div>velocity {hud.velocity < 0.01 || hud.velocity > 100 ? hud.velocity.toExponential(2) : hud.velocity.toFixed(3)}x</div>
    <div>drawn {hud.drawn}</div>
    <div class="rule"></div>
    <div>{(hud.accuracy * 100).toFixed(2)}% · {hud.combo}x <span class="dim">(max {hud.maxCombo})</span></div>
    <div class="dim">UR {hud.unstableRate.toFixed(1)}</div>
    {#each ruleset?.judgements ?? [] as judgement (judgement)}
      <div class="tally">
        <span style="color: {colourOf(judgement)}">{ruleset?.styleFor(judgement).label}</span>
        {hud.counts[judgement] ?? 0}
      </div>
    {/each}
    {#if silent}
      <div class="dim">no audio · system clock</div>
    {:else}
      <div class="dim">
        sync {audioClock.syncErrorMs.toFixed(2)} ms · rtt {audioClock.roundTripMs.toFixed(2)} ms
        {useWallClock ? ' · WALL CLOCK' : ''}
      </div>
      <div class="dim">
        voices {audioClock.stats?.activeVoices ?? 0}
        {#if (audioClock.stats?.droppedSamples ?? 0) > 0}
          <span class="warn">· {audioClock.stats?.droppedSamples} dropped</span>
        {/if}
      </div>
    {/if}
    <div class="rule"></div>
    <div>
      {hud.fps.toFixed(0)} fps
      <span class="dim">· frame {hud.frameMs.toFixed(1)} ms</span>
    </div>
    <!-- The frame period is pinned to the refresh rate by vsync, so it says nothing about
         headroom. Time spent working does, and is what other games label as their frame
         time. -->
    <div class:warn={hud.load > 0.5}>
      update {hud.updateMs.toFixed(2)} ms
      <span class="dim">· {(hud.load * 100).toFixed(0)}% of budget</span>
    </div>
    <div class:warn={hud.worstUpdateMs > frames.displayPeriodMs && frames.displayPeriodMs > 0}>
      worst update {hud.worstUpdateMs.toFixed(2)} ms
    </div>
    <div class:warn={hud.longFrames > 0}>dropped frames {hud.longFrames}</div>
  </div>
{/if}

<!-- The judgement itself is drawn on the playfield now, where the skin puts it. What is
     left here is the timing error, which osu shows nowhere and which is the reason to
     look at this line at all. -->
{#if lastJudgement && lastJudgement.errorMs !== null}
  <div class="flash" style="color: {colourOf(lastJudgement.judgement)}">
    <span class="offset">{lastJudgement.errorMs > 0 ? '+' : ''}{lastJudgement.errorMs.toFixed(0)} ms</span>
  </div>
{/if}

{#if error}
  <p class="error">{error}</p>
{/if}

<style>
  .stage {
    position: fixed;
    inset: 0;
  }

  .panel {
    position: fixed;
    bottom: 16px;
    left: 16px;
    right: 16px;
    z-index: 10;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: color-mix(in srgb, var(--panel) 90%, transparent);
    font-size: 13px;
  }

  select {
    max-width: 340px;
    flex: 1 1 220px;
  }

  select,
  button,
  input[type='range'] {
    font: inherit;
    color: var(--text);
    background: #1e1e28;
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 5px 10px;
  }

  button:not(:disabled) {
    cursor: pointer;
  }

  button:disabled,
  select:disabled {
    opacity: 0.45;
  }

  label {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--muted);
    white-space: nowrap;
  }

  .speed input {
    padding: 0;
    width: 110px;
  }

  .keys {
    margin-left: auto;
    font-family: ui-monospace, monospace;
    font-size: 12px;
    color: var(--muted);
  }

  .status {
    color: var(--muted);
  }

  .hud {
    position: fixed;
    top: 16px;
    left: 16px;
    z-index: 10;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: color-mix(in srgb, var(--panel) 85%, transparent);
    font-family: ui-monospace, 'IBM Plex Mono', monospace;
    font-size: 12px;
    line-height: 1.55;
  }

  .dim {
    color: var(--muted);
  }

  .warn {
    color: #ffb454;
  }

  .tally {
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }

  .flash {
    position: fixed;
    top: 38%;
    left: 50%;
    transform: translateX(-50%);
    z-index: 5;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    font-family: ui-monospace, 'IBM Plex Mono', monospace;
    font-size: 26px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    pointer-events: none;
  }

  .flash .offset {
    font-size: 13px;
    letter-spacing: 0;
    color: var(--muted);
    text-transform: none;
  }

  .rule {
    height: 1px;
    margin: 6px 0;
    background: var(--border);
  }

  .error {
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 10;
    max-width: 420px;
    margin: 0;
    padding: 10px 12px;
    border: 1px solid #7f3030;
    border-radius: 8px;
    background: #2a1414;
    color: #ff9b9b;
    font-size: 13px;
  }
</style>
