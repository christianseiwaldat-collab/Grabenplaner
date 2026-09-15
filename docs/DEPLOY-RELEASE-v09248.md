# Release v0.92.48-beta

Die Live-Prüfung des unter v0.92.47 fortgesetzten Trade-Auftrags zeigte eine
zusätzliche Unterbrechungsursache: Erstellung und Ablauf wurden mit zwei
Uhrabfragen gespeichert. Der reale Auftrag hatte dadurch eine Frist von
72 Stunden plus einer Millisekunde. Der bisherige Leser verlangte eine exakt
72-stündige Frist und hätte den verschlüsselten Auftrag beim nächsten
Dienststart verworfen.

Neue Upload- und Übernahmeaufträge berechnen ihre Zeitangaben aus derselben
Uhrabfrage. Der Leser akzeptiert die bisherige positive Abweichung bis zu
einer Sekunde und normalisiert die Frist auf exakt 72 Stunden ab Erstellung.
Größere oder negative Abweichungen bleiben ungültig; Rechte, Integrität,
Verschlüsselung und die bewusste Freigabe zur Übernahme bleiben bestehen.

17 Import-Tests bestanden, einschließlich fortlaufender Uhrzeit bei jeder
Abfrage, Prozessrekonstruktion für Upload und Übernahme sowie Wiederaufnahme
bereits gespeicherter Aufträge mit der produktiv beobachteten Abweichung.
Der laufende Trade-Auftrag bleibt für die Aktualisierung erhalten.

## Produktiver Abschluss

Commit `2ab47a66bc6a4682d5ba784b110f8bec37220d4f` wurde am 14.09.2026 um
23:22:18 UTC erfolgreich installiert. Alle 697 Paketdateien, das unveränderte
PostgreSQL-Paar, der Zugriffsschutz und die Betriebsbereitschaft bestanden.
Die vier tatsächlichen Artikelprüfungen bestätigten weiterhin RE und Zielpreis.

Nach dem tatsächlichen Dienstwechsel setzte derselbe verschlüsselte Trade-
Auftrag ohne neue Benutzeraktion fort. Seine Frist beträgt jetzt exakt
259.200.000 ms; Fehler und Wiederholungen standen auf null. Die zuvor
blockierende Tabelle ARTIKEL_BILDER_V2 war vollständig mit 30.567 Zeilen
übernommen. Der gesamte Import war weiterhin in Arbeit.

Der vollständige Wiederherstellungsnachweis von v0.92.47 bleibt für den
unveränderten kritischen Programmvertrag gültig; der Entscheidungsprüfer
bestätigte den kurzen Modus. Der konkrete Updateraufruf nutzte dennoch den
langen Ablauf, weil eine übernommene separat gepinnte Prüferfreigabe diesen
erzwingt. Das wurde vor dem nächsten normalen Update korrigiert, ohne den
installierten Paketprüfer oder seine Prüfungen zu ändern. Eine zusätzliche
native Vollprüfung wurde für diesen unveränderten Vertrag nicht gestartet;
der bestehende Nachtlauf bleibt aktiv.

Ein frischer Monitorlauf bestätigte alle 24 Prüfungen ohne automatischen
Neustart. Zwei Sicherungspaare blieben erhalten. Belege wurden gesichert,
lokal hashgeprüft geladen und nur eigene temporäre Releasekopien entfernt.
