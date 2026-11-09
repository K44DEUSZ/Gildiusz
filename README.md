# Gildiusz

Bot Discord do prowadzenia społeczności. Tworzy pokoje na czas rozmowy, nadaje role po reakcjach, sprawdza formaty plików i przekazuje zgłoszenia moderacji.

## Co potrafi

- **Pokoje głosowe:** osobny pokój po wejściu na wskazany kanał, zmiana nazwy, zamknięcie, zapraszanie osób i sprzątanie po rozmowie.
- **Role z reakcji:** wybór kilku ról, nadanie po kliknięciu emoji i odebranie po cofnięciu reakcji.
- **Filtr plików:** dozwolone formaty PDF, PNG, JPG, JPEG, WebP i GIF, sprawdzane po wysłaniu wiadomości. To kontrola formatu, nie skaner antywirusowy.
- **Zgłoszenia:** prywatne przekazanie opisu problemu na kanał wybrany przez administrację.

Każdy serwer ma własne ustawienia. Funkcje można włączać osobno i przypisywać do istniejących kanałów oraz ról. Bot nie nagrywa rozmów głosowych.

## Ustawienia na serwerze

Konfigurację zmienia właściciel lub osoba z uprawnieniem **Zarządzanie serwerem**. Komenda `/ustawienia` otwiera panel Discorda; `/konfiguracja` prowadzi do panelu WWW, gdy operator udostępni jego adres.

Uczestnicy korzystają z `/pokoj` i `/zglos`. Role do samodzielnego wyboru muszą znajdować się poniżej roli Gildiusza. Akceptacja zasad serwera pozostaje osobna.

## Status projektu

Gildiusz jest we wczesnej wersji. Strona i panel są rozwijane oddzielnie, a publiczne uruchomienie wspólnej usługi jest w przygotowaniu. W tym repozytorium znajduje się kod bota do własnego uruchomienia.

<details>
<summary>Uruchom własną instancję</summary>

Potrzebne są Node.js 24 LTS od 24.17 i własna aplikacja Discord z włączonym Message Content Intent.

```sh
git clone https://github.com/K44DEUSZ/Gildiusz.git
cd Gildiusz
npm ci --ignore-scripts
npm run build
npm run cli -- validate
```

Skopiuj `.env.example` do `.env` i uzupełnij dane swojej aplikacji oraz serwera. Token pozostaje prywatny. Przykładowy układ społeczności znajduje się w `config/server.json`, a treści wiadomości w `content/`.

Konfigurator najpierw pokazuje zmiany. Dla każdej fazy — `core`, `community`, `content` — przygotuj i sprawdź plan, a następnie zatwierdź jego konkretną sumę:

```sh
npm run cli -- plan --phase core
npm run cli -- apply --file reports/deployment-plan.json --approve HASH_Z_PLANU
```

Bot nie potrzebuje Administratora. Sprawdź jego uprawnienia i hierarchię ról. Baza wymaga trwałego dysku i jednej działającej instancji procesu. Po przygotowaniu serwera uruchom `npm start`. Dostępny jest też `docker compose up -d`.

</details>

## Problemy i licencja

Błąd możesz opisać w [Issues](https://github.com/K44DEUSZ/Gildiusz/issues). Nie dodawaj tokenów ani danych członków. Sprawy bezpieczeństwa opisuje [SECURITY.md](SECURITY.md).

Kod jest udostępniony na [licencji MIT](LICENSE). [Zależności](THIRD_PARTY_NOTICES.md) zachowują własne licencje. [English](README.en.md).
