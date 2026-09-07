"use strict";
// Allocate rounding once over the whole employee day, including split locations.
function eligibleMinutes(segment) {
  return Math.max(0, Math.min(1440, segment.endMinute) - Math.max(780, segment.startMinute));
}
function allocateSaturdayMinutes(groups) {
  const pieces = groups.flatMap((group, index) => group.map(segment => ({ ...segment, index })))
    .sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute || a.index - b.index);
  const result = groups.map(() => ({ eligibleMinutes: 0, bonusMinutes: 0 }));
  let exact = 0;
  for (const piece of pieces) {
    const eligible = eligibleMinutes(piece), before = Math.round(exact);
    exact += eligible / 2;
    result[piece.index].eligibleMinutes += eligible;
    result[piece.index].bonusMinutes += Math.round(exact) - before;
  }
  return result;
}
function plannedWorkSegments(start, end, lunchStart, lunchEnd) {
  const cuts = Number.isFinite(lunchStart) && Number.isFinite(lunchEnd) && lunchEnd > lunchStart
    ? [[start, Math.min(end, lunchStart)], [Math.max(start, lunchEnd), end]] : [[start, end]];
  return cuts.map(([from, to]) => ({ startMinute: Math.max(0, from), endMinute: Math.min(1440, to), workClassification: 'normal' }))
    .filter(s => s.endMinute > s.startMinute);
}
function projectSaturdayMinutes(all, visible) {
  const groups = [[], []];
  for (const segment of all) {
    const cuts = [...new Set([segment.startMinute, segment.endMinute, ...visible.flatMap(v => [v.startMinute, v.endMinute])])]
      .filter(n => n >= segment.startMinute && n <= segment.endMinute).sort((a, b) => a - b);
    for (let i = 1; i < cuts.length; i++) {
      const middle = (cuts[i - 1] + cuts[i]) / 2;
      const index = visible.some(v => middle >= v.startMinute && middle < v.endMinute) ? 0 : 1;
      groups[index].push({ startMinute: cuts[i - 1], endMinute: cuts[i] });
    }
  }
  return allocateSaturdayMinutes(groups)[0];
}
module.exports = { allocateSaturdayMinutes, plannedWorkSegments, projectSaturdayMinutes };
