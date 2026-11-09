# Gildiusz

[English version](README.en.md)

Polski bot Discord do prowadzenia społeczności: tworzy tymczasowe pokoje głosowe, przyjmuje zgłoszenia i sprawdza formaty załączników. Administracja może ustawić mu własną nazwę i awatar na swoim serwerze.

To wczesna wersja do samodzielnego uruchomienia. Jeden proces może obsługiwać kilka jawnie skonfigurowanych serwerów Discorda, z osobnymi bazami i ustawieniami. Bot potrzebuje stale działającego hosta. Instalacja nowych serwerów wymaga operatora; nie ma jeszcze publicznej samoobsługi.


## Co potrafi

- Własny pokój po wejściu na kanał techniczny, limit pokojów, przerwa między tworzeniem i sprzątanie pustych kanałów.
- `/pokoj`: zmiana nazwy, zamknięcie, otwarcie i zaproszenie uczestnika.
- `/zglos`: prywatne zgłoszenie do moderacji.
- `/ustawienia` i `/panel`: prywatny panel administracyjny, także z przycisku opublikowanego na kanale.
- Profil bota: nazwa i awatar na serwerze, podgląd przed zapisem, anulowanie i przywrócenie profilu domyślnego. Obrazy PNG, JPG i GIF do 2 MB.
- Wybór dozwolonych formatów: PDF, PNG, JPG, JPEG, WebP i GIF. Filtr porównuje format z nagłówkiem pliku po wysłaniu wiadomości.
- Konfigurator kanałów, ról, forów, onboardingu i AutoModa z podglądem planu przed zastosowaniem.

Bot nie nagrywa rozmów. Kontrola formatu pliku nie jest skanowaniem antywirusowym. Domyślnie pliki członków są wyłączone do czasu odbioru filtra.

## Uruchomienie

Wymagany Node.js 24 LTS od 24.17.0 oraz npm. SQLite jest wbudowany w Node.js.

```sh
git clone https://github.com/K44DEUSZ/gildiusz.git
cd gildiusz
npm ci --ignore-scripts
npm run check
npm test
npm run cli -- validate
```


`config/server.json` i `content/` zawierają przykładową konfigurację Kampusu Projektów. Dostosuj je przed zastosowaniem planu na swoim serwerze. Sama walidacja niczego nie zmienia na Discordzie.

Po konfiguracji:

```sh
npm run build
npm start
```


Na hostingu współdzielonym można uruchomić osobny proces z nadzorcą i CRON.
restarty i jawnie włączane pobieranie sprawdzonego `main` po pushu.

Po udanym wdrożeniu instalator zachowuje bieżącą i poprzednią paczkę; CRON obraca logi po przekroczeniu 5 MiB. Prywatne kopie baz są przechowywane osobno.

## Licencja

MIT. Copyright 2026 Bartosz Golat. Zależności zachowują własne licencje; wykaz jest w [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
