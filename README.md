# Token-Monitor

Ein Panel für Claude Code, das neben dem Chat anzeigt, wie viele Tokens du verbrauchst und wie nah du an deinen Limits bist.

- **Limits:** 5-Stunden-Fenster und Wochenlimit in Prozent, mit Countdown bis zum Reset (live aus der letzten API-Antwort)
- **Verbrauch:** diese Session, heute, dieser Monat, gesamt – jeweils Tokens und Kosten nach API-Preis
- **Verlauf:** Tagesdiagramm der letzten 30 Tage (Tokens oder Kosten)
- **Aufteilung:** nach Modell und nach Projekt (heute, Monat, gesamt)

Öffnen mit `/tokens`. Die Verbrauchszahlen stammen aus den lokalen Claude-Code-Transkripten des jeweiligen Geräts; die Limits gelten für dein ganzes Konto.

## Installation

Im Eingabefeld einer Claude-Code-Session im Terminal:

```
/plugin install token-monitor --marketplace BalthasarKnapp/token-monitor
```

Die Frage „Add marketplace?“ mit `y` beantworten, dann den Bereich „user“ mit Enter wählen.

Aus einer Shell:

```
claude plugin install token-monitor --marketplace BalthasarKnapp/token-monitor
```

In der Desktop-App: auf **+** neben dem Eingabefeld klicken, dann **Plugins** → **Add marketplace** mit `BalthasarKnapp/token-monitor`, danach **Add plugin**.

Das Repository ist privat: Auf jedem Gerät muss Git einmal bei github.com angemeldet sein (z. B. mit `gh auth login` und danach `gh auth setup-git`), sonst schlägt die Installation fehl.
