/**
 * Convert the built-in traffic baseline into the monthly fields expected by
 * third-party themes. The raw monthly counters remain available for the
 * built-in UI and for troubleshooting.
 */
export function applyThemeTrafficCompatibility(server, themeEnabled) {
  const target = { ...(server || {}) };

  if (!themeEnabled) {
    if (target.traffic_raw_rx_monthly !== undefined) {
      target.net_rx_monthly = target.traffic_raw_rx_monthly;
    }
    if (target.traffic_raw_tx_monthly !== undefined) {
      target.net_tx_monthly = target.traffic_raw_tx_monthly;
    }
    delete target.traffic_raw_rx_monthly;
    delete target.traffic_raw_tx_monthly;
    delete target.traffic_display_adjusted;
    return target;
  }

  // Use the raw values when this object has already been adapted. This keeps
  // the function idempotent when a cached server object is reused.
  const monthlyRx = parseFloat(target.traffic_raw_rx_monthly ?? target.net_rx_monthly) || 0;
  const monthlyTx = parseFloat(target.traffic_raw_tx_monthly ?? target.net_tx_monthly) || 0;
  const baseline = parseFloat(target.traffic_used_baseline) || 0;
  const baselineRx = parseFloat(target.traffic_rx_baseline) || 0;
  const baselineTx = parseFloat(target.traffic_tx_baseline) || 0;
  const baselinePeriodStart = parseFloat(target.traffic_baseline_period_start) || 0;
  const periodStart = parseFloat(target.traffic_period_start) || 0;
  const baselineExpired = (
    (baselinePeriodStart > 0 && periodStart > 0 && periodStart !== baselinePeriodStart) ||
    (baselineRx > 0 && monthlyRx < baselineRx) ||
    (baselineTx > 0 && monthlyTx < baselineTx)
  );
  const activeBaseline = baselineExpired ? 0 : baseline;
  const rxDelta = baselineExpired ? monthlyRx : Math.max(0, monthlyRx - baselineRx);
  const txDelta = baselineExpired ? monthlyTx : Math.max(0, monthlyTx - baselineTx);
  const mode = target.traffic_count_mode === 'rx'
    ? 'rx'
    : target.traffic_count_mode === 'tx'
      ? 'tx'
      : 'sum';

  // CF-Server-Monitor's legacy `disk` field is a numeric usage percentage.
  // LuminaPlus reserves `disk` for the optional disk-I/O object, while disk
  // usage already comes from `disk_used` / `disk_total`. Do not let the old
  // numeric field make the theme reject an otherwise valid server snapshot.
  if (
    target.disk === null ||
    (target.disk !== undefined && (typeof target.disk !== 'object' || Array.isArray(target.disk)))
  ) {
    delete target.disk;
  }

  target.traffic_raw_rx_monthly = monthlyRx;
  target.traffic_raw_tx_monthly = monthlyTx;

  // LuminaPlus reduces the two monthly fields directly. Put Panel Used into
  // the selected direction so its quota display matches the built-in UI.
  target.net_rx_monthly = mode === 'tx' ? rxDelta : activeBaseline + rxDelta;
  target.net_tx_monthly = mode === 'tx' ? activeBaseline + txDelta : txDelta;
  target.traffic_display_adjusted = true;
  return target;
}

/** Remove the legacy numeric disk field from history rows consumed by themes. */
export function applyThemeHistoryCompatibility(rows, themeEnabled) {
  if (!themeEnabled || !Array.isArray(rows)) return rows;

  return rows.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;

    const target = { ...row };
    if (
      target.disk === null ||
      (target.disk !== undefined && (typeof target.disk !== 'object' || Array.isArray(target.disk)))
    ) {
      delete target.disk;
    }
    return target;
  });
}
