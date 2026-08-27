<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { Application, TextureSource, UPDATE_PRIORITY, type Ticker } from 'pixi.js';

  import {
    AudioClock,
    LeadInClock,
    SystemClock,
    leadInFor,
    type PlaybackClock,
  } from './lib/audio/index.ts';
  import type { AvailableSkin, BundledChart, ImportedChart } from './lib/audio/types.ts';
  import { PlayableChart } from './lib/chart/playable-chart.ts';
  import {
    ColumnInput,
    defaultLayout,
    meanError,
    offsetIsWorthMoving,
    rulesetFor,
    suggestedOffsetMs,
    summariseErrors,
    unstableRate,
  } from './lib/gameplay/index.ts';
  import type { ErrorSummary, Judge, Ruleset } from './lib/gameplay/index.ts';
  import { FrameCounter, Playfield, SkinTheme } from './lib/render/index.ts';

  /** How long a judgement stays on screen. */
  const JUDGEMENT_FLASH_MS = 500;

  /**
   * The renderer backend to ask Pixi for.
   *
   * Kept as a constant so the HUD can say whether it was honoured. Pixi falls back without
   * complaint, and on Linux there is a real chance of it: WebGPU means Vulkan, and
   * Chromium refuses Vulkan under the Wayland ozone platform. Silently ending up on WebGL
   * matters when the point of the session is comparing how skins look, because filtering
   * and blending are not identical between the two.
   */
  const RENDERER_PREFERENCE = 'webgpu';

  /**
   * How far the mean has to sit from zero before moving the offset is worth it.
   *
   * Below this it is noise from a handful of notes rather than a real bias, and chasing it
   * would have the player re-calibrating after every play.
   */
  const OFFSET_WORTH_MOVING_MS = 5;

  /** The range the offset slider covers, and so the range a suggestion may land in. */
  const OFFSET_LIMIT_MS = 100;

  /**
   * The canvas formats worth swapping Pixi's default for.
   *
   * `getPreferredCanvasFormat` is typed as the whole of `GPUTextureFormat`, but the spec
   * only ever returns one of these two, and they are the only ones Pixi models. Checking
   * rather than casting means an unexpected answer leaves Pixi's own default alone instead
   * of forcing it into a format it cannot describe.
   */
  const CANVAS_FORMATS = ['bgra8unorm', 'rgba8unorm'] as const;

  function preferredCanvasFormat(): (typeof CANVAS_FORMATS)[number] | null {
    const preferred = navigator.gpu?.getPreferredCanvasFormat();
    return CANVAS_FORMATS.find((format) => format === preferred) ?? null;
  }

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

  /**
   * The approach before the music starts.
   *
   * Wraps whichever clock is really timing the chart, and reports negative time until it
   * takes over. A chart whose first note lands a fraction of a second in is unplayable
   * without one.
   */
  const leadIn = new LeadInClock(audioClock);

  /** How long this chart waits before its music starts. Zero when its intro has room. */
  let leadInMs = $state(0);

  /**
   * When nothing is left to judge, in chart milliseconds.
   *
   * The last note's own end plus however long it stays reachable — so the play is over the
   * moment the final judgement can no longer change, rather than when the audio runs out,
   * which on most charts is much later.
   */
  let finishedAtMs = $state(Infinity);

  /**
   * The summary shown once the play is over. `null` while playing or before starting.
   *
   * Presses and releases are summarised apart. A release is its own judgement on its own
   * window, so its average answers a different question — and it is the presses alone that
   * the offset should be calibrated from.
   */
  let result = $state.raw<{ press: ErrorSummary; release: ErrorSummary } | null>(null);

  /** The backend Pixi actually built, which is not always the one that was asked for. */
  let backend = $state('');

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
  const input = new ColumnInput(leadIn, {
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
    combo: 0, maxCombo: 0, accuracy: 1, unstableRate: 0, meanErrorMs: 0,
    counts: {} as Record<string, number>,
    syncErrorMs: 0, roundTripMs: 0, voices: 0, droppedSamples: 0,
    fps: 0, frameMs: 0, worstMs: 0, updateMs: 0, worstUpdateMs: 0, load: 0, longFrames: 0,
    renderMs: 0, worstRenderMs: 0,
  });

  onMount(async () => {
    // Match the canvas to the format the device actually wants.
    //
    // Pixi defaults to `bgra8unorm`, and a device that prefers something else has to copy
    // the whole surface every frame to convert it — Chromium says so in the console and
    // then does it anyway. Asking removes the copy, and on a device that already prefers
    // `bgra8unorm` this changes nothing.
    const preferredFormat = preferredCanvasFormat();
    if (preferredFormat) TextureSource.defaultOptions.format = preferredFormat;

    app = new Application();
    await app.init({
      resizeTo: stage,
      backgroundColor: 0x0d0d12,
      antialias: true,
      preference: RENDERER_PREFERENCE,
    });
    stage.appendChild(app.canvas);
    backend = app.renderer.name;
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

    // Bracket the renderer's own pass. Pixi registers `render` at LOW, and our `tick` runs
    // at NORMAL — before it — so the work timer above never saw a single draw call. Reading
    // "0% of budget" off a number that excluded the entire render is how an LN-heavy chart
    // could stutter while the HUD claimed there was nothing to it.
    app.ticker.add(markRenderStart, undefined, UPDATE_PRIORITY.LOW + 1);
    app.ticker.add(markRenderEnd, undefined, UPDATE_PRIORITY.LOW - 1);
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
      playfield?.setLatestHitMs(judge.latestHitMs);
      playfield?.drawLanes(playable);

      clock = leadIn;
      input.clock = leadIn;
      silent = false;

      // osu starts gameplay two seconds before the first note — `GameplayStartTime` is
      // `first.StartTime - 2000` — delaying the music itself when the intro is too short.
      // Without it a chart that opens on the beat is unreadable: the note is on the
      // receptor before the player has looked at it.
      const firstNoteMs = imported.chart.notes[0]?.timeMs ?? 0;
      leadInMs = leadInFor(firstNoteMs, imported.chart.audio?.leadInMs ?? 0);

      result = null;

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

      // Only now, because the clock clamps its position to the length of what was decoded.
      // A chart whose last note sits near the end of its audio would otherwise never reach
      // a deadline past that length, and the play would never be seen to finish.
      let lastNoteMs = 0;
      for (const note of imported.chart.notes) {
        lastNoteMs = Math.max(lastNoteMs, note.endMs ?? note.timeMs);
      }
      finishedAtMs = Math.min(
        lastNoteMs + judge.latestHitMs,
        audioClock.info?.durationMs ?? Infinity,
      );

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
      result = null;
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
        systemClock.start(-leadInMs);
      } else {
        // The approach starts now and the music starts when it runs out. Awaiting the
        // audio here instead would spend the whole lead-in inside `play()`, which is the
        // one thing the lead-in exists to avoid.
        leadIn.begin(leadInMs);
        const start = playing ? () => audioClock.restart() : () => audioClock.play();
        const begin = () => start().then(() => leadIn.handOver());

        if (leadInMs > 0) setTimeout(() => void begin().catch(report), leadInMs);
        else await begin();
      }

      playing = true;
      status = silent ? 'playing (silent)' : 'playing';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  /** Takes the summary's advice and dials it into the engine. */
  function applySuggestedOffset() {
    if (!result) return;

    // Clamped to what the slider can show. Letting the engine hold a value the control
    // cannot display would leave the two disagreeing with no way to see it.
    const suggested = Math.round(suggestedOffsetMs(audioOffsetMs, result.press));
    audioOffsetMs = Math.max(-OFFSET_LIMIT_MS, Math.min(OFFSET_LIMIT_MS, suggested));
    void window.electronAPI.audio.setOffsetMs(audioOffsetMs);
  }

  function report(e: unknown) {
    error = e instanceof Error ? e.message : String(e);
  }

  function rebuild() {
    if (!imported) return;
    playable = new PlayableChart(imported.chart, { constantVelocity });
    judge = ruleset?.createJudge(playable) ?? null;
    if (judge) playfield?.setLatestHitMs(judge.latestHitMs);
    playfield?.drawLanes(playable);
    playing = false;
  }

  /** Wall clock at the instant Pixi is about to render, set by a ticker callback. */
  let renderStartedAt = 0;

  function markRenderStart() {
    renderStartedAt = performance.now();
  }

  function markRenderEnd() {
    frames.recordRender(performance.now() - renderStartedAt);
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

      // The play ends when the last judgement can no longer change, not when the audio
      // stops: a chart's outro can run for another minute and there is nothing left to do
      // in it.
      if (playing && judge && !result && positionMs >= finishedAtMs) {
        result = {
          press: summariseErrors(judge.pressErrors),
          release: summariseErrors(judge.releaseErrors),
        };
      }

      if (playing && judge) {
        // Writing off expired notes runs on time, never on screen position: a chart can
        // hide notes entirely or freeze them in place, and both still have to be judged.
        for (const event of judge.update(positionMs)) flash(event.judgement, event.errorMs, event.column);

        hud.combo = judge.combo;
        hud.maxCombo = judge.maxCombo;
        hud.accuracy = judge.accuracy;
        hud.unstableRate = unstableRate(judge.pressErrors);
        hud.meanErrorMs = meanError(judge.pressErrors);
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

      // Read through `hud` rather than straight off the clock in the template. `audioClock`
      // is an ordinary class instance, not `$state`, so a text node that reads its fields
      // has nothing reactive to depend on and renders once with whatever it said at start
      // up — which is how the sync readouts sat at zero all the way through a play.
      hud.syncErrorMs = audioClock.syncErrorMs;
      hud.roundTripMs = audioClock.roundTripMs;
      hud.voices = audioClock.stats?.activeVoices ?? 0;
      hud.droppedSamples = audioClock.stats?.droppedSamples ?? 0;

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
    hud.renderMs = frames.renderMs;
    hud.worstRenderMs = frames.worstRenderMs;
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
    <input type="range" min={-OFFSET_LIMIT_MS} max={OFFSET_LIMIT_MS} step="1" bind:value={audioOffsetMs}
      oninput={() => void window.electronAPI.audio.setOffsetMs(audioOffsetMs)} />
    {audioOffsetMs > 0 ? '+' : ''}{audioOffsetMs} ms
  </label>

  <label class="speed"
    title="Draw this many frames ahead of the audio, to cancel the delay between a frame being computed and appearing. Moves the picture only — never the judgement.">
    draw ahead
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
  <!-- Whether Pixi got the backend it was asked for. Always visible: a fallback is not an
       error, but finding out only after loading a chart is no use when the question is
       whether to trust what you are looking at. -->
  <span class="backend" class:warn={backend !== '' && backend !== RENDERER_PREFERENCE}
    title={backend === RENDERER_PREFERENCE
      ? `Rendering with ${backend}, as requested`
      : `Asked for ${RENDERER_PREFERENCE}, got ${backend} — filtering and blending differ between the two`}>
    {backend || '…'}
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
    <!-- Spread is skill; a mean far from zero is calibration, and practice will not move
         it. If this sits at -20 ms you are hitting early and the offset wants +20. -->
    <div class:warn={Math.abs(hud.meanErrorMs) > 10}>
      mean {hud.meanErrorMs > 0 ? '+' : ''}{hud.meanErrorMs.toFixed(1)} ms
      <span class="dim">{Math.abs(hud.meanErrorMs) > 10 ? (hud.meanErrorMs < 0 ? '· early' : '· late') : ''}</span>
    </div>
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
        sync {hud.syncErrorMs.toFixed(2)} ms · rtt {hud.roundTripMs.toFixed(2)} ms
        {useWallClock ? ' · WALL CLOCK' : ''}
      </div>
      <div class="dim">
        voices {hud.voices}
        {#if hud.droppedSamples > 0}
          <span class="warn">· {hud.droppedSamples} dropped</span>
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
    <!-- The renderer turning that into draw calls, which the line above never included. -->
    <div class:warn={hud.renderMs + hud.updateMs > frames.displayPeriodMs * 0.5}>
      render {hud.renderMs.toFixed(2)} ms
      <span class="dim">· worst {hud.worstRenderMs.toFixed(2)}</span>
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

<!-- The end-of-play summary. Its whole job is answering one question — does the offset
     need moving — so the two halves and the suggestion are the point, and everything else
     is context for them. -->
{#if result}
  <div class="result">
    <div class="result-head">
      {((judge?.accuracy ?? 0) * 100).toFixed(2)}%
      <span class="dim">· {judge?.maxCombo ?? 0}x max</span>
    </div>

    <div class="rule"></div>

    {#if result.press.total === 0 && result.release.total === 0}
      <div class="dim">nothing was judged, so there is no timing to read</div>
    {:else}
      <div class="grid">
        <span></span>
        <span class="dim">early</span>
        <span class="dim">late</span>
        <span class="dim">mean</span>

        <span class="dim row">hits</span>
        <span class="early">{result.press.earlyMean.toFixed(1)}<small>{result.press.earlyCount}</small></span>
        <span class="late">+{result.press.lateMean.toFixed(1)}<small>{result.press.lateCount}</small></span>
        <strong class:warn={offsetIsWorthMoving(result.press, OFFSET_WORTH_MOVING_MS)}>
          {result.press.mean > 0 ? '+' : ''}{result.press.mean.toFixed(1)}
        </strong>

        <!-- Releases only exist on a chart with holds, and their window is half again as
             wide, so their average is its own reading rather than part of the one above. -->
        {#if result.release.total > 0}
          <span class="dim row">releases</span>
          <span class="early">{result.release.earlyMean.toFixed(1)}<small>{result.release.earlyCount}</small></span>
          <span class="late">+{result.release.lateMean.toFixed(1)}<small>{result.release.lateCount}</small></span>
          <strong>{result.release.mean > 0 ? '+' : ''}{result.release.mean.toFixed(1)}</strong>
        {/if}
      </div>

      <div class="dim">
        ± {result.press.standardError.toFixed(1)} on the hits · UR {unstableRate(
          judge?.pressErrors ?? [],
        ).toFixed(1)}
      </div>

      <div class="rule"></div>

      {#if offsetIsWorthMoving(result.press, OFFSET_WORTH_MOVING_MS)}
        <button class="apply" onclick={applySuggestedOffset}>
          set offset to {suggestedOffsetMs(audioOffsetMs, result.press) > 0 ? '+' : ''}{Math.round(
            suggestedOffsetMs(audioOffsetMs, result.press),
          )} ms
        </button>
        <div class="dim hint">
          you hit {Math.abs(result.press.mean).toFixed(0)} ms
          {result.press.mean < 0 ? 'early' : 'late'} on average, by more than the scatter can
          account for
        </div>
      {:else if Math.abs(result.press.mean) > OFFSET_WORTH_MOVING_MS}
        <div class="dim hint">
          the mean is off centre but the scatter is wider than the gap — play it again before
          trusting it
        </div>
      {:else}
        <div class="dim hint">
          centred within {OFFSET_WORTH_MOVING_MS} ms — the offset is fine, the spread is practice
        </div>
      {/if}
    {/if}
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

  .backend {
    font-family: ui-monospace, monospace;
    font-size: 12px;
    color: var(--muted);
  }

  .backend.warn {
    color: #ffb454;
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

  .result {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 20;
    min-width: 260px;
    padding: 16px 20px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: color-mix(in srgb, var(--panel) 96%, transparent);
    font-family: ui-monospace, 'IBM Plex Mono', monospace;
    font-size: 13px;
    line-height: 1.6;
    text-align: center;
  }

  .result-head {
    font-size: 20px;
  }

  .grid {
    display: grid;
    grid-template-columns: auto repeat(3, minmax(64px, auto));
    align-items: baseline;
    justify-content: center;
    gap: 2px 14px;
    margin: 6px 0 2px;
    font-size: 15px;
  }

  .grid .dim {
    font-size: 11px;
  }

  .grid .row {
    text-align: right;
    padding-right: 4px;
  }

  .grid small {
    display: block;
    font-size: 10px;
    color: var(--muted);
  }

  .grid strong {
    font-weight: 500;
  }

  .early { color: #8ad7ff; }
  .late  { color: #ffb454; }

  .apply {
    font: inherit;
    color: var(--text);
    background: #1e1e28;
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 6px 12px;
    cursor: pointer;
  }

  .hint {
    margin-top: 6px;
    font-size: 11px;
    max-width: 30ch;
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
