import type { ShopifyAnalyticsArgs } from './shopify.types';

/** Compile a closed, typed report contract into ShopifyQL. */
export function compileShopifyReport(args: ShopifyAnalyticsArgs): string {
  const period = compilePeriod(args.period);
  switch (args.operation) {
    case 'sales_summary':
      return `FROM sales\nSHOW ${unique(args.metrics).join(', ')}\n${period}`;
    case 'sales_timeseries':
      return `FROM sales\nSHOW ${unique(args.metrics).join(', ')}\nTIMESERIES ${args.granularity}\n${period}`;
    case 'sales_by_channel':
      return [
        'FROM sales',
        `SHOW ${unique(args.metrics).join(', ')}`,
        `GROUP BY ${args.dimension}`,
        period,
        `ORDER BY ${args.metrics[0]} DESC`,
        `LIMIT ${args.limit}`,
      ].join('\n');
    case 'sales_attribution':
      return [
        'FROM sales',
        `SHOW ${args.metric}`,
        `GROUP BY ${args.dimension}`,
        `WITH ${args.attribution}`,
        period,
        `ORDER BY ${args.metric}__${attributionSuffix(args.attribution)} DESC`,
        `LIMIT ${args.limit}`,
      ].join('\n');
    case 'sales_by_utm':
      return [
        'FROM sales',
        `SHOW ${unique(args.metrics).join(', ')}`,
        `GROUP BY ${unique(args.dimensions).join(', ')}`,
        period,
        `ORDER BY ${args.metrics[0]} DESC`,
        `LIMIT ${args.limit}`,
      ].join('\n');
    case 'product_performance':
      return ranked('sales', args.metrics, args.dimensions, period, args.limit);
    case 'customer_acquisition':
      return `FROM customers\nSHOW ${unique(args.metrics).join(', ')}\nTIMESERIES ${args.granularity}\n${period}`;
    case 'inventory_position':
      return ranked('inventory_by_location', args.metrics, args.dimensions, period, args.limit);
    case 'payments_summary':
      return `FROM payments\nSHOW ${unique(args.metrics).join(', ')}\n${period}`;
    case 'payments_by_method':
      return ranked('payments', args.metrics, args.dimensions, period, args.limit);
  }
}

function ranked(
  schema: 'sales' | 'inventory_by_location' | 'payments',
  metrics: readonly string[],
  dimensions: readonly string[],
  period: string,
  limit: number,
): string {
  const selectedMetrics = unique(metrics);
  return [
    `FROM ${schema}`,
    `SHOW ${selectedMetrics.join(', ')}`,
    `GROUP BY ${unique(dimensions).join(', ')}`,
    period,
    `ORDER BY ${selectedMetrics[0]} DESC`,
    `LIMIT ${limit}`,
  ].join('\n');
}

function attributionSuffix(value: Extract<ShopifyAnalyticsArgs, { operation: 'sales_attribution' }>['attribution']): string {
  return value.toLowerCase().replace('_attribution', '');
}

function compilePeriod(period: ShopifyAnalyticsArgs['period']): string {
  return period.kind === 'preset'
    ? `DURING ${period.value}`
    : `SINCE ${period.since}\nUNTIL ${period.until}`;
}

function unique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
