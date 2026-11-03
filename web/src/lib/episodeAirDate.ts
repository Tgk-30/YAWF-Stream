const AIR_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/** Episode air dates are calendar dates, not instants in the viewer's time zone. */
export function episodeAirDateLabel(airDate: string | null | undefined): string | null {
  if (!airDate || !/^\d{4}-\d{2}-\d{2}$/.test(airDate)) return null;
  const date = new Date(`${airDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== airDate) {
    return null;
  }
  return AIR_DATE_FORMAT.format(date);
}
