# Grabenplaner

<p align="center"><strong>Dienstplanung, Abwesenheiten und Zeiterfassung – passend für eine Filiale oder eine ganze Organisation.</strong></p>

<p align="center"><strong>Datenschutzfreundlich entwickelt – für einen DSGVO-konformen Betrieb konzipiert.</strong></p>

<p align="center">
  Grabenplaner verbindet Wochenplanung, Urlaubsverwaltung, Personalorganisation und ein smartphonegerechtes Mitarbeiterportal in einer übersichtlichen Anwendung. Filialen und Abteilungen bleiben sauber getrennt, Rechte lassen sich gezielt vergeben und jedes Unternehmen kann seinen eigenen Auftritt über wiederverwendbare Branding-Kits einrichten.
</p>

<p align="center">
  <strong>v0.78.7 Beta</strong> · Windows · Ubuntu-Server · SQLite · Source-available
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
| Personalimport, Lohnexport und direkte Schnittstellen | Ja | Ja, nach Rechten | Ja, nach Rechten |
| Login, Rollen und Bereichsrechte | Nicht erforderlich | Verpflichtend | Verpflichtend |
| Nutzung durch mehrere Browsergeräte | Nein, nur am Grabenplaner-PC | Ja, im Firmen-LAN/WLAN | Ja, über HTTPS |
| Mitarbeiterportal und eigener Dienstplan | Nicht im Standardbetrieb | Ja | Ja |
| Urlaubs- und ZA-Anträge, Krankmeldung und AUM-Upload | Nicht im Standardbetrieb | Ja | Ja |
| Zeiterfassung durch Mitarbeitende | Nicht im Standardbetrieb | Ja, je Standort aktivierbar | Ja, je Standort aktivierbar |
| Freiwillige WLAN-Zeitvorschläge | Nein | Optional mit Netzwerkintegration | Optional mit Netzwerkintegration |
| Backups | Lokal | Zentral am Host-PC | Zentral mit IT-Wartungswerkzeugen und optional verschlüsselter Offsite-Kopie |
| GitHub-Aktualisierungscheck | Ja | Ja | Ja |
| Automatisches Portable-Update | Ja | Ja, am Host-PC | Nein, kontrolliert durch die IT |
| Zugriff | Nur auf diesem Gerät | Im vertrauenswürdigen Firmennetz | Über Internet oder Intranet per HTTPS |
| Produktstatus | Verfügbar | Verfügbar | IT-verwalteter Beta-Serverbetrieb; produktive Freigabe nach Go-live-Prüfung |

Der Lokalbetrieb bleibt der unkomplizierte Standard für die vollständige Dienst- und Urlaubsplanung an einem Gerät. Im LAN-Host-Modus liegt die Datenbank ausschließlich am Host-PC; Mitarbeitende können sich im Firmen-LAN oder -WLAN anmelden und dort auch die Zeiterfassung verwenden. Der HTTPS-Server erweitert dieses Modell um geschützten Zugriff von außerhalb. Unterstützt werden Ubuntu 24.04 und 26.04 LTS auf x86-64 mit Caddy, systemd, getrennten Dienstrechten und ClamAV; für neue Beta-Server wird Ubuntu 26.04 LTS empfohlen. Unter Ubuntu kann ein optionales Restic-/rclone-Modul verifizierte lokale Sicherungspunkte täglich verschlüsselt zu Google Drive übertragen. Eine automatische Serverprüfung meldet Störungen redigiert in der Oberfläche; Wiederherstellungen bleiben ein bewusst beaufsichtigter, mehrstufiger Vorgang. Ein getrenntes Host-Sicherheitsmodul prüft SSH, UFW, automatische Sicherheitsaktualisierungen, Kernel- und Journalvorgaben. Aktivierende Änderungen bleiben ein ausdrücklicher Root-Vorgang mit Sicherheitsrollback und Bestätigung über eine eigenständige neue SSH-Verbindung. Die vorhandenen Windows-Werkzeuge bleiben verfügbar. Die konkrete Domain-, Firewall-, Zertifikats- und Betriebskonfiguration muss vor der Freigabe durch die zuständige IT geprüft werden. Details stehen in [SERVERBETRIEB.md](SERVERBETRIEB.md).

## System-Center und Recovery Assurance in v0.78 Beta

Das System-Center fasst Server, SQLite, Sicherungen, Wiederherstellung, TLS, Benachrichtigungen, Speicher und Updates in acht nachvollziehbaren Nachweiskarten zusammen. Ein serverseitig berechneter technischer Vertrauensindex zeigt Punktestand und Evidenzabdeckung transparent an. Fehlende oder veraltete Belege bleiben ausdrücklich unbekannt; kritische Befunde und unvollständige Nachweise deckeln den Index. Der Wert ist keine Verfügbarkeitsgarantie.

Vollständige Recovery-Assurance-Läufe werden weiterhin in einer Ed25519-signierten, über SHA-256 verketteten Historie protokolliert und erscheinen als redigierte Timeline. IT-Admin und Developer sowie ausdrücklich berechtigte Admins können einen Lauf nach einer Sicherheitsbestätigung im System-Center anfordern. Die Anwendung erhält dabei weder Root- noch Shell-Zugriff, sondern spricht ausschließlich mit einem eng begrenzten lokalen systemd-Socket-Broker. Für Google Drive bleibt ein eigener Google-OAuth-Client mit dem engen Umfang `drive.file` verpflichtend.

v0.78 ergänzt die vollständige, nächtliche Recovery-Assurance-Automatik. Jeder Lauf stellt einen Sicherungsstand außerhalb des Live-Systems wieder her, startet die installierte Anwendung gegen eine isolierte Kopie dieser Daten und hält das Ergebnis in der signierten Nachweiskette fest. Ein zufällig verzögerter systemd-Timer verhindert starre Lastspitzen; Sperren, Zeitgrenzen und vollständiges Aufräumen schützen den Produktivbetrieb.

Das System-Center zeigt zusätzlich den Automatikzustand, begrenzte Langzeittrends und den redigierten Eskalationsstatus. Fehlgeschlagene oder überfällige Nachweise erzeugen deduplizierte interne Warnungen für IT-Admin und Developer. Ein erfolgreicher Sicherungslauf allein wird weiterhin niemals als erfolgreich getestete Wiederherstellung ausgegeben.

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
      <h3>Krankmeldung und AUM in einem Ablauf</h3>
      <p>Mitarbeitende wählen den Krankheitszeitraum in einem gemeinsamen Kalender, können das voraussichtliche Ende offenlassen, eine AUM später nachreichen und anschließend ihre Arbeitsfähigkeit melden. Die lokale Datenerkennung verarbeitet digitale PDFs mit PDF.js sowie Scan-PDFs, hochgeladene Fotos und Kamerabilder mit Tesseract.js. Dokumenttext und OCR-Rohtext bleiben dabei im Browser; erst der bestätigte AUM-Upload überträgt das Dokument zur geschützten Speicherung.</p>
    </td>
  </tr>
</table>

## Key Features

- Dienst- und Urlaubsplanung für Filialen, Abteilungen und Teams
- Personalverwaltung mit Teammitgliedern, Positionen, Sollstunden und individuellen Arbeitsregeln
- Geprüfter CSV-/XLSX-Import für Personalstammdaten mit Feldzuordnung, Vorschau, Dublettenbehandlung und wiederverwendbaren Profilen
- Strikt lesender Personalimport aus freigegebenen Microsoft-SQL-Server-Views mit vollständig wiederverwendbaren, an die geprüfte Quelle gebundenen Importprofilen
- Mindestbesetzung je Filiale, Abteilung und Wochentag
- Automatische Anrechnung von Feiertagen
- Urlaubsplanung mit Jahres-, Quartals- und Monatsübersicht
- PDF-Export für Dienstpläne, Abteilungspläne und Urlaubsübersichten
- Wochenstundenübersicht, Plan-/Ist-Vergleich, Pausenhinweise und Samstagswertung
- Mitarbeiterportal mit Urlaubs- und ZA-Anträgen, gemeinsamem Krankmeldungs-/AUM-Ablauf, lokaler Dokumenterkennung und Zeiterfassung
- Persönliche Portal-Einstellungen für Passwort und freiwillige WLAN-Zeitvorschläge
- Datenschutzneutrale, konfigurierbare Begrüßungen für Arbeitstag, Urlaubsrückkehr und Genesung
- Sofortige interne Besetzungswarnung sowie optional zeitgesteuerte externe Warnkanäle für zuständige Leitungen
- Freiwilliger WLAN-Anwesenheitsassistent mit bearbeitbaren und bestätigungspflichtigen Zeitvorschlägen
- Wochen- und Monatsübersichten der Zeiterfassung mit nachvollziehbaren Korrekturanträgen
- Konfigurierbare CSV-/XLSX-Exporte für Lohnverrechnung mit Tagesjournal oder Lohnarten, Vorprüfung und getrennten Plan- beziehungsweise geprüften Ist-Werten
- Kontrollierte HTTPS-JSON-Übergabe final geprüfter, minimierter Lohnwerte mit Idempotenz, SSRF-Schutz, nachvollziehbarem Zustellstatus und herunterladbarem versionierten Schnittstellenvertrag
- Mobil optimiertes Leitungsportal mit konfigurierbaren Kernfunktionen
- Versionierte Mobile-API mit sicherer Geräteanmeldung, Standortbranding, persönlichem Dienstplan und Zeiterfassung für den eigenständigen Android-/iOS-Client
- Rollen- und Rechtemanagement mit personenbezogenen Zusatzrechten, Bereichsgrenzen sowie grafischer Prozessübersicht mit Konfigurationsprüfung, folgenloser Simulation und PDF-Dokumentation
- Standortbezogene Branding-Kits für unterschiedliche Filialauftritte
- Lokale SQLite-Datenbank ohne externen Datenbankserver
- Integriertes Backup-System, optional verschlüsselte Restic-/rclone-Offsite-Sicherung, transaktionales Ubuntu-Host-Hardening und GitHub-basierter Aktualisierungscheck
- System-Center mit transparentem technischem Vertrauensindex, signierter Recovery-Assurance-Timeline, begrenzten Langzeittrends, nächtlichem isoliertem App-Smoke-Test und deduplizierter interner Eskalation
- Windows-Host-Assistent für vorkonfigurierte USB-Sticks mit Funktionsprofil, Team, Rollen, Branding-Kits und anpassbarer „Erste Schritte“-PDF; nutzbar aus Lokal-, LAN- und HTTPS-Betrieb direkt am Host

## Schutz sensibler Personalakt-Daten

Sensible Inhalte des Personalakts sowie AUM-Dokumente und ihre geschützten Metadaten werden außerhalb des öffentlichen Webordners gespeichert und zusätzlich mit **AES-256-GCM** verschlüsselt. Die Anwendung prüft Dateitypen anhand ihres Inhalts; Bilder können platzsparend in eine A4-PDF-Datei umgewandelt werden. Im HTTPS-Serverbetrieb ergänzt eine verpflichtende Virenscanner-Prüfung den Uploadprozess.

Der Zugriff folgt eigenen, besonders eingeschränkten Rechten. Datenbank und verschlüsselte Dokumentablage werden gemeinsam gesichert. Diese zusätzlichen Schutzmaßnahmen ersetzen nicht HTTPS, sichere Betriebssystem- und Dateiberechtigungen, eine geschützte Schlüsselverwaltung und ein geprüftes Backupkonzept. Betriebliche Indizes und nicht sensible Verwaltungsdaten bleiben für den Anwendungsbetrieb in SQLite lesbar.

## In Vorbereitung

- Weitere Datenbankprovider und kundenspezifische, durch die jeweilige Firmen-IT geprüfte API-Verträge
- Hochverfügbarkeit und horizontale Skalierung über mehrere Anwendungsinstanzen
- Erweiterte Auswertungs- und Integrationsmöglichkeiten

## Schnellstart unter Windows

1. Die portable ZIP-Datei unter [Grabenplaner v0.78.7 Beta](https://github.com/christianseiwaldat-collab/Grabenplaner/releases/tag/v0.78.7-beta) herunterladen und entpacken.
2. `Grabenplaner v0.78.7 Beta starten.cmd` doppelt anklicken.
3. Grabenplaner öffnet sich lokal unter [http://localhost:3000](http://localhost:3000).

Die Arbeitsdatenbank wird bei der ersten Verwendung unter `data\dienstplan.db` angelegt und ist nicht Bestandteil der neutralen Release-ZIP. Beim Start entsteht automatisch eine interne Sicherung; zusätzliche lokale Sicherungsziele können in Grabenplaner eingerichtet werden.

Aktualisierungen werden über GitHub geprüft und als Portable-ZIP direkt über HTTPS geladen; eine installierte oder angemeldete GitHub CLI ist nicht erforderlich. Vor der Installation prüft Grabenplaner Dateigröße und SHA-256-Prüfsumme. Die integrierte Aktualisierung ersetzt die Programmdateien kontrolliert und startet Grabenplaner neu; Datenbank, Backups, AUM-Dateien und lokale Laufzeitkonfiguration bleiben geschützt.

## Technische Grundlage

| Bereich | Umsetzung |
|---|---|
| Anwendung | Lokale beziehungsweise zentral bereitgestellte Web-App mit Node.js und Express |
| Datenbank | SQLite, ohne separaten Datenbankserver |
| PDF-Ausgabe | PDFKit |
| Tabellenimport und -export | CSV sowie XLSX mit ExcelJS |
| Direkte Schnittstellen | Microsoft SQL Server über ausschließlich lesbare Views; HTTPS-JSON mit TLS 1.2+, DNS-/SSRF-Schutz und idempotenter Zustellung |
| Bild- und Dokumentaufbereitung | Sharp und PDFKit |
| Lokale AUM-Datenerkennung | PDF.js für digitale PDFs; Tesseract.js mit lokal mitgeliefertem deutschen Sprachmodell für Scan-PDFs, hochgeladene Fotos und Kamerabilder |
| Geschützter Personalakt-Speicher | AES-256-GCM, kontextgebundene Verschlüsselung und gemeinsame Sicherung mit der Datenbank |
| Authentifizierung | Rollen, Browser-Sitzungen mit CSRF-Schutz, rotierende native Geräte-Sitzungen und bereichsbezogene Berechtigungen |
| HTTPS-Serverbetrieb | IT-verwalteter Ubuntu- oder Windows-Einzelserver mit Caddy, automatischer Live-/Ready-Prüfung sowie kontrolliertem Update, Backup und Restore |
| Ubuntu-Offsite-Backup | Optionales Restic-Repository über rclone mit eigenem Google-OAuth-Client (`drive.file`), verschlüsselter Google-Drive-Kopie, signierter Recovery-Assurance-Historie und beaufsichtigter Wiederherstellung |
| Ubuntu-Host-Sicherheit | Separates, paketgebundenes Audit-/Hardening-Modul für Schlüssel-SSH, UFW, Sicherheitsupdates, Kernel- und Journalvorgaben mit Zwei-Sitzungs-Bestätigung und automatischem Rollback |

Für lokale Entwicklung wird Node.js 22.13 oder neuer benötigt:

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

Einrichtung, Rechte, Sicherheitsgrenzen und Betriebsablauf direkter SQL-/API-Verbindungen sind in [INTEGRATIONEN.md](INTEGRATIONEN.md) beschrieben.

Öffentliche, rein fiktive [Muster-Branding-Kits und Demodaten](demo/README.md) stehen getrennt von produktiven Daten zum Download und Testen bereit.

## Branding und öffentliche Auslieferung

Die öffentliche Grundauslieferung verwendet ausschließlich das neutrale Grabenplaner-Branding. Unternehmenslogos, geschützte Marken und kundenspezifische Voreinstellungen gehören in getrennte Branding-Kits und sind nicht Bestandteil dieses Repositorys.

## Lizenz und Sicherheit

Grabenplaner ist **source-available, aber nicht Open Source**. Private, interne Test- und Evaluierungsnutzung ist gemäß [LICENSE.md](LICENSE.md) erlaubt; kommerzielle Nutzung erfordert die vorherige schriftliche Genehmigung des Rechteinhabers.

Sicherheitsprobleme bitte vertraulich nach den Hinweisen in [SECURITY.md](SECURITY.md) melden und nicht als öffentliches GitHub-Issue veröffentlichen.
