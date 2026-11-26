# Masa Paneli (Desktop Panel)

Eski bir Android telefonu masanda üçüncü bir ekrana çevirir: saat, hava durumu, işlemci/GPU göstergeleri, çalan müzik, takvim, yapılacaklar, pomodoro, hızlı eylemler ve Türkçe sesli asistan **Jarvis**. Windows bilgisayarda tek bir Node süreci çalışır, telefon Chrome'dan bağlanır. Node tarafında hiçbir bağımlılık yok.

> *Turns an old Android phone into a desk dashboard for a Windows PC: clock, weather, CPU/GPU stats, now playing, calendar, todos, pomodoro and a Turkish voice assistant. Zero-dependency Node server, optional local Whisper voice service. The UI is in Turkish.*

**Gerekenler:** Windows 10/11, [Node.js 18+](https://nodejs.org), telefonda Chrome. Sesli asistanı bilgisayarda çalıştırmak için isteğe bağlı Python 3.10–3.12 (NVIDIA ekran kartı önerilir).

## Kurulum
```
git clone https://github.com/DuhaYusufBindere/Desktop-Panel.git
cd Desktop-Panel
copy config.example.json config.json
```
(`config.json` isteğe bağlı; takvim, konum ve hızlı eylemler için. Kişisel olduğu için repoya girmez.)

1. PC'de `baslat.bat` (ya da `node server.js`). İlk çalıştırmada Windows Güvenlik Duvarı sorarsa **Özel ağlar**a izin ver.
2. Konsolda bir **QR kod** çıkar (ya da tarayıcıda `http://localhost:7777/pair`). Telefonun kamerasıyla okut, Chrome'da aç.
3. Chrome menüsü → "Ana ekrana ekle". Çift dokun = tam ekran. Sol üst dişli = ayarlar.

Telefon ve PC aynı ağda olmalı:
- **Hotspot:** PC'yi telefonun hotspot'una bağla ya da telefonu PC'nin *Mobil etkin nokta*sına bağla.
- **Bluetooth:** Windows → Bluetooth ve cihazlar → telefonla eşleştir → "Kişisel ağ (PAN)" ile bağlan. Konsoldaki IP değişebilir; `/pair` sayfasını yeniden aç.

Eşleştirme anahtarı `data/token.txt` içinde. Anahtarı bilmeyen kimse panele ya da eylemlere erişemez. Anahtarı değiştirmek için dosyayı sil, sunucuyu yeniden başlat ve telefonu yeniden eşleştir.

## Sayfalar
| Sayfa | İçerik |
|---|---|
| Panel | Rakam rakam kayan saat, işlemci / bellek göstergeleri, 60 sn grafik, disk, hava durumu, sıradaki etkinlik |
| Donanım | İndirme / yükleme hızı grafikleri, GPU yükü ve sıcaklığı, CPU sıcaklığı, fan |
| Çalıyor | Çalan şarkı, kapak resminden renk alan arka plan, ilerleme, önceki / oynat / sonraki, ses |
| Odak | Pomodoro, günlük tur ve dakika, 7 günlük grafik |
| Gün | Takvim (ICS) ve yapılacaklar listesi (PC'de saklanır) |
| Araçlar | Hızlı eylemler, panoya metin gönder, bildirim geçmişi |

Ayarlardan sayfaları sırala/gizle, tema (otomatik / kehribar / buz / kâğıt), parlaklık, ekran koruyucu süresi seç, başka bilgisayarlar ekle. Eski/yavaş telefonda **Performans modu** bulanıklık ve hareketli arka planı kapatır.

## Jarvis (sesli asistan)
Üstteki mikrofon düğmesine dokun ya da Ayarlar → **“Hey Jarvis” ile uyandır**'ı aç ve “Hey Jarvis, …” de. Komutu panel anlar ve kendisi yapar. Google Asistan'ın dışarıya açık bir API'si olmadığı için asistan uygulamayı açmaz.

**Ses nerede çözülür?**
- **Bilgisayarda (önerilen):** `voice/` klasöründe Python ses servisi kuruluysa telefon mikrofon sesini doğrudan bilgisayara yollar. Orada [openWakeWord](https://github.com/dscripka/openWakeWord) “hey jarvis”i yakalar, [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (large-v3-turbo, ekran kartında) cümleyi Türkçe yazıya çevirir. Bip sesi yoktur, internet gerekmez, ses bilgisayardan dışarı çıkmaz. Sunucu açılınca servisi kendisi başlatır; ilk açılışta model (~1,6 GB) iner.
- **Chrome'da (yedek):** Servis kurulu değilse ya da hâlâ yükleniyorsa Chrome'un (Google) konuşma tanıması kullanılır. Android'de her başlatmada bip çalar ve internet ister.

Ses servisini sıfırdan kurmak (Python 3.10–3.12):
```
py -3.12 -m venv voice\.venv
voice\.venv\Scripts\python -m pip install -r voice\requirements.txt
```
Ekran kartı yoksa ya da bellek yetmezse servis kendiliğinden daha küçük modele / işlemciye geçer. Modeli `WHISPER_MODEL=small` gibi ortam değişkeniyle, uyandırma hassasiyetini `WAKE_THRESHOLD=0.4` (düşük = daha kolay uyanır) ile değiştirebilirsin.

| Söyle | Ne olur |
|---|---|
| “yarın saat 3'te diş randevusu ekle”, “cuma akşam 7'de sinema”, “28 kasımda doğum günü” | Takvime etkinlik ekler (saat yoksa tüm gün) |
| “2 saat sonra ilacı hatırlat” | O saate etkinlik ekler |
| “yapılacaklara süt almayı ekle” / “süt almayı tamamladım” | İş ekler / işaretler |
| “bugün neler var”, “yarın neler var”, “sıradaki toplantı ne” | Takvimi okur |
| “sıradaki şarkı”, “müziği durdur”, “sesi aç” | Bilgisayarın medya tuşları |
| “pomodoro başlat”, “saat kaç”, “hava nasıl”, “geri al” | |

- Sesle eklenen etkinlikler bilgisayarda (`data/events.json`) saklanır ve Google etkinliklerinin yanında **PANEL** etiketiyle görünür. Google Takvim'e yazmak OAuth girişi istediği için yapılmadı; ICS adresi yalnızca okunur.
- 1–6 arası saatler, “sabah” denmezse öğleden sonra sayılır (“3'te” → 15:00).
- Mikrofon da güvenli bağlantı ister: aşağıdaki Chrome bayrağı adımı aynen geçerli.
- “Hey Jarvis” açıkken telefon mikrofonu sürekli açık kalır (Android bildirim çubuğunda mikrofon simgesi görünür) ve ekran açıkken, panel öndeyken dinler.
- Mikrofon yoksa açılan pencerenin altına komutu yazabilirsin.

## İsteğe bağlı kurulumlar
Hepsi `config.json` ile yapılır (`config.example.json` örnek).

- **Takvim:** Google Takvim → Ayarlar → takvimin → *iCal biçiminde gizli adres* bağlantısını `icsUrl` olarak yaz. Tekrarlayan etkinlikler (günlük/haftalık/aylık/yıllık) açılır; tek tek değiştirilmiş tekrar örnekleri ve karmaşık BYDAY kuralları desteklenmez.
- **CPU sıcaklığı ve fan:** [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor) → Options → Remote Web Server → Run. Panel `localhost:8085` adresinden okur. NVIDIA ekran kartında sıcaklık/fan, `nvidia-smi` ile LHM'siz gelir.
- **Hızlı eylemler:** `actions` listesine `{id, label, icon, cmd}` ekle. Komutlar yalnızca bu dosyadan çalışır, telefon keyfi komut gönderemez.
- **Konum (hava/gün batımı):** Varsayılan olarak otomatik bulunur: önce Windows konum servisi, olmazsa IP adresinden yaklaşık şehir (`ipwho.is`'e IP'n gider) ve `data/location.json` içinde 24 saat saklanır. Kesin konum için `lat`, `lon` yaz; otomatik arama kapanır.
- **Telefonun konumunu kullanmak:** Ayarlar → Konum → **Telefon**. Chrome konumu yalnızca güvenli (HTTPS) sayfalara verir; panel yerel ağda HTTP olduğu için telefonda bir kez şunu yap: Chrome'da `chrome://flags/#unsafely-treat-insecure-origin-as-secure` aç, kutuya panelin adresini yaz (örn. `http://192.168.1.20:7777`), **Enabled** seç ve Chrome'u yeniden başlat. Sonra konum iznini ver. Adres (IP) değişirse bayrağa yeni adresi ekle. Konum 30 dakikada bir güncellenir.
- **Bildirim göndermek:** `POST /api/notify` ile `{"title":"…","body":"…","level":"warn"}`. Betiklerden, CI'dan, Home Assistant'tan kullanılabilir. Panel ayrıca işlemci/bellek/disk/sıcaklık için kendi uyarılarını üretir (`alerts:false` ile kapanır).

## Sınırlar
- Windows bildirimleri (WhatsApp vb.) okunmuyor; Windows bunu paketlenmemiş uygulamalara vermiyor.
- Ekranı açık tutma: HTTP'de `Wake Lock` yok, panel görünmez bir video akışıyla dener. Olmazsa telefonda Geliştirici seçenekleri → *Uyanık kal* aç.
- Ortam ışığı sensörü yalnızca tarayıcı izin verirse çalışır; yoksa geceleri saate göre kısılır.
- Medya tuşları ve pano yalnızca Windows'ta çalışır.
