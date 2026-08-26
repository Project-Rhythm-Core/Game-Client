import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Lane geometry, extracted from the playfield so it can be tested without a canvas.
 *
 * This mirrors what `measureLanes` does. The bug it exists to pin down was silent: a
 * miscounted separator list left later lanes at NaN, and lanes simply stopped being
 * drawn with nothing reported anywhere.
 */
function measureLanes(
  screenWidth: number,
  screenHeight: number,
  columnWidths: number[],
  lineWidths: number[],
  virtualHeight = 480,
): { x: number[]; widths: number[] } {
  const scale = screenHeight / virtualHeight;
  const widths = columnWidths.map((w) => w * scale);
  const lines = Array.from({ length: widths.length + 1 }, (_, i) => (lineWidths[i] ?? 0) * scale);

  const total = widths.reduce((s, w) => s + w, 0) + lines.reduce((s, l) => s + l, 0);
  let x = (screenWidth - total) / 2;

  return {
    widths,
    x: widths.map((width, index) => {
      x += lines[index];
      const left = x;
      x += width;
      return left;
    }),
  };
}

test('every lane gets a finite position', () => {
  const { x } = measureLanes(1920, 982, new Array(10).fill(50), [0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0]);

  assert.equal(x.length, 10);
  assert.ok(x.every(Number.isFinite), `got ${x}`);
});

test('a separator list shorter than the lane count does not poison later lanes', () => {
  // What a stale count produced: a list sized for a narrower chart. Reading past its end
  // used to make every following position NaN, so the rightmost lanes vanished.
  const { x } = measureLanes(1920, 982, new Array(10).fill(50), [0, 0, 0, 0, 0, 0, 0, 0]);

  assert.ok(x.every(Number.isFinite), `later lanes went missing: ${x}`);
  assert.ok(x[9] > x[8], 'lanes must stay in order');
});

test('the stage scales with the window height', () => {
  const small = measureLanes(1280, 720, new Array(4).fill(50), []);
  const large = measureLanes(2560, 1440, new Array(4).fill(50), []);

  assert.ok(Math.abs(large.widths[0] / small.widths[0] - 2) < 1e-9, 'twice the height, twice the lane');
});

test('the stage stays centred', () => {
  const { x, widths } = measureLanes(1600, 900, new Array(7).fill(50), []);

  const left = x[0];
  const right = x[6] + widths[6];
  assert.ok(Math.abs((left + right) / 2 - 800) < 1e-6, `centre was ${(left + right) / 2}`);
});

test('a separator pushes the lanes after it across', () => {
  const withLine = measureLanes(1920, 480, new Array(10).fill(50), [0, 0, 0, 0, 0, 20, 0, 0, 0, 0, 0]);
  const without = measureLanes(1920, 480, new Array(10).fill(50), []);

  assert.equal(withLine.x[5] - withLine.x[4], 70, 'the gap carries the separator');
  assert.equal(without.x[5] - without.x[4], 50);
});

/**
 * Where the combo digits land, mirroring `drawCombo`.
 *
 * The number has to stay centred on the stage as it gains digits, and the overlap has to
 * pull the digits together without being counted once too often — an off-by-one there
 * drifts the number sideways only for particular combo lengths, which is exactly the kind
 * of thing that survives being looked at.
 */
function layOutCombo(
  digits: number[],
  digitWidth: number,
  overlap: number,
  stageLeft: number,
  stageRight: number,
): { x: number[]; total: number } {
  const total = digits.length * digitWidth - overlap * (digits.length - 1);
  let x = (stageLeft + stageRight - total) / 2;

  return {
    total,
    x: digits.map(() => {
      const left = x;
      x += digitWidth - overlap;
      return left;
    }),
  };
}

test('the combo stays centred on the stage however many digits it has', () => {
  const centre = (stage: { x: number[]; total: number }) => stage.x[0] + stage.total / 2;

  for (const length of [1, 2, 3, 5]) {
    const laid = layOutCombo(new Array(length).fill(7), 40, 12, 200, 600);
    assert.equal(centre(laid), 400, `${length} digits drifted off centre`);
  }
});

test('overlap is applied between digits and not after the last one', () => {
  const { x, total } = layOutCombo([1, 2, 3], 40, 12, 0, 0);

  // Three digits, two gaps: 3 * 40 - 2 * 12.
  assert.equal(total, 96);
  assert.equal(x[1] - x[0], 28);
  assert.equal(x[2] - x[1], 28);
});

/**
 * Receptor geometry, mirroring `buildKeyArea`.
 *
 * The height cannot come from the texture the way a note's does: a receptor is stretched
 * across its lane but keeps the height it was authored at, so the two are independent.
 */
function measureReceptor(
  laneWidthPx: number,
  keyHeightVirtual: number,
  screenHeight: number,
  virtualHeight = 480,
): { width: number; height: number; top: number } {
  const scale = screenHeight / virtualHeight;
  const height = keyHeightVirtual * scale;
  return { width: laneWidthPx, height, top: screenHeight - height };
}

test('a receptor reaches from the hit position to the foot of the stage', () => {
  // What the reference o2jam skin ships: a hit position 96 units above the foot, and a
  // receptor authored to be exactly that tall.
  const screenHeight = 960;
  const scale = screenHeight / 480;
  const { top } = measureReceptor(64, 95.9375, screenHeight);

  assert.ok(Math.abs(top - 384 * scale) < 1, `receptor top ${top}, hit position ${384 * scale}`);
});

test('a receptor keeps its authored height when the lane is narrow', () => {
  // A wide texture in a narrow lane must not squash vertically: the two are independent.
  const narrow = measureReceptor(20, 62.5, 480);
  const wide = measureReceptor(80, 62.5, 480);

  assert.equal(narrow.height, wide.height);
  assert.equal(narrow.height, 62.5);
});
