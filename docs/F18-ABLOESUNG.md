# Kontrollierte Ablösung von F18-Lagerware

Der Grabenplaner übernimmt Leihdaten ausschließlich aus einer vollständigen Sicherung, die mit der Backup-Funktion von F18-Lagerware erstellt wurde. Ein direkter Zugriff auf die laufende F18-Datenbank oder eine automatische Abschaltung des bisherigen Systems findet nicht statt.

## Voraussetzungen

- Der Zielstandort und alle in Leihvorgängen vorkommenden Personen bestehen bereits im Grabenplaner.
- Eine Personalleitung oder höhere Rolle besitzt das Recht `loans:settings`.
- Von F18-Lagerware liegt eine aktuelle vollständige ZIP-Sicherung vor.
- Während des endgültigen Cutovers werden in F18 keine neuen Ausgaben oder Rücknahmen mehr erfasst.

Die Sicherung muss das Format `f18-lagerware-backup` in Schema-Version 1 verwenden. Der Assistent kontrolliert vor einer Übernahme:

- ZIP-Struktur und sichere Dateipfade,
- das enthaltene Backup-Manifest,
- Größe und SHA-256-Prüfsumme jeder deklarierten Datei,
- die SQLite-Integrität und die benötigten Tabellen,
- sechsstellige Artikelnummern und höchstens fünf Artikel je Leihe,
- maximal neun Ausgabe- und neun Rücknahmefotos je Leihe,
- vorhandene Fotodateien und plausible Pflichtdaten.

## Empfohlener Ablauf

1. Alle gerade laufenden F18-Vorgänge fertig erfassen.
2. Weitere Änderungen in F18 organisatorisch sperren.
3. Eine neue vollständige F18-Sicherung erstellen.
4. Im Grabenplaner unter **Einstellungen → Grundeinstellungen → F18-Lagerware ablösen** den Zielstandort und die ZIP-Datei auswählen.
5. **Sicherung prüfen** ausführen und alle Befunde lesen.
6. Die verwendeten F18-Personen eindeutig vorhandenen Grabenplaner-Teammitgliedern zuordnen.
7. Die angezeigten Summen für offene und retournierte Leihen, Artikel und Fotos mit F18 vergleichen.
8. Die geprüfte Ablösung bestätigen.
9. Stichprobenweise offene und abgeschlossene Leihen, Fotos sowie Ausgabe- und Rücknahmebelege öffnen.
10. F18 zunächst nur organisatorisch auf **Nur Lesen** setzen und für einen vereinbarten Übergangszeitraum aufbewahren.

## Schutz vor Dubletten

Eine abgeschlossene F18-Ablösung ist pro Zielstandort einmalig. Derselbe geprüfte Sicherungsstand kann ohne doppelte Datensätze erneut bestätigt werden. Eine andere zweite Sicherung für denselben Standort wird blockiert. Korrekturen erfolgen deshalb nicht durch einen erneuten Import, sondern nach Prüfung des unveränderlichen Migrationsprotokolls.

## Übernommene Daten

- offene und abgeschlossene Leihvorgänge,
- bis zu fünf Artikelpositionen mit Artikelnummer, Bezeichnung, Seriennummer und Zustandsangaben,
- Fälligkeit, Ausgabe- und Rücknahmezeitpunkt,
- ausleihende Person und dokumentierte Gegenprüfung,
- Ausgabe- und Rücknahmefotos,
- Notizen und F18-Zustandsangaben,
- neu erzeugte Grabenplaner-Ausgabe- und Rücknahmebelege.

Fotos werden beim Import erneut verarbeitet, von Metadaten bereinigt und im geschützten Dokumentenspeicher verschlüsselt abgelegt. Die neu erzeugten Belege verwenden das im Grabenplaner dem Zielstandort zugewiesene Branding. Alte F18-Branding-Dateien werden nicht importiert.

## Bewusst nicht automatisch

- Das laufende F18-System wird nicht verändert, gestoppt oder deinstalliert.
- Die F18-Datenbank wird nicht direkt mit dem Grabenplaner verbunden.
- E-Mail-Zustellungen aus der Vergangenheit werden nicht erneut ausgelöst.
- Abweichende oder fehlende Mitarbeiterzuordnungen werden nicht geraten.
- Daten werden bei einem Konflikt nicht stillschweigend gekürzt oder verworfen.

Die tatsächliche Stilllegung von F18 darf erst nach fachlicher Stichprobe, gesicherter Aufbewahrung des letzten F18-Backups und ausdrücklicher administrativer Entscheidung erfolgen.
