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
Der laufende Trade-Auftrag bleibt für die Aktualisierung erhalten. Der
produktive Abschlussnachweis wird nach dem Folgeupdate ergänzt.
