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

/**
 * Metres between contour lines at a zoom: close enough to show a valley's shape, far enough apart
 * that steep slopes don't turn black. Every fifth is an index contour.
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
