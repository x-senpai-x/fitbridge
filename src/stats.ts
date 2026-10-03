export function mean(xs: readonly number[]): number {
  return xs.reduce((sum, x) => sum + x, 0) / xs.length;
}

export function median(xs: readonly number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? NaN) : ((sorted[mid - 1] ?? NaN) + (sorted[mid] ?? NaN)) / 2;
}

export function sampleSd(xs: readonly number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((sum, x) => sum + (x - m) ** 2, 0) / (xs.length - 1));
}

// Least-squares slope of y over x.
export function slope(xs: readonly number[], ys: readonly number[]): number | null {
  if (xs.length < 2) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  xs.forEach((x, i) => {
    sxy += (x - mx) * ((ys[i] ?? my) - my);
    sxx += (x - mx) ** 2;
  });
  return sxx === 0 ? null : sxy / sxx;
}

export function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  if (xs.length < 3) return null;
  // Exact test: a constant with a fractional part has a mean that is not exactly the constant.
  if (xs.every((x) => x === xs[0]) || ys.every((y) => y === ys[0])) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  xs.forEach((x, i) => {
    const dy = (ys[i] ?? my) - my;
    sxy += (x - mx) * dy;
    sxx += (x - mx) ** 2;
    syy += dy ** 2;
  });
  return sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy);
}

// Ranks from 1, ties sharing their average rank.
export function ranks(xs: readonly number[]): number[] {
  const order = xs.map((x, i) => ({ x, i })).sort((a, b) => a.x - b.x);
  const out = new Array<number>(xs.length).fill(0);
  for (let start = 0; start < order.length;) {
    let end = start;
    while (end + 1 < order.length && order[end + 1]?.x === order[start]?.x) end++;
    for (let k = start; k <= end; k++) out[order[k]?.i ?? 0] = (start + end) / 2 + 1;
    start = end + 1;
  }
  return out;
}

export function spearman(xs: readonly number[], ys: readonly number[]): number | null {
  return pearson(ranks(xs), ranks(ys));
}
