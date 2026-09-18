# Dienstplan: erste Anzeige und Mitarbeiterabruf

Die produktiven Zugriffsprotokolle am 18.09.2026 zeigten Dienstplanantworten
mit HTTP 200 nach rund 1–3 Sekunden. Zeitgleich dauerte `/api/employees`
teilweise 6–8 Sekunden; ein Abruf scheiterte mit HTTP 500 und
`PERSISTENCE_TIMEOUT`. Die Oberfläche wartete auf alle Antworten gemeinsam
und verwarf dadurch auch einen bereits erfolgreich geladenen Dienstplan.

Der Dienstplan wird jetzt nach seiner eigenen Antwort dargestellt. Fehler
bei Zusatzdaten bleiben sichtbar, verhindern diese erste Anzeige aber nicht.
Beim Einstieg wird die angeforderte Ansicht mit ihrem Standort vor dem
Datenabruf ausgewählt, ohne einen zweiten Initialabruf auszulösen.
Antworten einer abgelösten Anmeldung dürfen die Ansicht nicht aktualisieren.

Der Mitarbeiterabruf verwendet denselben geschützten, an eine Anfrage
gebundenen PostgreSQL-Lesebereich wie die Dienstplanung. Er bündelt die
Einzelabfragen in einer lesenden Transaktion mit erneuter Rechteprüfung vor
der Antwort. Standortfilter und personenbezogene Feldfreigaben bleiben bestehen.

Gezielte Lade-, Rechte- und Architekturprüfungen: 21 bestanden. Der vorhandene
native PostgreSQL-Paritätstest wurde um die Mitarbeiterliste erweitert.
Die erste lokale Ausführung konnte die abgeschaltete Entwicklungsdatenbank
nicht erreichen; dies ist kein fachlicher Testerfolg. Veröffentlichung und
produktive Antwortzeiten sind gesondert zu verifizieren. Ein spezifischer
Firefox-Darstellungsfehler ist bislang nicht reproduziert.
