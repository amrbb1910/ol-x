# Radar Okazji OLX

Lokalna aplikacja do wyszukiwania świeżych ogłoszeń samochodów z OLX w Warszawie i oznaczania ofert poniżej ceny rynkowej.

## Uruchomienie

```powershell
node server.mjs
```

Potem otwórz:

```text
http://localhost:5173
```

Możesz też dwukrotnie kliknąć `start-radar.cmd` w Windowsie.

## Jak działa analiza

- aplikacja pobiera najnowsze wyniki z OLX dla Warszawy,
- stosuje filtry marki, rocznika, ceny i promienia,
- porównuje cenę ogłoszenia z medianą podobnych aut z pobranych wyników,
- pokazuje ogłoszenia tańsze od ustawionego progu,
- oznacza słowa ryzyka, np. uszkodzone, cesja, leasing albo zamiana.

To szybki radar okazji, a nie rzeczoznawca: niska cena może wynikać ze stanu auta, finansowania, błędnego przebiegu lub opisu.
