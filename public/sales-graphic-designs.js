'use strict';
window.renderSalesGraphicPreview = function (style = 'classic') {
  const host = document.querySelector('.sales-graphic-design'); if (!host) return;
  const designs = {
    classic: ['Klassik', '#052442', '#e7f2ff', '#185077', '#ffce13'],
    studio: ['Studio', '#ffffff', '#193f38', '#d7e4df', '#008774'],
    aurora: ['Aurora', '#121f37', '#e9faff', '#29435e', '#46e6cf'],
    editorial: ['Editorial', '#fffcf8', '#39224e', '#ded7e4', '#8551bd'],
    pulse: ['Pulse', '#ffffff', '#4d302b', '#edddd6', '#d95743']
  };
  const [label, background, ink, grid, accent] = designs[style] || designs.classic;
  host.style.background = background; host.style.color = ink; host.style.borderColor = grid;
  const heading = document.createElement('strong'); heading.textContent = label + ' · Verkäufe im Zeitverlauf';
  const note = document.createElement('span'); note.textContent = 'Designvorschau mit Beispielwerten'; note.style.color = ink;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 640 160'); svg.setAttribute('aria-hidden', 'true');
  const shape = (tag, attributes) => { const n = document.createElementNS(svg.namespaceURI, tag); for (const [key, value] of Object.entries(attributes)) n.setAttribute(key, value); svg.append(n); return n; };
  for (let y = 20; y <= 140; y += 30) shape('line', { x1: 8, x2: 632, y1: y, y2: y, stroke: grid });
  const values = [24, 39, 62, 47, 73, 91, 65, 58, 86, 109, 78, 69, 98, 116, 94, 121, 103, 112];
  const points = values.map((value, i) => [22 + i * 35, 140 - value]);
  if (style === 'aurora') shape('polygon', { points: [[22, 140], ...points, [points.at(-1)[0], 140]].map(p => p.join(',')).join(' '), fill: accent, opacity: '.16' });
  if (['aurora', 'pulse'].includes(style)) shape('polyline', { points: points.map(p => p.join(',')).join(' '), fill: 'none', stroke: accent, 'stroke-width': style === 'pulse' ? 3 : 2 });
  points.forEach(([x, y]) => {
    if (style === 'classic') { for (let py = 134; py > y; py -= 9) shape('rect', { x: x - 9, y: py, width: 18, height: Math.min(6, 140 - py), fill: accent }); }
    else if (style === 'studio') shape('rect', { x: x - 10, y, width: 20, height: 140 - y, rx: 4, fill: accent });
    else if (style === 'editorial') shape('line', { x1: x, x2: x, y1: y, y2: 140, stroke: accent, 'stroke-width': 2 });
    if (!['classic', 'studio'].includes(style)) shape('circle', { cx: x, cy: y, r: style === 'editorial' ? 5 : 3, fill: accent });
  });
  host.replaceChildren(heading, note, svg);
};
