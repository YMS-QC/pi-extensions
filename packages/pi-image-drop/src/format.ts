const MIB = 1024 * 1024;

export function formatBytes(value: number): string {
	if (value < 1024) return `${value} B`;
	if (value < MIB) return `${Math.round(value / 1024)} KiB`;
	return `${Number((value / MIB).toFixed(1))} MiB`;
}
