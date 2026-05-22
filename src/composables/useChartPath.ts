export function useChartPath(padding = 9) {
  const linePath = (pts: number[], w: number, h: number, max = 100) =>
    pts.map((p, i) => {
      const x = (i / (pts.length - 1)) * w;
      const y = h - (Math.min(p, max) / max) * (h - padding * 2) - padding;
      return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(' ');

  const areaPath = (pts: number[], w: number, h: number, max = 100) =>
    `${linePath(pts, w, h, max)} L${w} ${h} L0 ${h} Z`;

  return { linePath, areaPath };
}
