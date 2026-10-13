# Brückenbauer

Ein Brücken-Bauspiel fürs Handy, Tablet (besonders iPad) und den PC. Du baust aus
Holz-, Stahl- und Seil-Balken eine Brücke über eine Schlucht oder einen Fluss –
dann fahren Fahrrad, Auto, Bus und LKW darüber, und die Physik entscheidet, ob
die Brücke hält. Es gibt vorgefertigte Level, einen Sandkasten zum freien
Bauen und einen Level-Editor für eigene Level.

Die gesamte Bedienung ist auf Deutsch. Das Spiel läuft im Browser, braucht
keine Installation aus einem App-Store und funktioniert nach dem ersten
Öffnen auch **offline**. Auf dem iPad lässt es sich wie eine richtige App auf
den Home-Bildschirm legen (siehe unten).

Dieses README richtet sich an alle, die das Spiel **nicht** als
Programmierer:in betreuen, sondern nur testen, pflegen und veröffentlichen
wollen. Du brauchst dafür keine Programmierkenntnisse.

---

## 1. Was ist in diesem Ordner?

```
Brueckenbauer/
├── index.html          Startseite des Spiels (die Datei, die geöffnet wird)
├── style.css            Aussehen (Farben, Schrift, Layout)
├── manifest.json         Beschreibung für "Zum Home-Bildschirm"
├── service-worker.js     sorgt für Offline-Betrieb und Updates
├── .nojekyll             technische Datei für GitHub Pages (nicht löschen)
├── README.md             diese Anleitung
├── js/                   das eigentliche Spielprogramm
│   ├── main.js              Spielablauf, Menüs, Bedienung
│   ├── physics.js            Brücken-Physik (Kräfte, Bruch, Simulation)
│   ├── render.js              alles, was gezeichnet wird
│   ├── editor.js               Bau-Logik (Balken setzen, Löschen, Rückgängig)
│   ├── levels.js                 die vorgefertigten Level
│   ├── save.js                    Spielstand (siehe Abschnitt 6)
│   └── audio.js                    Soundeffekte
└── icons/               App-Icons in verschiedenen Größen
    ├── icon-192.png, icon-512.png, icon-maskable-512.png   (Android/PWA)
    ├── apple-touch-icon.png                                 (iPad/iPhone)
    ├── favicon-32.png                                        (Browser-Tab)
    └── make-icons.py          Python-Skript, das obige Icons erzeugt
                                 (nur zum Nachbearbeiten der Icons nötig,
                                  für den Spielbetrieb unwichtig)
```

Du musst an diesen Dateien normalerweise **nichts** ändern – dieses README
beschreibt nur, wie du das Spiel testest und veröffentlichst.

---

## 2. Auf dem PC testen

Das Spiel **nur per Doppelklick auf `index.html` zu öffnen reicht nicht
ganz**: Der Browser öffnet die Datei dann über `file://…`, und darüber
funktionieren Offline-Betrieb und "Installieren" nicht. Zum Testen richtig
einrichten:

1. **Visual Studio Code** installieren (falls noch nicht vorhanden):
   <https://code.visualstudio.com/> → herunterladen → installieren.
2. In VS Code links auf das Erweiterungen-Symbol klicken (die vier Quadrate),
   nach **"Live Server"** suchen (von Ritwick Dey) und installieren.
3. In VS Code den Ordner `Brueckenbauer` öffnen (Datei → Ordner öffnen…).
4. Im Datei-Explorer von VS Code **rechtsklick auf `index.html`** →
   **"Open with Live Server"**. Der Browser öffnet sich automatisch mit einer
   Adresse wie `http://127.0.0.1:5500/index.html` – jetzt funktioniert alles
   wie später online, inklusive Offline-Test (siehe Abschnitt 8).
5. Änderungen an einer Datei speichern (Strg+S) – Live Server lädt die Seite
   automatisch neu.

Zum schnellen Ansehen ohne Testen der Offline-Funktion reicht auch ein
Doppelklick auf `index.html`, aber dann bitte nicht über fehlendes Offline-
Verhalten oder eine fehlende Installier-Möglichkeit wundern – das ist normal
und kein Fehler.

---

## 3. Veröffentlichen mit GitHub Desktop

So bekommt das Spiel eine eigene Internet-Adresse, die du mit anderen teilen
kannst (kostenlos, über "GitHub Pages").

### 3.1 Einmalig einrichten

1. Falls noch nicht vorhanden: einen GitHub-Account anlegen auf
   <https://github.com> ("Sign up").
2. **GitHub Desktop** installieren: <https://desktop.github.com/> →
   herunterladen → installieren → mit dem GitHub-Account anmelden.
3. In GitHub Desktop: **File → Add local repository…**
4. Als Ordner `Documents\Brueckenbauer` auswählen.
5. GitHub Desktop fragt meist "This directory does not appear to be a Git
   repository" – dann auf **"create a repository"** klicken.
6. Wichtig: Der Name muss **genau** `Brueckenbauer` heißen (so wird er
   automatisch vorgeschlagen, wenn der Ordner so heißt) – das ergibt später
   die Adresse `https://<benutzername>.github.io/Brueckenbauer/`. Bestätigen.
7. Unten links einen kurzen Commit-Kommentar eintragen (z. B. "Erste
   Version") und auf **"Commit to main"** klicken.
8. Oben auf **"Publish repository"** klicken. Im Dialog die Option
   **"Keep this code private" UNBEDINGT ABWÄHLEN** (Haken entfernen) – nur
   ein öffentliches Repository kann später über GitHub Pages im Internet
   angezeigt werden. Dann auf "Publish repository" klicken.

### 3.2 GitHub Pages einschalten (auch nur einmalig)

1. Im Browser zu `https://github.com/<benutzername>/Brueckenbauer` gehen
   (oder in GitHub Desktop oben auf "View on GitHub").
2. Oben auf **Settings** (Zahnrad-Symbol, im Reiter der Repository-Seite).
3. Links auf **Pages** klicken.
4. Bei **"Source"** auswählen: **"Deploy from a branch"**.
5. Bei **"Branch"**: **`main`** auswählen, Ordner **`/ (root)`** auswählen.
6. Auf **Save** klicken.
7. **1–2 Minuten warten**, dann ist das Spiel erreichbar unter:

   ```
   https://<benutzername>.github.io/Brueckenbauer/
   ```

   (`<benutzername>` durch den eigenen GitHub-Benutzernamen ersetzen, klein
   geschrieben, ohne `< >`.)

---

## 4. Später etwas ändern und veröffentlichen

1. Dateien ganz normal bearbeiten (z. B. in VS Code) und lokal testen
   (Abschnitt 2).
2. In GitHub Desktop erscheinen die geänderten Dateien automatisch in der
   Liste links.
3. Unten links einen kurzen Kommentar eintragen, was sich geändert hat, und
   auf **"Commit to main"** klicken.
4. Oben auf **"Push origin"** klicken (lädt die Änderung zu GitHub hoch).
5. Fertig. Das veröffentlichte Spiel aktualisiert sich **von selbst**: Beim
   nächsten Öffnen – oder spätestens beim übernächsten – laden Browser und
   installierte App automatisch die neue Version im Hintergrund nach (siehe
   Abschnitt 8, "Technischer Hintergrund"). Niemand muss etwas neu
   installieren, und **der Spielstand bleibt dabei vollständig erhalten.**

---

## 5. Auf dem iPad installieren

1. Auf dem iPad in **Safari** (nicht Chrome oder einem anderen Browser) die
   Adresse `https://<benutzername>.github.io/Brueckenbauer/` öffnen.
2. Unten (oder oben, je nach iPadOS-Version) auf das **Teilen-Symbol**
   tippen (Quadrat mit Pfeil nach oben).
3. Im Menü nach unten scrollen und **"Zum Home-Bildschirm"** antippen.
4. Oben rechts auf **"Hinzufügen"** tippen.

Jetzt liegt ein Brückenbauer-Icon auf dem Home-Bildschirm. **Das Spiel immer
über dieses Icon starten**, nicht über ein Lesezeichen in Safari – nur die
installierte App läuft im Vollbild und hat ihren eigenen, verlässlichen
Speicherplatz für den Spielstand (siehe nächster Abschnitt).

---

## 6. Ganz wichtig: der Spielstand

Das Spiel merkt sich automatisch, welche Level geschafft wurden, wie viele
Sterne und welche eigenen Level gebaut wurden. Dabei gilt:

- **Die Adresse darf sich nie mehr ändern.** Der Spielstand hängt an der
  genauen Internet-Adresse. Das heißt:
  - Das GitHub-Repository **nie umbenennen**.
  - Den GitHub-Benutzernamen **nie ändern**.
  - Das Repository **nie löschen**.
  - **Keine eigene Domain** nachträglich einrichten (auch wenn GitHub Pages
    das anbietet) – dann wäre der alte Spielstand auf der neuen Adresse
    nicht mehr da.
- Die auf dem **Home-Bildschirm installierte App hat ihren eigenen
  Speicherplatz**, getrennt von normalen Safari-Tabs. Öffnet man dieselbe
  Adresse in einem normalen Safari-Tab, sieht man dort **nicht** automatisch
  den Spielstand der installierten App (und umgekehrt). Darum: **immer über
  das Home-Bildschirm-Icon spielen.**
- Das Spiel speichert zusätzlich gleich in **zwei** unabhängigen Speichern
  des Geräts (damit ein Problem mit dem einen den Spielstand nicht komplett
  verliert) und speichert bei jeder Änderung sofort, auch wenn man die App
  nur kurz wechselt oder zuklappt.
- Trotzdem: **Mach regelmäßig eine Sicherung**, besonders vor größeren
  iPad- oder Browser-Updates:
  - Im Spiel: **Einstellungen → Spielstand exportieren**.
  - Auf dem iPad erscheint danach ein Teilen-Dialog – dort **"In Dateien
    sichern"** wählen und einen Ordner aussuchen (z. B. iCloud Drive). Auf
    dem PC wird stattdessen direkt eine Datei heruntergeladen
    (`brueckenbauer-spielstand-JJJJ-MM-TT.json`).
  - Zum Zurückspielen: im Spiel **Einstellungen → Spielstand importieren**
    und die gesicherte Datei auswählen. Das Spiel zeigt vorher an, was in
    der Datei enthalten ist (Anzahl geschaffter Level etc.), und fragt nach
    Bestätigung.
  - Das Spiel erinnert selbst daran, wenn die letzte Sicherung mehr als 14
    Tage her ist.

---

## 7. Fehlerbehebung

- **Direkt nach dem Veröffentlichen erscheint "404 – page not found".**
  Kein Fehler, GitHub Pages braucht nach dem Einrichten manchmal 1–2 Minuten.
  Einfach kurz warten und die Seite neu laden.
- **Auf dem iPad erscheint noch die alte Version des Spiels.** Die App einmal
  ganz schließen (im App-Umschalter nach oben wischen) und zweimal
  nacheinander neu öffnen – beim ersten Öffnen wird die neue Version im
  Hintergrund geladen, beim zweiten Öffnen wird sie angezeigt.
- **Nach dem Umbenennen/Löschen eines Repositories ist der Spielstand weg.**
  Das lässt sich leider nicht reparieren (siehe Abschnitt 6) – deshalb vorher
  immer exportieren/sichern.
- **"Publish repository" bietet keine Checkbox "Keep this code private"
  mehr an** (z. B. weil das Repository schon veröffentlicht wurde). Dann in
  den GitHub-Einstellungen des Repositories unter *Settings → General →
  Danger Zone → Change visibility* auf "Public" stellen, falls es aus
  Versehen privat angelegt wurde – ein privates Repository zeigt GitHub
  Pages nicht öffentlich an.

---

## 8. Technischer Hintergrund (optional zu lesen)

Für alle, die es genauer wissen möchten:

- **Offline-Betrieb**: Ein sogenannter *Service Worker*
  (`service-worker.js`) legt beim ersten Besuch eine Kopie aller Spieldateien
  im Browser ab. Danach startet das Spiel auch ganz ohne Internetverbindung.
  Beim Testen mit Live Server (`localhost`/`127.0.0.1`) wird zur Bequemlichkeit
  bei jedem Laden zuerst die aktuelle Datei vom Server genommen; nur wenn der
  Server nicht erreichbar ist, kommt die gespeicherte Kopie zum Einsatz. Auf
  der echten, veröffentlichten Adresse läuft es andersherum: Es wird sofort
  die gespeicherte Kopie gezeigt (schneller Start, funktioniert offline),
  während im Hintergrund nach einer neueren Version geschaut wird – ist eine
  da, wird sie erst beim *übernächsten* Start sichtbar, und zwar nur, wenn
  wirklich **alle** Dateien erfolgreich geladen werden konnten (kein
  Durcheinander aus alten und neuen Dateien).
- **Spielstand**: `js/save.js` speichert gleichzeitig in zwei getrennten
  Browser-Speichern (`localStorage` und `IndexedDB`) und nimmt beim Start
  automatisch die neuere der beiden Kopien. Jede Änderung wird nach rund
  300 ms automatisch gesichert, und zusätzlich sofort, sobald die Seite in
  den Hintergrund geht, geschlossen oder neu geladen wird. Ein beschädigter
  Spielstand wird nie stillschweigend überschrieben, sondern aufbewahrt. Der
  Service Worker selbst rührt den Spielstand nie an.
- **Icons**: `icons/make-icons.py` ist ein Python-Skript (benötigt die
  Bibliothek *Pillow*, `pip install pillow`), das aus einem Brücken-Motiv
  alle benötigten Icon-Größen neu erzeugt. Nötig ist es nur, wenn das Icon
  selbst verändert werden soll.
