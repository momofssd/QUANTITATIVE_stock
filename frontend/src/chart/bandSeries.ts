/**
 * Custom Lightweight Charts series that shades the area between two values (used for the Bollinger Bands).
 * The library has no built-in "fill between two lines", so this draws the polygon itself.
 */
import {
  customSeriesDefaultOptions,
  type CustomData,
  type CustomSeriesOptions,
  type CustomSeriesPricePlotValues,
  type CustomSeriesWhitespaceData,
  type ICustomSeriesPaneRenderer,
  type ICustomSeriesPaneView,
  type PaneRendererCustomData,
  type PriceToCoordinateConverter,
  type Time,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";

export interface BandData extends CustomData<Time> {
  upper: number;
  lower: number;
}

export interface BandOptions extends CustomSeriesOptions {
  fillColor: string;
}

class BandRenderer implements ICustomSeriesPaneRenderer {
  data: PaneRendererCustomData<Time, BandData> | null = null;
  options: BandOptions | null = null;

  draw(target: CanvasRenderingTarget2D, toY: PriceToCoordinateConverter): void {
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      const d = this.data;
      if (!d || !d.visibleRange || !this.options) return;
      ctx.fillStyle = this.options.fillColor;
      let seg: { x: number; yu: number; yl: number }[] = [];
      const flush = () => {
        if (seg.length > 1) {
          ctx.beginPath();
          ctx.moveTo(seg[0].x, seg[0].yu);
          for (const p of seg) ctx.lineTo(p.x, p.yu);
          for (let i = seg.length - 1; i >= 0; i--) ctx.lineTo(seg[i].x, seg[i].yl);
          ctx.closePath();
          ctx.fill();
        }
        seg = [];
      };
      const from = Math.max(0, d.visibleRange.from - 1);
      const to = Math.min(d.bars.length, d.visibleRange.to + 1);
      for (let i = from; i < to; i++) {
        const bar = d.bars[i];
        const v = bar.originalData;
        const yu = v.upper === undefined ? null : toY(v.upper);
        const yl = v.lower === undefined ? null : toY(v.lower);
        if (yu === null || yl === null) {
          flush(); // gap (e.g. before the band has enough bars)
          continue;
        }
        seg.push({ x: bar.x * hr, yu: yu * vr, yl: yl * vr });
      }
      flush();
    });
  }
}

export class BandFillSeries implements ICustomSeriesPaneView<Time, BandData, BandOptions> {
  private readonly r = new BandRenderer();

  renderer(): ICustomSeriesPaneRenderer {
    return this.r;
  }

  update(data: PaneRendererCustomData<Time, BandData>, options: BandOptions): void {
    this.r.data = data;
    this.r.options = options;
  }

  priceValueBuilder(d: BandData): CustomSeriesPricePlotValues {
    return [d.lower, d.upper, d.upper];
  }

  isWhitespace(d: BandData | CustomSeriesWhitespaceData<Time>): d is CustomSeriesWhitespaceData<Time> {
    return (d as BandData).upper === undefined || (d as BandData).lower === undefined;
  }

  defaultOptions(): BandOptions {
    return { ...customSeriesDefaultOptions, fillColor: "rgba(0, 151, 167, 0.10)" };
  }
}
