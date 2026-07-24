# Pilot und Abnahme

Stand: Grabenplaner v0.84 Beta

Der Produktreife-Bereich im System-Center dokumentiert einen begrenzten, nachvollziehbaren Pilot- und Abnahmestand. Er ersetzt keine rechtliche Einzelfallprüfung, keine unabhängige Sicherheitsprüfung und keine vollständige Barrierefreiheitsbewertung.

## Sechs getrennte Gates

1. **Desktop-Pilot**
   - Dienstplanung bearbeiten, speichern und als PDF exportieren.
   - Personal-, Antrags- und Einstellungsabläufe im unterstützten Desktop-Browser prüfen.
   - Der Viewport muss mindestens 900 CSS-Pixel breit sein.
2. **Mobiler Browser**
   - Login, Zeiterfassung, persönlicher Dienstplan, Urlaub und ZA prüfen.
   - Kamera- und Datei-Upload für AUM einschließlich Rückkehr in den richtigen Ablauf prüfen.
   - Der Viewport darf höchstens 899 CSS-Pixel breit sein.
3. **Barrierearme Bedienung**
   - Prüfbasis ist WCAG 2.2.
   - Kernabläufe mit Tastatur und sichtbarem Fokus prüfen.
   - Kernseiten bei 200 Prozent Zoom kontrollieren.
   - Namen von Bedienelementen und dynamische Statusmeldungen prüfen.
   - Kontrast, Fokus und Zustände in heller und dunkler Darstellung kontrollieren.
4. **Performance**
   - Desktop-Seitenstart: höchstens 3.000 ms.
   - Mobiler Seitenstart: höchstens 5.000 ms.
   - Die gemessene Navigation Timing-Dauer wird zusammen mit Browser und Viewport gespeichert. Eine Überschreitung kann serverseitig nicht als bestanden protokolliert werden.
5. **Security-Audit**
   - Server, Datenbank und TLS müssen im System-Center aktuell technisch bestätigt sein.
   - Die Prüfbasis orientiert sich an OWASP ASVS 5.0.0.
6. **Recovery-Drill**
   - Recovery Assurance muss einen erfolgreichen isolierten Restore und einen erfolgreichen Anwendungsstart nachweisen.
   - Ein vorhandenes Backup ohne getestete Wiederherstellung genügt nicht.

## Nachweise und Integrität

- Jeder manuelle Nachweis enthält Release-Version, Prüfpunkt, Ergebnis, Plattform, Browser, Browserversion, Viewport, Darstellung, Prüfzeitpunkt und optional eine kurze Notiz.
- Nachweise sind append-only. Aktualisieren oder Löschen ist auf Datenbankebene gesperrt.
- Jeder Datensatz besitzt einen kanonisch berechneten SHA-256-Beleg.
- Beim App-Start werden alle gespeicherten Nachweise und Abnahmen erneut verifiziert. Beschädigte oder nachträglich veränderte Daten verhindern einen scheinbar grünen Status.
- Für jeden Prüfpunkt zählt der jüngste gültige Nachweis. Ein neuer Fehlernachweis blockiert das betroffene Gate.
- Nachweise zählen nur für die Release-Version, in der sie tatsächlich erfasst wurden. Eine neue Version beginnt mit offenen Pilot-Gates.

## Doppelte Abnahme

Nach sechs bestandenen Gates sind zwei getrennte Entscheidungen erforderlich:

- **Technische Abnahme:** Developer, IT-Administration oder dafür technisch berechtigte Administration.
- **Fachliche Abnahme:** Personalleitung, Administration oder Developer.

Jede Abnahme ist an die konkrete App-Version und einen SHA-256-Fingerabdruck des gesamten Prüfstands gebunden. Ein neuer Pilotnachweis, ein geänderter technischer Gate-Status oder eine neue Version verändert diesen Fingerabdruck. Frühere Abnahmen bleiben in der Historie erhalten, gelten für den neuen Stand aber nicht mehr.

## Rollen und Protokollierung

Das Recht `system:readiness:review` erlaubt das Erfassen von Pilotnachweisen. Technische und fachliche Abnahmen besitzen zusätzliche Rollen- und Rechtebedingungen. Alle Erfassungen und Entscheidungen werden im Portal-Audit protokolliert.

## Mobile Grenze

v0.84 prüft den vorhandenen responsiven Webzugang für Android- und iOS-Browser. Native App-Erweiterungen und WLAN-Automatik sind nicht Bestandteil dieses Blocks. Kamera- und Dateiupload, Touch-Bedienung, Login und Sitzungssicherheit bleiben aber verpflichtende mobile Pilotpunkte.

## Prüfgrundlagen

- [W3C Web Content Accessibility Guidelines (WCAG) 2.2](https://www.w3.org/TR/WCAG22/)
- [OWASP Application Security Verification Standard (ASVS) 5.0.0](https://owasp.org/www-project-application-security-verification-standard/)

Die Verweise beschreiben die verwendeten Prüfgrundlagen. Grabenplaner behauptet damit keine vollständige WCAG-Konformität oder ASVS-Zertifizierung und gibt keine pauschale Rechts-, Sicherheits- oder Barrierefreiheitsgarantie.
