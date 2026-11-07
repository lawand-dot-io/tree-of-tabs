import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASK_AFTER_DAYS, ASK_AFTER_DAYS_USED, countDay, shouldAsk, today } from '../src/review.js';

test('the first day starts the count', () => {
  assert.deepEqual(countDay(undefined, 100), { firstDay: 100, lastDay: 100, daysUsed: 1 });
});

test('opening the tree again the same day counts once', () => {
  const usage = countDay(undefined, 100);
  assert.equal(countDay(usage, 100), usage);
});

test('each new day counts once, gaps or not', () => {
  let usage = countDay(undefined, 100);
  for (const day of [101, 101, 105, 120]) usage = countDay(usage, day);
  assert.deepEqual(usage, { firstDay: 100, lastDay: 120, daysUsed: 4 });
});

test('a clock set back does not count or undo days', () => {
  const usage = { firstDay: 100, lastDay: 110, daysUsed: 5 };
  assert.equal(countDay(usage, 104), usage);
});

test('nobody is asked before using it for long enough', () => {
  assert.equal(shouldAsk(undefined, 500), false);
  // Every day, but not for two weeks yet.
  assert.equal(shouldAsk({ firstDay: 100, lastDay: 112, daysUsed: 13 }, 100 + ASK_AFTER_DAYS - 1), false);
  // Long ago, but only on a few days.
  assert.equal(shouldAsk({ firstDay: 100, lastDay: 200, daysUsed: ASK_AFTER_DAYS_USED - 1 }, 300), false);
});

test('people who use it get asked', () => {
  assert.equal(shouldAsk({ firstDay: 100, lastDay: 114, daysUsed: ASK_AFTER_DAYS_USED }, 100 + ASK_AFTER_DAYS), true);
});

test('a day starts at local midnight', () => {
  const evening = new Date(2026, 10, 7, 23, 59);
  const morning = new Date(2026, 10, 8, 0, 1);
  assert.equal(today(morning) - today(evening), 1);
  assert.equal(today(new Date(2026, 10, 7, 0, 1)), today(evening));
});
