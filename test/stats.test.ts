import { describe, expect, it } from 'vitest';
import { mean, median, pearson, ranks, sampleSd, slope, spearman } from '../src/stats';

describe('statistics', () => {
  it.each([
    [[1, 2, 3, 4], 2.5, 2.5],
    [[3, 1, 2], 2, 2],
    [[7], 7, 7],
  ])('mean and median of %j', (xs, m, med) => {
    expect(mean(xs)).toBe(m);
    expect(median(xs)).toBe(med);
  });

  it('computes the sample standard deviation', () => {
    expect(sampleSd([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(Math.sqrt(32 / 7), 12);
    expect(sampleSd([5])).toBeNull();
  });

  it('computes the least-squares slope', () => {
    expect(slope([0, 1, 2, 3], [1, 3, 5, 7])).toBe(2);
    expect(slope([0, 1, 2, 3], [4, 4, 4, 4])).toBe(0);
    expect(slope([2, 2], [1, 5])).toBeNull();
    expect(slope([1], [1])).toBeNull();
  });

  it.each([
    [[1, 2, 3, 4, 5], [2, 4, 6, 8, 10], 1],
    [[1, 2, 3, 4, 5], [5, 4, 3, 2, 1], -1],
    [[1, 2, 3], [1, 3, 2], 0.5],
  ])('pearson %j %j = %d', (xs, ys, r) => {
    expect(pearson(xs, ys)).toBeCloseTo(r, 12);
  });

  it('returns null for pearson below 3 pairs or with a constant series', () => {
    expect(pearson([1, 2], [1, 2])).toBeNull();
    expect(pearson([1, 2, 3], [4, 4, 4])).toBeNull();
  });

  it('returns null for a constant series whose mean is not exactly the constant', () => {
    const steps = [1000, 2000, 3000, 4000, 5000, 6000, 7000];
    expect(pearson(steps, Array<number>(7).fill(44.3))).toBeNull();
    expect(pearson(Array<number>(10).fill(44.3), Array<number>(10).fill(70.3))).toBeNull();
    expect(spearman(steps, Array<number>(7).fill(44.3))).toBeNull();
  });

  it('averages tied ranks and makes spearman rank-based', () => {
    expect(ranks([10, 20, 20, 30])).toEqual([1, 2.5, 2.5, 4]);
    const xs = [1, 2, 3, 4, 5];
    const ys = [1, 4, 9, 16, 25];
    expect(spearman(xs, ys)).toBeCloseTo(1, 12);
    expect(pearson(xs, ys)).toBeCloseTo(0.9811049102515929, 12);
  });
});
