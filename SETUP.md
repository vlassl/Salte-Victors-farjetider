# Automatisk uppdatering av färjetider

## Vad som händer
Varje natt (02:15 UTC) hämtar GitHub tidtabeller för 14 dagar framåt från
Trafikverkets öppna API, skriver `data.json` och commitar den. Appen läser
`data.json` när den startar och använder de inbäddade tiderna som reserv om
filen saknas eller nätet är nere.

## Engångsuppsättning

1. **Lägg in API-nyckeln som secret**
   Repo → Settings → Secrets and variables → Actions → New repository secret
   - Namn: `TRV_KEY`
   - Värde: din nyckel från data.trafikverket.se

2. **Ladda upp filerna** (Add file → Upload files)
   - `index.html`
   - `scripts/fetch-timetables.mjs`
   - `.github/workflows/update-timetables.yml`

3. **Testkör direkt**
   Repo → Actions → "Uppdatera färjetider" → Run workflow
   Efter en minut ska `data.json` finnas i repot.

## Vad som uppdateras automatiskt
- **Hönöleden** – helt
- **Björköleden** – helt, inklusive kallelseturer
- **Nordöleden** – helt: turer, anmärkningar och ankomsttider.
  Ankomster finns inte i API:et utan härleds:
  `ankomst = min(samma färjas nästa avgång från destinationen,
                 avgång + maximal överfartstid)`
  Validerat mot PDF-tidtabellen: 64 av 65 turer exakt rätt en vardag.

## Vad som inte uppdateras
- **Linje 296** – Västtrafik, finns inte i detta API.

## Loggar för framtida analys
- `log/deviations.jsonl` – varje inställd tur (`Deleted`) och varje
  `DeviationId` som dyker upp, med tidpunkt, sträcka och Info-texter.
- `log/unknown-info.txt` – Info-texter som skriptet inte känner igen,
  så nya anmärkningstyper upptäcks.

Efter några månader finns underlag för att bygga störningsvisning i appen.
