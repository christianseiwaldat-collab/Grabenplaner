# Abhängigkeitsnachprüfung vom 24. Oktober 2026

Der vollständige SCA-Teil des Security-Laufs `40040033510` prüfte den Quellstand `d5198f91dd2b058ca5649b5a25a30bb4d2eadd9c` und meldete zwei OSV-Advisories sowie eine aggregierte High-Meldung der NPM-Registry. Der SCA-Teil ist fehlgeschlagen. Dieser Bericht erteilt weder eine Ausnahme vom Security-Gate noch eine Freigabe des gesamten Laufs oder des Produktivstands.

| Advisory | Betroffene Abhängigkeit | Bewertung und nächster Schritt |
| --- | --- | --- |
| [GHSA-27r3-jxmh-p828 / CVE-2026-111181](https://github.com/expressjs/body-parser/security/advisories/GHSA-27r3-jxmh-p828) | `body-parser@2.3.0` über `express@5.2.1` | Priorität P1. Der globale JSON-Parser verarbeitet komprimierte Anfragen vor der Anwendungsautorisierung. Nachlaufende Bytes können nach erfolgreicher Verarbeitung einen unbehandelten Decoderfehler auslösen und den Prozess beenden. Kompatibler Fix: Override auf `2.4.0`; Express bleibt unverändert. |
| [GHSA-xcx6-jx8p-x3h5 / CVE-2026-109461](https://github.com/AzureAD/microsoft-authentication-library-for-js/security/advisories/GHSA-xcx6-jx8p-x3h5) | `@azure/msal-node@5.4.0` über `tedious@20.3.7` → `@azure/identity@4.13.1` | OSV bewertet High (7,5); der Hersteller bewertet Moderate (5,9). Betroffen ist die Verarbeitung nicht vertrauenswürdiger Authorization-Code-Antwortfelder. Der aktuelle GP-SQL-Adapter unterstützt ausschließlich Benutzername/Passwort und konstruiert fest Tedious-Authentifizierung `default`. Zusätzlich ist der konkrete Herstellerfix auf die vorhandene Version zurückportiert und lokal geprüft; die vollständige Linux-/CI-Freigabe steht noch aus. |

Der historische Registry-Beleg enthält nur die aggregierte Anzahl, keine Advisory-Identität. Eine gesonderte, frische Registry-Abfrage mit exakt PNPM `11.7.0` gegen den unveränderten ursprünglichen Lock bestätigt `body-parser` als einzige Registry-High-Meldung. Dieselbe Abfrage gegen den vorbereiteten Lock meldet keine Registry-Schwachstelle. Diese späteren Abfragen ersetzen weder den ursprünglichen Beleg noch die unabhängige OSV-Prüfung; insbesondere bleibt die OSV-MSAL-Meldung bestehen.

## Begrenzter Änderungssatz

`pnpm-workspace.yaml` pinnt ausschließlich `body-parser: 2.4.0` unter `overrides`. Der mit PNPM `11.7.0` neu aufgelöste Lock ändert die bestehende Body-Parser-Version und fügt deren Abhängigkeit `content-type@2.1.0` hinzu. Alle anderen Paketversionen einschließlich Express bleiben gleich; `package.json` bleibt unverändert. Der neue Parser und Content-Type benötigen Node `>=18` und sind mit dem GP-Mindeststand Node `22.13` vereinbar.

Die Originaltarballs von PNPM `11.7.0`, Body-Parser `2.4.0` und Content-Type `2.1.0` wurden vor ihrer Verwendung mit SHA512-SRI, Registry-Signatur und dem SHA256-Fingerabdruck des NPM-ECDSA-Schlüssels geprüft. Die private Frozen-Installation lief mit deaktivierten Installationsskripten und deaktivierter `.pnpmfile`, getrenntem Store und unverändertem Lock. Systemwerkzeuge und der ursprüngliche Abhängigkeitsbaum wurden dabei nicht verändert.

Der gesonderte MSAL-Backport erhält Version, Abhängigkeiten, Exports und MIT-Lizenz von `5.4.0`. Er übernimmt aus dem Herstellercommit `f550958586475dbfeb1cd44be14a2d653728850e` die Abweisung nicht unterstützter Instance-Aware-Konfigurationen und die feste Projektion der Authorization-Code-Antwort: Code und erwartete Nonce stammen aus dem ursprünglichen Request; nur der zurückgegebene State bleibt für die CSRF-Prüfung erhalten. Antwortgesteuerte Routingfelder werden verworfen. Die sieben geänderten Original-TS-, CJS-, ESM-, Fehler- und Typdateien sind einzeln gebunden; der vollständige installierte Paketbaum ist zusätzlich gehasht. Veraltete Source-Map-Verweise in den geänderten Ausgabedateien sind entfernt. Die Originaltarballs `5.4.0` und `7.1.0` wurden mit SRI und Registry-Signaturen geprüft.

`scripts/security/patch-policy.json` registriert diesen engen Backport bis zum 23. November 2026. Vor jeder SCA-Bewertung prüft der Patchverifizierer Original-SRI im Lock, Patch-/Workspace-/Lockbezug, alle sieben installierten Dateien, den gesamten MSAL-Paketbaum und beide tatsächlich ausgeführten Exportvarianten. Eine Abweichung oder ein fehlgeschlagener Test lässt den Nachweis scheitern. Der Scannerrohbefund wird unverändert aufbewahrt; ausschließlich der exakt passende, erfolgreich geprüfte Befund erhält den Status `remediated_by_verified_patch`. Die Liste `advisoryExceptions` bleibt leer. Zusätzliche Advisories und aggregierte Registry-Meldungen bleiben blockierend.

## Bereits ausgeführte lokale Nachweise

Die vier Tests in `test/security-body-parser-trailing-bytes.test.js` verwenden ausschließlich synthetische Kindprozesse auf `127.0.0.1`. Der ursprüngliche `2.3.0`-Graph beendet den Prozess beim komprimierten Nachlaufbytes-Fall mit einem unbehandelten `Z_DATA_ERROR`; die übrigen drei Fälle bestehen. Mit dem vorbereiteten `2.4.0`-Graph bestehen alle vier Fälle einschließlich anschließender Health-Anfragen. Geprüft werden außerdem ungültiger Zeichensatz, ungültige Kompression, Größenlimit sowie die JSON-, Raw-, Text- und Formular-APIs.

Die drei Tests in `test/security-msal-auth-reachability.test.js` prüfen die konkrete Authentifizierungsgrenze: Azure-Routingfelder werden nicht übernommen, Authorization-Code-/Token-Felder werden als SQL-Credentials abgewiesen, und auch beim direkten Aufruf des echten GP-Adapters entsteht ausschließlich die feste Tedious-Konfiguration für Benutzername/Passwort. Zusammen mit den bestehenden Integrations- und SQL-Quellentests bestehen 27 lokale Fälle. Ein externer SQL-Server wurde dabei nicht kontaktiert.

Die 14 zusätzlichen MSAL-Backportfälle in `test/security-msal-auth-code-backport.test.js` prüfen beide Exports, schädliche Antwortmetadaten, erhaltene State-Prüfung, Instance-Aware-Abweisung und normale Client-Credentials. Der originale `5.4.0`-Baum besteht sechs Fälle und scheitert erwartungsgemäß an acht Sicherheitskontrollen. Der mittels PNPM-Patch und echtem Frozen-Install erzeugte Kandidat besteht alle 14 Fälle; zusammen mit Parser-, Adapter- und bestehenden SQL-Tests bestehen 45 Fälle. Der tatsächliche Redemptionpfad wird mit einem ausschließlich synthetischen Netzwerkadapter aufgezeichnet; es werden keine Token an einen echten Endpunkt übertragen.

Diese Nachweise wurden unter Windows mit Node `24.19.0` ausgeführt. Vollständige Linux-Tests, der Mindest-Node-Stand und die vollständige CI/SAST bleiben gesonderte Abschlussanforderungen. Historische Wiederherstellungstests verwenden einen getrennt aus dem unveränderten `b2ba03c`-Lock erzeugten Dependencybaum. Dessen extern gepinnter Manifesthash bindet die Originalmetadaten und jede tatsächlich installierte Datei. Ein abweichender aktueller Lock darf niemals stillschweigend die alten Tests versorgen.

## Primärquellen

- [Body-Parser 2.4.0 und offizieller Sicherheitsfix](https://github.com/expressjs/body-parser/releases/tag/v2.4.0)
- [Offizielle Body-Parser-Regressionsfälle](https://github.com/expressjs/body-parser/blob/v2.4.0/test/json.js)
- [MSAL-Sicherheitsänderung, PR 8901](https://github.com/AzureAD/microsoft-authentication-library-for-js/pull/8901)
- [MSAL Node 7.1.0](https://github.com/AzureAD/microsoft-authentication-library-for-js/releases/tag/msal-node-v7.1.0)
- [NPM-Registry-Signaturen](https://docs.npmjs.com/about-registry-signatures/)
