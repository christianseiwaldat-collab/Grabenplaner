# Abschluss der erneuten Block-4-Vorpruefung am 07.09.2026

Die auf die gesamte schlanke Kasse und den bestehenden GP-Bestand begrenzte Vorpruefung ist abgeschlossen. Die Kassenintegration in Block 4 kann fortgesetzt werden. Ein weiterer vollstaendiger Trade-Neuaufbau ist fuer diese Vorpruefung nicht erforderlich. Dies ist keine Freigabe zur sofortigen produktiven Aktivierung.

## Groesse und korrigierter Pruefumfang

Die zuvor gemeldeten 2,12 GB betrafen einen neu aufgebauten, isolierten TradeFoto-Testbestand samt SQLite-Schreibjournal. Es war weder die schlanke Kasse noch die produktive GP-Datenbank. Der zusaetzliche Lauf wurde nach der Umfangskorrektur des Nutzers abgebrochen. Seine zuletzt vorhandenen 3.009.471.312 Byte an Testdatenbank und Journal wurden entfernt. Die Kassenphase dieses kombinierten Laufs hatte nicht begonnen; der Lauf wird ausdruecklich nicht als bestanden gewertet.

Fuer die komplette Kasse bleibt der bestandene Nachweis bei **816,53 MB** fuer 1.082.167 Zeilen, sieben Tabellen und alle 97 Geschaeftsfelder. Die Access-Quelle hat 330,93 MB. Der Faktor 2,47 beinhaltet verschluesselte Werte und Suchindizes. Es gibt keine zusaetzlichen universellen Kassenkopien. Der vorhandene GP-Bestand hat 638,07 MB; die Addition ergibt **1,45 GB Datenbankvolumen**. Diese Addition ist eine Planung, keine neu gemessene kombinierte Datenbank.

Der vollstaendige Kassenimport mit Wertepruefung und Kompaktierung dauerte im bestandenen PC-Lauf 12 Minuten 47 Sekunden. Einschliesslich Sicherungen und Wiederherstellungen dauerte der Nachweis 16 Minuten 54 Sekunden. Diese PC-Zeiten sind keine VPS-Laufzeitgarantie. Ein unveraenderter Export erfordert keinen erneuten Import. Quellhash und alle zehn im Kassenbericht erfassten Implementierungsdateien wurden jetzt erneut abgeglichen und stimmen ueberein.

## Abgeschlossene Nachweise

- Vollstaendige aktuelle Testsuite: **3.053 bestanden, 0 fehlgeschlagen, 41 uebersprungen**; 3.094 insgesamt. Eine veraltete Test-Erwartung fuer die SQL-Inventarzaehler wurde korrigiert, danach bestand die ganze Suite.
- Native Linux-Sperrpruefung: 5 von 5 bestanden; 35 Shell-Skripte syntaktisch geprueft.
- VPS-Anwendungs- und Offsite-Selbsttests bestanden. Google-Drive-Restore und separater Start der wiederhergestellten Anwendung bestanden. Letzterer ist kein vollstaendiger signierter Assurance-Lauf.
- Kassenarchiv: 449,21 MB. Wiederherstellung samt neuer Vault-/Provider-Instanz und erneutem Vergleich aller 1.082.167 Zeilen bestanden. Ein unveraenderter weiterer Sicherungspunkt benoetigte 52,5 KB; geaenderte Exporte koennen mehr benoetigen.
- Reale vorhandene GP-Tagessicherungen in isolierten Archiven geprueft: vier App-Tage und sieben externe Tage; Integritaet und jeweils aeltester/neuster Restore bestanden. Groesster beobachteter Tageszuwachs: 77,12 MB. Alle verwendeten Original-Backups blieben erhalten.

## Speicherrechnung und verbleibender Abschluss

Gemessener Freiraum am VPS: **72,45 GB**; auf Google Drive: **109,57 GB**. Die konservative Rechnung fuer bestehenden GP plus schlanke Kasse benoetigt **40,04 GB zusaetzlichen Freiraum**, einschliesslich Sicherungsarchiven, acht kalkulierten Arbeitskopien, Journal, Austausch-/Aufraeumreserve und 10 GiB Reserve. Damit bleiben in diesem Szenario **32,41 GB** darueber frei. Die bereits vorhandenen Backups sind im belegten VPS-Speicher enthalten; ihre Loeschung wird nicht als Einsparung vorausgesetzt.

Die Rechnung setzt den vorbereiteten komprimierten Archivbetrieb mit zwei Bereichen und jeweils 20 Kalendertagen voraus. Sie verwendet den doppelten beobachteten GP-Tageszuwachs plus den unveraenderten Kassenanteil. Sie garantiert keinen beliebig grossen neuen Export und ist kein gemessener produktiver Spitzenbedarf. Der bisherige installierte Rohbackup-Betrieb wurde nicht umgestellt; der maschinelle Gesamtstatus qualified bleibt false.

Als konkrete Restarbeit bleiben die fachliche Anbindung der kompakten Kasse mit Rechten und Zuordnungen, der atomare Datenstandswechsel samt Rueckkehr, sowie das zusammenhaengende Runtime-/Backup-Update. Beim anschliessenden Release ist die vollstaendige signierte Betriebs-/Wiederherstellungspruefung erforderlich; der installierte Helfer hat noch das alte 120-Sekunden-Startfenster. Es wurde kein Deploy durchgefuehrt.

Auch der zusaetzlich begonnene Versuch, saemtliche alten Backup-Punkte umzuwandeln, wurde zur Begrenzung des Pruefumfangs gestoppt und sein eigenes temporaeres VPS-Verzeichnis entfernt. Er ist kein bestandener Umstellungsnachweis. Die abgeschlossene Messung der vorhandenen Tagessicherungen bleibt gueltig.

[Maschinenlesbarer Bericht mit Evidenz-Hashes](BLOCK-4-NEUPRUEFUNG-2026-09-07.json)
