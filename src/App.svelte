<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { Application, type Ticker } from 'pixi.js';

  import { AudioClock } from './lib/audio/index.ts';
  import type { BundledChart, ImportedChart } from './lib/audio/types.ts';
  import { PlayableChart } from './lib/chart/playable-chart.ts';
  import { FrameCounter, Playfield } from './lib/render/index.ts';

  /** Judgement window used only to retire notes while there is no input yet. */
  const LATE_WINDOW_MS = 180;

  let stage: HTMLDivElement;
  let app: Application | null = null;
  let playfield: Playfield | null = null;

  const clock = new AudioClock();
  const frames = new FrameCounter();
  // Reactive: the HUD reads both, so Svelte has to see them change.
  let playable = $state<PlayableChart | null>(null);
  let imported = $state<ImportedChart | null>(null);

  let available = $state<BundledChart[]>([]);
  let selected = $state('');
  let status = $state('starting up');
  let error = $state<string | null>(null);
  let ready = $state(false);
  let playing = $state(false);
  let constantVelocity = $state(false);
  let travelMs = $state(700);

  // Diagnostics, refreshed from the render loop.
  let hud = $state({
    positionMs: 0, scroll: 0, velocity: 1, drawn: 0, missed: 0,
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
    void clock.unload();
  });

  function onResize() {
    if (playable && playfield) playfield.drawLanes(playable);
  }

  async function load() {
    error = null;
    ready = false;
    playing = false;
    status = 'converting…';

    try {
      imported = await window.electronAPI.chart.importOsu(selected);
      playable = new PlayableChart(imported.chart, { constantVelocity });
      playfield?.drawLanes(playable);

      if (!imported.audioPath) {
        // A fully keysounded chart has no track to play, and the engine cannot yet
        // mix its samples, so it can be drawn but not heard.
        status = 'no background track — this chart is keysounded, so it will be silent';
        ready = true;
        return;
      }

      status = 'decoding audio…';
      await clock.load(imported.audioPath);

      status = 'waiting for the device…';
      if (!(await clock.waitUntilReady())) {
        error = 'the audio device never came up';
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
      playable.reset();
      // The tally is per attempt: hitches from loading say nothing about this run.
      frames.reset();
      hud.missed = 0;
      if (imported?.audioPath) {
        if (playing) await clock.restart();
        else await clock.play();
      }
      playing = true;
      status = 'playing';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function rebuild() {
    if (!imported) return;
    playable = new PlayableChart(imported.chart, { constantVelocity });
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
      const positionMs = clock.isRunning ? clock.positionMs() : 0;
      const scroll = playable.scroll.positionAt(positionMs);

      if (playing) {
        // Retiring runs on time, never on screen position: a chart can hide notes
        // entirely or freeze them in place, and both still have to be judged.
        hud.missed += playable.retireExpired(positionMs, LATE_WINDOW_MS);
      }

      playfield.draw(playable, scroll);

      hud.positionMs = positionMs;
      hud.scroll = scroll;
      hud.velocity = playable.scroll.velocityAt(positionMs);
      hud.drawn = playfield.drawnCount;
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

  function onKey(event: KeyboardEvent) {
    if (event.code === 'Space') {
      event.preventDefault();
      void start();
    }
  }
</script>

<svelte:window on:keydown={onKey} />

<div class="stage" bind:this={stage}></div>

<div class="panel">
  <select bind:value={selected} disabled={!available.length}>
    {#each available as chart (chart.path)}
      <option value={chart.path}>{chart.name}</option>
    {/each}
  </select>

  <button onclick={load} disabled={!selected}>Load</button>
  <button onclick={start} disabled={!ready}>{playing ? 'Restart' : 'Play'}</button>

  <label>
    <input type="checkbox" bind:checked={constantVelocity} onchange={rebuild} />
    no SV
  </label>

  <label class="speed">
    speed
    <input type="range" min="250" max="1500" step="50" bind:value={travelMs}
      oninput={() => playfield?.setTravelMs(travelMs)} />
    {travelMs} ms
  </label>

  <span class="status">{status}</span>
</div>

{#if playable}
  <div class="hud">
    <div>{imported?.summary.artist} — {imported?.summary.title}</div>
    <div class="dim">[{imported?.summary.difficultyName}] · {playable.chart.columns.length}K · {playable.chart.notes.length} notes</div>
    <div>pos {hud.positionMs.toFixed(0)} ms</div>
    <div>scroll {hud.scroll.toFixed(0)}</div>
    <div>velocity {hud.velocity < 0.01 || hud.velocity > 100 ? hud.velocity.toExponential(2) : hud.velocity.toFixed(3)}x</div>
    <div>drawn {hud.drawn}</div>
    <div>missed {hud.missed}</div>
    <div class="dim">sync {clock.syncErrorMs.toFixed(2)} ms · rtt {clock.roundTripMs.toFixed(2)} ms</div>
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

  .status {
    margin-left: auto;
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
