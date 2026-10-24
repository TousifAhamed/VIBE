import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { DataZoomComponent, GridComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([BarChart, LineChart, PieChart, GridComponent, TooltipComponent, DataZoomComponent, CanvasRenderer]);

export type ChartKind = 'bar' | 'line' | 'pie';

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;
}

/**
 * One interactive chart. Clicking a category marks it (ctrl/cmd-click adds
 * to the marking) and the grid filters to the marked rows, like marking in
 * Spotfire.
 */
export class InteractiveChart {
  private readonly chart: echarts.ECharts;
  private labels: string[] = [];
  private values: number[] = [];
  private kind: ChartKind = 'bar';
  private measure = '';
  private marked = new Set<string>();

  constructor(
    host: HTMLElement,
    private readonly onMark: (labels: string[]) => void,
  ) {
    this.chart = echarts.init(host, undefined, { renderer: 'canvas' });
    new ResizeObserver(() => this.chart.resize()).observe(host);
    // Pie slices are hit directly; for bar and line charts a click anywhere in
    // a category's column marks it, which is far easier to hit than a thin bar.
    this.chart.on('click', (p) => {
      if (this.kind === 'pie') {
        this.toggle(p.dataIndex as number, p.event?.event as MouseEvent | undefined);
      }
    });
    this.chart.getZr().on('click', (e) => {
      if (this.kind === 'pie' || this.labels.length === 0) {
        return;
      }
      const point = [e.offsetX, e.offsetY];
      if (!this.chart.containPixel({ gridIndex: 0 }, point)) {
        return;
      }
      const [index] = this.chart.convertFromPixel({ seriesIndex: 0 }, point) as number[];
      if (index >= 0 && index < this.labels.length) {
        this.toggle(Math.round(index), e.event as MouseEvent | undefined);
      }
    });
  }

  private toggle(index: number, e: MouseEvent | undefined): void {
    const label = this.labels[index];
    if (label === undefined) {
      return;
    }
    const additive = !!e && (e.ctrlKey || e.metaKey || e.shiftKey);
    if (additive) {
      if (this.marked.has(label)) {
        this.marked.delete(label);
      } else {
        this.marked.add(label);
      }
    } else {
      this.marked = this.marked.size === 1 && this.marked.has(label) ? new Set() : new Set([label]);
    }
    this.render();
    this.onMark([...this.marked]);
  }

  clearMarking(): void {
    this.marked.clear();
    this.render();
  }

  setData(kind: ChartKind, measure: string, labels: string[], values: number[]): void {
    this.kind = kind;
    this.measure = measure;
    this.labels = labels;
    this.values = values;
    this.marked = new Set([...this.marked].filter((m) => labels.includes(m)));
    this.render();
  }

  private render(): void {
    const fg = cssVar('--vscode-foreground', '#ccc');
    const muted = cssVar('--vscode-descriptionForeground', '#999');
    const accent = cssVar('--vscode-charts-blue', '#3b82f6');
    const markColor = cssVar('--vscode-charts-orange', '#f59e0b');
    const gridLine = cssVar('--vscode-panel-border', 'rgba(128,128,128,0.25)');
    const anyMarked = this.marked.size > 0;
    const colorFor = (label: string) => (this.marked.has(label) ? markColor : anyMarked ? fadeColor(accent) : accent);

    const tooltip = {
      trigger: this.kind === 'pie' ? ('item' as const) : ('axis' as const),
      valueFormatter: (v: unknown) => (typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(v)),
    };

    if (this.kind === 'pie') {
      this.chart.setOption(
        {
          animationDuration: 300,
          tooltip,
          series: [
            {
              type: 'pie',
              name: this.measure,
              radius: ['35%', '70%'],
              label: { color: fg },
              data: this.labels.map((l, i) => ({
                name: l,
                value: this.values[i],
                selected: this.marked.has(l),
                itemStyle: anyMarked && !this.marked.has(l) ? { opacity: 0.35 } : {},
              })),
            },
          ],
        },
        true,
      );
      return;
    }

    this.chart.setOption(
      {
        animationDuration: 300,
        tooltip,
        grid: { left: 12, right: 16, top: 32, bottom: this.labels.length > 25 ? 40 : 12, containLabel: true },
        xAxis: {
          type: 'category',
          data: this.labels,
          axisLabel: {
            color: muted,
            rotate: this.labels.length > 8 ? 40 : 0,
            interval: this.labels.length > 25 ? 'auto' : 0,
            width: 90,
            overflow: 'truncate',
          },
          axisLine: { lineStyle: { color: gridLine } },
        },
        yAxis: {
          type: 'value',
          name: this.measure,
          nameTextStyle: { color: muted, align: 'left' },
          axisLabel: { color: muted },
          splitLine: { lineStyle: { color: gridLine } },
        },
        dataZoom: this.labels.length > 25 ? [{ type: 'inside' }, { type: 'slider', height: 16, bottom: 10 }] : [],
        series: [
          {
            type: this.kind,
            name: this.measure,
            smooth: this.kind === 'line',
            symbolSize: 7,
            lineStyle: { color: accent, width: 2 },
            data: this.values.map((v, i) => ({ value: v, itemStyle: { color: colorFor(this.labels[i]), borderRadius: [3, 3, 0, 0] } })),
          },
        ],
      },
      true,
    );
  }
}

function fadeColor(color: string): string {
  return color.startsWith('#') && color.length === 7 ? `${color}59` : color;
}
