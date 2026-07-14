# Grabenplaner

<p align="center">
  <img src="public/assets/grabenplaner-logo.svg" alt="Grabenplaner – Dienst- und Urlaubsplanung" width="430">
</p>

<p align="center"><strong>Dienstplanung, Abwesenheiten und Zeiterfassung – passend für eine Filiale oder eine ganze Organisation.</strong></p>

<p align="center"><strong>Datenschutzfreundlich entwickelt – für einen DSGVO-konformen Betrieb konzipiert.</strong></p>

<p align="center">
  Grabenplaner verbindet Wochenplanung, Urlaubsverwaltung, Personalorganisation und ein smartphonegerechtes Mitarbeiterportal in einer übersichtlichen Anwendung. Filialen und Abteilungen bleiben sauber getrennt, Rechte lassen sich gezielt vergeben und jedes Unternehmen kann seinen eigenen Auftritt über wiederverwendbare Branding-Kits einrichten.
</p>

<p align="center">
  <strong>v0.59 Beta</strong> · Windows · SQLite · Source-available
</p>

<p align="center">
  <a href="https://github.com/christianseiwaldat-collab/Grabenplaner/releases/latest"><strong>Aktuelle Version herunterladen</strong></a>
</p>

## Grabenplaner, drei Betriebsmodelle

| Funktion | Lokalbetrieb | LAN-Host | HTTPS-Server |
|---|---|---|---|
| Dienst- und Abteilungsplanung | Ja | Ja | Ja |
| Urlaubsplanung, Auswertungen und PDF-Export | Ja | Ja | Ja |
| Personal, Standorte, Branding und Einstellungen | Ja | Ja, nach Rechten | Ja, nach Rechten |
| Login, Rollen und Bereichsrechte | Nicht erforderlich | Verpflichtend | Verpflichtend |
| Nutzung durch mehrere Browsergeräte | Nein, nur am Grabenplaner-PC | Ja, im Firmen-LAN/WLAN | Ja, über HTTPS |
| Mitarbeiterportal und eigener Dienstplan | Nicht im Standardbetrieb | Ja | Ja |
| Urlaubs- und ZA-Anträge, Krankmeldung und AUM-Upload | Nicht im Standardbetrieb | Ja | Ja |
| Zeiterfassung durch Mitarbeitende | Nicht im Standardbetrieb | Ja, je Standort aktivierbar | Ja, je Standort aktivierbar |
| Freiwillige WLAN-Zeitvorschläge | Nein | Optional mit Netzwerkintegration | Optional mit Netzwerkintegration |
| Backups | Lokal | Zentral am Host-PC | Zentral mit IT-Wartungswerkzeugen |
| GitHub-Aktualisierungscheck | Ja | Ja | Ja |
| Automatisches Portable-Update | Ja | Ja, am Host-PC | Nein, kontrolliert durch die IT |
| Zugriff | Nur auf diesem Gerät | Im vertrauenswürdigen Firmennetz | Über Internet oder Intranet per HTTPS |
| Produktstatus | Verfügbar | Verfügbar | Technische Pilotbasis |

Der Lokalbetrieb bleibt der unkomplizierte Standard für die vollständige Dienst- und Urlaubsplanung an einem Gerät. Im LAN-Host-Modus liegt die Datenbank ausschließlich am Host-PC; Mitarbeitende können sich im Firmen-LAN oder -WLAN anmelden und dort auch die Zeiterfassung verwenden. Der HTTPS-Server erweitert dieses Modell um geschützten Zugriff von außerhalb, muss vor einem Produktiveinsatz jedoch durch die zuständige Firmen-IT eingerichtet und geprüft werden. Details stehen in [SERVERBETRIEB.md](SERVERBETRIEB.md).

## Planung, Verwaltung und Mitarbeiterportal

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/readme/dienstplanung.webp" alt="Neutrale Dienstplanung im Grabenplaner" width="420">
      <h3>Dienstplanung, die sofort lesbar ist</h3>
      <p>Dienste für Filialen und Abteilungen planen, Mindestbesetzungen im Blick behalten und übersichtliche Wochen- oder Abteilungspläne als PDF ausgeben.</p>
    </td>
    <td width="50%" valign="top">
      <img src="docs/readme/teams-standorte.webp" alt="Teams und Standorte im Grabenplaner verwalten" width="420">
      <h3>Teams und Standorte einfach verwalten</h3>
      <p>Teammitglieder, Positionen, Sollstunden, individuelle Arbeitsregeln sowie Standort- und Abteilungszuordnungen werden zentral gepflegt.</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/readme/rechtemanagement.webp" alt="Rollen und personenbezogene Rechte im Grabenplaner" width="420">
      <h3>Rechte passend zur Organisation</h3>
      <p>Rollen bilden den sicheren Ausgangspunkt. Berechtigte Stellen können zusätzliche Rechte gezielt pro Person und innerhalb des zugewiesenen Bereichs vergeben.</p>
    </td>
    <td width="50%" valign="top">
      <img src="docs/readme/branding-kits.webp" alt="Branding-Kits und standortbezogene Zuweisung" width="420">
      <h3>Ein Auftritt – oder einer je Filiale</h3>
      <p>Branding-Kits mit Logo, Farben und PDF-Vorgaben lassen sich importieren, exportieren und unterschiedlichen Standorten zuweisen. Der Produktname <strong>Grabenplaner</strong> bleibt unverändert.</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/readme/mitarbeiterportal.webp" alt="Smartphonegerechtes Mitarbeiterportal mit Zeiterfassung" width="300">
      <h3>Für Mitarbeitende auf Smartphones gemacht</h3>
      <p>Dienstplan ansehen, Arbeitszeit buchen sowie Urlaub, Zeitausgleich und Änderungen beantragen – mit einer bewusst einfachen mobilen Oberfläche.</p>
    </td>
    <td width="50%" valign="top">
      <img src="docs/readme/aum-upload.webp" alt="Geschützter AUM-Upload im Mitarbeiterportal" width="300">
      <h3>Krankmelden und AUM direkt übermitteln</h3>
      <p>Mitarbeitende können sich im Portal krankmelden und eine AUM als Dokument oder Handyfoto nachreichen. Für die lokale OCR-Auswertung verlassen weder Foto noch OCR-Rohtext den Browser; beim bestätigten AUM-Upload wird das Dokument an Grabenplaner übertragen und geschützt gespeichert.</p>
    </td>
  </tr>
</table>

## Key Features

- Dienst- und Urlaubsplanung für Filialen, Abteilungen und Teams
- Personalverwaltung mit Teammitgliedern, Positionen, Sollstunden und individuellen Arbeitsregeln
- Mindestbesetzung je Filiale, Abteilung und Wochentag
- Automatische Anrechnung von Feiertagen
- Urlaubsplanung mit Jahres-, Quartals- und Monatsübersicht
- PDF-Export für Dienstpläne, Abteilungspläne und Urlaubsübersichten
- Wochenstundenübersicht, Plan-/Ist-Vergleich, Pausenhinweise und Samstagswertung
- Mitarbeiterportal mit Urlaubs- und ZA-Anträgen, Krankmeldung, lokalem AUM-OCR und Zeiterfassung
- Sofortige interne Besetzungswarnung sowie optional zeitgesteuerte externe Warnkanäle für zuständige Leitungen
- Freiwilliger WLAN-Anwesenheitsassistent mit bearbeitbaren und bestätigungspflichtigen Zeitvorschlägen
- Wochen- und Monatsübersichten der Zeiterfassung mit nachvollziehbaren Korrekturanträgen
- Mobil optimiertes Leitungsportal mit konfigurierbaren Kernfunktionen
- Rollen- und Rechtemanagement mit personenbezogenen Zusatzrechten und Bereichsgrenzen
- Standortbezogene Branding-Kits für unterschiedliche Filialauftritte
- Lokale SQLite-Datenbank ohne externen Datenbankserver
- Integriertes Backup-System und GitHub-basierter Aktualisierungscheck

## Schutz sensibler Personalakt-Daten

Sensible Inhalte des Personalakts sowie AUM-Dokumente und ihre geschützten Metadaten werden außerhalb des öffentlichen Webordners gespeichert und zusätzlich mit **AES-256-GCM** verschlüsselt. Die Anwendung prüft Dateitypen anhand ihres Inhalts; Bilder können platzsparend in eine A4-PDF-Datei umgewandelt werden. Im vorgesehenen Serverbetrieb ergänzt eine verpflichtende Virenscanner-Prüfung den Uploadprozess.

Der Zugriff folgt eigenen, besonders eingeschränkten Rechten. Datenbank und verschlüsselte Dokumentablage werden gemeinsam gesichert. Diese zusätzlichen Schutzmaßnahmen ersetzen nicht HTTPS, sichere Betriebssystem- und Dateiberechtigungen, eine geschützte Schlüsselverwaltung und ein geprüftes Backupkonzept. Betriebliche Indizes und nicht sensible Verwaltungsdaten bleiben für den Anwendungsbetrieb in SQLite lesbar.

## In Vorbereitung

- **Schnittstellen zur Lohnverrechnung:** Standardisierte Exporte für Arbeitszeiten, Abwesenheiten und relevante Personalstammdaten sind geplant, aber noch nicht verfügbar. Unterstützte Zielformate und Lohnverrechnungssysteme werden erst mit der konkreten Schnittstelle festgelegt.
- Weitere Produktivhärtung und IT-gestützte Einführung des öffentlichen HTTPS-Serverbetriebs
- Erweiterte Auswertungs- und Integrationsmöglichkeiten

## Schnellstart unter Windows

1. Die portable ZIP-Datei unter [Releases](https://github.com/christianseiwaldat-collab/Grabenplaner/releases/latest) herunterladen und entpacken.
2. `Grabenplaner v0.59 Beta starten.cmd` doppelt anklicken.
3. Grabenplaner öffnet sich lokal unter [http://localhost:3000](http://localhost:3000).

Die Arbeitsdatenbank wird bei der ersten Verwendung unter `data\dienstplan.db` angelegt und ist nicht Bestandteil der neutralen Release-ZIP. Beim Start entsteht automatisch eine interne Sicherung; zusätzliche lokale Sicherungsziele können in Grabenplaner eingerichtet werden.

Aktualisierungen werden über GitHub geprüft. Die integrierte Aktualisierung ersetzt die Programmdateien kontrolliert und startet Grabenplaner neu; Datenbank, Backups, AUM-Dateien und lokale Laufzeitkonfiguration bleiben geschützt.

## Technische Grundlage

| Bereich | Umsetzung |
|---|---|
| Anwendung | Lokale beziehungsweise zentral bereitgestellte Web-App mit Node.js und Express |
| Datenbank | SQLite, ohne separaten Datenbankserver |
| PDF-Ausgabe | PDFKit |
| Bild- und Dokumentaufbereitung | Sharp und PDFKit |
| Lokale AUM-Texterkennung | Tesseract.js mit lokal mitgeliefertem deutschen Sprachmodell |
| Geschützter Personalakt-Speicher | AES-256-GCM, kontextgebundene Verschlüsselung und gemeinsame Sicherung mit der Datenbank |
| Authentifizierung | Rollen, Sitzungen, CSRF-Schutz und bereichsbezogene Berechtigungen |
| Server-Pilot | HTTPS-Reverse-Proxy, Dienstbetrieb, Diagnose-, Backup- und Restore-Vorlagen |

Für lokale Entwicklung wird Node.js 22 oder neuer benötigt:

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm start
```

Der Port kann über die Umgebungsvariable `PORT` geändert werden:

```powershell
$env:PORT=8080
pnpm start
```

Eine private GitHub-Codespaces-Umgebung für Demo- und Funktionstests ist in [CODESPACES.md](CODESPACES.md) beschrieben. Dort dürfen keine echten Personal-, Planungs- oder Gesundheitsdaten verwendet werden.

Öffentliche, rein fiktive [Muster-Branding-Kits und Demodaten](demo/README.md) stehen getrennt von produktiven Daten zum Download und Testen bereit.

## Branding und öffentliche Auslieferung

Die öffentliche Grundauslieferung verwendet ausschließlich das neutrale Grabenplaner-Branding. Unternehmenslogos, geschützte Marken und kundenspezifische Voreinstellungen gehören in getrennte Branding-Kits und sind nicht Bestandteil dieses Repositorys.

## Lizenz und Sicherheit

Grabenplaner ist **source-available, aber nicht Open Source**. Private, interne Test- und Evaluierungsnutzung ist gemäß [LICENSE.md](LICENSE.md) erlaubt; kommerzielle Nutzung erfordert die vorherige schriftliche Genehmigung des Rechteinhabers.

Sicherheitsprobleme bitte vertraulich nach den Hinweisen in [SECURITY.md](SECURITY.md) melden und nicht als öffentliches GitHub-Issue veröffentlichen.
