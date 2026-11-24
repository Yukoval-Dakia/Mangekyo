export const ridingLesson = {
  title: '同一趟骑行，两块码表', distanceKm: 10, movingMinutes: 30, stoppedMinutes: 10, comparisonMinutes: 20,
} as const;

export function averageSpeed(distanceKm: number, minutes: number): number {
  return (distanceKm * 60) / minutes;
}
