# Gildiusz

Bot Discord do prowadzenia społeczności. Tworzy pokoje na czas rozmowy, nadaje role po reakcjach, sprawdza formaty plików i przekazuje zgłoszenia moderacji.

## Co potrafi

- **Pokoje głosowe:** osobny pokój po wejściu na wskazany kanał, zmiana nazwy, zamknięcie, zapraszanie osób i sprzątanie po rozmowie.
- **Role z reakcji:** wybór kilku ról, nadanie po kliknięciu emoji i odebranie po cofnięciu reakcji.
- **Filtr plików:** wybór formatów dla kanału i sprawdzanie nagłówka po wysłaniu wiadomości. Domyślnie PDF, PNG, JPG, JPEG, WebP i GIF; można też wybrać dodatkowe obrazy, audio, wideo i archiwa. To kontrola formatu, nie skaner antywirusowy.
- **Zgłoszenia:** prywatne przekazanie opisu problemu na kanał wybrany przez administrację.

Każdy serwer ma własne ustawienia. Funkcje można włączać osobno i przypisywać do istniejących kanałów oraz ról. Bot nie nagrywa rozmów głosowych.

## Ustawienia na serwerze

Konfigurację zmienia właściciel lub osoba z uprawnieniem **Zarządzanie serwerem**. Komenda `/ustawienia` otwiera panel Discorda; `/konfiguracja` prowadzi do panelu WWW, gdy operator udostępni jego adres.

Uczestnicy korzystają z `/pokoj` i `/zglos`. Role do samodzielnego wyboru muszą znajdować się poniżej roli Gildiusza. Akceptacja zasad serwera pozostaje osobna.

## Status projektu

[Strona Gildiusza](https://gildiusz.kaadeusz.pl) i [panel](https://gildiusz.kaadeusz.pl/panel) są już publicznie dostępne. Działają cztery podstawowe funkcje: pokoje głosowe, role za reakcje, filtr plików i przekazywanie zgłoszeń moderacji.

Spotkania, zgłoszenia z historią i pomysły, ogłoszenia na termin oraz akceptacja regulaminu z rolą członka pozostają w ograniczonych testach. Nie są jeszcze gotowe do ogólnego udostępnienia. Integracja z Twitchem oraz aktywność i rangi są planowane.

W tym repozytorium znajduje się otwarty kod bota do własnego uruchomienia.

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

Opcjonalny autodeploy na hostingu pobiera dokładną paczkę `main` po udanym CI i sprawdza jej tożsamość oraz sumę SHA-256. Aktualizacja nie tworzy kopii danych i nie wymaga włączonego komputera operatora. Przed zatrzymaniem bota i przed aktywacją sprawdza zgodność pełnych schematów baz, migracji oraz dziennika usunięć. Wydanie wymagające migracji lub naprawy danych pozostaje do ręcznego wdrożenia. Nieudany start może cofnąć sam kod dopiero po ponownym potwierdzeniu zgodności danych; zapisane dane i wykonane działania Discorda pozostają bieżące.

Ręczne kopie i odtwarzanie są osobnymi czynnościami operatora przez `scripts/recovery.mjs`. Opcjonalne narzędzia `scripts/backup-relay.mjs serve ROOT` i `scripts/backup-pc.mjs CONFIG` wymagają osobnego ograniczonego dostępu, przypiętego katalogu PC i klucza szyfrowania. Nie instalują dostępu ani harmonogramu, a zwykłe wdrożenie ich nie uruchamia. Istniejący niedokończony punkt aktualizacji wymaga rozstrzygnięcia przez operatora.

</details>

## Problemy i licencja

Błąd możesz opisać w [Issues](https://github.com/K44DEUSZ/Gildiusz/issues). Nie dodawaj tokenów ani danych członków. Sprawy bezpieczeństwa opisuje [SECURITY.md](SECURITY.md).

Kod jest udostępniony na [licencji MIT](LICENSE). [Zależności](THIRD_PARTY_NOTICES.md) zachowują własne licencje. [English](README.en.md).
