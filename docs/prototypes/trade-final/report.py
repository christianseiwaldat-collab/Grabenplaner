from pathlib import Path
import json, html
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.pagesizes import A4
from pypdf import PdfReader, PdfWriter

root=Path(__file__).resolve().parents[3]
out=root.parent/'output'/'Trade-Block6-2026-09-25'
v=json.loads((out/'Volumenpruefung.json').read_text(encoding='utf-8'))
for name in ['Regular','Bold']:
    pdfmetrics.registerFont(TTFont('GP'+name,str(root/'lib'/'pdf-fonts'/('Roboto-'+name+'.ttf'))))
green=colors.HexColor('#21483e'); muted=colors.HexColor('#536b62'); pale=colors.HexColor('#edf3ef')
styles=getSampleStyleSheet()
styles.add(ParagraphStyle(name='GPBody',fontName='GPRegular',fontSize=10.2,leading=15,textColor=green,spaceAfter=9))
styles.add(ParagraphStyle(name='GPTitle',fontName='GPBold',fontSize=25,leading=30,textColor=green,spaceAfter=13))
styles.add(ParagraphStyle(name='GPHead',fontName='GPBold',fontSize=13,leading=18,textColor=green,spaceBefore=13,spaceAfter=7))
styles.add(ParagraphStyle(name='GPSmall',fontName='GPRegular',fontSize=8.6,leading=12,textColor=muted,spaceAfter=7))
P=lambda s,style='GPBody':Paragraph(s,styles[style])
flow=[]
def text(s,style='GPBody'):flow.append(P(s,style))
def table(rows,widths):
    data=[[P(str(c),'GPSmall') for c in row] for row in rows]
    t=Table(data,colWidths=widths,hAlign='LEFT',repeatRows=1)
    t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),pale),('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,colors.HexColor('#f7f9f7')]),('VALIGN',(0,0),(-1,-1),'TOP'),('TOPPADDING',(0,0),(-1,-1),8),('BOTTOMPADDING',(0,0),(-1,-1),3),('LINEBELOW',(0,0),(-1,-1),.3,colors.HexColor('#d8e2dc'))]))
    flow.append(t)
    flow.append(Spacer(1,10))
text('Trade-Ausbau<br/>Abschluss der Blöcke 4 bis 6','GPTitle')
text('Grabenplaner · Lokale Umsetzung und Gesamtnachweis · 25. September 2026','GPSmall')
text('Inventuren und erklärbare Handlungsvorschläge sind in „Einkauf &amp; Bestand“ eingebunden. Die fachliche und visuelle Schlussprüfung wurde wie beauftragt ohne Zwischenabnahme durchgeführt. Der Stand ist lokal geprüft und noch nicht veröffentlicht.')
text('Inventuren &amp; Differenzen','GPHead')
text('Eine Übersicht je Inventur und Filiale zeigt das Datum, alle Positionszahlen und die Verteilung auf Mehrbestand, Minderbestand, unveränderte Zählungen und fehlende Mengen. Der Klick auf eine Inventur öffnet die ausgewählten Abweichungen und Mengenprüffälle. Quellabweichung und rechnerische Abweichung bleiben getrennt. Archivierte Artikel tragen einen Herkunftsnachweis.')
text('Handlungsvorschläge','GPHead')
text('Fünf klar begründete Ergebnisse: Umlagerung prüfen, Nachbeschaffung prüfen, Zulauf abgleichen, Bestandsabbau prüfen und Datengrundlage prüfen. Jedes Detail nennt Bestandsstichtag, Verkaufszeitraum, Mengen, mögliche Gegenfilialen und die Grenzen der Aussage.')
table([['Aktualitäts- und Vergleichsregeln','Einstellung'],['Bestandsalter / Abstand zum Verkaufsende','Jeweils höchstens 7 Tage'],['Beobachtung','Mindestens 28 Tage; Standard 90 Tage'],['Reichweite bei knappem Bestand','Unter 14 Tagen bei positivem Nettoabsatz'],['Mögliche Gegenfiliale / Bestandsabbau','Über 60 / 180 Tage oder ohne erfassten Verkauf']],[305,194])
text('Gemeinsame Bedienung','GPHead')
text('Zeitraumkalender mit Beginn und Ende, Wochenbereichen und direkter Datumseingabe. Sortierbare Datenspalten auch auf dem Handy. Gespeicherte Ergebnisse, einklappbare Filter, passende PDF-Sortierung sowie heller und dunkler Modus.')
text('Eine Empfehlung bleibt ein Prüfauftrag. Es gibt keine automatische Bestellung oder Umbuchung und keine berechnete freie Umlagerungsmenge. Reservierungen und bestätigte Mindestbestände sind nicht verlässlich je Filiale zugeordnet. Die Quellwerte „Bestellt“ und „im Zulauf“ ersetzen keinen Beschaffungsabgleich.','GPSmall')
flow.append(PageBreak())
text('Prüfung und tatsächliche Datenmenge','GPTitle')
text('Funktion und Berechtigungen','GPHead')
text('112 unterschiedliche Fach-, HTTP-, PDF- und Oberflächenprüfungen bestanden. Darunter: 5.001 Verkäufe im Jahres-/CRM-Vergleich, 450 Inventurdetails über mehrere Seiten, Retouren, Quellwechsel, Rücknahme, Teilimporte, Filialgrenzen und unveränderliche gespeicherte Ergebnisse. Ein älteres Testbeispiel wurde an die gemeinsame Inventurdatei angepasst und erfolgreich erneut geprüft.')
text('Die 25 zuletzt geprüften Such- und UI-Fälle waren ebenfalls grün. 56 zusätzliche Datenbank-Vertragstests bestanden. Zwei native Integrationstests auf PostgreSQL 18.6 bestanden ohne übersprungene Tests. Der erste Lauf zeigte eine fehlende Artikel-Lesefreigabe im Berichts-Worker; der korrigierte Lauf war vollständig grün. Der eigene lokale Testcluster wurde anschließend gestoppt.')
text('Großbestand aus hashgeprüften Arbeitskopien','GPHead')
n=lambda x:f'{x:,}'.replace(',','.')
table([['Datengruppe','Geprüfte Größe'],['Aktueller Artikelstamm / Artikelarchiv',n(19584)+' / '+n(17468)],['Warenbewegungen / Filialbestandspositionen',n(141084)+' / '+n(236542)],['Inventurdetails in der Quelle / ausgewählt',n(332675)+' / '+n(4902)],['Inventurköpfe mit Positionen',n(438)]],[305,194])
flow.append(PageBreak())
text('Lesezeiten und Suchverhalten','GPTitle')
text('Abgeschlossene Fachabfragen einschließlich Entschlüsselung im Großbestand. Alle Seiten der jeweiligen Abfrage wurden bis zum Ende gelesen.','GPSmall')
labels={'stocktakes':'Inventurübersicht','article-history':'Artikelhistorie, exakte Kennung','movements':'Warenbewegungen, Zeitraum','suggestions':'Handlungshinweise, exakte Kennung'}
rows=[['Abfrage','Zeilen / Schritte','Dauer']]
for q in v['queries']:
    label='Inventurdetails' if q['kind']=='stocktakes' and q['input'].get('stocktakeId') else labels[q['kind']]
    rows.append([label,n(q['rows'])+' / '+n(q['pages']),(str(q['milliseconds'])+' ms' if q['milliseconds']<10 else f"{q['milliseconds']/1000:.2f} s".replace('.',','))])
table(rows,[263,138,98])
text('Die freie Suche bleibt für Bezeichnungen und Teilbegriffe verfügbar. Im Ausgangstest benötigte dieselbe Artikelkennung als freie Suche 49,74 Sekunden in der Artikelhistorie und 375,83 Sekunden in den Filialbeständen. Die ausdrücklich exakte Suche verwendet vorhandene geschützte Indizes: 4 Millisekunden bzw. 4,08 Sekunden für dieselben Kennungen. Ein weiterer Artikel mit zwölf Bestandszeilen wurde in 3,88 Sekunden geprüft.','GPBody')
text('Die freie Suche über alle Artikel bleibt bei großen Datenmengen entsprechend langsamer. Bekannte Artikelnummern sollten über „Artikelnummer exakt“ gesucht werden. Filialübergreifende Vorschläge laufen als gespeicherte Serveraufträge mit Fortschrittsanzeige.','GPBody')
text('Gemessen mit einer separat aufgebauten, verschlüsselten Reporting-Testdatenbank auf diesem Windows-Rechner. Die Zeiten messen Fachabfragen einschließlich Entschlüsselung; sie sind keine VPS-Zusage und keine Messung des kompletten Upload-/Importvorgangs. Die drei verwendeten Arbeitskopien waren vor und nach dem Lauf hashidentisch. Ein unabhängiger lesender SQLite-Abgleich bestätigte die Mengen aller sechs geladenen Datengruppen.','GPSmall')
text('Die native PostgreSQL-Prüfung verwendete synthetische Beispiele. Der Großbestand enthält keine freigegebene vollständige Kassenpublikation; deshalb prüft er bei Handlungshinweisen den sicheren Zustand ohne ausreichende Verkaufsgrundlage. Aussagefähige Absatz-/Umlagerungsfälle wurden separat mit freigegebenen synthetischen Kassendaten geprüft.','GPSmall')
text('Anhang: unveränderte Anwendungs-PDFs mit ausdrücklich synthetischen Beispielen. Detailprotokolle, Screenshots und Messwerte liegen im Ordner „Trade-Block6-2026-09-25“. Quelldateien und Produktiv-VPS wurden nicht verändert.','GPSmall')
base=out/'Abschlussbericht-Text.pdf'
def page(canvas,doc):
    canvas.setFillColor(pale);canvas.rect(48,802,499,18,stroke=0,fill=1)
    canvas.setFillColor(green);canvas.setFont('GPBold',8);canvas.drawString(56,808,'GRABENPLANER  /  TRADE-AUSBAU')
    canvas.setFont('GPRegular',8);canvas.setFillColor(muted);canvas.drawString(48,29,'Lokaler Prüfstand · 25.09.2026');canvas.drawRightString(547,29,'Bericht · '+str(doc.page))
SimpleDocTemplate(str(base),pagesize=A4,leftMargin=48,rightMargin=48,topMargin=57,bottomMargin=48,title='Trade-Ausbau: Abschlussbericht Blöcke 4 bis 6',author='Grabenplaner').build(flow,onFirstPage=page,onLaterPages=page)
writer=PdfWriter();writer.append(str(base),outline_item='Abschlussbericht')
for filename,title in [('Inventuren-Abnahme.pdf','Beispiel: Inventurübersicht'),('Inventur-Differenzen.pdf','Beispiel: Inventurdifferenzen'),('Handlungshinweise-Abnahme.pdf','Beispiel: Handlungshinweise')]:writer.append(str(out/filename),outline_item=title)
writer.add_metadata({'/Title':'Trade-Ausbau - Abschlussbericht Blöcke 4 bis 6','/Author':'Grabenplaner'})
final=out/'Trade-Ausbau-Abschlussbericht-2026-09-25.pdf'
with final.open('wb') as dest:writer.write(dest)
reader=PdfReader(final)
assert all(page.extract_text().strip() for page in reader.pages)
assert not any('\ufffd' in page.extract_text() for page in reader.pages)
print(json.dumps({'path':str(final),'pages':len(reader.pages),'reportPages':len(PdfReader(base).pages),'bytes':final.stat().st_size},ensure_ascii=False))
