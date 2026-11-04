# Lokale Kennwortprüfung – Quellen und Betrieb

Die Kennwortpolicy prüft neue Kennwörter unverändert als UTF-8: 15 bis 256 Unicode-Codepoints, höchstens 1024 UTF-8-Bytes. Es gibt keine Trimmung, Kürzung, NFC-Normalisierung oder Änderung der Groß-/Kleinschreibung des Hash-Eingabewerts. `scrypt-v1` bleibt Aufgabe des Anwendungsservers. Dieses Modul verifiziert keine bestehenden Anmeldehashes.

## Gebündelte Quellen

Beide Ableitungen stammen aus dem öffentlichen SecLists-Repository, Commit `60e43f4d2b0251330ff18ea4fa76aabec0515dcb`, geprüft am 18.10.2026. URLs, Bytezahlen, SHA-256-Prüfsummen, Filterstatistik und Ausgabefingerprints stehen in `manifest.json`. Nur die Hashableitungen werden gebündelt; Quelldaten werden nicht mitgeliefert.

- **Common-Liste:** [`Passwords/Common-Credentials/xato-net-10-million-passwords.txt`](https://github.com/danielmiessler/SecLists/blob/60e43f4d2b0251330ff18ea4fa76aabec0515dcb/Passwords/Common-Credentials/xato-net-10-million-passwords.txt). Das [zugehörige README](https://github.com/danielmiessler/SecLists/blob/60e43f4d2b0251330ff18ea4fa76aabec0515dcb/Passwords/Common-Credentials/README.md) beschreibt die Häufigkeitsreihenfolge. Erst die Kennwortpolicy anwenden und deduplizieren, danach die ersten 3000 geeigneten Einträge auswählen. Der 3000. Eintrag liegt bei Quellzeile 790039; insgesamt sind 141033 von 5189454 Quellzeilen passend. Eine ungefilterte Top3000-Liste wäre nicht gleichwertig. Ausgabe: 3000 SHA-256-Werte, 195000 Bytes.
- **Separater Breach-Satz:** [`Passwords/Leaked-Databases/rockyou.txt.tar.gz`](https://github.com/danielmiessler/SecLists/blob/60e43f4d2b0251330ff18ea4fa76aabec0515dcb/Passwords/Leaked-Databases/rockyou.txt.tar.gz). Alle unterschiedlichen zur Policy passenden UTF-8-Zeilen des historischen RockYou-Datensatzes werden übernommen: 400992 SHA-256-Werte, 12831744 Bytes. 218 ungültige UTF-8-Zeilen wurden ausgeschlossen. Der Quellbereich [Leaked-Databases](https://github.com/danielmiessler/SecLists/blob/60e43f4d2b0251330ff18ea4fa76aabec0515dcb/Passwords/Leaked-Databases/README.md) erlaubt nur Passwortdaten ohne Personen-/Kontozuordnung.

SecLists veröffentlicht das Repository unter MIT; der unveränderte Hinweis ist in `LICENSE-SecLists.txt` enthalten. In den geprüften Verzeichnishinweisen wurde keine abweichende dateispezifische Lizenz genannt. Herkunft und Lizenzangabe beruhen auf dem veröffentlichenden Repository; die ursprünglichen Leaks wurden nicht unabhängig rekonstruiert und es wird kein neuer Rechtsstatus für ihre historischen Inhalte behauptet.

Die Common-Rangfolge ist historisch und nicht für GP-Nutzer neu erhoben. RockYou ist ein historischer Breach, kein aktueller vollständiger Bestand aller kompromittierten Kennwörter. Ein Nichttreffer bedeutet nur „in diesen lokalen Prüfsätzen nicht gefunden“. Die Quelle enthält keine zusätzliche Sprach-/Regionalabdeckungsgarantie. Insbesondere erfolgt kein laufender HIBP- oder anderer Netzwerkabruf. ASVS-Common- und Breach-Prüfung sind getrennte Kontrollen; eine Gesamtzertifizierung wird damit nicht behauptet.

## Kontextkatalog

Verglichen werden ausschließlich vollständige Kandidaten: `Grabenplaner` und die vom Server gelieferten Werte `loginName`, `employeeNumber`, `displayName`, `organizationName`. Der Vergleich ist für diese Kontextkontrolle unabhängig von Groß-/Kleinschreibung. Führende/abschließende Leerzeichen der **Kontextnamen** werden entfernt, Wortzwischenräume als Leerzeichen, ohne Trennzeichen, Bindestrich, Unterstrich oder Punkt kombiniert. Varianten erhalten keinen Zusatz oder `1`, `12`, `123`, `1234`, `!`, `1!`, `123!` oder das vorherige/aktuelle/nächste UTC-Kalenderjahr, optional mit `!`. Dies ändert weder das eingegebene Kennwort noch dessen späteren Hash. Keine Substring-Sperre: eine lange unabhängige Passphrase darf den Produktnamen enthalten. Kontextwerte sind auf 512 UTF-16-Einheiten und vier dokumentierte Felder begrenzt; dadurch sind Arbeit und Kandidatenanzahl begrenzt.

## Reproduktion und Updates

Mit Python 3.11 oder neuer aus dem Repository:

```text
python scripts/build-password-policy-corpus.py --source-cache <privater-Quellenordner> --download
```

Der optionale Download bezieht ausschließlich die festgeschriebenen öffentlichen Quellen (rund 102 MB); Größen und SHA-256 werden vor Verarbeitung geprüft. Ohne `--download` ist der Build vollständig offline und benötigt den bereits qualifizierten Cache. Das Archiv wird im Speicherstrom gelesen, nie als Verzeichnis entpackt. Einziger zugelassener Inhalt ist `rockyou.txt` mit 139921497 Bytes. `--output-dir` erlaubt eine getrennte Reproduktionsprüfung. Quellkennwörter werden nicht in Logs ausgegeben. Die Ausgabe ist deterministisch; Quelle und Filter müssen zusammen geändert, überprüft und versioniert werden.

Bei Quellenupdates sind die exakten Quellen- und Lizenzbelege, mindestens 3000 Common-Einträge **nach** Policyfilter, Breachabdeckung, ausgeschlossene Kodierungen und reproduzierbare Hashes neu zu prüfen. Eine Änderung an Länge/Unicode-Semantik erfordert ebenfalls einen neuen Korpus. Der Snapshot wird über den normalen geprüften Anwendungsrelease verteilt, kein eigenständiger Download im Produkt. Verantwortliche und organisatorischer Reviewrhythmus gehören in die Betriebsplanung; diese Dateien erfinden keine verbindlichen Aktualitätsfristen.

Die Anwendung lädt und verifiziert beide Datendateien einmal pro Prozess. Fehlender, beschädigter, unvollständiger oder mit der Policy inkompatibler Korpus sperrt Neusetzen mit `PORTAL_PASSWORD_POLICY_UNAVAILABLE` (503). Ein bereits laufender Prozess verwendet seinen unveränderten geprüften Speicherstand; Updates werden erst nach Neustart geladen. Es gibt keinen stillen Fallback auf eine leere Liste. Ein vorhandener historischer Snapshot bleibt verwendbar; `corpusVersion` identifiziert dessen Stand ausdrücklich. Die vorhandene Anmeldeverifikation muss unabhängig von der Verfügbarkeit der Neusetzenprüfung bleiben.

SHA-256 wird nur zum lokalen Listenvergleich verwendet und ersetzt keine gesalzene Kennwortableitung. Es werden weder Kandidaten noch Lookuphashes oder Hashpräfixe extern übertragen oder protokolliert. Der Runtime-Breachsatz ist ein sortierter Binärpuffer mit 32 Bytes pro Eintrag und binärer Suche; er erzeugt keinen String pro Eintrag. Tests nutzen öffentlich bekannte oder synthetische Fixtures ohne reale GP-Kontodaten.
