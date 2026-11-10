# Shorts Bot

Uzun videolardan OpusClip’in en yüksek puan verdiği klipleri alır, her klibi kendi anlatımınla özgünleştirir ve YouTube Shorts kanalına düzenli aralıklarla (varsayılan: 2 günde bir, 19:00) yayınlar.

Bir klip şöyle hazırlanır:
1. **OpusClip** videodan klipleri çıkarır, dikey (9:16) hale getirir ve puana göre sıralar.
2. **Claude** klipten 4 kare görür, klibin konuşmasını ve senin notunu okur. Seslendirme metnini, videonun üstündeki başlığı, YouTube başlığını, açıklamayı ve etiketleri yazar.
3. **ElevenLabs** metni seçtiğin sesle seslendirir.
4. Uygulama **ffmpeg** ile videoyu birleştirir: seslendirme öne çıkar, klibin kendi sesi kısılır (varsayılan %25), istersen müzik eklenir. Seslendirmeye kelime kelime eşlenen altyazı ve üstte başlık kutusu basılır.
5. Sen videoyu izleyip onaylarsın. Video **YouTube**’a hemen yüklenir ve gizli bekler; yayın saati gelince YouTube onu herkese açar. O saatte bilgisayarın kapalı olması sorun değil.

Hiçbir video sen onaylamadan yüklenmez. Ayarlar’daki “otomatik onay” seçeneğini açarsan, sırada onaylı video yoksa en eski hazır taslağı senin yerine onaylar.

## Windows’a kurulum

1. `ShortsBot-Kurulum-x.y.z.exe` dosyasına çift tıkla (GitHub → Releases).
2. Windows “Bilgisayarınız korundu” uyarısı verirse **Ek bilgi → Yine de çalıştır**’a bas. Dosya imzasız olduğu için bu uyarı çıkıyor.
3. Kurulum bitince masaüstündeki **Shorts Bot** kısayoluyla aç.

ffmpeg ve altyazı fontu kurulum dosyasının içinde gelir. Ayrıca bir şey kurman gerekmez.

## İlk ayarlar (Ayarlar sekmesi)

Pano’daki “Kurulum tamamlanmadı” listesi eksik olanları gösterir; maddeye tıklayınca ilgili ayara gider.

| Servis | Ne için | Anahtar nereden alınır |
|---|---|---|
| OpusClip | Videodan klip çıkarma | clip.opus.pro/dashboard → sol alt köşe. API, OpusClip’in **Pro, Max ve Business** planlarında açık. |
| Claude | Seslendirme metni, başlık, etiketler | Claude Console (platform.claude.com) → API Keys |
| ElevenLabs | Seslendirme | ElevenLabs hesabı → Developers → API Keys. Kaydettikten sonra **Sesleri getir** ile bir ses seç. |
| YouTube | Yükleme ve zamanlama | Aşağıdaki adımlar (bir kerelik, ~10 dakika) |

### YouTube’u bağlama

1. **console.cloud.google.com**’da yeni bir proje oluştur.
2. API’ler ve Hizmetler → Kitaplık → **YouTube Data API v3** → Etkinleştir.
3. **Google Auth Platform** (OAuth izin ekranı): uygulama adını ve e-postanı gir, kitle olarak **Harici (External)** seç.
4. Kitle (Audience) sayfasında **Uygulamayı yayınla**’ya bas (“In production”). Test modunda kalırsa Google bağlantıyı 7 günde bir koparır.
5. İstemciler (Clients) → İstemci oluştur → uygulama türü **Masaüstü uygulaması** → Oluştur. Çıkan Client ID’yi (ve varsa secret’ı) Shorts Bot’a yapıştır, **Kaydet**.
6. **YouTube’a bağlan**’a bas ve kanalın bağlı olduğu Google hesabıyla giriş yap. “Google bu uygulamayı doğrulamadı” uyarısı çıkarsa **Gelişmiş → uygulamana git**’e bas. Uygulamayı sadece sen kullandığın için bu normal.

Google, doğrulanmamış projelerden yüklenen videoları eskiden “gizli”ye kilitliyordu. Bu kural 2 Kasım 2026’da kaldırıldı, videolar herkese açık yayınlanabiliyor. Yükleme kotası günde 100 video; 2 günde bir yayın için fazlasıyla yeterli.

## Kullanım

- **Kaynaklar:** Video bağlantısını ekle (YouTube, Drive, Vimeo, Twitch…). “Bu video ne hakkında?” alanına maç, takımlar, oyuncular gibi bilgileri yaz. Claude bunları kullanır ve emin olmadığı isim, skor ya da tarihi uydurmaz. “OpusClip neyi arasın?” alanına “goller ve kurtarışlar” gibi bir tarif yazabilirsin; bu alan sadece ClipAnything modelinde kullanılır. OpusClip videonun uzunluğuna göre 5-30 dakikada bitirir.
- **Klipler:** OpusClip’in klipleri. **#1** OpusClip’in en yüksek puan verdiği klip. **Taslak hazırla** ya da **Atla**.
- **Taslaklar:** Hazırlanan videoyu izle. Başlığı, metni, açıklamayı ve etiketleri düzeltebilirsin:
  - Metni ya da üst başlığı değiştirip **Kaydet**’e basarsan seslendirme ve video yeniden oluşur.
  - **Claude yeniden yazsın:** “Claude’a not” alanındaki yönlendirmeyle yeni bir versiyon yazar (“daha esprili olsun”, “oyuncunun adı Icardi” gibi).
  - **Sesi yenile:** Aynı metni, Ayarlar’da seçili sesle yeniden seslendirir.
  - **Onayla ve zamanla:** Video sıradaki boş yayın saatine yerleşir ve YouTube’a yüklenir.
- **Takvim:** Zamanlanan ve yayınlanan videolar, YouTube bağlantılarıyla.
- **Otomatik taslak (varsayılan açık):** Uygulama, onay bekleyen taslak sayısını ayardaki değerde (varsayılan 2) tutar. Önce her videonun 1 numaralı klibini, sonra 2 numaralılarını kullanır.

Ayarlar ve videolar `%APPDATA%\Shorts Bot` klasöründe tutulur. Uygulama açıkken her dakika OpusClip’i kontrol eder, taslak hazırlar ve onaylanan videoları yükler. YouTube’a yüklenmiş videolar uygulama kapalıyken de saatinde yayınlanır.

### Müzik

Ayarlar → Video → **Müzik klasörünü aç**. Oraya koyduğun mp3/m4a/wav dosyalarından her videoya rastgele biri, düşük seste eklenir. Klasör boşsa müzik eklenmez. Telifsiz müzik kullan (örneğin YouTube Ses Kitaplığı).

## Özgünlük ve telif

Uygulama klibi gerçekten dönüştürür: kendi anlatımın, kendi yorumun, başlık ve altyazı eklenir. Videoyu aynalamak ya da hızlandırmak gibi telif tespitini atlatmaya yönelik numaralar **içermez**. Kaynak videonun hakları sende değilse (örneğin maç yayınları) YouTube telif talebi ya da uyarısı gelebilir; seslendirme bunu engellemez. En güvenlisi kendi videoların, izin aldığın içerikler ya da klip yapılmasına izin veren yayıncılar.

Gerçek bir kişinin sesini taklit eden bir ElevenLabs sesi kullanıyorsan Ayarlar → YouTube’daki “değiştirilmiş veya yapay içerik” kutusunu işaretle.

## Maliyetler

- **OpusClip:** 1 kredi = 1 dakika kaynak video. API ile açılan her proje en az 10 kredi. Pro/Max planlarında API ile ayda en fazla 900 kredi (15 saat) işlenebilir.
- **ElevenLabs:** Karakter başına. 45 saniyelik bir Short yaklaşık 600-800 karakter.
- **Claude:** Taslak başına birkaç sent (4 küçük görüntü ve kısa bir metin).
- **YouTube:** Ücretsiz.

## İlk gerçek denemede kontrol edilecekler

Bu noktalar sahte servislerle test edildi; gerçek hesaplarla ilk denemede bakılmalı:
- **OpusClip sırası = puan sırası mı?** OpusClip’in API’si puan sayısını vermiyor; klipleri arayüzdeki gibi puana göre sıralı döndürdüğünü varsayıyoruz. İlk projede Klipler’deki #1, #2… sırasını OpusClip sitesindeki puanlarla karşılaştır.
- **OpusClip altyazısı kapalı mı geliyor?** Uygulama projeyi altyazısız istiyor. Kliplerde OpusClip’in kendi altyazısı da görünürse, OpusClip’te altyazısı kapalı bir marka şablonu oluştur ve ID’sini Ayarlar → OpusClip’e yaz.
- **Ses ve altyazı uyumu:** İlk taslağı izle; konuşma hızı ve ses seviyeleri Ayarlar’dan değiştirilebilir.

## Kaynak koddan çalıştırma

```bash
npm install
```

| Komut | Ne yapar |
|---|---|
| `npm run app` | Masaüstü uygulamasını açar |
| `npm run panel` | Pencere olmadan çalıştırır, panel `http://127.0.0.1:3000` adresinde |
| `npm test` | Birim ve uçtan uca testler (OpusClip, ElevenLabs, Claude ve YouTube sahte sunucularla, video gerçek ffmpeg ile) |
| `npm run typecheck` | TypeScript tip kontrolü |
| `npm run dist:win` | Windows kurulum dosyasını üretir |

GitHub Actions her push’ta Windows’ta testleri çalıştırır ve kurulum dosyasını üretir. `main` dalındaki derleme Releases’a yüklenir.

## Dosyalar

```
src/
  desktop/main.ts      masaüstü uygulaması (Electron)
  dashboard/           panel arayüzü ve yerel sunucu
  runtime.ts           her dakikalık döngü, iş kuyruğu, otomatik taslak ve onay
  pipeline.ts          taslak hazırlama (indir → Claude → ElevenLabs → altyazı → video) ve yükleme
  opus.ts              OpusClip API istemcisi
  claude.ts            seslendirme metni (Claude API)
  eleven.ts            ElevenLabs API istemcisi
  subtitles.ts         kelime zamanlı ASS altyazı
  ffmpeg.ts            video birleştirme
  youtube.ts           Google OAuth ve YouTube yükleme
  schedule.ts          yayın saatleri
  settings.ts          ayarlar ve doğrulama
assets/fonts/          altyazı fontu (Montserrat, SIL Open Font License)
test/                  testler ve sahte servisler
```
