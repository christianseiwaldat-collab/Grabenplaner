"use strict";
// Synthetic source only; no saved pages, URLs or employee records from uploads.
function fixtureHtml({ name = "Filialleitung Mara", balanceDate = "06.09.2026", week = 37 } = {}) {
  const days = [
    '<div>Gesamt: 8.50</div><div>Anwesend M</div><div>09:00-12:30</div><div>(3.50 St.)</div><div>Anwesend</div><div>13:00-18:00</div><div>(5.00 St.)</div>',
    '<div>Gesamt: 6.40</div><div>Krank</div><div>Stunden: 4.90</div><div>Nachtrag</div><div>Nachtrag erledigt.(9:00-10:30)</div><div>Anwesend</div><div>09:00-10:30</div><div>(1.50 St.)</div>',
    '<div>Gesamt: 6.40</div><div>Urlaub</div><div>Ganztag</div>',
    '<div>Gesamt: 8.75</div><div>Nachtrag</div><div>Nachtrag erledigt.(9:00-13:30;14:00-18:15)</div><div>Anwesend</div><div>09:00-13:30</div><div>(4.50 St.)</div><div>Anwesend</div><div>14:00-18:15</div><div>(4.25 St.)</div>',
    '<div>Gesamt: 0.00</div>',
    '<div>Gesamt: 3.00</div><div>Anwesend</div><div>13:00-15:00</div><div>(2.00 St.)</div><div>Zuschläge</div><div>13:00-15:00</div><div>(1.00 St.)</div>',
    '<div>Gesamt: 0.00</div>',
  ];
  const pairs = [
    ['Vorgaben/Stand:', '.' + balanceDate], ['Wo.Tage/Std', '5/6.40'], ['Rest Url. (Tage)', '37.50'], ['Mehrstunden', '3.00'],
    ['Wochenstunden', ''], ['Stunden inklusive Zuschläge', '33.05'], ['Anwesend', '32.05'], ['Krank (Std)', '4.90'], ['Urlaub (Std)', '6.40'], ['Zuschläge', '1.00'], ['Mehrstunden', '1.05'],
  ];
  return `<html><body><script>throw new Error('must never run')</script><table><tr><td><div>1 ${name}</div><div>Eintritt: 01.01.2020</div><div>Wa: KW ${week}</div></td>${days.map(day => `<td>${day}</td>`).join('')}<td><table>${pairs.map(([k,v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table></td></tr></table></body></html>`;
}
function mhtml(html = fixtureHtml(), encoding = "quoted-printable") {
  const bytes = Buffer.from(html);
  const content = encoding === "base64" ? bytes.toString("base64") : encoding === "quoted-printable"
    ? [...bytes].map(byte => byte >= 33 && byte <= 126 && byte !== 61 ? String.fromCharCode(byte) : "=" + byte.toString(16).toUpperCase().padStart(2, "0")).join("") : html;
  return Buffer.from(`MIME-Version: 1.0\r\nContent-Type: multipart/related;\r\n boundary="synthetic-boundary"\r\n\r\n--synthetic-boundary\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: ${encoding}\r\nContent-Location: https://example.invalid/do-not-fetch\r\n\r\n${content}\r\n--synthetic-boundary--\r\n`);
}
module.exports = { fixtureHtml, mhtml };
