# Release v0.92.47-beta

## Problem und Änderung

Die am 14.09.2026 bereits gestartete Trade-Übernahme blieb beim Erneuern der
Prüfpläne für 30.567 Zeilen in ARTIKEL_BILDER_V2 stehen. Das produktive
PostgreSQL-Protokoll bestätigte wiederholte Statement-Timeouts im Trigger für
die Import-Zustandszähler. Die gesamte unbeschränkte Aktualisierung wurde
zurückgenommen; gleichzeitig warteten andere schreibende GP-Aufrufe.

Das Zurücksetzen erfolgt jetzt nach Zustand und Zeilennummer in Paketen mit
höchstens 200 Zeilen. Erst nach dem vollständigen Zurücksetzen beginnt die
erneute Prüfung. Quellkonflikte und ungültige Zeilen bleiben erhalten. Lesen
des Importfortschritts benötigt keine globale Schreibsperre. Review und Apply
geben bei PostgreSQL nach ihrem kurzen Zeitbudget die Transaktion wieder frei.
Es werden weder Datenbank-Timeouts erhöht noch historische Migrationsdateien
geändert. Core- und Sales-Schema bleiben unverändert.

Ein separater, authentifizierter Start mit CSRF- und Revisionsprüfung speichert
den Übernahmeauftrag im bestehenden verschlüsselten Auftragsspeicher. Ein
Upload autorisiert weiterhin ausschließlich Bereitstellung und Prüfung.
Der Worker prüft aktuelle Rechte bei jedem Paket, übernimmt nur den gewählten
Dateistand und setzt über gespeicherte Prüfstände fort. Vorübergehende Fehler
haben drei gestaffelte Wiederholungen; fachliche Fehler bleiben sichtbar.
Parallel gestartete interaktive Mutationen desselben Auftrags werden abgewiesen.

## Filialkonto

Neben dem oberen Artikelsuchfeld öffnet „Scannen“ einen kompakten Kamera-Dialog.
Die lokal ausgelieferte Bibliothek @zxing/browser 0.2.1 erkennt EAN und QR.
Artikelcodes behalten führende Nullen und lösen unmittelbar die Suche aus.
QR-Webadressen werden nicht geöffnet; nur enthaltene Artikel-/EAN-Kennungen
werden übernommen. Kamera-Zugriff benötigt die normale Browserfreigabe und ist
über Permissions-Policy auf das Portal und die eigene Herkunft begrenzt.
Kamerabilder verlassen das Gerät nicht. Schließen, Ansichtwechsel, Hintergrund
und ein erfolgreicher Treffer stoppen den Stream, einschließlich verspäteter
Antworten auf die Berechtigungsanfrage.

Die produktive Nachprüfung nach dem Benutzerhinweis „RE nicht verfügbar“ fand
keine übernommenen ARTIKEL_STAMM-Segmente, obwohl der bisherige Artikelkatalog
DurchschnittEK und Brutto-/Nettopreise bereits enthielt. Die Kalkulation liest
deshalb bei fehlendem Master nun den bereits akzeptierten aktuellen Katalog:
ausschließlich das fachlich bestätigte Feld DurchschnittEK, keine alternativen
Einkaufspreise. Alte Kennzeichnungen unknown/unresolved dieses exakten Feldes
werden entsprechend der Benutzerbestätigung als Netto-EK interpretiert.
Quarantäne, Mehrdeutigkeit, andere Währungen und andere EK-Felder bleiben gesperrt.
Die MwSt. wird nur bei eindeutig übereinstimmenden Brutto-/Nettopaaren bestimmt
und entsprechend bezeichnet. Vorhandene Masterwerte bleiben vorrangig.

Vier aktuelle produktive Artikel wurden ausschließlich lesend mit der neuen
Berechnung geprüft. Artikel 100792: Ø EK netto 955,306884385816 €, Brutto-VK
1.329 €, Netto-VK 1.107,50 €, RE 152,19 € / 13,74 %. Ziel-RE 10 % ergibt einen
aufgerundeten Brutto-VK von 1.273,75 €. Ein zusätzlicher HTTP-Test bildet den
bisherigen Katalog ohne vollständige Masterübernahme nach. Preisfarben folgen
dem errechneten RE; ein positiver Verkaufspreis mit Verlust erscheint rot.

## Prüfung vor Veröffentlichung

- Isolierte native PostgreSQL-Prüfung mit 30.567 zurückzusetzenden Zeilen und
  zwei gesperrten Zeilen: 153 Pakete, längstes Paket 155 ms. Zustandstrigger,
  Zähler und Freigabe der Schreibsperre nach jedem Paket bestätigt.
- Verschlüsselte synthetische Import- und Wiederaufnahmeprüfungen erhalten
  bereits übernommene Zeilen, Rechteentzug, Pause und explizite Startfreigabe.
- Tatsächlich ausgelieferte Decoderdatei mit synthetischen EAN- und QR-Mustern
  sowie leeren Kamerabildern geprüft; automatische Suche und verspätete
  Kameraantworten zusätzlich als Clientablauf geprüft.
- Lokale Filialkonto-Vorschau im schmalen Browser: Suchfeld, rechter Scanbutton
  und Dialog bedienbar. Auf dem Prüfgerät ist keine Kamera vorhanden; die
  verständliche Meldung wurde bestätigt. Ein physischer Scan auf dem Handy
  ist dadurch noch nicht nachgewiesen.
- Der Browserablauf mit einem bisherigen Artikelimport ohne Masterdaten zeigt
  RE 13,74 %, nimmt Ziel-RE 10 % an und gibt 1.273,75 € aus. Die Eingabe eines
  Verlustpreises färbt das Feld rot und zeigt den negativen RE. Kein horizontaler
  Seitenüberlauf in der schmalen Ansicht. Der Screenshotabruf der Automatisierung
  lief in ein Zeitlimit; Bedienung, DOM und Abmessungen wurden direkt geprüft.

Die Freigabe umfasst das bestehende Updateverfahren mit frischem gekoppeltem
Rückkehrpunkt und dem automatisch bestimmten Prüfmodus. Kein VPS-/PostgreSQL-
Neustart und keine Änderung an Netzwerkzugängen.

## Produktiver Abschluss

Der bestehende Updater installierte Commit
`dd34cc861322a727f9fcb615948bab8980dba2a9` erfolgreich am 14.09.2026 um
22:43:18 UTC. Der Versionswechsel mit Paketprüfung und Sicherung benötigte
rund 15 Minuten. Alle 697 ausgelieferten Dateien wurden am VPS geprüft;
Core-/Sales-Strukturen, Datenbankautorität und fremde Dienste blieben erhalten.

Die tatsächlich installierte Artikeldetailfunktion wurde anschließend mit den
vier genannten produktiven Artikeln und reinen Leserechten geprüft: RE und
Ziel-RE verfügbar, Eingabefeld aktiviert, Scannerdateien erreichbar und
Kameraberechtigung auf das Portal begrenzt. Die bestehende Chrome-Anmeldung
blieb gültig. Ein echter Handy-Kamerascan wurde weiterhin nicht durchgeführt.

Die vollständige externe Wiederherstellung einschließlich Anwendungstest
bestand am 14.09.2026 um 23:04:21 UTC, Run
`cac17d37-89e8-4b46-8f1c-6387f6db69f0`. Ein frischer Monitorlauf bestätigte
alle 24 Betriebsprüfungen ohne automatischen Neustart. Zwei gekoppelte
Sicherungspaare blieben erhalten; temporäre Release- und native Testkopien
wurden nach Sicherung der Belege entfernt. Die Belege wurden lokal mit
Hashprüfung übernommen.

Der bereits begonnene Trade-Auftrag wurde über die angemeldete GP-Oberfläche
am gespeicherten Stand fortgesetzt. Die frühere Problemstelle mit 30.567 Zeilen
bestand Vorbereitung und Prüfung; um 23:06 UTC waren 15.032 dieser Zeilen
übernommen. Der Auftrag lief nach Verlassen der Importseite weiter,
ohne Wiederholungsfehler. Die vollständigen 396.466 Zeilen waren zu diesem
Zeitpunkt noch nicht übernommen.

Der zusätzliche Live-Nachweis des verschlüsselten Auftrags deckte eine
Millisekundenabweichung der Ablaufzeit auf. Die Korrektur und der Nachweis
der Wiederaufnahme sind in [v0.92.48](DEPLOY-RELEASE-v09248.md) dokumentiert.
