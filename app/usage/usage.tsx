'use client';

import { Block, Flexbox } from '@lobehub/ui';
import { Button, Select } from '@lobehub/ui/base-ui';
import { atom } from 'jotai';
import {
  ChartLine,
  ChartNoAxesCombined,
  LoaderCircle,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { createContext, useContext } from 'react';

export type UsageRange =
  '1h' | '3h' | '6h' | '12h' | '24h' | '3d' | '7d' | 'today' | 'yesterday';

export interface UsageBucketPoint {
  callCount: number;
  cacheHitTokens: number;
  label: string;
  start: string;
  totalTokens: number;
}

export interface UsageChartSeries {
  model: string;
  points: UsageBucketPoint[];
}

export interface UsageTableRow {
  callCount: number;
  cacheHitTokens: number;
  model: string;
  totalTokens: number;
}

export interface UsageFilterOption {
  label: string;
  value: string;
}

export interface UsageFiltersState {
  accessKey: string;
  credential: string;
  range: UsageRange;
}

export interface UsageState {
  autoRefreshSeconds: number;
  autoRefreshVisible: boolean;
  callSeries: UsageChartSeries[];
  filters: {
    accessKeys: UsageFilterOption[];
    credentials: UsageFilterOption[];
  };
  hoveredPoint: {
    chart: 'calls' | 'tokens';
    label: string;
    metricLabel: string;
    model: string;
    value: number;
    x: number;
    y: number;
  } | null;
  lastUpdatedAt: string;
  loading: boolean;
  request: UsageFiltersState;
  tableRows: UsageTableRow[];
  todaySummary: {
    cacheHitTokens: number;
    callCount: number;
    totalTokens: number;
  };
  tokenSeries: UsageChartSeries[];
}

export interface AdminUsageSnapshot {
  callSeries: UsageChartSeries[];
  filters: UsageState['filters'];
  range: UsageRange;
  tableRows: UsageTableRow[];
  todaySummary: UsageState['todaySummary'];
  tokenSeries: UsageChartSeries[];
  updatedAtLabel: string;
}

export interface UsageInitialData {
  usage?: AdminUsageSnapshot;
}

export const defaultUsageState: UsageState = {
  autoRefreshSeconds: 15,
  autoRefreshVisible: true,
  callSeries: [],
  filters: { accessKeys: [], credentials: [] },
  hoveredPoint: null,
  lastUpdatedAt: '',
  loading: true,
  request: { accessKey: 'all', credential: 'all', range: '24h' },
  tableRows: [],
  todaySummary: { cacheHitTokens: 0, callCount: 0, totalTokens: 0 },
  tokenSeries: [],
};

export const usageStateAtom = atom<UsageState>(defaultUsageState);

export const createUsageState = (initialData: UsageInitialData): UsageState => {
  return {
    ...defaultUsageState,
    callSeries: initialData.usage?.callSeries ?? [],
    filters: initialData.usage?.filters ?? defaultUsageState.filters,
    lastUpdatedAt: initialData.usage?.updatedAtLabel ?? '',
    loading: false,
    request: {
      ...defaultUsageState.request,
      range: initialData.usage?.range ?? '24h',
    },
    tableRows: initialData.usage?.tableRows ?? [],
    todaySummary:
      initialData.usage?.todaySummary ?? defaultUsageState.todaySummary,
    tokenSeries: initialData.usage?.tokenSeries ?? [],
  };
};

export interface UsageController {
  onAccessKeyChange: (value: string) => void;
  onAutoRefreshSecondsChange: (value: number) => void;
  onClearHistory: () => void;
  onCredentialChange: (value: string) => void;
  onHoverPoint: (point: UsageState['hoveredPoint']) => void;
  onRangeChange: (value: UsageRange) => void;
  onRefresh: () => void;
  usage: UsageState;
}

const UsageContext = createContext<UsageController | null>(null);
export const UsageProvider = UsageContext.Provider;

const useUsage = (): UsageController => {
  const controller = useContext(UsageContext);
  if (!controller) throw new Error('Usage controller is unavailable');
  return controller;
};

const chartColors = [
  '#1d4ed8',
  '#ea580c',
  '#059669',
  '#9333ea',
  '#dc2626',
  '#0891b2',
];

const getMonotoneLinePath = (points: Array<{ x: number; y: number }>) => {
  if (!points.length) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;

  const slopes = points.slice(1).map((point, index) => {
    const previousPoint = points[index];
    return (point.y - previousPoint.y) / (point.x - previousPoint.x);
  });
  const tangents = points.map((point, index) => {
    if (index === 0) return slopes[0];
    if (index === points.length - 1) return slopes.at(-1) ?? 0;

    const previousSlope = slopes[index - 1];
    const nextSlope = slopes[index];
    if (
      previousSlope === 0 ||
      nextSlope === 0 ||
      previousSlope * nextSlope < 0
    ) {
      return 0;
    }

    const previousDistance = point.x - points[index - 1].x;
    const nextDistance = points[index + 1].x - point.x;
    return (
      (2 * nextDistance +
        previousDistance +
        nextDistance +
        2 * previousDistance) /
      ((2 * nextDistance + previousDistance) / previousSlope +
        (nextDistance + 2 * previousDistance) / nextSlope)
    );
  });

  const segments = points.slice(1).map((point, index) => {
    const previousPoint = points[index];
    const horizontalDistance = point.x - previousPoint.x;
    return `C ${previousPoint.x + horizontalDistance / 3}, ${previousPoint.y + (tangents[index] * horizontalDistance) / 3}, ${point.x - horizontalDistance / 3}, ${point.y - (tangents[index + 1] * horizontalDistance) / 3}, ${point.x}, ${point.y}`;
  });

  return `M ${points[0].x} ${points[0].y} ${segments.join(' ')}`;
};

const formatNumber = (locale: string, value: number) =>
  new Intl.NumberFormat(locale).format(value);

const formatCompactNumber = (locale: string, value: number) => {
  const unit = [
    { divisor: 1_000_000_000, suffix: 'b' },
    { divisor: 1_000_000, suffix: 'm' },
    { divisor: 1_000, suffix: 'k' },
  ].find((item) => Math.abs(value) >= item.divisor);
  if (!unit) return formatNumber(locale, value);
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value / unit.divisor)}${unit.suffix}`;
};

const UsageChart = ({
  chart,
  chartWidth: width,
  emptyLabel,
  hoveredPoint,
  locale,
  metric,
  metricLabel,
  onHoverPoint,
  series,
  title,
}: {
  chart: 'calls' | 'tokens';
  chartWidth: number;
  emptyLabel: string;
  hoveredPoint: UsageState['hoveredPoint'];
  locale: string;
  metric: 'callCount' | 'totalTokens';
  metricLabel: string;
  onHoverPoint: (point: UsageState['hoveredPoint']) => void;
  series: UsageChartSeries[];
  title: string;
}) => {
  const height = 260;
  const padding = { bottom: 36, left: 52, right: 24, top: 16 };
  const labels = series[0]?.points.map((point) => point.label) ?? [];
  const pointCount = labels.length;
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const largestValue = Math.max(
    1,
    ...series.flatMap((item) => item.points.map((point) => point[metric])),
  );
  const gridStep = Math.max(5, Math.ceil(largestValue / 20) * 5);
  const gridStepCount = Math.ceil(largestValue / gridStep);
  const maxValue = gridStep * gridStepCount;
  const getX = (index: number) =>
    pointCount <= 1
      ? padding.left + chartWidth / 2
      : padding.left + (chartWidth / (pointCount - 1)) * index;
  const getY = (value: number) =>
    padding.top + chartHeight - (value / maxValue) * chartHeight;
  const gridValues = Array.from(
    { length: gridStepCount },
    (_, index) => gridStep * (index + 1),
  ).reverse();
  const xLabelInterval = Math.max(1, Math.ceil((pointCount - 1) / 3));
  const axisLabelFontSize = width < 640 ? 11 : 8;

  return (
    <Block direction="vertical" gap={16} padding={24} variant="outlined">
      <Flexbox align="center" gap={8} horizontal>
        <ChartLine aria-hidden="true" size={18} strokeWidth={2} />
        <h3 className="section-title">{title}</h3>
      </Flexbox>
      {series.length && pointCount ? (
        <div className="usage-chart relative">
          <Flexbox className="mb-3" gap={6} wrap="wrap">
            {series.map((item, index) => {
              const color = chartColors[index % chartColors.length];
              return (
                <Flexbox align="center" gap={6} horizontal key={item.model}>
                  <span
                    aria-hidden="true"
                    className="h-px w-3 rounded-full"
                    // eslint-disable-next-line react/forbid-dom-props
                    style={{ backgroundColor: color }}
                  />
                  <span
                    className="text-[11px] font-medium"
                    // eslint-disable-next-line react/forbid-dom-props
                    style={{ color }}
                  >
                    {item.model}
                  </span>
                </Flexbox>
              );
            })}
          </Flexbox>
          <svg
            aria-label={title}
            className="usage-chart-svg h-auto w-full overflow-visible"
            role="img"
            viewBox={`0 0 ${width} ${height}`}
          >
            <title>{title}</title>
            {gridValues.map((value) => {
              const y = getY(value);
              return (
                <g key={`grid-${value}`}>
                  <line
                    className="stroke-border-light dark:stroke-border-dark"
                    strokeWidth="1"
                    vectorEffect="non-scaling-stroke"
                    x1={padding.left}
                    x2={width - padding.right}
                    y1={y}
                    y2={y}
                  />
                  <text
                    className="fill-secondary"
                    fontSize={axisLabelFontSize}
                    textAnchor="end"
                    x={padding.left - 10}
                    y={y + 4}
                  >
                    {formatCompactNumber(locale, value)}
                  </text>
                </g>
              );
            })}
            {series.map((item, seriesIndex) => {
              const color = chartColors[seriesIndex % chartColors.length];
              const points = item.points.map((point, index) => ({
                x: getX(index),
                y: getY(point[metric]),
              }));
              return (
                <g key={item.model}>
                  <path
                    d={getMonotoneLinePath(points)}
                    fill="none"
                    stroke={color}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.5"
                    vectorEffect="non-scaling-stroke"
                  />
                  {item.points.map((point, index) => {
                    const value = point[metric];
                    const x = getX(index);
                    const y = getY(value);
                    const hover = () =>
                      onHoverPoint({
                        chart,
                        label: point.label,
                        metricLabel,
                        model: item.model,
                        value,
                        x,
                        y,
                      });
                    return (
                      <circle
                        cx={x}
                        cy={y}
                        fill={color}
                        key={`${item.model}-${point.start}`}
                        onBlur={() => onHoverPoint(null)}
                        onFocus={hover}
                        onMouseEnter={hover}
                        onMouseLeave={() => onHoverPoint(null)}
                        r="2"
                        stroke="transparent"
                        strokeWidth="8"
                        tabIndex={0}
                      />
                    );
                  })}
                </g>
              );
            })}
            {labels.map((label, index) => (
              <text
                className="fill-secondary"
                fontSize={axisLabelFontSize}
                key={`${title}-${label}`}
                textAnchor={
                  index === 0
                    ? 'start'
                    : index === labels.length - 1
                      ? 'end'
                      : 'middle'
                }
                x={getX(index)}
                y={height - 10}
              >
                {index === 0 ||
                index === labels.length - 1 ||
                index % xLabelInterval === 0
                  ? label
                  : ''}
              </text>
            ))}
          </svg>
          {hoveredPoint?.chart === chart ? (
            <div
              className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full"
              // eslint-disable-next-line react/forbid-dom-props
              style={{
                left: `${(hoveredPoint.x / width) * 100}%`,
                top: `${(hoveredPoint.y / height) * 100}%`,
              }}
            >
              <Block
                className="min-w-44 text-xs"
                direction="vertical"
                gap={4}
                padding={12}
                variant="outlined"
              >
                <div className="font-semibold">{hoveredPoint.model}</div>
                <div className="mt-1 text-secondary">{hoveredPoint.label}</div>
                <div className="mt-1">
                  {hoveredPoint.metricLabel}:{' '}
                  <span className="font-semibold">
                    {formatNumber(locale, hoveredPoint.value)}
                  </span>
                </div>
              </Block>
            </div>
          ) : null}
        </div>
      ) : (
        <Flexbox
          align="center"
          className="py-12 text-secondary"
          direction="vertical"
          gap={8}
        >
          <ChartLine aria-hidden="true" size={18} strokeWidth={2} />
          <div className="mt-2">{emptyLabel}</div>
        </Flexbox>
      )}
    </Block>
  );
};

const Usage = () => {
  const {
    onAccessKeyChange,
    onAutoRefreshSecondsChange,
    onClearHistory,
    onCredentialChange,
    onHoverPoint,
    onRangeChange,
    onRefresh,
    usage,
  } = useUsage();
  const translations = useTranslations('Admin.usage');
  const locale = useLocale();
  const rangeOptions = [
    '1h',
    '3h',
    '6h',
    '12h',
    '24h',
    '3d',
    '7d',
    'today',
    'yesterday',
  ].map((value) => ({
    label: translations(`ranges.${value}`),
    value: value as UsageRange,
  }));
  const autoRefreshOptions = [0, 5, 15, 30, 60, 300].map((value) => ({
    label: translations(`autoRefreshOptions.${value}`),
    value,
  }));
  const credentialOptions = usage.filters.credentials.map((option) => ({
    ...option,
    label:
      option.value === 'all' ? translations('allCredentials') : option.label,
  }));
  const accessKeyOptions = usage.filters.accessKeys.map((option) => ({
    ...option,
    label:
      option.value === 'all' ? translations('allAccessKeys') : option.label,
  }));

  return (
    <div className="block" id="usage">
      {usage.autoRefreshVisible ? (
        <Block
          className="mb-6"
          direction="vertical"
          gap={12}
          padding={16}
          variant="outlined"
        >
          <div className="flex items-center gap-3 text-sm text-text-light dark:text-text-dark">
            <label className="usage-auto-refresh-label inline-flex items-center gap-2 text-secondary">
              {translations('autoRefresh')}
              <Select
                aria-label={translations('autoRefresh')}
                onChange={(value) => onAutoRefreshSecondsChange(Number(value))}
                options={autoRefreshOptions}
                value={usage.autoRefreshSeconds}
              />
            </label>
          </div>
        </Block>
      ) : null}
      <Block
        className="mb-6"
        direction="vertical"
        gap={16}
        padding={24}
        variant="outlined"
      >
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-4 flex-1">
            <label className="block">
              <div className="mb-2 text-sm font-medium text-text-light dark:text-text-dark">
                {translations('range')}
              </div>
              <Select
                aria-label={translations('range')}
                className="w-full"
                onChange={(value) => onRangeChange(value as UsageRange)}
                options={rangeOptions}
                value={usage.request.range}
              />
            </label>
            <label className="block">
              <div className="mb-2 text-sm font-medium text-text-light dark:text-text-dark">
                {translations('credential')}
              </div>
              <Select
                aria-label={translations('credential')}
                className="w-full"
                onChange={onCredentialChange}
                options={credentialOptions}
                value={usage.request.credential}
              />
            </label>
            <label className="block">
              <div className="mb-2 text-sm font-medium text-text-light dark:text-text-dark">
                {translations('accessKey')}
              </div>
              <Select
                aria-label={translations('accessKey')}
                className="w-full"
                onChange={onAccessKeyChange}
                options={accessKeyOptions}
                value={usage.request.accessKey}
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button
              htmlType="button"
              icon={usage.loading ? LoaderCircle : RefreshCw}
              onClick={onRefresh}
              type="primary"
            >
              {translations('refresh')}
            </Button>
            <Button
              danger
              htmlType="button"
              icon={Trash2}
              onClick={onClearHistory}
            >
              {translations('clearHistory')}
            </Button>
          </div>
        </div>
        <div className="mt-4 text-sm text-secondary">
          {usage.lastUpdatedAt
            ? translations('lastUpdated', { value: usage.lastUpdatedAt })
            : translations('firstLoad')}
        </div>
      </Block>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-6 mb-6">
        {[
          [translations('callsToday'), usage.todaySummary.callCount],
          [translations('tokensToday'), usage.todaySummary.totalTokens],
          [translations('cacheHitToday'), usage.todaySummary.cacheHitTokens],
        ].map(([label, value]) => (
          <Block
            direction="vertical"
            gap={8}
            key={label}
            padding={24}
            variant="outlined"
          >
            <div className="text-sm text-secondary mb-2">{label}</div>
            <div className="text-3xl font-bold text-text-light dark:text-text-dark">
              {formatNumber(locale, Number(value))}
            </div>
          </Block>
        ))}
      </div>
      <div className="usage-chart-desktop grid gap-6 mb-6">
        <UsageChart
          chart="calls"
          chartWidth={1000}
          emptyLabel={translations('emptyCalls')}
          hoveredPoint={usage.hoveredPoint}
          locale={locale}
          metric="callCount"
          metricLabel={translations('metricCalls')}
          onHoverPoint={onHoverPoint}
          series={usage.callSeries}
          title={translations('callTrend')}
        />
        <UsageChart
          chart="tokens"
          chartWidth={1000}
          emptyLabel={translations('emptyTokens')}
          hoveredPoint={usage.hoveredPoint}
          locale={locale}
          metric="totalTokens"
          metricLabel={translations('metricTokens')}
          onHoverPoint={onHoverPoint}
          series={usage.tokenSeries}
          title={translations('tokenTrend')}
        />
      </div>
      <div className="usage-chart-mobile grid gap-6 mb-6">
        <UsageChart
          chart="calls"
          chartWidth={320}
          emptyLabel={translations('emptyCalls')}
          hoveredPoint={usage.hoveredPoint}
          locale={locale}
          metric="callCount"
          metricLabel={translations('metricCalls')}
          onHoverPoint={onHoverPoint}
          series={usage.callSeries}
          title={translations('callTrend')}
        />
        <UsageChart
          chart="tokens"
          chartWidth={320}
          emptyLabel={translations('emptyTokens')}
          hoveredPoint={usage.hoveredPoint}
          locale={locale}
          metric="totalTokens"
          metricLabel={translations('metricTokens')}
          onHoverPoint={onHoverPoint}
          series={usage.tokenSeries}
          title={translations('tokenTrend')}
        />
      </div>
      <Block direction="vertical" gap={16} padding={24} variant="outlined">
        <Flexbox align="center" gap={8} horizontal>
          <ChartNoAxesCombined aria-hidden="true" size={18} strokeWidth={2} />
          <h3 className="section-title">{translations('modelSummary')}</h3>
        </Flexbox>
        <div className="w-full overflow-x-auto">
          <table className="w-full border-collapse mt-4">
            <thead>
              <tr>
                <th className="p-3 px-4 text-left font-semibold border-b border-border-light dark:border-border-dark">
                  {translations('model')}
                </th>
                <th className="p-3 px-4 text-right font-semibold border-b border-border-light dark:border-border-dark">
                  {translations('tableCalls')}
                </th>
                <th className="p-3 px-4 text-right font-semibold border-b border-border-light dark:border-border-dark">
                  {translations('tableTokens')}
                </th>
                <th className="p-3 px-4 text-right font-semibold border-b border-border-light dark:border-border-dark">
                  {translations('tableCacheHit')}
                </th>
              </tr>
            </thead>
            <tbody>
              {usage.tableRows.length ? (
                usage.tableRows.map((row) => (
                  <tr key={row.model}>
                    <td className="p-3 px-4 border-b border-border-light dark:border-border-dark">
                      {row.model}
                    </td>
                    <td className="p-3 px-4 border-b border-border-light dark:border-border-dark text-right">
                      {formatNumber(locale, row.callCount)}
                    </td>
                    <td className="p-3 px-4 border-b border-border-light dark:border-border-dark text-right">
                      {formatNumber(locale, row.totalTokens)}
                    </td>
                    <td className="p-3 px-4 border-b border-border-light dark:border-border-dark text-right">
                      {formatNumber(locale, row.cacheHitTokens)}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td
                    className="p-3 px-4 border-b border-border-light dark:border-border-dark text-center"
                    colSpan={4}
                  >
                    {translations('emptySummary')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Block>
    </div>
  );
};

export default Usage;
