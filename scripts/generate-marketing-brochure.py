from pathlib import Path
import textwrap

from reportlab.graphics import renderPDF
from reportlab.graphics.barcode.qr import QrCodeWidget
from reportlab.graphics.shapes import Drawing
from reportlab.lib.colors import HexColor, white
from reportlab.lib.pagesizes import A3, A4, landscape
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "pdf"
IMAGES = ROOT / "docs" / "readme"

CREAM = HexColor("#F6F2E8")
PAPER = HexColor("#FFFEFB")
INK = HexColor("#172531")
MUTED = HexColor("#687A80")
GREEN = HexColor("#0E4338")
MID_GREEN = HexColor("#2F9977")
PALE_GREEN = HexColor("#E3F1EA")
YELLOW = HexColor("#F5C84C")
CORAL = HexColor("#F06445")
LINE = HexColor("#D6E0DB")


def wrapped_lines(text, font, size, max_width):
    words = text.split()
    lines = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if not current or stringWidth(candidate, font, size) <= max_width:
            current = candidate
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def draw_text(c, text, x, y, width, font="Helvetica", size=10, color=INK, leading=None, max_lines=None):
    leading = leading or size * 1.35
    lines = wrapped_lines(text, font, size, width)
    if max_lines:
        lines = lines[:max_lines]
    c.setFont(font, size)
    c.setFillColor(color)
    for line in lines:
        c.drawString(x, y, line)
        y -= leading
    return y


def draw_brand(c, x, y, scale=1.0, light=False):
    mark = 55 * scale
    c.setFillColor(MID_GREEN)
    c.roundRect(x, y - mark, mark, mark, 12 * scale, fill=1, stroke=0)
    c.setStrokeColor(white)
    c.setLineWidth(4.5 * scale)
    for offset, length in [(16, 29), (28, 35), (40, 24)]:
        c.line(x + 12 * scale, y - offset * scale, x + (12 + length) * scale, y - offset * scale)
    c.setFillColor(YELLOW)
    c.circle(x + 42 * scale, y - 28 * scale, 5 * scale, fill=1, stroke=0)
    text_color = white if light else INK
    c.setFillColor(text_color)
    c.setFont("Helvetica-Bold", 19 * scale)
    c.drawString(x + mark + 12 * scale, y - 21 * scale, "Grabenplaner")
    c.setFont("Helvetica", 7.8 * scale)
    c.drawString(x + mark + 12 * scale, y - 37 * scale, "Dienst- und Urlaubsplanung")


def draw_fitted_image(c, image_path, x, y, width, height, pad=0, shadow=True):
    image_path = Path(image_path)
    if not image_path.exists():
        return
    if shadow:
        c.setFillColor(HexColor("#D5D2C9"))
        c.roundRect(x + 5, y - 5, width, height, 12, fill=1, stroke=0)
    c.setFillColor(PAPER)
    c.roundRect(x, y, width, height, 12, fill=1, stroke=0)
    reader = ImageReader(str(image_path))
    iw, ih = reader.getSize()
    scale = min((width - pad * 2) / iw, (height - pad * 2) / ih)
    draw_w, draw_h = iw * scale, ih * scale
    c.drawImage(reader, x + (width - draw_w) / 2, y + (height - draw_h) / 2,
                draw_w, draw_h, preserveAspectRatio=True, mask="auto")
    c.setStrokeColor(LINE)
    c.setLineWidth(0.7)
    c.roundRect(x, y, width, height, 12, fill=0, stroke=1)


def draw_pill(c, text, x, y, width, fill=PALE_GREEN, color=GREEN, size=8.5):
    c.setFillColor(fill)
    c.roundRect(x, y, width, 24, 12, fill=1, stroke=0)
    c.setFillColor(color)
    c.setFont("Helvetica-Bold", size)
    c.drawCentredString(x + width / 2, y + 8, text)


def draw_feature_card(c, x, y, width, height, eyebrow, title, slogan, body, image=None, accent=MID_GREEN):
    c.setFillColor(PAPER)
    c.roundRect(x, y, width, height, 16, fill=1, stroke=0)
    c.setStrokeColor(LINE)
    c.setLineWidth(0.7)
    c.roundRect(x, y, width, height, 16, fill=0, stroke=1)
    c.setFillColor(accent)
    c.roundRect(x + 15, y + height - 31, 52, 5, 2.5, fill=1, stroke=0)
    image_width = 112 if image else 0
    text_width = width - 34 - image_width
    c.setFillColor(CORAL)
    c.setFont("Helvetica-Bold", 7.2)
    c.drawString(x + 17, y + height - 48, eyebrow.upper())
    c.setFillColor(INK)
    title_size = 14
    title_lines = wrapped_lines(title, "Helvetica-Bold", title_size, text_width)[:2]
    c.setFont("Helvetica-Bold", title_size)
    title_y = y + height - 69
    for line in title_lines:
        c.drawString(x + 17, title_y, line)
        title_y -= 16
    c.setFillColor(GREEN)
    c.setFont("Helvetica-Bold", 8.6)
    slogan_y = title_y - 2
    c.drawString(x + 17, slogan_y, slogan)
    draw_text(c, body, x + 17, slogan_y - 18, text_width, size=7.6, color=MUTED, leading=10.2, max_lines=5)
    if image:
        draw_fitted_image(c, image, x + width - image_width - 13, y + 14, image_width, height - 28, pad=3, shadow=False)


def draw_front(c, x, y, width, height):
    c.setFillColor(CREAM)
    c.rect(x, y, width, height, fill=1, stroke=0)
    c.setFillColor(MID_GREEN)
    c.circle(x + width + 10, y + height - 28, 112, fill=1, stroke=0)
    c.setFillColor(YELLOW)
    c.circle(x + width - 38, y + height - 10, 23, fill=1, stroke=0)
    draw_brand(c, x + 48, y + height - 48, 1.15)
    draw_pill(c, "v0.57 Beta - Windows - SQLite", x + width - 210, y + height - 52, 164)
    c.setFillColor(CORAL)
    c.setFont("Helvetica-Bold", 8)
    c.drawString(x + 48, y + height - 178, "PLANUNG - PERSONAL - ZEIT")
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 30)
    c.drawString(x + 48, y + height - 232, "Planung, Personal")
    c.drawString(x + 48, y + height - 270, "und Zeit - an einem Ort.")
    draw_text(c,
              "Für Filialen und Teams: Dienstplanung, Abwesenheiten, Personalverwaltung, Zeiterfassung und Mitarbeiterportal in einer klaren Oberfläche.",
              x + 48, y + height - 312, width - 94, size=11.3, color=MUTED, leading=15)
    c.setFillColor(GREEN)
    c.setFont("Helvetica-Bold", 11)
    c.drawString(x + 48, y + height - 376, "Datenschutzfreundlich entwickelt -")
    c.drawString(x + 48, y + height - 392, "für einen DSGVO-konformen Betrieb konzipiert.")
    draw_pill(c, "Lokal ohne Cloud-Zwang", x + 48, y + height - 442, 142)
    draw_pill(c, "Zentral im Firmennetz", x + 202, y + height - 442, 142)
    draw_pill(c, "Smartphone-Portal", x + 356, y + height - 442, 142)
    draw_fitted_image(c, IMAGES / "dienstplanung.webp", x + 48, y + 56, width - 96, 282, pad=4)
    c.setFillColor(GREEN)
    c.roundRect(x + 48, y + 28, width - 96, 24, 12, fill=1, stroke=0)
    c.setFillColor(white)
    c.setFont("Helvetica-Bold", 8.6)
    c.drawCentredString(x + width / 2, y + 36, "Planen, prüfen und als übersichtliches PDF ausgeben.")


def draw_back(c, x, y, width, height):
    c.setFillColor(CREAM)
    c.rect(x, y, width, height, fill=1, stroke=0)
    c.setFillColor(GREEN)
    c.rect(x, y + height - 96, width, 96, fill=1, stroke=0)
    draw_brand(c, x + 46, y + height - 29, 0.82, light=True)
    c.setFillColor(white)
    c.setFont("Helvetica-Bold", 18)
    c.drawString(x + 250, y + height - 48, "Technik für IT und Administration")
    c.setFont("Helvetica", 7.8)
    c.drawString(x + 250, y + height - 66, "Kompakt, lokal kontrollierbar und schrittweise erweiterbar.")

    rows = [
        ("Laufzeit", "Node.js ab 22 - Express 5"),
        ("Datenbank", "SQLite - WAL-Modus - Fremdschlüssel"),
        ("Dokumentschutz", "AUM-Dateien AES-256-GCM - private Ablage"),
        ("Betriebsarten", "Lokal - LAN-Host - HTTPS-Server"),
        ("Rechte", "Rollen, Bereichsscopes und delegierbare Einzelrechte"),
        ("Sicherungen", "Integritätsprüfung - Manifest - Prüfsummen"),
        ("Updates", "GitHub-basierter Versionscheck und Neustartablauf"),
        ("Testumgebung", "Private Codespaces-Demo mit fiktiven Daten"),
    ]
    table_x, table_y, table_w = x + 46, y + height - 140, width - 92
    c.setFillColor(PAPER)
    c.roundRect(table_x, table_y - 256, table_w, 256, 13, fill=1, stroke=0)
    row_h = 31
    for idx, (label, value) in enumerate(rows):
        ry = table_y - 24 - idx * row_h
        c.setFillColor(GREEN)
        c.setFont("Helvetica-Bold", 7.4)
        c.drawString(table_x + 14, ry, label)
        c.setFillColor(INK)
        c.setFont("Helvetica", 7.4)
        c.drawString(table_x + 138, ry, value)
        if idx < len(rows) - 1:
            c.setStrokeColor(LINE)
            c.line(table_x + 12, ry - 10, table_x + table_w - 12, ry - 10)

    c.setFillColor(CORAL)
    c.setFont("Helvetica-Bold", 8)
    c.drawString(x + 46, y + 292, "ENTWICKLUNG & PROJEKT")
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 21)
    c.drawString(x + 46, y + 253, "Quellcode ansehen.")
    c.setFillColor(GREEN)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(x + 46, y + 221, "@christianseiwaldat-collab")
    c.setFillColor(MUTED)
    c.setFont("Helvetica", 7.4)
    c.drawString(x + 46, y + 199, "github.com/christianseiwaldat-collab/Grabenplaner")
    draw_text(c,
              "Grabenplaner ist source-available, aber nicht Open Source. Kommerzielle Nutzung erfordert die vorherige schriftliche Genehmigung des Rechteinhabers.",
              x + 46, y + 153, width - 230, size=7.3, color=MUTED, leading=9.6)
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 7.2)
    c.drawString(x + 46, y + 175, "Lizenz")

    qr = QrCodeWidget("https://github.com/christianseiwaldat-collab/Grabenplaner")
    bounds = qr.getBounds()
    qr_size = 95
    drawing = Drawing(qr_size, qr_size, transform=[qr_size / (bounds[2] - bounds[0]), 0, 0,
                                                    qr_size / (bounds[3] - bounds[1]), 0, 0])
    drawing.add(qr)
    c.setFillColor(PAPER)
    c.roundRect(x + width - 180, y + 112, 132, 146, 14, fill=1, stroke=0)
    renderPDF.draw(drawing, c, x + width - 162, y + 146)
    c.setFillColor(MUTED)
    c.setFont("Helvetica-Bold", 7)
    c.drawCentredString(x + width - 114, y + 127, "GitHub-Projekt öffnen")
    c.setFillColor(MUTED)
    c.setFont("Helvetica", 6.8)
    c.drawString(x + 46, y + 65, "Sicherheitsmeldungen: christian.seiwald.at@gmail.com")
    c.setStrokeColor(LINE)
    c.line(x + 46, y + 48, x + width - 46, y + 48)
    c.setFont("Helvetica", 6.5)
    c.drawString(x + 46, y + 34, "Grabenplaner - Technik und Projekt")


def draw_inside_spread(c):
    width, height = landscape(A3)
    c.setFillColor(CREAM)
    c.rect(0, 0, width, height, fill=1, stroke=0)
    c.setFillColor(GREEN)
    c.rect(0, height - 54, width, 54, fill=1, stroke=0)
    draw_brand(c, 34, height - 11, 0.58, light=True)
    c.setFillColor(white)
    c.setFont("Helvetica-Bold", 18)
    c.drawCentredString(width / 2, height - 33, "Eine Oberfläche. Alles im Blick.")
    c.setFillColor(MUTED)
    c.setFont("Helvetica", 8.4)
    c.drawCentredString(width / 2, height - 74, "Der Grabenplaner verbindet Planung und Selbstverwaltung - verständlich am PC und direkt am Smartphone.")

    center_x, center_y, center_w, center_h = 482, 92, 226, 650
    c.setFillColor(PALE_GREEN)
    c.roundRect(center_x - 16, center_y - 16, center_w + 32, center_h + 32, 28, fill=1, stroke=0)
    draw_fitted_image(c, IMAGES / "mitarbeiterportal.webp", center_x, center_y, center_w, center_h, pad=5)
    draw_pill(c, "Smartphone-Portal", center_x + 34, center_y + center_h - 30, center_w - 68, fill=YELLOW, color=GREEN)

    left_x, right_x, card_w, card_h = 30, 800, 365, 194
    ys = [548, 330, 112]
    draw_feature_card(c, left_x, ys[0], card_w, card_h,
                      "Dienstplanung", "Planen ohne Tabellenchaos", "Besetzung sofort lesbar",
                      "Filialen, Abteilungen, Sollstunden, Pausen, Feiertage und PDF-Ausgabe greifen direkt ineinander.",
                      IMAGES / "dienstplanung.webp", MID_GREEN)
    draw_feature_card(c, left_x, ys[1], card_w, card_h,
                      "Urlaub & ZA", "Anträge, die ihren Weg finden", "Vom Antrag bis zur Freigabe",
                      "Urlaub, Zeitausgleich, Sperrzeiten und mehrstufige Genehmigungen bleiben transparent und nachvollziehbar.",
                      None, YELLOW)
    draw_feature_card(c, left_x, ys[2], card_w, card_h,
                      "Personalmanagement", "Stammdaten mit Schutzkonzept", "Menschen verwalten, Daten schützen",
                      "Teams und Standorte zentral pflegen. AUM-Dokumente liegen privat und AES-256-GCM-verschlüsselt im geschützten Datenbereich.",
                      IMAGES / "teams-standorte.webp", CORAL)

    draw_feature_card(c, right_x, ys[0], card_w, card_h,
                      "Zeit & Anwesenheit", "Weniger tippen, sauber bestätigen", "WLAN-Anwesenheitsassistent",
                      "Kommen, Pause und Gehen bleiben klar. Freiwillige WLAN-Erkennung erstellt nur bearbeitbare Vorschläge - niemals stille Buchungen.",
                      None, MID_GREEN)
    draw_feature_card(c, right_x, ys[1], card_w, card_h,
                      "Branding & Betrieb", "Eine App, mehrere Auftritte", "Passend zu jeder Filiale",
                      "Branding-Kits, lokale Nutzung, LAN-Host und HTTPS-Servermodus geben kleinen Organisationen einen kontrollierten Einstieg.",
                      IMAGES / "branding-kits.webp", YELLOW)
    draw_feature_card(c, right_x, ys[2], card_w, card_h,
                      "Rechte & Updates", "Rechte gezielt vergeben", "Kontrolle ohne Umwege",
                      "Rollen, Bereichsscopes und Einzelrechte sorgen für klare Zuständigkeiten. Updates kommen unkompliziert über GitHub.",
                      IMAGES / "rechtemanagement.webp", CORAL)

    c.setFillColor(GREEN)
    c.roundRect(414, 35, 362, 34, 17, fill=1, stroke=0)
    c.setFillColor(white)
    c.setFont("Helvetica-Bold", 9)
    c.drawCentredString(width / 2, 47, "Hohe Usability - klare Rechte - kontrollierbare Betriebsdaten")


def draw_a4_planning(c):
    width, height = A4
    c.setFillColor(CREAM)
    c.rect(0, 0, width, height, fill=1, stroke=0)
    c.setFillColor(CORAL)
    c.setFont("Helvetica-Bold", 8)
    c.drawString(42, height - 50, "PLANUNG & VERWALTUNG")
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 26)
    c.drawString(42, height - 88, "Vom Wochenplan")
    c.drawString(42, height - 120, "bis zur Rechtevergabe.")
    draw_text(c, "Mehrere Filialen und Abteilungen bleiben getrennt - und trotzdem in einer Anwendung zusammengeführt.",
              42, height - 151, width - 84, size=9.5, color=MUTED, leading=13)
    draw_fitted_image(c, IMAGES / "dienstplanung.webp", 42, height - 390, width - 84, 205, pad=3)
    draw_feature_card(c, 42, 240, width - 84, 128, "Urlaub & ZA", "Anträge mit klarer Freigabe",
                      "Planbar statt unübersichtlich",
                      "Sperrzeiten, mehrstufige Genehmigungen und transparente Verläufe schaffen Verlässlichkeit.", None, YELLOW)
    draw_feature_card(c, 42, 92, (width - 96) / 2, 126, "Personal", "Zentral gepflegt", "Teams im Blick",
                      "Standorte, Abteilungen, Sollstunden und sichere AUM-Ablage.", None, CORAL)
    draw_feature_card(c, 54 + (width - 96) / 2, 92, (width - 96) / 2, 126, "Rechte", "Passend zur Aufgabe", "Gezielt delegieren",
                      "Rollen, Bereiche und Einzelrechte bleiben nachvollziehbar.", None, MID_GREEN)


def draw_a4_portal(c):
    width, height = A4
    c.setFillColor(CREAM)
    c.rect(0, 0, width, height, fill=1, stroke=0)
    c.setFillColor(CORAL)
    c.setFont("Helvetica-Bold", 8)
    c.drawString(42, height - 50, "MITARBEITERPORTAL & BETRIEB")
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 25)
    c.drawString(42, height - 88, "Für Mitarbeitende einfach.")
    c.drawString(42, height - 120, "Für den Betrieb kontrollierbar.")
    draw_fitted_image(c, IMAGES / "mitarbeiterportal.webp", 42, 172, 218, 505, pad=4)
    feature_x, feature_w = 282, width - 324
    draw_feature_card(c, feature_x, 535, feature_w, 142, "Zeiterfassung", "Direkt beim Start", "Kommen. Pause. Gehen.",
                      "Plan-Ist-Vergleich und Tagesprüfung bleiben auf dem Smartphone sofort greifbar.", None, MID_GREEN)
    draw_feature_card(c, feature_x, 373, feature_w, 142, "WLAN-Assistent", "Freiwillig und bestätigungspflichtig", "Weniger tippen",
                      "Anwesenheit erzeugt bearbeitbare Zeitvorschläge. Vertrauen ersetzt nie die Bestätigung.", None, YELLOW)
    draw_feature_card(c, feature_x, 211, feature_w, 142, "AUM", "Sicher übermitteln", "Foto oder PDF",
                      "Dokumente werden privat abgelegt und zusätzlich mit AES-256-GCM geschützt.", IMAGES / "aum-upload.webp", CORAL)
    draw_feature_card(c, feature_x, 49, feature_w, 142, "Branding & Updates", "Eine App, mehrere Marken", "Einfach versorgt",
                      "Branding je Filiale, drei Betriebsmodi und GitHub-basierte Aktualisierung.", IMAGES / "branding-kits.webp", MID_GREEN)


def create_a4(path):
    c = canvas.Canvas(str(path), pagesize=A4, pageCompression=1)
    c.setTitle("Grabenplaner Produktprospekt")
    c.setAuthor("Christian Seiwald")
    c.setSubject("Dienstplanung, Mitarbeiterportal und Zeiterfassung")
    draw_front(c, 0, 0, *A4)
    c.showPage()
    draw_a4_planning(c)
    c.showPage()
    draw_a4_portal(c)
    c.showPage()
    draw_back(c, 0, 0, *A4)
    c.save()


def create_a3(path):
    page_size = landscape(A3)
    half_width = page_size[0] / 2
    c = canvas.Canvas(str(path), pagesize=page_size, pageCompression=1)
    c.setTitle("Grabenplaner Produktprospekt - A3 Druckbogen")
    c.setAuthor("Christian Seiwald")
    c.setSubject("Aussen- und Innenseite fuer A3-Querformat-Falzung")
    draw_back(c, 0, 0, half_width, page_size[1])
    draw_front(c, half_width, 0, half_width, page_size[1])
    c.showPage()
    draw_inside_spread(c)
    c.save()


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    create_a4(OUTPUT / "Grabenplaner-Prospekt-A4.pdf")
    create_a3(OUTPUT / "Grabenplaner-Prospekt-Druckbogen-A3.pdf")


if __name__ == "__main__":
    main()
