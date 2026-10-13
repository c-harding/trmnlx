// Contour lines from an elevation grid, for the contours map style (see map-drawing.ts): traced with
// d3-contour (marching squares, interpolated between samples), as lines rather than its polygons.
import { contours } from "d3-contour";

/** A level's contour lines, as points in the grid's units (0 to its width and height). */
export interface ContourLevel {
  /** Metres above sea level */
  level: number;
  /** An index contour: every fifth, drawn stronger */
  index: boolean;
  lines: { x: number; y: number }[][];
}

// Contour intervals to choose from (m): the usual 1, 2.5, 5 steps, at least 10 m, as the elevations
// are about 30 m apart in most of the world
const INTERVALS = [10, 25, 50, 100, 250, 500, 1000];
// The interval is about this many times the steep slopes' height difference per screen pixel: their
// lines about 2.5 px apart, which merge where it's steepest but leave gentler ground lines enough
// (chosen to match hand-picked intervals for maps from Snowdonia to Everest)
const SPACING = 2.5;
// How steep "the steep slopes" are: this share of the land is less steep
const STEEP = 0.9;

/**
 * Metres between contour lines for a grid of elevations (`width` × `height`, row by row), shown at
 * `cellsPerPixel` grid cells per screen pixel: from how steep its land is (see SPACING), the nearest
 * of INTERVALS (by ratio); undefined if there's no land to judge by. Every fifth is an index contour.
 */
export function slopeInterval(
  grid: ArrayLike<number>,
  width: number,
  height: number,
  cellsPerPixel: number,
): number | undefined {
  // The height difference per grid cell (central differences), above sea level only, where the
  // lines are
  const slopes: number[] = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      if (!(grid[y * width + x] > 1)) continue;
      const dx = (grid[y * width + x + 1] - grid[y * width + x - 1]) / 2;
      const dy = (grid[(y + 1) * width + x] - grid[(y - 1) * width + x]) / 2;
      slopes.push(Math.hypot(dx, dy));
    }
  }
  if (slopes.length === 0) return undefined;
  slopes.sort((a, b) => a - b);
  const target = SPACING * slopes[Math.floor(STEEP * (slopes.length - 1))] * cellsPerPixel;
  return INTERVALS.reduce((best, interval) =>
    Math.abs(Math.log(interval / target)) < Math.abs(Math.log(best / target)) ? interval : best,
  );
}

/**
 * Metres between contour lines at a zoom, where there's no land to judge by (see slopeInterval):
 * close enough to show a valley's shape, far enough apart that steep slopes don't turn black.
 */
export function contourInterval(zoom: number) {
  if (zoom >= 13.5) return 20;
  if (zoom >= 12.5) return 50;
  if (zoom >= 11.5) return 100;
  if (zoom >= 10) return 200;
  if (zoom >= 8) return 500;
  return 1000;
}

/**
 * The contour lines of a grid of elevations (`width` × `height`, row by row), every `interval`
 * metres above sea level (the sea's floor is left out: the coast comes from the water). d3-contour
 * gives each level's areas as polygons, closed along the grid's edge; those edges aren't contours,
 * so the rings are cut there into lines.
 */
export function contourLines(
  grid: ArrayLike<number>,
  width: number,
  height: number,
  interval: number,
): ContourLevel[] {
  let max = -Infinity;
  for (let i = 0; i < grid.length; i++) if (grid[i] > max) max = grid[i];
  const levels: number[] = [];
  for (let level = interval; level <= max; level += interval) levels.push(level);
  if (levels.length === 0) return [];
  const onEdge = ([x, y]: number[]) => x <= 0 || y <= 0 || x >= width || y >= height;
  return (
    contours()
      .size([width, height])
      // d3-contour only reads the values by index, so a typed array does without a copy
      .thresholds(levels)(grid as number[])
      .map((multi) => {
        const lines: { x: number; y: number }[][] = [];
        for (const polygon of multi.coordinates) {
          for (const ring of polygon) {
            let line: { x: number; y: number }[] = [];
            for (let k = 0; k < ring.length; k++) {
              // A step along the grid's edge ends the line there
              if (k > 0 && onEdge(ring[k - 1]) && onEdge(ring[k])) {
                if (line.length > 1) lines.push(line);
                line = [];
              }
              line.push({ x: ring[k][0], y: ring[k][1] });
            }
            if (line.length > 1) lines.push(line);
          }
        }
        return { level: multi.value, index: multi.value % (interval * 5) === 0, lines };
      })
      .filter((level) => level.lines.length > 0)
  );
}
