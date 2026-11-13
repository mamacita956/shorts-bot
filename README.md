# Shorts Bot

Uzun videolardan en iyi anları seçer, her klibi kendi anlatımınla özgünleştirir ve YouTube Shorts kanalına düzenli aralıklarla (varsayılan: 2 günde bir, 19:00) yayınlar.

Klipler iki yoldan gelir:
- **Video dosyası → Claude klip ajanı:** Bilgisayarındaki maç videosunu Claude izler, en iyi anları puanlayıp kendisi keser (aşağıda). OpusClip gerekmez.
- **Bağlantı → OpusClip:** OpusClip videodan klipleri çıkarır, dikey hale getirir ve puana göre sıralar.

Her videonun en iyi 5 klibi kullanılır (Ayarlar’dan değişir). Bir klip şöyle hazırlanır:
1. Klip ajanı ya da OpusClip klipleri seçer.
2. **Claude** klipten 4 kare görür, klibin konuşmasını ve senin notunu okur. Seslendirme metnini, videonun üstündeki başlığı, YouTube başlığını, açıklamayı, etiketleri ve kapak yazısını yazar. Kanalın önceki videolarından çıkan dersleri de kullanır (aşağıda).
3. **ElevenLabs** metni seçtiğin sesle seslendirir.
4. Uygulama **ffmpeg** ile videoyu birleştirir: seslendirme öne çıkar, klibin kendi sesi kısılır (varsayılan %25), istersen müzik eklenir. Seslendirmeye kelime kelime eşlenen altyazı ve üstte başlık kutusu basılır. Yatay maç görüntüsü dikey videonun ortasına yerleşir, arkasına kendisinin bulanık hali konur (futbol Shorts’larındaki bilinen görünüm). Klibin en çarpıcı karesinden bir de **kapak görseli** hazırlanır.
5. Üç **değerlendirme ajanı** bitmiş videoyu inceleyip tartışır (aşağıda). Onaylarlarsa video **YouTube**’a hemen yüklenir ve gizli bekler; yayın saati gelince YouTube onu herkese açar. O saatte bilgisayarın kapalı olması sorun değil. YouTube videoyu işlemeyi bitirince kapak da yüklenir.
6. Yayınlanan videoların **izlenme, beğeni ve yorum** sayıları YouTube’dan alınır. Claude bunlardan kanal için dersler çıkarır; sonraki videolarda metni yazan Claude ve ajanlar bu dersleri kullanır.

## Klip ajanı (video dosyaları)

Kaynaklar’a bilgisayarındaki bir video dosyasını eklersin (masaüstünde **Dosya seç…**, ya da dosyanın yolunu yapıştır). Claude videoyu doğrudan oynatamaz; uygulama onu şöyle “izletir”:

1. **Ses:** Videonun sesi ayrılır ve **ElevenLabs** (Scribe) ile kelime kelime yazıya dökülür; tezahürat gibi sesler de işaretlenir. Sesin saniye saniye ne kadar yükseldiği de ölçülür: gol anında spiker ve tribün bağırır.
2. **Görüntü:** Videonun tamamından birkaç saniyede bir kare alınır, üzerine zamanı yazılır ve 20’li sayfalar halinde Claude’a gösterilir (90 dakikalık maç ≈ 54 sayfa).
3. **Aday anlar:** Claude kareleri, dökümü ve ses grafiğini birlikte okuyup aday anları bulur.
4. **Yakından bakış:** Her adayın çevresinden saniyede bir kare alınır. Claude bunlara bakıp en iyi klipleri seçer, her birine 0-100 arası puan verir, başlangıç ve bitişini kendisi ayarlar (golde atak başından tepkiye kadar), aynı anın tekrarını eler.
5. Seçilen anlar videodan kesilir ve **Klipler**’e puan sırasıyla gelir; her klipte Claude’un neden seçtiği yazar.

**Ayarlar → Klip ajanı**’ndaki kutuya Claude’un ne araması gerektiğini yazarsın (“goller, kurtarışlar, tartışmalı pozisyonlar…”). Kanal tarzı, videoya yazdığın not ve YouTube sonuçlarından çıkan kanal dersleri de seçime katılır. Klip uzunluğu “Klip süreleri”nden, sayısı “Her videodan kullanılacak klip sayısı”ndan gelir.

Bir maç 5-15 dakikada biter ve yaklaşık 1,5 dolar tutar: ElevenLabs döküm saati 0,20 dolar, gerisi Claude. Senin video dosyana hiç dokunulmaz; kaynağı silsen de yerinde kalır.

YouTube linkinden video indirmek YouTube’un kullanım şartlarına aykırı olduğu için klip ajanı sadece dosyayla çalışır. Linkle eklenen videoları OpusClip işler.

## Değerlendirme ajanları

Her video yayına girmeden önce üç ajandan oluşan bir kuruldan geçer. Ajanlar bitmiş videodan 4 kareyi (altyazı ve üst başlıkla birlikte), seslendirme metnini, YouTube başlığını, açıklamayı, etiketleri, kapak yazısını ve klibin orijinal konuşmasını görür. Kanalın sonuçları geldikçe çıkan dersleri ve kendi verdikleri puanların gerçek izlenmeyle karşılaştırmasını da görürler:

| Ajan | Neye bakar |
|---|---|
| **İzleyici** | Üst başlık ve ilk cümle ilk iki saniyede kaydırmayı durduruyor mu, tempo iyi mi, sonuna kadar izlenir mi? |
| **Editör** | Anlatım ekrandakiyle uyuşuyor mu, desteklenmeyen isim, skor ya da iddia var mı, dil ve yazım doğru mu, altyazı okunuyor mu? |
| **Kanal yöneticisi** | Kanalın tarzına uyuyor mu, anlatım gerçekten yorum katıyor mu (YouTube’un tekrar kullanılan içerik kuralları), başlık abartılı mı, kanala zarar verecek bir şey var mı? |

1. turda her ajan bağımsız olarak 1-10 arası puan ve onay ya da ret verir. 2. turda diğer ikisinin görüşlerini okur, onlara cevap verir ve son oyunu verir. Ajanların çoğunluğu onaylar **ve** ortalama puan eşiği (varsayılan 7) geçerse video yayın sırasına girer ve kendiliğinden YouTube’a yüklenir.

Reddederlerse metin, ajanların önerileriyle Claude’a bir kez daha yazdırılır, video yeniden oluşturulur ve tekrar değerlendirilir. Yine reddederlerse video Taslaklar’da senin kararını bekler; tartışmanın tamamını orada okuyabilirsin.

Ayarlar → Değerlendirme ajanları’ndan karar yetkisini değiştirebilirsin: ajanlar karar versin (varsayılan), ajanlar sadece yorum yapsın ve onayı sen ver, ya da ajan olmasın. Ajanlar Claude’un seçili modelini kullanır; video başına 6 kısa istek gider.

## Kapak görseli

Claude klibe bakarken kapak için en çarpıcı kareyi ve 2-4 kelimelik bir kapak yazısı seçer. Uygulama o kareyi altyazısız alır, renkleri biraz canlandırır ve yazıyı büyük harflerle, vurgu renginde basar (1080x1920 JPEG). Taslaklar’da kapağı videonun altında görürsün; **Kapak yazısı** alanını değiştirip **Kaydet**’e basarsan sadece kapak yeniden hazırlanır, video ve ajanların kararı değişmez.

YouTube Shorts kapağını, video yüklendikten ve YouTube onu işlemeyi bitirdikten sonra kabul ediyor. Uygulama bunu birkaç dakikada bir kontrol eder ve kapağı yükler; Takvim’de “Kapak yüklendi” yazar. YouTube özel kapağa sadece **telefonla doğrulanmış** kanallarda izin verir: doğrulanmamışsa uygulama bunu bir kez bildirir ve video kapaksız (YouTube’un seçtiği kareyle) yayınlanır. Doğrulama: youtube.com/verify. Kapağı istemezsen Ayarlar → Video’dan kapatabilirsin.

## Sonuçlar ve öğrenme

Uygulama açıkken 6 saatte bir, son 60 günde yayınlanan videoların izlenme, beğeni ve yorum sayılarını YouTube’dan alır. Videolar adil karşılaştırılsın diye her videonun **48. saatteki** sayıları ayrıca saklanır. YouTube bir videoyu reddederse (örneğin telif) ya da video yayın saatinde açılmazsa bildirim gelir ve Takvim’de “Sorun var” yazar.

En az 3 videonun sonucu gelince Claude bu sayılardan kanal için 3-8 kısa ders çıkarır: hangi girişler, başlıklar, uzunluklar ve konular daha çok izlendi, ajanların puanları izlenmeyle ne kadar örtüştü. Sonra yeni sonuçlar geldikçe ya da haftada bir dersleri günceller. Dersler, en çok izlenen videoların girişleri ve ajan puanı ile izlenme karşılaştırması bir sonraki metni yazan Claude’a ve değerlendirme ajanlarına verilir. Böylece kanal büyüdükçe kararlar senin izleyicine göre şekillenir. **Sonuçlar** sekmesinde sayıları, dersleri ve **Şimdi güncelle** düğmesini bulursun. Az veriyle çıkan dersler zayıf olur; Claude bunu derslerde belirtir.

## Windows’a kurulum

1. `ShortsBot-Kurulum-x.y.z.exe` dosyasına çift tıkla (GitHub → Releases).
2. Windows “Bilgisayarınız korundu” uyarısı verirse **Ek bilgi → Yine de çalıştır**’a bas. Dosya imzasız olduğu için bu uyarı çıkıyor.
3. Kurulum bitince masaüstündeki **Shorts Bot** kısayoluyla aç.

ffmpeg ve altyazı fontu kurulum dosyasının içinde gelir. Ayrıca bir şey kurman gerekmez.

Uygulama **Windows açılınca arka planda kendiliğinden başlar** ve saatin yanındaki simgede çalışır. Pencereyi kapatmak uygulamayı kapatmaz; tamamen kapatmak için simgeye sağ tıklayıp **Çıkış**’ı seç. Bir taslak onayını beklediğinde, ajanlar bir videoyu onaylayıp zamanladığında ya da bir yükleme hata verdiğinde Windows bildirimi gelir; bildirime tıklayınca Taslaklar açılır. Açılışta başlamayı Ayarlar → Uygulama’dan ya da simgenin menüsünden kapatabilirsin.

## İlk ayarlar (Ayarlar sekmesi)

Pano’daki “Kurulum tamamlanmadı” listesi eksik olanları gösterir; maddeye tıklayınca ilgili ayara gider.

| Servis | Ne için | Anahtar nereden alınır |
|---|---|---|
| Claude | Klip ajanı, seslendirme metni, başlık, etiketler, değerlendirme | Claude Console (platform.claude.com) → API Keys |
| ElevenLabs | Seslendirme ve videodaki konuşmaların dökümü | ElevenLabs hesabı → Developers → API Keys. Kaydettikten sonra **Sesleri getir** ile bir ses seç. |
| OpusClip (isteğe bağlı) | Linkle eklenen videolardan klip çıkarma | clip.opus.pro/dashboard → sol alt köşe. API, OpusClip’in **Pro, Max ve Business** planlarında açık. Sadece video dosyası kullanacaksan gerekmez. |
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

- **Kaynaklar:** Bilgisayarındaki video dosyasını seç (klip ajanı) ya da video bağlantısını ekle (OpusClip: YouTube, Drive, Vimeo, Twitch…). “Bu video ne hakkında?” alanına maç, takımlar, oyuncular gibi bilgileri yaz. Claude bunları kullanır ve emin olmadığı isim, skor ya da tarihi uydurmaz. “OpusClip neyi arasın?” alanına “goller ve kurtarışlar” gibi bir tarif yazabilirsin; bu alan sadece ClipAnything modelinde kullanılır. OpusClip videonun uzunluğuna göre 5-30 dakikada bitirir.
- **Klipler:** Seçilen klipler. **#1** en yüksek puanlı klip: klip ajanında Claude’un puanı ve gerekçesi kartta yazar, OpusClip’te OpusClip’in sırasıdır. **Taslak hazırla** ya da **Atla**.
- **Taslaklar:** Hazırlanan videoyu izle. Başlığı, metni, açıklamayı ve etiketleri düzeltebilirsin:
  - Metni ya da üst başlığı değiştirip **Kaydet**’e basarsan seslendirme ve video yeniden oluşur. Sadece kapak yazısını değiştirirsen sadece kapak yeniden hazırlanır.
  - **Claude yeniden yazsın:** “Claude’a not” alanındaki yönlendirmeyle yeni bir versiyon yazar (“daha esprili olsun”, “oyuncunun adı Icardi” gibi).
  - **Sesi yenile:** Aynı metni, Ayarlar’da seçili sesle yeniden seslendirir.
  - **Ajanlara değerlendirt:** Düzenlediğin videoyu kurula tekrar sorar.
  - **Onayla ve zamanla:** Ajanlar ne derse desin video sıradaki boş yayın saatine yerleşir ve YouTube’a yüklenir.
- **Takvim:** Zamanlanan ve yayınlanan videolar, YouTube bağlantıları ve kapak durumuyla.
- **Sonuçlar:** Yayınlanan videoların izlenme, 48. saat izlenmesi, beğeni, yorum ve ajan puanı; ajanların öğrendiği dersler.
- **Otomatik taslak (varsayılan açık):** Ajanlar karar verirken uygulama ileriye 3 yayın saatini dolu tutacak kadar klip hazırlar; karar sendeyken onayını bekleyen 2 taslak tutar. Önce her videonun 1 numaralı klibini, sonra 2 numaralılarını kullanır.

Ayarlar ve videolar `%APPDATA%\Shorts Bot` klasöründe tutulur. Uygulama çalışırken her dakika OpusClip’i kontrol eder, taslak hazırlar, ajanlara değerlendirtir ve onaylanan videoları yükler. YouTube’a yüklenmiş videolar uygulama kapalıyken de saatinde yayınlanır.

### Müzik

Ayarlar → Video → **Müzik klasörünü aç**. Oraya koyduğun mp3/m4a/wav dosyalarından her videoya rastgele biri, düşük seste eklenir. Klasör boşsa müzik eklenmez. Telifsiz müzik kullan (örneğin YouTube Ses Kitaplığı).

## Özgünlük ve telif

Uygulama klibi gerçekten dönüştürür: kendi anlatımın, kendi yorumun, başlık ve altyazı eklenir. Videoyu aynalamak ya da hızlandırmak gibi telif tespitini atlatmaya yönelik numaralar **içermez**. Kaynak videonun hakları sende değilse (örneğin maç yayınları) YouTube telif talebi ya da uyarısı gelebilir; seslendirme bunu engellemez. En güvenlisi kendi videoların, izin aldığın içerikler ya da klip yapılmasına izin veren yayıncılar.

Gerçek bir kişinin sesini taklit eden bir ElevenLabs sesi kullanıyorsan Ayarlar → YouTube’daki “değiştirilmiş veya yapay içerik” kutusunu işaretle.

## Maliyetler

- **Klip ajanı:** 90 dakikalık maç başına yaklaşık 1,5 dolar (ElevenLabs döküm 0,20 dolar/saat, gerisi Claude).
- **OpusClip (linkler için):** 1 kredi = 1 dakika kaynak video. API ile açılan her proje en az 10 kredi. Pro/Max planlarında API ile ayda en fazla 900 kredi (15 saat) işlenebilir.
- **ElevenLabs:** Karakter başına. 45 saniyelik bir Short yaklaşık 600-800 karakter.
- **Claude:** Taslak başına birkaç sent (4 küçük görüntü ve kısa bir metin); ajan kurulu video başına 6 kısa istek daha yapar, yaklaşık 10-15 sent. Kanal dersleri yeni sonuçlar geldikçe tek bir istekle güncellenir (birkaç sent).
- **YouTube:** Ücretsiz. Günlük API kotasının çok küçük bir kısmı kullanılır: kapak yüklemesi 50, sonuç kontrolü 1 birim (günlük kota 10.000).

## İlk gerçek denemede kontrol edilecekler

Bu noktalar sahte servislerle test edildi; gerçek hesaplarla ilk denemede bakılmalı:
- **Klip ajanı doğru anları seçiyor mu?** İlk maçta Klipler’deki anları kendin de izle; Claude’un gerekçesi kartta yazar. Seçim istediğin gibi değilse Ayarlar → Klip ajanı’ndaki talimatı netleştir (“sadece goller”, “kenar çizgisi kavgalarını alma” gibi).
- **Dikey görünüm:** Maç görüntüsü ortada küçük kalıyorsa Ayarlar → Video → “Yatay videoda yakınlaştırma”yı artır.
- **OpusClip sırası = puan sırası mı?** OpusClip’in API’si puan sayısını vermiyor; klipleri arayüzdeki gibi puana göre sıralı döndürdüğünü varsayıyoruz. İlk projede Klipler’deki #1, #2… sırasını OpusClip sitesindeki puanlarla karşılaştır.
- **OpusClip altyazısı kapalı mı geliyor?** Uygulama projeyi altyazısız istiyor. Kliplerde OpusClip’in kendi altyazısı da görünürse, OpusClip’te altyazısı kapalı bir marka şablonu oluştur ve ID’sini Ayarlar → OpusClip’e yaz.
- **Ses ve altyazı uyumu:** İlk taslağı izle; konuşma hızı ve ses seviyeleri Ayarlar’dan değiştirilebilir.
- **Kapak YouTube’a gitti mi?** İlk videodan sonra Takvim’de “Kapak yüklendi” yazmalı ve YouTube Studio’da kapak görünmeli. “Kapak: … izin vermedi” yazıyorsa kanalı youtube.com/verify’dan doğrula.
- **Sonuçlar geliyor mu?** İlk video yayınlandıktan birkaç saat sonra Sonuçlar’da izlenme sayıları görünmeli. YouTube’u bu sürümden önce bağladıysan sorun yok; aynı izin yeterli.

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
  pipeline.ts          taslak hazırlama (indir → Claude → ElevenLabs → altyazı → video → kapak), ajan değerlendirmesi, yükleme ve sonuçlar
  review.ts            değerlendirme ajanları (iki turlu tartışma ve karar)
  finder.ts            klip ajanı: Claude’un videoyu izleyip anları seçmesi
  analyze.ts           klip ajanı için ses, döküm, kare sayfaları ve kesme
  insights.ts          YouTube sonuçlarından kanal dersleri
  opus.ts              OpusClip API istemcisi
  claude.ts            seslendirme metni (Claude API)
  eleven.ts            ElevenLabs API istemcisi (seslendirme ve döküm)
  subtitles.ts         kelime zamanlı ASS altyazı ve kapak yazısı
  ffmpeg.ts            video birleştirme, dikey düzen ve kapak görseli
  youtube.ts           Google OAuth, YouTube yükleme, kapak ve sonuçlar
  schedule.ts          yayın saatleri
  settings.ts          ayarlar ve doğrulama
assets/fonts/          altyazı fontu (Montserrat, SIL Open Font License)
test/                  testler ve sahte servisler
```
